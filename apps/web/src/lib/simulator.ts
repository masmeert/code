import { useSyncExternalStore } from "react";

interface ThreadSimulator {
  readonly open: boolean;
  /** The simulator the panel shows; null until one is picked. */
  readonly deviceId: string | null;
}

const STORAGE_KEY = "masscode.simulator";
const CLOSED: ThreadSimulator = { open: false, deviceId: null };

function readThreads(): Record<string, ThreadSimulator> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

let threads = readThreads();
const listeners = new Set<() => void>();

function updateThread(threadId: string, update: (simulator: ThreadSimulator) => ThreadSimulator) {
  threads = { ...threads, [threadId]: update(threads[threadId] ?? CLOSED) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
  } catch {}
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
