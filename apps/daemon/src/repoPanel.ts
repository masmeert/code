/**
 * The source control panel: a repo's status, branches and diff, announced as events, and the
 * git actions run from it (commit, push, pull requests, merges).
 */
import {
  RuntimeEvent,
  type GitAction,
  type MergeMethod,
  type PullRequest,
  type RepoStatus,
  type SourceControlKind,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { coalesceLoads } from "./coalesceLoads.ts";
import { getErrorMessage } from "./errors.ts";
import {
  commitAll,
  fastForwardDefaultBranch,
  listBranches,
  mergeIntoBase,
  pushBranch,
  readDiff,
  readPullRequestRange,
  readRecentSubjects,
  readRemoteUrl,
  readRepoRoot,
  readStatus,
} from "./git.ts";
import { buildWriterInput } from "./harnesses.ts";
import {
  detectSourceControl,
  mergePullRequest,
  openPullRequest,
  probeSourceControl,
  readPullRequest,
  readPullRequestTemplate,
} from "./sourceControl.ts";
import type { SettingsStore } from "./storage/SettingsStore.ts";
import type { ThreadEntry } from "./threads/entry.ts";
import { generateCommitMessage, generatePullRequest } from "./writer.ts";

// Asking the host means a network call, so answers are kept a while (t3code keeps them 60 s).
const PULL_REQUEST_TTL_MS = 60_000;

// At most one fetch per repo this often, however many windows ask (t3code fetches every 30 s).
const AUTO_PULL_INTERVAL_MS = 30_000;

export const createRepoPanel = Effect.fn("createRepoPanel")(function* ({
  settingsStore,
  publish,
  threads,
  refreshMeta,
}: {
  readonly settingsStore: typeof SettingsStore.Service;
  readonly publish: (event: RuntimeEvent) => void;
  readonly threads: ReadonlyMap<string, ThreadEntry>;
  /** Re-reads a thread's branch and announces its meta. */
  readonly refreshMeta: (entry: ThreadEntry) => void;
}) {
  const hosts = new Map<string, Promise<SourceControlKind | null>>();
  const pullRequests = new Map<string, { at: number; pr: Promise<PullRequest | null> }>();
  const pulledAt = new Map<string, number>();
  /** Commits and pushes on one repo run one at a time. */
  const gitLocks = new Map<string, Semaphore.Semaphore>();

  /** Announces the branches at `path`; `error` reports a failed checkout alongside them. */
  function publishBranches(path: string, error: string | null = null) {
    return Effect.promise(() => listBranches(path)).pipe(
      Effect.map(({ current, branches }) =>
        publish(RuntimeEvent.cases["git.branches"].make({ path, current, branches, error })),
      ),
    );
  }

  /** The repo state at `path`, with its host and the branch's pull request. */
  async function readRepo(path: string): Promise<RepoStatus | null> {
    const status = await readStatus(path);

    if (!status) return null;

    const url = await readRemoteUrl(path);
    let host = hosts.get(url ?? "");

    if (!host) {
      host = detectSourceControl(url);
      hosts.set(url ?? "", host);
    }

    const sourceControl = await host;

    const key = `${path}\0${status.branch}`;
    let cached = pullRequests.get(key);

    if (
      sourceControl &&
      status.branch &&
      (!cached || Date.now() - cached.at > PULL_REQUEST_TTL_MS)
    ) {
      cached = { at: Date.now(), pr: readPullRequest(path, sourceControl, status.branch) };
      pullRequests.set(key, cached);
    }

    return { ...status, sourceControl, pullRequest: (sourceControl && (await cached?.pr)) || null };
  }

  function forgetPullRequest(path: string) {
    for (const key of pullRequests.keys())
      if (key.startsWith(`${path}\0`)) pullRequests.delete(key);
  }

  /** Announces the repo state at `path`; `action`/`error` report the git action it answers. */
  function publishStatus(
    path: string,
    action: GitAction | null = null,
    error: string | null = null,
  ) {
    return Effect.promise(() => readRepo(path)).pipe(
      Effect.map((status) =>
        publish(RuntimeEvent.cases["git.status"].make({ path, status, action, error })),
      ),
    );
  }

  function publishDiff(path: string) {
    return Effect.map(
      Effect.promise(() => readDiff(path)),
      (diff) => publish(RuntimeEvent.cases["git.diff"].make({ path, ...diff })),
    );
  }

  // Plain refreshes (every window, every finished tool call) coalesce per repo.
  const refreshStatus = yield* coalesceLoads(
    Effect.fn("refreshStatus")(function* (path: string) {
      const { autoPull } = yield* settingsStore.get;

      if (autoPull && Date.now() - (pulledAt.get(path) ?? 0) > AUTO_PULL_INTERVAL_MS) {
        pulledAt.set(path, Date.now());
        yield* Effect.promise(() => fastForwardDefaultBranch(path));
      }

      yield* publishStatus(path);
    }),
  );

  const refreshDiff = yield* coalesceLoads(publishDiff);

  /** A message for everything uncommitted at `path`, from the commit model in settings. */
  const writeCommitMessage = Effect.fn("writeCommitMessage")(function* (path: string) {
    const settings = yield* settingsStore.get;

    const [diff, recent] = yield* Effect.promise(() =>
      Promise.all([readDiff(path), readRecentSubjects(path, 20)]),
    );

    if (diff.error) return { error: diff.error };

    if (!diff.patch) return { error: "Nothing to commit" };

    return yield* Effect.tryPromise({
      try: () =>
        generateCommitMessage({ ...buildWriterInput(path, settings, recent), patch: diff.patch }),
      catch: (error) => `Couldn't write a commit message: ${getErrorMessage(error)}`,
    }).pipe(
      Effect.map((message) => ({ message })),
      Effect.catch((error) => Effect.succeed({ error })),
    );
  });

  /**
   * Pushes the branch if the host doesn't have all of it, writes the title and body with the
   * commit model, and opens the pull request. Resolves to an error message on failure.
   */
  const submitPullRequest = Effect.fn("submitPullRequest")(function* (path: string) {
    const status = yield* Effect.promise(() => readRepo(path));

    if (!status?.sourceControl) return "This repo's remote isn't on GitHub or GitLab";

    if (!status.branch) return "Check out a branch first";

    if (status.branch === status.defaultBranch)
      return `You're on ${status.branch}; create a branch for the pull request first`;

    if (status.changes) return "Commit your changes before opening a pull request";

    const isOpen = status.pullRequest?.state === "open" || status.pullRequest?.state === "draft";

    if (isOpen) return `#${status.pullRequest.number} is already open for this branch`;

    const { sourceControl, branch } = status;

    if (!status.upstream || status.ahead) {
      const pushed = yield* Effect.promise(() => pushBranch(path));

      if (pushed) return pushed;
    }

    const settings = yield* settingsStore.get;

    const [range, recent, root] = yield* Effect.promise(() =>
      Promise.all([
        readPullRequestRange(path, branch),
        readRecentSubjects(path, 20),
        readRepoRoot(path),
      ]),
    );

    if (!range) return "Couldn't find the branch to open the pull request against";

    if (!range.commits) return `This branch has no commits that ${range.base} doesn't have`;

    // t3code only follows templates on GitHub; GitLab keeps its own in .gitlab/.
    const template =
      settings.followTemplates !== false && sourceControl === "github" && root
        ? yield* Effect.promise(() => readPullRequestTemplate(root))
        : null;

    const text = yield* Effect.tryPromise({
      try: () =>
        generatePullRequest({
          ...buildWriterInput(path, settings, recent),
          ...range,
          head: branch,
          template,
        }),
      catch: (error) => `Couldn't write the pull request: ${getErrorMessage(error)}`,
    }).pipe(Effect.result);

    if (Result.isFailure(text)) return text.failure;

    return yield* Effect.promise(() =>
      openPullRequest(path, sourceControl, { base: range.base, head: branch, ...text.success }),
    );
  });

  /** Merges the branch's open pull request on its host. Resolves to an error message on failure. */
  async function mergeOpenPullRequest(path: string, method: MergeMethod) {
    const status = await readRepo(path);
    const sourceControl = status?.sourceControl;
    const pullRequest = status?.pullRequest;

    if (
      !sourceControl ||
      !pullRequest ||
      (pullRequest.state !== "open" && pullRequest.state !== "draft")
    )
      return "This branch has no open pull request";

    return mergePullRequest(path, sourceControl, pullRequest.number, method);
  }

  function withRepoLock<A, E>(path: string, effect: Effect.Effect<A, E>) {
    let lock = gitLocks.get(path);

    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      gitLocks.set(path, lock);
    }

    return lock.withPermit(effect);
  }

  /** Runs a git action on the repo at `path`, one at a time, and announces the repo state after it. */
  const runGitAction = Effect.fn("runGitAction")(
    function* (path: string, action: GitAction, run: Effect.Effect<string | null>) {
      const error = yield* run;
      yield* publishStatus(path, action, error);
    },
    (effect, path) => withRepoLock(path, effect),
  );

  /** Commits everything at `path`, with `message` or one the commit model writes, and pushes if asked. */
  function commit(path: string, message: string, push: boolean) {
    const action: GitAction = push ? "commit-push" : "commit";

    return withRepoLock(
      path,
      Effect.gen(function* () {
        const written = message.trim() ? { message } : yield* writeCommitMessage(path);

        let error =
          "error" in written
            ? written.error
            : yield* Effect.promise(() => commitAll(path, written.message));

        if (!error && push) error = yield* Effect.promise(() => pushBranch(path));

        yield* publishStatus(path, action, error);
        yield* publishDiff(path);
      }),
    );
  }

  /** Announces the branches after `run` switched or created one, and the meta of threads in `path`. */
  const changeBranch = Effect.fn("changeBranch")(function* (
    path: string,
    run: () => Promise<string | null>,
  ) {
    const error = yield* Effect.promise(run);
    yield* publishBranches(path, error);

    for (const entry of threads.values()) if (entry.info.cwd === path) refreshMeta(entry);
  });

  return {
    publishBranches,
    refreshStatus,
    refreshDiff,
    changeBranch,
    commit,
    push: (path: string) =>
      runGitAction(
        path,
        "push",
        Effect.promise(() => pushBranch(path)),
      ),
    createPullRequest: (path: string) =>
      runGitAction(
        path,
        "pull-request",
        submitPullRequest(path).pipe(Effect.ensuring(Effect.sync(() => forgetPullRequest(path)))),
      ),
    mergePullRequest: (path: string, method: MergeMethod) =>
      runGitAction(
        path,
        "merge",
        Effect.promise(() => mergeOpenPullRequest(path, method)).pipe(
          Effect.ensuring(Effect.sync(() => forgetPullRequest(path))),
        ),
      ),
    mergeIntoBase: (path: string) =>
      runGitAction(
        path,
        "merge-into-base",
        Effect.promise(() => mergeIntoBase(path)),
      ),
    /** Forgets which host each remote is on, and announces what the source control CLIs can reach. */
    refreshSourceControl: Effect.promise(async () => {
      hosts.clear();
      publish(
        RuntimeEvent.cases["sourceControl.updated"].make({
          statuses: await probeSourceControl(),
        }),
      );
    }),
  };
});
