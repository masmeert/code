/**
 * Compacts idle Claude threads just before their prompt cache expires, so the next message reads a
 * summary rather than the whole conversation uncached. Opt-in, since compacting loses detail.
 * Timers live in memory: ones still waiting when MassCode quits are skipped.
 */
import { RuntimeEvent } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderRegistry } from "../providers/provider-registry.ts";
import type { SettingsStore } from "../storage/settings-store.ts";
import type { Agents } from "./agents.ts";
import { isBusy } from "./entry.ts";
import type { SequencedEvent, ThreadRegistry } from "./registry.ts";

/** Below this, re-reading the conversation uncached is cheap, so compacting would mostly lose context. */
const MIN_CONTEXT_TOKENS = 100_000;

/**
 * When to compact after a turn ends: how long Claude keeps a prompt cached (an hour on
 * subscriptions, five minutes with an API key), less enough time to resume the session and send
 * the compaction while it's still warm.
 */
const COMPACT_AFTER_MS = {
  subscription: 60 * 60_000 - 3 * 60_000,
  apiKey: 5 * 60_000 - 60_000,
};

export function createIdleCompaction({
  runFork,
  settingsStore,
  providerRegistry,
  threads,
  publish,
  compact,
}: Pick<ThreadRegistry, "threads" | "publish"> &
  Pick<Agents, "compact"> & {
    readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
    readonly settingsStore: typeof SettingsStore.Service;
    readonly providerRegistry: typeof ProviderRegistry.Service;
  }) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Compacted since their last message: a compaction is never compacted again. */
  const compacted = new Set<string>();

  function cancel(threadId: string) {
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
  }

  const compactIfIdle = Effect.fn("compactIfIdle")(function* (threadId: string) {
    timers.delete(threadId);
    const entry = threads.get(threadId);
    const tokens = entry?.info.usage?.context?.usedTokens ?? 0;

    if (
      !entry ||
      (yield* settingsStore.get).compactIdleThreads !== true ||
      entry.info.provider !== "claude" ||
      entry.info.archivedAt !== null ||
      isBusy(entry) ||
      compacted.has(threadId) ||
      tokens < MIN_CONTEXT_TOKENS
    )
      return;

    compacted.add(threadId);
    publish(RuntimeEvent.cases["thread.compacted"].make({ threadId, tokens }));
    yield* compact(threadId);
  });

  /** Times the thread's compaction from the end of its latest turn. */
  const schedule = Effect.fn("schedule")(function* (threadId: string) {
    cancel(threadId);
    const entry = threads.get(threadId);

    if (entry?.info.provider !== "claude" || (yield* settingsStore.get).compactIdleThreads !== true)
      return;

    const claude = (yield* providerRegistry.list).find((status) => status.kind === "claude");

    timers.set(
      threadId,
      setTimeout(
        () => runFork(compactIfIdle(threadId).pipe(Effect.ignore)),
        claude?.plan ? COMPACT_AFTER_MS.subscription : COMPACT_AFTER_MS.apiKey,
      ),
    );
  });

  return {
    /** Keeps each thread's timer in step with its turns, for as long as the daemon runs. */
    follow: (events: Stream.Stream<SequencedEvent>) =>
      Stream.runForEach(events, ({ event }) => {
        if (RuntimeEvent.guards["user.message"](event)) {
          cancel(event.threadId);
          compacted.delete(event.threadId);
        } else if (RuntimeEvent.guards["thread.removed"](event)) {
          cancel(event.threadId);
          compacted.delete(event.threadId);
        } else if (RuntimeEvent.guards["turn.completed"](event)) {
          return schedule(event.threadId);
        }

        return Effect.void;
      }),
  };
}
