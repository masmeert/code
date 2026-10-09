/** Rewinding a thread to before one of its messages, and forking a new thread from one. */
import { type ClientCommand, fileRestoreBlocker, RuntimeEvent } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { CommandError } from "../errors.ts";
import { copyCheckpoints, deleteCheckpoints, hasCheckpoint, restoreCheckpoint } from "../git.ts";
import { ADAPTERS } from "../harnesses.ts";
import type { SettingsStore } from "../storage/SettingsStore.ts";
import type { Coverage, ThreadStore } from "../storage/ThreadStore.ts";
import type { Agents } from "./agents.ts";
import {
  buildThreadInfo,
  createEntry,
  deriveTitle,
  getForkPoint,
  hasSwitchedHarness,
  isBusy,
} from "./entry.ts";
import type { ThreadRegistry } from "./registry.ts";

export function createHistory({
  store,
  settingsStore,
  threads,
  getEntry,
  publish,
  markUpdated,
  setResumeTokens,
  setCoverage,
  dropSession,
}: Pick<
  ThreadRegistry,
  "threads" | "getEntry" | "publish" | "markUpdated" | "setResumeTokens" | "setCoverage"
> &
  Pick<Agents, "dropSession"> & {
    readonly store: typeof ThreadStore.Service;
    readonly settingsStore: typeof SettingsStore.Service;
  }) {
  /**
   * Rewinds to before a user message: the provider's conversation first (the step that
   * can refuse), then the transcript, then, if asked, the files.
   */
  const rewind = Effect.fn("rewind")(function* (
    command: Extract<ClientCommand, { _tag: "thread.rewind" }>,
  ) {
    const entry = yield* getEntry(command.threadId);
    const { id: threadId, cwd, provider } = entry.info;
    if (isBusy(entry))
      return yield* new CommandError({ message: "Stop the agent before rewinding" });

    const found = store.findUserMessage(threadId, command.messageId);
    if (!found) return yield* new CommandError({ message: "That message is gone" });
    if (found.event.steer)
      return yield* new CommandError({ message: "A message sent mid-turn can't be rewound to" });

    if (command.restoreFiles) {
      const blocker = fileRestoreBlocker(
        entry.info,
        [...threads.values()].map((other) => other.info),
      );
      if (blocker) return yield* new CommandError({ message: blocker });
      if (!(yield* Effect.promise(() => hasCheckpoint(cwd, threadId, command.messageId)))) {
        return yield* new CommandError({
          message: "There's no snapshot of the files from that point",
        });
      }
    }

    yield* dropSession(entry, null);

    const resumeToken = entry.resumeTokens[provider];
    if (hasSwitchedHarness(entry)) {
      // Each harness's own conversation holds only its turns, so none can be cut back to the
      // same point: the next message starts this one afresh, handed what's left of the thread.
      setResumeTokens(entry, {});
      setCoverage(entry, { [provider]: 0 });
    } else if (resumeToken) {
      const token = yield* ADAPTERS[provider].rewind({
        cwd: entry.home.path,
        harness: (yield* settingsStore.get).providers[provider],
        resumeToken,
        ...getForkPoint(found),
        messageId: command.messageId,
      });
      setResumeTokens(entry, token ? { [provider]: token } : {});
    }

    store.truncate(threadId, found.seq);
    publish(RuntimeEvent.cases["thread.rewound"].make({ threadId, messageId: command.messageId }));
    markUpdated(threadId);

    const error = command.restoreFiles
      ? yield* Effect.promise(() => restoreCheckpoint(cwd, threadId, command.messageId))
      : null;
    void deleteCheckpoints(
      cwd,
      threadId,
      found.from.map((message) => message.messageId),
    );
    if (error)
      return yield* new CommandError({
        message: `Rewound the conversation, but couldn't restore the files: ${error}`,
      });
  });

  /**
   * Starts a new thread with the conversation through a message's turn: the provider's copy
   * first (the step that can refuse), then the transcript and file snapshots.
   */
  const fork = Effect.fn("fork")(function* (
    command: Extract<ClientCommand, { _tag: "thread.fork" }>,
  ) {
    const source = yield* getEntry(command.threadId);
    const { cwd, provider } = source.info;
    if (isBusy(source))
      return yield* new CommandError({ message: "Stop the agent before forking" });

    const cut = store.findTurnsAfter(source.info.id, command.messageId);
    if (!cut) return yield* new CommandError({ message: "That message is gone" });

    const sourceToken = source.resumeTokens[provider];
    // A thread that switched harness forks like a rewind: afresh, handed the conversation.
    const resumeToken =
      sourceToken && !hasSwitchedHarness(source)
        ? yield* ADAPTERS[provider].fork({
            cwd: source.home.path,
            harness: (yield* settingsStore.get).providers[provider],
            resumeToken: sourceToken,
            ...getForkPoint(cut),
          })
        : null;

    const info = buildThreadInfo({
      id: crypto.randomUUID(),
      projectId: source.info.projectId,
      provider,
      model: source.info.model,
      cwd,
      title: source.info.title.startsWith("Fork of ")
        ? source.info.title
        : deriveTitle(`Fork of ${source.info.title}`, source.info.title),
      branch: source.info.branch,
      worktree: source.info.worktree,
    });

    const coverage: Coverage = hasSwitchedHarness(source) ? { [provider]: 0 } : {};
    threads.set(
      info.id,
      createEntry(info, source.home, resumeToken ? { [provider]: resumeToken } : {}, coverage),
    );
    store.insertThread(info, source.home);
    store.copyEvents(source.info.id, info.id, cut.seq);
    store.appendEvent(
      info.id,
      RuntimeEvent.cases["thread.forked"].make({
        threadId: info.id,
        fromThreadId: source.info.id,
        fromTitle: source.info.title,
      }),
    );
    if (resumeToken) store.setResumeTokens(info.id, { [provider]: resumeToken });
    store.setCoverage(info.id, coverage);

    publish(
      RuntimeEvent.cases["thread.created"].make({
        thread: info,
        requestId: command.requestId,
        hasTranscript: true,
      }),
    );
    void copyCheckpoints(
      cwd,
      source.info.id,
      info.id,
      cut.from.map((message) => message.messageId),
    );
  });

  return { rewind, fork };
}
