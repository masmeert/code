/**
 * Threads watching a GitHub pull request: new reviews and comments from others, and checks starting
 * to fail, come to the thread's agent as a message. Merging or closing the pull request ends the
 * watch and shelves the thread, its work being done.
 */
import { MessageSender } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { CommandError } from "../errors.ts";
import { readRemoteUrl } from "../git.ts";
import { clip } from "../handoff.ts";
import {
  detectSourceControl,
  type PullRequestActivity,
  readGitHubLogin,
  readPullRequestActivity,
} from "../source-control.ts";
import type { Agents } from "./agents.ts";
import type { ThreadEntry } from "./entry.ts";
import type { ThreadRegistry } from "./registry.ts";

/** Checks take minutes, and every machine on the account shares gh's rate limit. */
export const PULL_REQUEST_POLL_MS = 2 * 60_000;

export type PullRequestWatch = ReturnType<typeof createPullRequestWatch>;

export function createPullRequestWatch({
  threads,
  reportErrorsIn,
  refreshShelved,
  setShelveOverride,
  setPullRequestWatch,
  send,
}: Pick<
  ThreadRegistry,
  "threads" | "reportErrorsIn" | "refreshShelved" | "setShelveOverride" | "setPullRequestWatch"
> &
  Pick<Agents, "send">) {
  /** Who gh is signed in as: the agent posts as them, so their own posts aren't news. */
  let login: Promise<string | null> | null = null;

  function readActivity(target: string, cwd: string) {
    return Effect.promise(() => readPullRequestActivity(target, cwd));
  }

  /** What's new on the pull request since the agent last heard, as a message for it; null when nothing is. */
  function describeNews(
    entry: ThreadEntry,
    activity: PullRequestActivity,
    self: string | null,
  ): string | null {
    const watch = entry.pullRequestWatch!;

    const posts = activity.posts.filter(
      (post) =>
        post.at > watch.seenAt && post.author !== self && (post.body || post.verb !== "commented"),
    );

    const isFailingNow = activity.checks === "failing" && watch.checks !== "failing";

    if (posts.length === 0 && !isFailingNow) return null;

    const lines = [
      ...posts.map(
        (post) => `- ${post.author} ${post.verb}${post.body ? `: ${clip(post.body, 2000)}` : ""}`,
      ),
      ...(isFailingNow ? [`- Checks failing: ${activity.failingChecks.join(", ")}`] : []),
    ];

    return `Pull request #${activity.number} ("${activity.title}") has news:\n\n${lines.join("\n")}\n\nDeal with what needs it; pushing to its branch updates the pull request. \`gh pr view ${activity.number} --comments\` shows the whole discussion (inline review comments are under \`gh api repos/{owner}/{repo}/pulls/${activity.number}/comments\`), and \`gh pr checks ${activity.number}\` the checks.`;
  }

  /** Reads the thread's pull request and passes on what's new; ends the watch once it's merged or closed. */
  const checkThread = Effect.fn("checkThread")(function* (entry: ThreadEntry) {
    const watch = entry.pullRequestWatch;

    if (!watch || entry.info.archivedAt !== null) return;

    const read = yield* readActivity(watch.url, entry.info.cwd);

    // gh failing now (offline, signed out) is retried on the next pass.
    if (Result.isFailure(read) || entry.pullRequestWatch !== watch) return;

    const activity = read.success;

    if (activity.state === "merged" || activity.state === "closed") {
      setPullRequestWatch(entry, null);
      setShelveOverride(entry, "shelved");
      refreshShelved(entry);

      return;
    }

    login ??= readGitHubLogin();
    const news = describeNews(entry, activity, yield* Effect.promise(() => login!));

    setPullRequestWatch(entry, {
      ...watch,
      title: activity.title,
      seenAt: Math.max(watch.seenAt, ...activity.posts.map((post) => post.at)),
      checks: activity.checks,
    });

    if (!news) return;

    const { effort, fast, permission } = entry.turnSettings ?? { effort: null, permission: "ask" };

    yield* send(
      entry,
      news,
      { effort, fast, permission, attachments: [] },
      {
        queue: true,
        from: MessageSender.cases.pullRequest.make({ number: activity.number, url: activity.url }),
      },
    ).pipe(reportErrorsIn(entry.info.id), Effect.ignore);
  });

  /**
   * Starts the thread watching `target` (a pull request URL or number), or its branch's pull
   * request when null; what's there already isn't news.
   */
  const watch = Effect.fn("watch")(function* (entry: ThreadEntry, target: string | null) {
    const { cwd, branch } = entry.info;
    const host = yield* Effect.promise(async () => detectSourceControl(await readRemoteUrl(cwd)));

    if (host !== "github")
      return yield* new CommandError({
        message:
          host === "gitlab"
            ? "Watching works with GitHub pull requests only, not GitLab merge requests."
            : "The thread's repo isn't on GitHub, so there's no pull request to watch.",
      });

    if (!target && !branch)
      return yield* new CommandError({
        message: "The thread's folder isn't on a branch. Pass the pull request's URL or number.",
      });

    const read = yield* readActivity(target ?? branch!, cwd);

    if (Result.isFailure(read))
      return yield* new CommandError({
        message: `Couldn't read the pull request: ${read.failure}`,
      });

    const activity = read.success;

    if (activity.state === "merged" || activity.state === "closed")
      return yield* new CommandError({
        message: `#${activity.number} is already ${activity.state}, so there's nothing to watch.`,
      });

    setPullRequestWatch(entry, {
      number: activity.number,
      url: activity.url,
      title: activity.title,
      seenAt: Math.max(0, ...activity.posts.map((post) => post.at)),
      checks: activity.checks,
    });

    return activity;
  });

  return {
    watch,
    unwatch: (entry: ThreadEntry) => setPullRequestWatch(entry, null),
    /** One pass over every watching thread, one at a time to go easy on the rate limit. */
    checkAll: Effect.suspend(() =>
      Effect.forEach(
        [...threads.values()].filter((entry) => entry.pullRequestWatch),
        (entry) => checkThread(entry),
        { discard: true },
      ),
    ),
  };
}
