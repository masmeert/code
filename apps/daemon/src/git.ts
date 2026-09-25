import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import * as Predicate from "effect/Predicate";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Git processes running at once, across all repos. Several windows, threads and
 * untracked-file diffs can ask at the same time; the rest wait their turn (t3code caps at 8 too).
 */
const MAX_GIT_PROCESSES = 8;
let running = 0;
const waiting: Array<() => void> = [];

const acquire = () => {
  if (running < MAX_GIT_PROCESSES) {
    running++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
};

/** Hands the slot straight to the next waiter, so nobody can slip in between. */
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

interface GitResult {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

const execGit = async (
  cwd: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptions,
): Promise<GitResult> => {
  await acquire();
  try {
    return await new Promise((resolve) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { ...options, encoding: "utf8" },
        (error, stdout, stderr) =>
          resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  } finally {
    release();
  }
};

/** Branch checked out in `cwd` (also before the first commit); the short commit when detached, null outside a repo. */
export const readBranch = async (cwd: string): Promise<string | null> => {
  const head = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 });
  const ref = head.stdout.trim();
  if (head.error || !ref) {
    // No commits yet: HEAD names a branch that doesn't exist.
    const symbolic = await execGit(cwd, ["symbolic-ref", "--short", "HEAD"], { timeout: 2000 });
    return symbolic.error ? null : symbolic.stdout.trim() || null;
  }
  if (ref !== "HEAD") return ref;
  const sha = await execGit(cwd, ["rev-parse", "--short", "HEAD"], { timeout: 2000 });
  return sha.error ? null : sha.stdout.trim() || null;
};

const git = async (cwd: string, args: ReadonlyArray<string>, timeout = 5000) => {
  const { error, stdout, stderr } = await execGit(cwd, args, { timeout });
  return { ok: !error, stdout: stdout.trim(), stderr: stderr.trim() || (error?.message ?? "") };
};

/** Local branches, most recently committed first; a branch with no commits yet is listed too. */
export const listBranches = async (cwd: string) => {
  const [current, refs] = await Promise.all([
    readBranch(cwd),
    git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
  ]);
  const branches = refs.ok ? refs.stdout.split("\n").filter(Boolean) : [];
  if (current && !branches.includes(current)) branches.unshift(current);
  return { current, branches };
};

/** Switches `cwd` to an existing local branch; resolves to git's error message on failure. */
export const checkoutBranch = async (cwd: string, branch: string) => {
  const { branches } = await listBranches(cwd);
  if (!branches.includes(branch)) return `No local branch "${branch}"`;
  const result = await git(cwd, ["switch", branch], 15000);
  return result.ok ? null : firstLines(result.stderr);
};

/** Creates `branch` at HEAD and switches to it; resolves to an error message on failure. */
export const createBranch = async (cwd: string, branch: string) => {
  const name = branch.trim();
  // check-ref-format rejects spaces, "..", trailing ".lock" and the like; a leading "-" would read as a flag.
  if (
    !name ||
    name.startsWith("-") ||
    !(await git(cwd, ["check-ref-format", "--branch", name])).ok
  ) {
    return `"${name}" isn't a valid branch name`;
  }
  const { branches } = await listBranches(cwd);
  if (branches.includes(name)) return `Branch "${name}" already exists`;
  const result = await git(cwd, ["switch", "-c", name], 15000);
  return result.ok ? null : firstLines(result.stderr);
};

const firstLines = (text: string) => text.split("\n").filter(Boolean).slice(0, 3).join("\n");

/** Git's well-known empty tree: the base to diff against before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED = 100;

const gitRaw = async (cwd: string, args: ReadonlyArray<string>) => {
  const { error, stdout, stderr } = await execGit(cwd, args, {
    timeout: 10000,
    maxBuffer: MAX_PATCH_BYTES * 2,
  });
  return {
    code: error ? (Predicate.isNumber(error.code) ? error.code : -1) : 0,
    stdout,
    stderr: stderr.trim() || (error?.message ?? ""),
  };
};

const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Uncommitted changes in `cwd` vs HEAD, untracked files included, as one unified patch. */
export const readDiff = async (
  cwd: string,
): Promise<{ patch: string; truncated: boolean; error: string | null }> => {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { patch: "", truncated: false, error: "Not a git repo" };
  const hasHead = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;

  const tracked = await gitRaw(cwd, ["diff", ...DIFF_FLAGS, hasHead ? "HEAD" : EMPTY_TREE]);
  if (tracked.code !== 0) return { patch: "", truncated: false, error: firstLines(tracked.stderr) };

  const others = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = others.ok ? others.stdout.split("\0").filter(Boolean) : [];
  let patch = tracked.stdout;
  let truncated = untracked.length > MAX_UNTRACKED;
  // In parallel (the process cap bounds it), kept in order.
  const added =
    patch.length > MAX_PATCH_BYTES
      ? []
      : await Promise.all(
          untracked
            .slice(0, MAX_UNTRACKED)
            // --no-index exits 1 when the files differ, which is always the case here.
            .map((file) =>
              gitRaw(cwd, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file]),
            ),
        );
  for (const file of added) if (file.code === 0 || file.code === 1) patch += file.stdout;
  if (patch.length > MAX_PATCH_BYTES) {
    // Cut at a file boundary so the patch still parses.
    const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
    patch = cut > 0 ? patch.slice(0, cut + 1) : "";
    truncated = true;
  }
  return { patch, truncated, error: null };
};

/** Never wait on a credential prompt nobody can answer. */
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

const gitLong = async (cwd: string, args: ReadonlyArray<string>, timeout = 60000) => {
  const { error, stdout, stderr } = await execGit(cwd, args, {
    timeout,
    env: NO_PROMPT,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !error,
    stdout: stdout.trim(),
    stderr: stderr.trim() || stdout.trim() || (error?.message ?? ""),
  };
};

export interface RepoStatus {
  /** Changed files, untracked included. */
  readonly changes: number;
  /** Null when detached. */
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  /** Commits on the branch that the default branch doesn't have. */
  readonly aheadOfDefault: number;
  readonly upstream: string | null;
  /** Commits not yet on the upstream; with no upstream, every commit on the branch. */
  readonly ahead: number;
  readonly behind: number;
  readonly hasRemote: boolean;
  readonly detached: boolean;
}

/** Working-tree and upstream state of `cwd`, null outside a repo. */
export const readStatus = async (cwd: string): Promise<RepoStatus | null> => {
  const [status, remotes] = await Promise.all([
    git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    git(cwd, ["remote"]),
  ]);
  if (!status.ok) return null;
  let changes = 0;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  let branch: string | null = null;
  let oid: string | null = null;
  for (const line of status.stdout.split("\n")) {
    if (!line) continue;
    if (!line.startsWith("#")) {
      changes++;
      continue;
    }
    const [, key, ...rest] = line.split(" ");
    if (key === "branch.head") {
      detached = rest[0] === "(detached)";
      branch = detached ? null : (rest[0] ?? null);
    } else if (key === "branch.oid") oid = rest[0] === "(initial)" ? null : (rest[0] ?? null);
    else if (key === "branch.upstream") upstream = rest[0] ?? null;
    else if (key === "branch.ab") {
      ahead = Math.abs(Number(rest[0]) || 0);
      behind = Math.abs(Number(rest[1]) || 0);
    }
  }
  if (!upstream && oid && !detached) {
    const count = await git(cwd, ["rev-list", "--count", "HEAD"]);
    ahead = count.ok ? Number(count.stdout) || 0 : 0;
  }
  const defaultBranch = await readDefaultBranch(cwd);
  const base = defaultBranch && (await baseRef(cwd, defaultBranch));
  const aheadOfDefault =
    base && oid && branch !== defaultBranch
      ? Number((await git(cwd, ["rev-list", "--count", `${base}..HEAD`])).stdout) || 0
      : 0;
  return {
    changes,
    branch,
    defaultBranch,
    aheadOfDefault,
    upstream,
    ahead,
    behind,
    hasRemote: remotes.ok && remotes.stdout.length > 0,
    detached,
  };
};

/** The remote pull requests go to: origin, else the first one. */
export const mainRemote = async (cwd: string) => {
  const remotes = (await git(cwd, ["remote"])).stdout.split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
};

/** What the main remote's HEAD points at, else main or master if one exists. */
export const readDefaultBranch = async (cwd: string) => {
  const remote = await mainRemote(cwd);
  if (remote) {
    const head = await git(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    if (head.ok && head.stdout.startsWith(`${remote}/`))
      return head.stdout.slice(remote.length + 1);
  }
  for (const name of ["main", "master"]) {
    const found = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (found.ok) return name;
  }
  return null;
};

/** The remote-tracking ref of `branch` when there is one, since the local copy may be stale; else the branch itself. */
const baseRef = async (cwd: string, branch: string) => {
  const remote = await mainRemote(cwd);
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : null;
  if (tracking && (await git(cwd, ["rev-parse", "--verify", "--quiet", tracking])).ok)
    return tracking;
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok
    ? branch
    : null;
};

/** The main remote's URL, for telling which host it's on. */
export const readRemoteUrl = async (cwd: string) => {
  const remote = await mainRemote(cwd);
  if (!remote) return null;
  const url = await git(cwd, ["remote", "get-url", remote]);
  return url.ok ? url.stdout : null;
};

/**
 * Fast-forwards the default branch from its upstream when the checkout has nothing of its
 * own: no changes and no commits the upstream lacks. Resolves to whether it pulled.
 */
export const autoPull = async (cwd: string) => {
  const ready = (status: RepoStatus | null) =>
    status?.upstream &&
    status.branch !== null &&
    status.branch === status.defaultBranch &&
    status.changes === 0 &&
    status.ahead === 0;
  if (!ready(await readStatus(cwd))) return false;
  if (!(await gitLong(cwd, ["fetch", "--quiet", "--no-tags"], 15000)).ok) return false;
  const fetched = await readStatus(cwd);
  if (!ready(fetched) || !fetched?.behind) return false;
  return (await gitLong(cwd, ["pull", "--ff-only"], 30000)).ok;
};

const cap = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;

/**
 * What a pull request from HEAD into `base` would contain, for writing its text. `base`
 * is the branch the user set as merge base (gh's `branch.<name>.gh-merge-base`), else the default branch.
 */
export const readPullRequestRange = async (cwd: string, branch: string) => {
  const configured = await git(cwd, ["config", `branch.${branch}.gh-merge-base`]);
  const base =
    configured.ok && configured.stdout ? configured.stdout : await readDefaultBranch(cwd);
  if (!base) return null;
  const ref = (await baseRef(cwd, base)) ?? base;
  const [log, stat, patch] = await Promise.all([
    git(cwd, ["log", "--oneline", `${ref}..HEAD`]),
    git(cwd, ["diff", "--stat", `${ref}...HEAD`]),
    gitRaw(cwd, ["diff", ...DIFF_FLAGS, "--patch", "--minimal", `${ref}...HEAD`]),
  ]);
  return {
    base,
    commits: cap(log.stdout, 12_000),
    stat: cap(stat.stdout, 12_000),
    patch: cap(patch.stdout, 40_000),
  };
};

/** Subjects of the last few commits, newest first; empty before the first commit. */
export const readRecentSubjects = async (cwd: string, count = 8) => {
  const log = await git(cwd, ["log", `-${count}`, "--format=%s"]);
  return log.ok ? log.stdout.split("\n").filter(Boolean) : [];
};

/** Stages everything and commits it; resolves to an error message on failure. */
export const commitAll = async (cwd: string, message: string) => {
  const text = message.trim();
  if (!text) return "Write a commit message first";
  const add = await gitLong(cwd, ["add", "-A"]);
  if (!add.ok) return firstLines(add.stderr);
  const commit = await gitLong(cwd, ["commit", "-m", text]);
  return commit.ok ? null : firstLines(commit.stderr);
};

/** Pushes the current branch, setting its upstream on the first push; resolves to an error message on failure. */
export const pushBranch = async (cwd: string) => {
  const status = await readStatus(cwd);
  if (!status) return "Not a git repo";
  if (status.detached) return "Can't push a detached HEAD";
  if (!status.hasRemote) return "No remote to push to";
  let args = ["push"];
  if (!status.upstream) {
    const remotes = (await git(cwd, ["remote"])).stdout.split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
    args = ["push", "-u", remote, "HEAD"];
  }
  const result = await gitLong(cwd, args, 120000);
  return result.ok ? null : firstLines(result.stderr);
};

// --- checkpoints -------------------------------------------------------------
// Snapshots of a working tree, taken around each turn so its changes can be shown
// and undone. Written as commits under hidden refs, through a scratch copy of the
// index: the user's staging, branch and history are never touched (t3code does the same).

const CHECKPOINT_REFS = "refs/apcode/checkpoints";
/** Snapshot commits need an author even where git has no identity configured. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "APCode",
  GIT_AUTHOR_EMAIL: "apcode@localhost",
  GIT_COMMITTER_NAME: "APCode",
  GIT_COMMITTER_EMAIL: "apcode@localhost",
};

export const checkpointRef = (threadId: string, messageId: string, when: "start" | "end") =>
  `${CHECKPOINT_REFS}/${threadId}/${messageId}/${when}`;

/** Commits the working tree as it is (untracked files included, ignored ones not); null outside a repo. */
const snapshot = async (cwd: string, message: string): Promise<string | null> => {
  const indexPath = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!indexPath.ok) return null;
  const scratch = join(tmpdir(), `apcode-index-${crypto.randomUUID()}`);
  try {
    // Starting from the real index lets `add` skip files whose stat info hasn't changed.
    await copyFile(indexPath.stdout, scratch).catch(() => undefined);
    const env = { ...process.env, ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: scratch };
    const add = await execGit(cwd, ["add", "-A"], { timeout: 60000, env });
    if (add.error) return null;
    const tree = await execGit(cwd, ["write-tree"], { timeout: 30000, env });
    const treeId = tree.stdout.trim();
    if (tree.error || !treeId) return null;
    const commit = await execGit(cwd, ["commit-tree", treeId, "-m", message], {
      timeout: 10000,
      env,
    });
    const commitId = commit.stdout.trim();
    return commit.error || !commitId ? null : commitId;
  } finally {
    await rm(scratch, { force: true });
  }
};

/** Snapshots the working tree under `ref`; false outside a repo or if it failed. */
export const captureCheckpoint = async (cwd: string, ref: string) => {
  const commit = await snapshot(cwd, `apcode checkpoint ${ref}`);
  if (!commit) return false;
  return (await git(cwd, ["update-ref", ref, commit])).ok;
};

const refExists = async (cwd: string, ref: string) =>
  (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;

/** Keeps a patch under the size cap, cut at a file boundary so it still parses. */
const capPatch = (patch: string) => {
  if (patch.length <= MAX_PATCH_BYTES) return { patch, truncated: false };
  const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
  return { patch: cut > 0 ? patch.slice(0, cut + 1) : "", truncated: true };
};

/** The target to compare a turn's start against: its end snapshot, or the working tree if it has none yet. */
const turnEnd = async (cwd: string, threadId: string, messageId: string) => {
  const end = checkpointRef(threadId, messageId, "end");
  return (await refExists(cwd, end)) ? end : await snapshot(cwd, "apcode working tree");
};

/** What one turn changed, as a unified patch. */
export const readCheckpointDiff = async (cwd: string, threadId: string, messageId: string) => {
  const start = checkpointRef(threadId, messageId, "start");
  if (!(await refExists(cwd, start)))
    return { patch: "", truncated: false, error: "No snapshot of this turn" };
  const end = await turnEnd(cwd, threadId, messageId);
  if (!end) return { patch: "", truncated: false, error: "Couldn't read the working tree" };
  const diff = await gitRaw(cwd, ["diff", ...DIFF_FLAGS, start, end]);
  if (diff.code !== 0) return { patch: "", truncated: false, error: firstLines(diff.stderr) };
  return { ...capPatch(diff.stdout), error: null };
};

/** Files and lines one turn changed; null if it has no snapshots. */
export const readCheckpointStats = async (cwd: string, threadId: string, messageId: string) => {
  const start = checkpointRef(threadId, messageId, "start");
  const end = checkpointRef(threadId, messageId, "end");
  const diff = await git(cwd, ["diff", "--numstat", "--no-renames", start, end]);
  if (!diff.ok) return null;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.stdout.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t");
    files++;
    // Binary files show "-".
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  return { files, additions, deletions };
};

/**
 * Puts the working tree back to the snapshot taken when `messageId` was sent. What's
 * there now is snapshotted first (under a backup ref), so the restore itself can be undone.
 */
export const restoreCheckpoint = async (
  cwd: string,
  threadId: string,
  messageId: string,
): Promise<string | null> => {
  const start = checkpointRef(threadId, messageId, "start");
  if (!(await refExists(cwd, start))) return "There's no snapshot of the files from that point";
  const current = await snapshot(cwd, "apcode backup before restore");
  if (!current) return "Couldn't snapshot the current files";
  await git(cwd, ["update-ref", `refs/apcode/backups/${threadId}/${Date.now()}`, current]);
  const changed = await git(cwd, ["diff", "--name-only", "--no-renames", "-z", start, current]);
  if (!changed.ok) return firstLines(changed.stderr);
  const paths = changed.stdout.split("\0").filter(Boolean);
  if (!paths.length) return null;
  const inStart = new Set(
    (await git(cwd, ["ls-tree", "-r", "--name-only", "-z", start])).stdout
      .split("\0")
      .filter(Boolean),
  );
  const restore = paths.filter((path) => inStart.has(path));
  // Batches keep the command line short.
  for (let i = 0; i < restore.length; i += 200) {
    const result = await gitLong(cwd, [
      "restore",
      `--source=${start}`,
      "--worktree",
      "--",
      ...restore.slice(i, i + 200),
    ]);
    if (!result.ok) return firstLines(result.stderr);
  }
  // Files created since then.
  await Promise.all(
    paths.filter((path) => !inStart.has(path)).map((path) => rm(join(cwd, path), { force: true })),
  );
  return null;
};

/** Whether the turn started by `messageId` has a snapshot to go back to. */
export const hasCheckpoint = (cwd: string, threadId: string, messageId: string) =>
  refExists(cwd, checkpointRef(threadId, messageId, "start"));

/** Drops every snapshot of a thread, backups included. */
export const deleteThreadCheckpoints = async (cwd: string, threadId: string) => {
  const refs = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    `${CHECKPOINT_REFS}/${threadId}`,
    `refs/apcode/backups/${threadId}`,
  ]);
  if (!refs.ok || !refs.stdout) return;
  await updateRefs(
    cwd,
    refs.stdout
      .split("\n")
      .filter(Boolean)
      .map((ref) => `delete ${ref}\n`)
      .join(""),
  );
};

const updateRefs = async (cwd: string, stdin: string) => {
  await acquire();
  try {
    await new Promise<void>((resolve) => {
      const child = execFile("git", ["-C", cwd, "update-ref", "--stdin"], { timeout: 10000 }, () =>
        resolve(),
      );
      child.stdin?.end(stdin);
    });
  } finally {
    release();
  }
};

/** Drops the snapshots of the given messages' turns. */
export const deleteCheckpoints = async (
  cwd: string,
  threadId: string,
  messageIds: ReadonlyArray<string>,
) => {
  const refs = messageIds.flatMap((id) => [
    checkpointRef(threadId, id, "start"),
    checkpointRef(threadId, id, "end"),
  ]);
  if (refs.length) await updateRefs(cwd, refs.map((ref) => `delete ${ref}\n`).join(""));
};

// --- worktrees ---------------------------------------------------------------

/** Top of the repo containing `cwd`; null outside one. */
export const repoRoot = async (cwd: string) => {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return root.ok && root.stdout ? root.stdout : null;
};

/**
 * Adds a worktree at `path` on a new branch `branch`, starting from what's checked out
 * in `cwd`. Resolves to an error message on failure.
 */
/** With `fromOrigin`, starts from origin's copy of the current branch when it has one, else from HEAD. */
export const addWorktree = async (
  cwd: string,
  path: string,
  branch: string,
  fromOrigin: boolean,
) => {
  await mkdir(dirname(path), { recursive: true });
  const hasHead = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
  if (!hasHead) return "Worktrees need at least one commit";
  const current = fromOrigin ? await readBranch(cwd) : null;
  const fetched = current !== null && (await gitLong(cwd, ["fetch", "origin", current], 30000)).ok;
  const result = await gitLong(cwd, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
    fetched ? `origin/${current}` : "HEAD",
  ]);
  return result.ok ? null : firstLines(result.stderr);
};

/** Removes a thread's worktree if nothing in it is uncommitted; its branch stays. True when removed. */
export const removeWorktreeIfClean = async (path: string) => {
  const status = await git(path, ["status", "--porcelain"]);
  if (!status.ok || status.stdout) return false;
  return (await gitLong(path, ["worktree", "remove", path])).ok;
};
