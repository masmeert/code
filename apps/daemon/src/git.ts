import { execFile } from "node:child_process";

/** Branch checked out in `cwd` (also before the first commit); the short commit when detached, null outside a repo. */
export const readBranch = (cwd: string) =>
  new Promise<string | null>((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 }, (error, stdout) => {
      const ref = stdout.trim();
      if (error || !ref) {
        // No commits yet: HEAD names a branch that doesn't exist.
        execFile("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], { timeout: 2000 }, (e, name) => resolve(e ? null : name.trim() || null));
        return;
      }
      if (ref !== "HEAD") return resolve(ref);
      execFile("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { timeout: 2000 }, (e, sha) => resolve(e ? null : sha.trim() || null));
    });
  });

const git = (cwd: string, args: ReadonlyArray<string>, timeout = 5000) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() || (error?.message ?? "") }),
    );
  });

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
  if (!name || name.startsWith("-") || !(await git(cwd, ["check-ref-format", "--branch", name])).ok) {
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

const gitRaw = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10000, maxBuffer: MAX_PATCH_BYTES * 2 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
        stdout,
        stderr: stderr.trim() || (error?.message ?? ""),
      }),
    );
  });

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/** Uncommitted changes in `cwd` vs HEAD, untracked files included, as one unified patch. */
export const readDiff = async (cwd: string): Promise<{ patch: string; truncated: boolean; error: string | null }> => {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { patch: "", truncated: false, error: "Not a git repo" };
  const hasHead = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;

  const tracked = await gitRaw(cwd, ["diff", ...DIFF_FLAGS, hasHead ? "HEAD" : EMPTY_TREE]);
  if (tracked.code !== 0) return { patch: "", truncated: false, error: firstLines(tracked.stderr) };

  const others = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = others.ok ? others.stdout.split("\0").filter(Boolean) : [];
  let patch = tracked.stdout;
  let truncated = untracked.length > MAX_UNTRACKED;
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    if (patch.length > MAX_PATCH_BYTES) {
      truncated = true;
      break;
    }
    // --no-index exits 1 when the files differ, which is always the case here.
    const added = await gitRaw(cwd, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file]);
    if (added.code === 0 || added.code === 1) patch += added.stdout;
  }
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

const gitLong = (cwd: string, args: ReadonlyArray<string>, timeout = 60000) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() || stdout.trim() || (error?.message ?? "") }),
    );
  });

export interface RepoStatus {
  /** Changed files, untracked included. */
  readonly changes: number;
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
  let oid: string | null = null;
  for (const line of status.stdout.split("\n")) {
    if (!line) continue;
    if (!line.startsWith("#")) {
      changes++;
      continue;
    }
    const [, key, ...rest] = line.split(" ");
    if (key === "branch.head") detached = rest[0] === "(detached)";
    else if (key === "branch.oid") oid = rest[0] === "(initial)" ? null : (rest[0] ?? null);
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
  return { changes, upstream, ahead, behind, hasRemote: remotes.ok && remotes.stdout.length > 0, detached };
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
