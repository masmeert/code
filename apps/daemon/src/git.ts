import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { repositoryOf } from "@masscode/contracts";
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

function acquireGitSlot() {
  if (running < MAX_GIT_PROCESSES) {
    running++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => waiting.push(resolve));
}

/** Hands the slot straight to the next waiter, so nobody can slip in between. */
function releaseGitSlot() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

interface GitResult {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function execGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptions,
): Promise<GitResult> {
  await acquireGitSlot();
  try {
    return await new Promise((resolve) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          ...options,
          // Paths we pass are file names, never patterns: a file named `*` mustn't match every file.
          env: { ...(options.env ?? process.env), GIT_LITERAL_PATHSPECS: "1" },
          encoding: "utf8",
        },
        (error, stdout, stderr) =>
          resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  } finally {
    releaseGitSlot();
  }
}

/** Branch checked out in `cwd` (also before the first commit); the short commit when detached, null outside a repo. */
export async function readBranch(cwd: string): Promise<string | null> {
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
}

async function runGit(cwd: string, args: ReadonlyArray<string>, timeout = 5000) {
  const { error, stdout, stderr } = await execGit(cwd, args, { timeout });
  return { ok: !error, stdout: stdout.trim(), stderr: stderr.trim() || (error?.message ?? "") };
}

/** Local branches, most recently committed first; a branch with no commits yet is listed too. */
export async function listBranches(cwd: string) {
  const [current, refs] = await Promise.all([
    readBranch(cwd),
    runGit(cwd, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]),
  ]);
  const branches = refs.ok ? refs.stdout.split("\n").filter(Boolean) : [];
  if (current && !branches.includes(current)) branches.unshift(current);

  return { current, branches };
}

/** Tracked and untracked files in `cwd`, minus ignored ones; empty outside a repo. */
export async function listFiles(cwd: string) {
  const { error, stdout } = await execGit(
    cwd,
    ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
  );
  return error ? [] : stdout.split("\n").filter(Boolean);
}

/** Switches `cwd` to an existing local branch; resolves to git's error message on failure. */
export async function checkoutBranch(cwd: string, branch: string) {
  const { branches } = await listBranches(cwd);
  if (!branches.includes(branch)) return `No local branch "${branch}"`;

  const result = await runGit(cwd, ["switch", branch], 15000);
  return result.ok ? null : getFirstLines(result.stderr);
}

/** Creates `branch` at HEAD and switches to it; resolves to an error message on failure. */
export async function createBranch(cwd: string, branch: string) {
  const name = branch.trim();
  // check-ref-format rejects spaces, "..", trailing ".lock" and the like; a leading "-" would read as a flag.
  if (
    !name ||
    name.startsWith("-") ||
    !(await runGit(cwd, ["check-ref-format", "--branch", name])).ok
  ) {
    return `"${name}" isn't a valid branch name`;
  }

  const { branches } = await listBranches(cwd);
  if (branches.includes(name)) return `Branch "${name}" already exists`;

  const result = await runGit(cwd, ["switch", "-c", name], 15000);
  return result.ok ? null : getFirstLines(result.stderr);
}

function getFirstLines(text: string) {
  return text.split("\n").filter(Boolean).slice(0, 3).join("\n");
}

/** Git's well-known empty tree: the base to diff against before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED = 100;

async function runGitRaw(cwd: string, args: ReadonlyArray<string>) {
  const { error, stdout, stderr } = await execGit(cwd, args, {
    timeout: 10000,
    maxBuffer: MAX_PATCH_BYTES * 2,
  });
  return {
    code: error ? (Predicate.isNumber(error.code) ? error.code : -1) : 0,
    stdout,
    stderr: stderr.trim() || (error?.message ?? ""),
  };
}

const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Uncommitted changes in `cwd` vs HEAD, untracked files included, as one unified patch. */
export async function readDiff(
  cwd: string,
): Promise<{ patch: string; truncated: boolean; error: string | null }> {
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { patch: "", truncated: false, error: "Not a git repo" };

  const hasHead = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;

  const tracked = await runGitRaw(cwd, ["diff", ...DIFF_FLAGS, hasHead ? "HEAD" : EMPTY_TREE]);
  if (tracked.code !== 0)
    return { patch: "", truncated: false, error: getFirstLines(tracked.stderr) };

  const others = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
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
              runGitRaw(cwd, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file]),
            ),
        );
  for (const file of added) {
    if (file.code === 0 || file.code === 1) patch += file.stdout;
  }

  if (patch.length > MAX_PATCH_BYTES) {
    // Cut at a file boundary so the patch still parses.
    const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
    patch = cut > 0 ? patch.slice(0, cut + 1) : "";
    truncated = true;
  }

  return { patch, truncated, error: null };
}

/** Never wait on a credential prompt nobody can answer. */
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

async function runGitLong(cwd: string, args: ReadonlyArray<string>, timeout = 60000) {
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
}

interface RepoStatus {
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
  /** In a linked worktree, the local branch this one merges into; null elsewhere. */
  readonly base: BaseBranch | null;
}

interface BaseBranch {
  readonly branch: string;
  /** Commits on this branch that the base doesn't have. */
  readonly ahead: number;
  /** All of this branch's work is in the base already, squash and rebase merges included. */
  readonly merged: boolean;
  /** Files a merge into the base would conflict in. */
  readonly conflicts: ReadonlyArray<string>;
  /** The checkout that has the base out, whose files a merge updates; null when none does. */
  readonly checkout: string | null;
}

/** Working-tree and upstream state of `cwd`, null outside a repo. */
export async function readStatus(cwd: string): Promise<RepoStatus | null> {
  const [status, remotes] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    runGit(cwd, ["remote"]),
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
    } else if (key === "branch.oid") {
      oid = rest[0] === "(initial)" ? null : (rest[0] ?? null);
    } else if (key === "branch.upstream") {
      upstream = rest[0] ?? null;
    } else if (key === "branch.ab") {
      ahead = Math.abs(Number(rest[0]) || 0);
      behind = Math.abs(Number(rest[1]) || 0);
    }
  }

  if (!upstream && oid && !detached) {
    const count = await runGit(cwd, ["rev-list", "--count", "HEAD"]);
    ahead = count.ok ? Number(count.stdout) || 0 : 0;
  }

  const defaultBranch = await readDefaultBranch(cwd);
  const base = defaultBranch && (await findBaseRef(cwd, defaultBranch));
  const aheadOfDefault =
    base && oid && branch !== defaultBranch
      ? Number((await runGit(cwd, ["rev-list", "--count", `${base}..HEAD`])).stdout) || 0
      : 0;

  return {
    base: branch && oid ? await readBase(cwd, branch, oid) : null,
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
}

/** The remote pull requests go to: origin, else the first one. */
async function findMainRemote(cwd: string) {
  const remotes = (await runGit(cwd, ["remote"])).stdout.split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

/** What the main remote's HEAD points at, else main or master if one exists. */
async function readDefaultBranch(cwd: string) {
  const remote = await findMainRemote(cwd);
  if (remote) {
    const head = await runGit(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    if (head.ok && head.stdout.startsWith(`${remote}/`))
      return head.stdout.slice(remote.length + 1);
  }

  for (const name of ["main", "master"]) {
    const found = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (found.ok) return name;
  }

  return null;
}

/** The remote-tracking ref of `branch` when there is one, since the local copy may be stale; else the branch itself. */
async function findBaseRef(cwd: string, branch: string) {
  const remote = await findMainRemote(cwd);
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : null;
  if (tracking && (await runGit(cwd, ["rev-parse", "--verify", "--quiet", tracking])).ok)
    return tracking;

  return (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok
    ? branch
    : null;
}

/** The main remote's URL, for telling which host it's on. */
export async function readRemoteUrl(cwd: string) {
  const remote = await findMainRemote(cwd);
  if (!remote) return null;

  const url = await runGit(cwd, ["remote", "get-url", remote]);
  return url.ok ? url.stdout : null;
}

/**
 * Fast-forwards the default branch from its upstream when the checkout has nothing of its
 * own: no changes and no commits the upstream lacks. Resolves to whether it pulled.
 */
export async function fastForwardDefaultBranch(cwd: string) {
  function canFastForward(status: RepoStatus | null) {
    return (
      status?.upstream &&
      status.branch !== null &&
      status.branch === status.defaultBranch &&
      status.changes === 0 &&
      status.ahead === 0
    );
  }

  if (!canFastForward(await readStatus(cwd))) return false;
  if (!(await runGitLong(cwd, ["fetch", "--quiet", "--no-tags"], 15000)).ok) return false;

  const fetched = await readStatus(cwd);
  if (!canFastForward(fetched) || !fetched?.behind) return false;

  return (await runGitLong(cwd, ["pull", "--ff-only"], 30000)).ok;
}

function capText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

/** The branch set as `branch`'s merge base (gh's `branch.<name>.gh-merge-base`), else the default branch. */
async function readMergeBase(cwd: string, branch: string) {
  const configured = await runGit(cwd, ["config", `branch.${branch}.gh-merge-base`]);
  return configured.ok && configured.stdout ? configured.stdout : await readDefaultBranch(cwd);
}

/** The checkout that has `branch` out, among the repo's main one and its worktrees. */
async function findCheckout(cwd: string, branch: string) {
  const list = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  for (const entry of list.stdout.split("\n\n")) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`))
      return lines[0]?.replace(/^worktree /, "") ?? null;
  }

  return null;
}

/**
 * What merging HEAD into `into` would give, worked out without touching any checkout;
 * null when git can't tell (unrelated histories, say).
 */
async function previewMerge(cwd: string, into: string) {
  const [result, current] = await Promise.all([
    runGitRaw(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", into, "HEAD"]),
    runGit(cwd, ["rev-parse", `${into}^{tree}`]),
  ]);
  // Exit 1 means conflicts, listed after the tree.
  if (result.code !== 0 && result.code !== 1) return null;

  const [tree = "", ...conflicts] = result.stdout.split("\n").filter(Boolean);
  return { tree, conflicts, changesNothing: result.code === 0 && tree === current.stdout };
}

async function readBase(cwd: string, branch: string, head: string): Promise<BaseBranch | null> {
  const dirs = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, commonDir] = dirs.stdout.split("\n");
  if (!dirs.ok || gitDir === commonDir) return null;

  const name = await readMergeBase(cwd, branch);
  if (!name || name === branch || !(await hasRef(cwd, `refs/heads/${name}`))) return null;

  const [count, checkout] = await Promise.all([
    runGit(cwd, ["rev-list", "--count", `refs/heads/${name}..HEAD`]),
    findCheckout(cwd, name),
  ]);
  const ahead = Number(count.stdout) || 0;
  if (ahead === 0) {
    // The base has every commit: merged, unless the branch never moved from where it was created (its oldest reflog entry).
    const reflog = await runGit(cwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]);
    const start = reflog.stdout.split("\n").at(-1);
    return { branch: name, ahead, merged: !!start && start !== head, conflicts: [], checkout };
  }

  const local = await previewMerge(cwd, `refs/heads/${name}`);
  // A pull request merged on the host may not be in the local base yet.
  const tracking = await findBaseRef(cwd, name);
  const merged =
    !!local?.changesNothing ||
    (!!tracking && tracking !== name && !!(await previewMerge(cwd, tracking))?.changesNothing);

  return {
    branch: name,
    ahead,
    merged,
    conflicts: merged ? [] : (local?.conflicts ?? []),
    checkout,
  };
}

/**
 * Merges the branch checked out in `cwd` into its base: in the checkout that has the base
 * out, or by moving the base alone when none does. It checks first that the merge is clean,
 * so no checkout is ever left mid-merge. Resolves to an error message on failure.
 */
export async function mergeIntoBase(cwd: string) {
  const status = await readStatus(cwd);
  const base = status?.base;
  if (!status?.branch || !base) return "This branch has no local base branch to merge into";
  if (status.changes > 0)
    return `Commit or discard the ${status.changes} ${status.changes === 1 ? "change" : "changes"} in this worktree first`;
  if (base.merged) return `Already merged into ${base.branch}`;
  if (base.ahead === 0) return `No commits to merge into ${base.branch} yet`;
  if (base.conflicts.length > 0)
    return `Merging into ${base.branch} would conflict in ${base.conflicts.join(", ")}. Merge ${base.branch} into this branch and resolve them first.`;

  if (base.checkout) {
    const dirty = await runGit(base.checkout, ["status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok) return getFirstLines(dirty.stderr);
    if (dirty.stdout)
      return `${base.branch} has uncommitted changes in ${base.checkout}. Commit or stash them there, then merge again.`;

    const merge = await runGitLong(base.checkout, ["merge", "--no-edit", status.branch]);
    if (merge.ok) return null;

    // Only reachable if the base moved since the check above.
    await runGit(base.checkout, ["merge", "--abort"]);
    return getFirstLines(merge.stderr);
  }

  const ref = `refs/heads/${base.branch}`;
  const [old, head] = await Promise.all([
    runGit(cwd, ["rev-parse", ref]),
    runGit(cwd, ["rev-parse", "HEAD"]),
  ]);
  if (!old.ok || !head.ok) return getFirstLines(old.stderr || head.stderr);

  let target = head.stdout;
  if (!(await runGit(cwd, ["merge-base", "--is-ancestor", old.stdout, head.stdout])).ok) {
    const preview = await previewMerge(cwd, old.stdout);
    if (!preview || preview.conflicts.length > 0)
      return `${base.branch} changed and no longer merges cleanly. Check it and merge again.`;

    const commit = await runGit(cwd, [
      "commit-tree",
      preview.tree,
      "-p",
      old.stdout,
      "-p",
      head.stdout,
      "-m",
      `Merge branch '${status.branch}'`,
    ]);
    if (!commit.ok) return getFirstLines(commit.stderr);
    target = commit.stdout;
  }

  // Given the old value, update-ref fails rather than overwrite a base that moved meanwhile.
  const update = await runGit(cwd, [
    "update-ref",
    "-m",
    `merge ${status.branch}`,
    ref,
    target,
    old.stdout,
  ]);
  return update.ok ? null : getFirstLines(update.stderr);
}

/**
 * What a pull request from HEAD into `base` would contain, for writing its text. `base`
 * is the branch the user set as merge base (gh's `branch.<name>.gh-merge-base`), else the default branch.
 */
export async function readPullRequestRange(cwd: string, branch: string) {
  const base = await readMergeBase(cwd, branch);
  if (!base) return null;

  const ref = (await findBaseRef(cwd, base)) ?? base;
  const [log, stat, patch] = await Promise.all([
    runGit(cwd, ["log", "--oneline", `${ref}..HEAD`]),
    runGit(cwd, ["diff", "--stat", `${ref}...HEAD`]),
    runGitRaw(cwd, ["diff", ...DIFF_FLAGS, "--patch", "--minimal", `${ref}...HEAD`]),
  ]);

  return {
    base,
    commits: capText(log.stdout, 12_000),
    stat: capText(stat.stdout, 12_000),
    patch: capText(patch.stdout, 40_000),
  };
}

/** Subjects of the last few commits, newest first; empty before the first commit. */
export async function readRecentSubjects(cwd: string, count = 8) {
  const log = await runGit(cwd, ["log", `-${count}`, "--format=%s"]);
  return log.ok ? log.stdout.split("\n").filter(Boolean) : [];
}

/** Stages everything and commits it; resolves to an error message on failure. */
export async function commitAll(cwd: string, message: string) {
  const text = message.trim();
  if (!text) return "Write a commit message first";

  const add = await runGitLong(cwd, ["add", "-A"]);
  if (!add.ok) return getFirstLines(add.stderr);

  const commit = await runGitLong(cwd, ["commit", "-m", text]);
  return commit.ok ? null : getFirstLines(commit.stderr);
}

/** Pushes the current branch, setting its upstream on the first push; resolves to an error message on failure. */
export async function pushBranch(cwd: string) {
  const status = await readStatus(cwd);
  if (!status) return "Not a git repo";
  if (status.detached) return "Can't push a detached HEAD";
  if (!status.hasRemote) return "No remote to push to";

  let args = ["push"];
  if (!status.upstream) {
    const remotes = (await runGit(cwd, ["remote"])).stdout.split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
    args = ["push", "-u", remote, "HEAD"];
  }

  const result = await runGitLong(cwd, args, 120000);
  return result.ok ? null : getFirstLines(result.stderr);
}

// --- checkpoints -------------------------------------------------------------
// Snapshots of a working tree, taken around each turn so its changes can be shown
// and undone. Written as commits under hidden refs, through a scratch copy of the
// index: the user's staging, branch and history are never touched (t3code does the same).

const CHECKPOINT_REFS = "refs/masscode/checkpoints";

/** Snapshot commits need an author even where git has no identity configured. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "MassCode",
  GIT_AUTHOR_EMAIL: "masscode@localhost",
  GIT_COMMITTER_NAME: "MassCode",
  GIT_COMMITTER_EMAIL: "masscode@localhost",
};

export function getCheckpointRef(threadId: string, messageId: string, when: "start" | "end") {
  return `${CHECKPOINT_REFS}/${threadId}/${messageId}/${when}`;
}

/** Commits the working tree as it is (untracked files included, ignored ones not); null outside a repo. */
async function snapshotWorkingTree(cwd: string, message: string): Promise<string | null> {
  const indexPath = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  if (!indexPath.ok) return null;

  const scratch = join(tmpdir(), `masscode-index-${crypto.randomUUID()}`);
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
}

/** Snapshots the working tree under `ref`; false outside a repo or if it failed. */
export async function captureCheckpoint(cwd: string, ref: string) {
  const commit = await snapshotWorkingTree(cwd, `masscode checkpoint ${ref}`);
  if (!commit) return false;

  return (await runGit(cwd, ["update-ref", ref, commit])).ok;
}

async function hasRef(cwd: string, ref: string) {
  return (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
}

/** Keeps a patch under the size cap, cut at a file boundary so it still parses. */
function capPatch(patch: string) {
  if (patch.length <= MAX_PATCH_BYTES) return { patch, truncated: false };

  const cut = patch.lastIndexOf("\ndiff --git ", MAX_PATCH_BYTES);
  return { patch: cut > 0 ? patch.slice(0, cut + 1) : "", truncated: true };
}

/** The target to compare a turn's start against: its end snapshot, or the working tree if it has none yet. */
async function resolveTurnEnd(cwd: string, threadId: string, messageId: string) {
  const end = getCheckpointRef(threadId, messageId, "end");
  return (await hasRef(cwd, end)) ? end : await snapshotWorkingTree(cwd, "masscode working tree");
}

/** What one turn changed, as a unified patch. */
export async function readCheckpointDiff(cwd: string, threadId: string, messageId: string) {
  const start = getCheckpointRef(threadId, messageId, "start");
  if (!(await hasRef(cwd, start)))
    return { patch: "", truncated: false, error: "No snapshot of this turn" };

  const end = await resolveTurnEnd(cwd, threadId, messageId);
  if (!end) return { patch: "", truncated: false, error: "Couldn't read the working tree" };

  const diff = await runGitRaw(cwd, ["diff", ...DIFF_FLAGS, start, end]);
  if (diff.code !== 0) return { patch: "", truncated: false, error: getFirstLines(diff.stderr) };

  return { ...capPatch(diff.stdout), error: null };
}

/** Files and lines one turn changed; null if it has no snapshots. */
export async function readCheckpointStats(cwd: string, threadId: string, messageId: string) {
  const start = getCheckpointRef(threadId, messageId, "start");
  const end = getCheckpointRef(threadId, messageId, "end");
  const diff = await runGit(cwd, ["diff", "--numstat", "--no-renames", start, end]);
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
}

/**
 * Puts the working tree back to the snapshot taken when `messageId` was sent. What's
 * there now is snapshotted first (under a backup ref), so the restore itself can be undone.
 */
export async function restoreCheckpoint(
  cwd: string,
  threadId: string,
  messageId: string,
): Promise<string | null> {
  const start = getCheckpointRef(threadId, messageId, "start");
  if (!(await hasRef(cwd, start))) return "There's no snapshot of the files from that point";

  const current = await snapshotWorkingTree(cwd, "masscode backup before restore");
  if (!current) return "Couldn't snapshot the current files";

  await runGit(cwd, ["update-ref", `refs/masscode/backups/${threadId}/${Date.now()}`, current]);
  const changed = await runGit(cwd, ["diff", "--name-only", "--no-renames", "-z", start, current]);
  if (!changed.ok) return getFirstLines(changed.stderr);

  const paths = changed.stdout.split("\0").filter(Boolean);
  if (!paths.length) return null;

  const inStart = new Set(
    (await runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", start])).stdout
      .split("\0")
      .filter(Boolean),
  );
  const restore = paths.filter((path) => inStart.has(path));
  // Batches keep the command line short.
  for (let offset = 0; offset < restore.length; offset += 200) {
    const result = await runGitLong(cwd, [
      "restore",
      `--source=${start}`,
      "--worktree",
      "--",
      ...restore.slice(offset, offset + 200),
    ]);
    if (!result.ok) return getFirstLines(result.stderr);
  }

  // Files created since then.
  await Promise.all(
    paths.filter((path) => !inStart.has(path)).map((path) => rm(join(cwd, path), { force: true })),
  );
  return null;
}

/** Whether the turn started by `messageId` has a snapshot to go back to. */
export function hasCheckpoint(cwd: string, threadId: string, messageId: string) {
  return hasRef(cwd, getCheckpointRef(threadId, messageId, "start"));
}

/** Drops every snapshot of a thread, backups included. */
export async function deleteThreadCheckpoints(cwd: string, threadId: string) {
  const refs = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    `${CHECKPOINT_REFS}/${threadId}`,
    `refs/masscode/backups/${threadId}`,
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
}

/** Gives another thread the same snapshots, except those of the given messages' turns. */
export async function copyCheckpoints(
  cwd: string,
  fromThreadId: string,
  toThreadId: string,
  exceptMessageIds: ReadonlyArray<string>,
) {
  const source = `${CHECKPOINT_REFS}/${fromThreadId}`;
  const prefix = `${source}/`;
  const refs = await runGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", source]);
  if (!refs.ok || !refs.stdout) return;

  const except = new Set(exceptMessageIds);
  const updates = refs.stdout.split("\n").flatMap((line) => {
    const [objectId, ref] = line.split(" ");
    if (!objectId || !ref?.startsWith(prefix)) return [];

    const path = ref.slice(prefix.length);
    if (except.has(path.split("/")[0]!)) return [];
    return [`update ${CHECKPOINT_REFS}/${toThreadId}/${path} ${objectId}\n`];
  });
  if (updates.length) await updateRefs(cwd, updates.join(""));
}

async function updateRefs(cwd: string, stdin: string) {
  await acquireGitSlot();
  try {
    await new Promise<void>((resolve) => {
      const child = execFile("git", ["-C", cwd, "update-ref", "--stdin"], { timeout: 10000 }, () =>
        resolve(),
      );
      child.stdin?.end(stdin);
    });
  } finally {
    releaseGitSlot();
  }
}

/** Drops the snapshots of the given messages' turns. */
export async function deleteCheckpoints(
  cwd: string,
  threadId: string,
  messageIds: ReadonlyArray<string>,
) {
  const refs = messageIds.flatMap((id) => [
    getCheckpointRef(threadId, id, "start"),
    getCheckpointRef(threadId, id, "end"),
  ]);
  if (refs.length) await updateRefs(cwd, refs.map((ref) => `delete ${ref}\n`).join(""));
}

// --- worktrees ---------------------------------------------------------------

/** Top of the repo containing `cwd`; null outside one. */
export async function readRepoRoot(cwd: string) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root.ok && root.stdout ? root.stdout : null;
}

/**
 * Adds a worktree at `path` on a new branch `branch`, starting from what's checked out in
 * `cwd`; with `fromOrigin`, from origin's copy of the current branch when it has one.
 * Resolves to an error message on failure.
 */
export async function addWorktree(cwd: string, path: string, branch: string, fromOrigin: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const hasHead = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
  if (!hasHead) return "Worktrees need at least one commit";

  const current = fromOrigin ? await readBranch(cwd) : null;
  const isFetched =
    current !== null && (await runGitLong(cwd, ["fetch", "origin", current], 30000)).ok;
  const result = await runGitLong(cwd, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
    isFetched ? `origin/${current}` : "HEAD",
  ]);
  if (!result.ok) return getFirstLines(result.stderr);

  // What the branch merges into, locally and in pull requests.
  const source = await runGit(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  if (source.ok && source.stdout)
    await runGit(path, ["config", `branch.${branch}.gh-merge-base`, source.stdout]);
  return null;
}

/** Removes a thread's worktree if nothing in it is uncommitted, and its branch once that's merged. True when removed. */
export async function removeWorktreeIfClean(path: string) {
  const [status, commonDir] = await Promise.all([
    readStatus(path),
    runGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (!status || status.changes > 0) return false;
  if (!(await runGitLong(path, ["worktree", "remove", path])).ok) return false;

  // Forced because a squash-merged branch looks unmerged to git.
  if (status.base?.merged && status.branch && commonDir.ok)
    await runGit(commonDir.stdout, ["branch", "-D", status.branch]);
  return true;
}

/** Where `cwd` sits in its repo, like "apps/web"; "" at the top, null outside a repo. */
export async function readRepoFolder(cwd: string) {
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  return prefix.ok ? prefix.stdout.replace(/\/$/, "") : null;
}

/** Clones `url` into folder `folderName` (the repo's own by default) under `parent`; resolves to its path or why it failed. */
export async function cloneRepository(url: string, parent: string, folderName?: string) {
  const name =
    folderName?.trim() ||
    url
      .trim()
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, "");
  if (name && /[/\\]|^\.\.?$/.test(name))
    return { path: null, error: `Can't name a folder ${name}` };
  if (!name) return { path: null, error: "That doesn't look like a repository URL" };

  await mkdir(parent, { recursive: true });
  const path = join(parent, name);
  // Cloned there before (say, from another thread's draft): that copy is the one to use.
  const existing = await readRemoteUrl(path).catch(() => null);
  if (existing && repositoryOf(existing) === repositoryOf(url)) return { path, error: null };

  const result = await execGit(parent, ["clone", "--", url.trim(), path], {
    timeout: 10 * 60 * 1000,
    // A host that never reached this server trusts its key on first sight, like cloning in a
    // terminal and answering yes; a changed key still fails. No prompt can be answered here.
    env: {
      ...NO_PROMPT,
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
  });
  if (!result.error) return { path, error: null };

  if (/permission denied \(publickey|could not read username/i.test(result.stderr)) {
    return {
      path: null,
      error:
        "This machine can't sign in to that repository. Add an SSH key for it here (or sign in to its git host), then retry.",
    };
  }

  return { path: null, error: getFirstLines(result.stderr.trim() || result.stdout.trim()) };
}
