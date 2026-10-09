/**
 * The threads in memory, and the event stream that keeps clients in step with them: every
 * event published is stored, applied to its thread, and sent to subscribers in order.
 */
import {
  isAwaitingUser,
  isTurnActive,
  RuntimeEvent,
  ServerFrame,
  type LimitStop,
  type QueuedMessage,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { CommandError } from "../errors.ts";
import { readBranch } from "../git.ts";
import type { SettingsStore } from "../storage/SettingsStore.ts";
import {
  type Coverage,
  isPersisted,
  type ResumeTokens,
  type ShelveOverride,
  type ThreadStore,
} from "../storage/ThreadStore.ts";
import { createEntry, deriveTitle, isShelved, type ThreadEntry } from "./entry.ts";

export interface SequencedEvent {
  /** Publish order, in memory only; lets a connection skip what a transcript read already covered. */
  readonly seq: number;
  /** Stored events' id, the clients' resume cursor. */
  readonly id: number | null;
  readonly event: RuntimeEvent;
}

/** A transcript read, taken at publish position `seq`. */
export interface ThreadRead {
  readonly seq: number;
  readonly frame: Extract<ServerFrame, { _tag: "thread.snapshot" | "thread.replay" }>;
}

/** A client further behind than this gets a fresh snapshot instead of a replay. */
const MAX_REPLAY = 2000;

/** Same, by size: a replay this big costs more than the snapshot (t3code's budget is 8MB too). */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/**
 * Streamed text is merged into one delta per message per window before it goes out,
 * instead of a frame (and a client re-render) per token. Any other event flushes first,
 * so order is kept.
 */
const DELTA_FLUSH_MS = 40;

type TextDelta = Extract<RuntimeEvent, { _tag: "assistant.delta" | "reasoning.delta" }>;

const isTextDelta = RuntimeEvent.isAnyOf(["assistant.delta", "reasoning.delta"]);

export type ThreadRegistry = Effect.Success<ReturnType<typeof createThreadRegistry>>;

/** Restores the stored threads; closing the scope stops it from storing or sending anything more. */
export const createThreadRegistry = Effect.fn("createThreadRegistry")(function* ({
  store,
  settingsStore,
  onShelve,
}: {
  readonly store: typeof ThreadStore.Service;
  readonly settingsStore: typeof SettingsStore.Service;
  /** A thread just got shelved: it shouldn't keep its agent or idle terminals around. */
  readonly onShelve: (entry: ThreadEntry) => void;
}) {
  const pubsub = yield* PubSub.unbounded<SequencedEvent>();
  const threads = new Map<string, ThreadEntry>();
  /** Messages and thoughts still streaming, as one delta of all their text so far, keyed by id; dropped once they complete. */
  const streaming = new Map<string, TextDelta>();
  /** Deltas waiting for the next flush, merged per message. */
  const pendingDeltas = new Map<string, TextDelta>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  let latestSettings = yield* settingsStore.get;

  for (const { info, home, resumeTokens, coverage, shelveOverride, queue } of yield* store.load) {
    threads.set(
      info.id,
      createEntry(
        {
          ...info,
          shelved: isShelved(info, shelveOverride, Date.now(), latestSettings),
          ...(queue.length > 0 && { queue }),
        },
        home,
        resumeTokens,
        coverage,
        shelveOverride,
      ),
    );
  }

  /**
   * Set as the daemon goes away: agents still running then mustn't touch its state. Their
   * callbacks run outside any fiber, so closing the scope doesn't stop them.
   */
  let isShuttingDown = false;
  yield* Effect.addFinalizer(() => Effect.sync(() => void (isShuttingDown = true)));

  // Approvals pending when the daemon stopped died with their agent process.
  for (const [requestId, threadId] of store.listUnresolvedApprovals()) {
    store.appendEvent(
      threadId,
      RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }),
    );
  }

  // Threads from before auto-titles are still named after their project folder.
  for (const entry of threads.values()) {
    if (entry.info.title !== basename(entry.info.cwd)) continue;

    const text = store.readFirstUserMessage(entry.info.id);

    if (text === null) continue;

    entry.info = { ...entry.info, title: deriveTitle(text, entry.info.title) };
    store.setMeta(entry.info.id, { title: entry.info.title, updatedAt: entry.info.updatedAt });
  }

  /** Re-reads the branch (a turn may have switched it) and announces the thread's current meta. */
  function refreshMeta(entry: ThreadEntry) {
    const { cwd } = entry.info;
    void readBranch(cwd).then((branch) => {
      if (threads.get(entry.info.id) !== entry || entry.info.cwd !== cwd) return;

      entry.info = { ...entry.info, branch };
      const { id: threadId, title, updatedAt, worktree } = entry.info;
      publish(
        RuntimeEvent.cases["thread.meta"].make({
          threadId,
          title,
          updatedAt,
          branch,
          cwd,
          worktree,
        }),
      );
    });
  }

  function setTitle(entry: ThreadEntry, title: string) {
    entry.info = { ...entry.info, title };
    store.setMeta(entry.info.id, { title, updatedAt: entry.info.updatedAt });
    refreshMeta(entry);
  }

  /** The agent switched into a worktree or back out of one: the thread's folder follows it. */
  async function followAgentCwd(entry: ThreadEntry, reported: string) {
    // The agent may report the home folder with its symlinks resolved.
    const [real, home] = await Promise.all([realpath(reported), realpath(entry.home.path)]).catch(
      () => [reported, entry.home.path],
    );

    const cwd = real === home ? entry.home.path : reported;

    if (cwd === entry.info.cwd || threads.get(entry.info.id) !== entry) return;

    // The turn's start snapshot is of the folder it left, so there's nothing to compare its end with.
    entry.currentTurn = null;
    entry.info = { ...entry.info, cwd, worktree: entry.home.isWorktree || cwd !== entry.home.path };
    store.setAgentCwd(entry.info.id, cwd === entry.home.path ? null : cwd);
    refreshMeta(entry);
  }

  /** Marks activity on a thread: new message or finished turn. */
  function markUpdated(threadId: string) {
    const entry = threads.get(threadId);

    if (!entry) return;

    entry.info = { ...entry.info, updatedAt: Date.now() };
    store.setMeta(threadId, { title: entry.info.title, updatedAt: entry.info.updatedAt });
    refreshMeta(entry);
  }

  function flushDeltas() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (pendingDeltas.size === 0) return;

    const batch = [...pendingDeltas.values()];
    pendingDeltas.clear();

    for (const event of batch) recordAndPublish(event);
  }

  function publish(event: RuntimeEvent) {
    if (isTextDelta(event)) {
      const pending = pendingDeltas.get(event.messageId);
      pendingDeltas.set(
        event.messageId,
        pending ? { ...pending, delta: pending.delta + event.delta } : event,
      );
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);

      return;
    }

    flushDeltas();
    recordAndPublish(event);
  }

  function recordAndPublish(event: RuntimeEvent) {
    if (isShuttingDown) return;

    let id: number | null = null;

    if (isTextDelta(event)) {
      const sent = streaming.get(event.messageId)?.delta ?? "";
      streaming.set(event.messageId, { ...event, delta: sent + event.delta });
    } else if (isPersisted(event)) {
      if (RuntimeEvent.isAnyOf(["assistant.completed", "reasoning.completed"])(event))
        streaming.delete(event.messageId);
      id = store.appendEvent(event.threadId, event);
    }

    const entry = "threadId" in event && event.threadId ? threads.get(event.threadId) : undefined;

    if (entry) {
      if (RuntimeEvent.guards["thread.status"](event)) {
        entry.info = { ...entry.info, status: event.status };

        if (isTurnActive(event.status) && entry.shelveOverride !== null)
          setShelveOverride(entry, null);
      }

      if (RuntimeEvent.guards["thread.usage"](event) && event.usage) {
        entry.info = { ...entry.info, usage: event.usage };
        store.setUsage(entry.info.id, event.usage);
      }

      entry.activeAt = Date.now();
    }

    PubSub.publishUnsafe(pubsub, { seq: ++seq, id, event });

    if (entry) trackLiveState(entry, event);

    if (RuntimeEvent.isAnyOf(["user.message", "turn.completed"])(event))
      markUpdated(event.threadId);

    if (RuntimeEvent.guards["settings.updated"](event)) {
      latestSettings = event.settings;

      for (const other of threads.values()) refreshShelved(other);
    }

    if (entry) refreshShelved(entry);
  }

  /** Keeps the thread's in-flight tool call and pending request current, announcing each change. */
  function trackLiveState(entry: ThreadEntry, event: RuntimeEvent) {
    const threadId = entry.info.id;
    const { activity, request } = entry.info;

    const hasStoppedRunning =
      RuntimeEvent.guards["thread.status"](event) && event.status !== "running";

    const nextActivity = RuntimeEvent.guards["tool.started"](event)
      ? { toolId: event.toolId, tool: event.name, summary: event.summary }
      : hasStoppedRunning ||
          (RuntimeEvent.guards["tool.completed"](event) && event.toolId === activity?.toolId)
        ? undefined
        : activity;

    const nextRequest = RuntimeEvent.guards["approval.requested"](event)
      ? {
          requestId: event.requestId,
          title: event.title,
          detail: event.detail,
          asksQuestions: event.questions !== undefined,
        }
      : (RuntimeEvent.guards["thread.status"](event) && !isAwaitingUser(event.status)) ||
          (RuntimeEvent.guards["approval.resolved"](event) &&
            event.requestId === request?.requestId)
        ? undefined
        : request;

    if (nextActivity === activity && nextRequest === request) return;

    const { activity: _activity, request: _request, ...rest } = entry.info;
    let info: ThreadInfo = rest;

    if (nextActivity) info = { ...info, activity: nextActivity };

    if (nextRequest) info = { ...info, request: nextRequest };
    entry.info = info;

    if (nextActivity !== activity)
      publish(
        RuntimeEvent.cases["thread.activity"].make({ threadId, activity: nextActivity ?? null }),
      );

    if (nextRequest !== request)
      publish(
        RuntimeEvent.cases["thread.request"].make({ threadId, request: nextRequest ?? null }),
      );
  }

  /** Announces the thread's shelved state when it changed. */
  function refreshShelved(entry: ThreadEntry) {
    const shelved = isShelved(entry.info, entry.shelveOverride, Date.now(), latestSettings);

    if (shelved === entry.info.shelved) return;

    entry.info = { ...entry.info, shelved };
    publish(RuntimeEvent.cases["thread.shelved"].make({ threadId: entry.info.id, shelved }));

    if (shelved) onShelve(entry);
  }

  function setShelveOverride(entry: ThreadEntry, override: ShelveOverride) {
    entry.shelveOverride = override;
    store.setShelveOverride(entry.info.id, override);
  }

  for (const entry of threads.values()) refreshMeta(entry);

  const getEntry = Effect.fn("getEntry")(function* (threadId: string) {
    const entry = threads.get(threadId);

    if (!entry) return yield* new CommandError({ message: `No thread ${threadId}` });

    return entry;
  });

  function setResumeTokens(entry: ThreadEntry, tokens: ResumeTokens) {
    entry.resumeTokens = tokens;
    store.setResumeTokens(entry.info.id, tokens);
  }

  function setCoverage(entry: ThreadEntry, coverage: Coverage) {
    entry.coverage = coverage;
    store.setCoverage(entry.info.id, coverage);
  }

  function setQueue(entry: ThreadEntry, queue: ReadonlyArray<QueuedMessage>) {
    const { queue: _queue, ...info } = entry.info;
    entry.info = queue.length > 0 ? { ...info, queue } : info;
    store.setQueue(entry.info.id, queue);
    publish(
      RuntimeEvent.cases["thread.queue"].make({ threadId: entry.info.id, queue: [...queue] }),
    );
  }

  function setLimitStop(entry: ThreadEntry, limitStop: LimitStop | null) {
    const { limitStop: _limitStop, ...info } = entry.info;
    entry.info = limitStop ? { ...info, limitStop } : info;
    store.setLimitStop(entry.info.id, limitStop);
    publish(RuntimeEvent.cases["thread.limitStop"].make({ threadId: entry.info.id, limitStop }));
  }

  /**
   * Reports a failure in a thread's transcript (in none when null), then passes it on: for
   * failures nobody waits on, and commands that start a thread, which name none themselves.
   */
  function reportErrorsIn(threadId: string | null, announce = publish) {
    return <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tapError(effect, (error) =>
        Effect.sync(() =>
          announce(RuntimeEvent.cases.error.make({ threadId, message: error.message })),
        ),
      );
  }

  /** Side chat events go out unstored and unbatched, to the connection that asked. */
  function publishSideChat(event: RuntimeEvent) {
    if (!isShuttingDown) PubSub.publishUnsafe(pubsub, { seq: ++seq, id: null, event });
  }

  /** Applies `settings` and announces them; when they couldn't be saved, fails after. */
  function saveSettings(settings: Settings) {
    return settingsStore
      .update(settings)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => publish(RuntimeEvent.cases["settings.updated"].make({ settings }))),
        ),
      );
  }

  return {
    threads,
    getEntry,
    publish,
    publishSideChat,
    flushDeltas,
    reportErrorsIn,
    refreshMeta,
    setTitle,
    followAgentCwd,
    markUpdated,
    refreshShelved,
    setShelveOverride,
    setResumeTokens,
    setCoverage,
    setQueue,
    setLimitStop,
    saveSettings,
    /** Every event published from here on. */
    subscribe: Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription),
    /** Drops a removed thread's text still streaming or waiting to go out. */
    forgetStreaming: (threadId: string) => {
      for (const [messageId, message] of streaming)
        if (message.threadId === threadId) streaming.delete(messageId);

      for (const [messageId, delta] of pendingDeltas)
        if (delta.threadId === threadId) pendingDeltas.delete(messageId);
    },
    readThread: (threadId: string, after: number | null, turnLimit: number): ThreadRead | null => {
      if (!threads.has(threadId)) return null;

      const live = [...streaming.values()].filter((delta) => delta.threadId === threadId);
      const cursor = store.readCursor(threadId);

      // A cursor past the end means the cache is from another database: start over.
      // Sized before anything is decoded, so a huge gap never gets read.
      if (after !== null && after <= cursor) {
        const { count, bytes } = store.measureAfter(threadId, after);

        if (count <= MAX_REPLAY && bytes <= MAX_REPLAY_BYTES) {
          return {
            seq,
            frame: ServerFrame.cases["thread.replay"].make({
              threadId,
              events: store.readAfter(threadId, after),
              streaming: live,
              cursor,
            }),
          };
        }
      }

      const { events, page } = store.readTurns(threadId, turnLimit);

      return {
        seq,
        frame: ServerFrame.cases["thread.snapshot"].make({
          threadId,
          events,
          streaming: live,
          cursor,
          page,
        }),
      };
    },
    readOlder: (threadId: string, before: number, turnLimit: number) => {
      if (!threads.has(threadId)) return null;

      const { events, page } = store.readTurns(threadId, turnLimit, before);

      return { events, page: page ?? { before, hasMore: false } };
    },
    search: (query: string) => store.search(query, 50).filter((hit) => threads.has(hit.threadId)),
  };
});
