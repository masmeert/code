import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage.ts";

const ThreadSimulator = Schema.Struct({
  open: Schema.Boolean,
  /** The simulator the panel shows; null until one is picked. */
  deviceId: Schema.NullOr(Schema.String),
});

type ThreadSimulator = typeof ThreadSimulator.Type;

const STORAGE_KEY = "masscode.simulator";

const CLOSED: ThreadSimulator = { open: false, deviceId: null };

const ThreadSimulators = Schema.Record(Schema.String, ThreadSimulator);

let threads = readStored(STORAGE_KEY, ThreadSimulators, {});

const listeners = new Set<() => void>();

function updateThread(threadId: string, update: (simulator: ThreadSimulator) => ThreadSimulator) {
  threads = { ...threads, [threadId]: update(threads[threadId] ?? CLOSED) };
  writeStored(STORAGE_KEY, ThreadSimulators, threads);

  for (const listener of listeners) listener();
}

export function useSimulator(threadId: string): ThreadSimulator {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => threads[threadId] ?? CLOSED,
  );
}

export function toggleSimulator(threadId: string) {
  updateThread(threadId, (simulator) => ({ ...simulator, open: !simulator.open }));
}

/** A simulator attached to the thread, by the user or its agent, opens the panel on it. */
export function showDevice(threadId: string, deviceId: string | null) {
  updateThread(threadId, (simulator) => ({ open: deviceId !== null || simulator.open, deviceId }));
}
