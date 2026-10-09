import * as Schema from "effect/Schema";

export const MergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeMethod = typeof MergeMethod.Type;

/**
 * The repo a git remote URL points to, as `owner/repo`, however it's written:
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, `ssh://git@host:22/owner/repo`.
 * The host is left out: one server is often reached by different names, like a LAN and a public one.
 */
export function repositoryOf(url: string) {
  const match = url
    .trim()
    .match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+(?::\d+)?[/:](.+?)(?:\.git)?\/*$/i);
  return match?.[1] ?? url.trim();
}

export const GitAction = Schema.Literals([
  "commit",
  "commit-push",
  "push",
  "pull-request",
  "merge",
  "merge-into-base",
]);
export type GitAction = typeof GitAction.Type;

/** Hosts we can open pull requests on, through their CLIs (gh, glab). */
export const SourceControlKind = Schema.Literals(["github", "gitlab"]);
export type SourceControlKind = typeof SourceControlKind.Type;

/** What the daemon knows about one host's CLI on this machine. */
export const SourceControlStatus = Schema.Struct({
  kind: SourceControlKind,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** Null when sign-in couldn't be checked. */
  authenticated: Schema.NullOr(Schema.Boolean),
  account: Schema.NullOr(Schema.String),
  /** Why it can't be used yet, and how to fix it. */
  detail: Schema.NullOr(Schema.String),
});
export type SourceControlStatus = typeof SourceControlStatus.Type;

/** The pull request (merge request on GitLab) for a branch. */
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  base: Schema.String,
});
export type PullRequest = typeof PullRequest.Type;

/** In a linked worktree, the local branch its branch merges into. */
const BaseBranch = Schema.Struct({
  branch: Schema.String,
  /** Commits on the worktree's branch that the base doesn't have. */
  ahead: Schema.Number,
  /** All of the branch's work is in the base already, squash and rebase merges included. */
  merged: Schema.Boolean,
  /** Files a merge into the base would conflict in. */
  conflicts: Schema.Array(Schema.String),
  /** The checkout that has the base out, whose files a merge updates; null when none does. */
  checkout: Schema.NullOr(Schema.String),
});

export const RepoStatus = Schema.Struct({
  /** Changed files, untracked included. */
  changes: Schema.Number,
  /** Null when detached. */
  branch: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
  /** Commits on the branch that the default branch doesn't have. */
  aheadOfDefault: Schema.Number,
  /** Host of the main remote, when it's one pull requests can be opened on. */
  sourceControl: Schema.NullOr(SourceControlKind),
  /** The branch's open pull request, else its latest one. */
  pullRequest: Schema.NullOr(PullRequest),
  upstream: Schema.NullOr(Schema.String),
  /** Commits not on the upstream yet; with no upstream, every commit on the branch. */
  ahead: Schema.Number,
  behind: Schema.Number,
  hasRemote: Schema.Boolean,
  detached: Schema.Boolean,
  /** Null outside a linked worktree. */
  base: Schema.NullOr(BaseBranch),
});
export type RepoStatus = typeof RepoStatus.Type;
