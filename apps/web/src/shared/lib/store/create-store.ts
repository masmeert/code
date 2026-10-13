import { useSyncExternalStore } from "react";

/** State that components read through `useStore`, and plain code through `getState` and `watch`. */
export function createStore<State>(initial: State) {
  let state = initial;

  const listeners = new Set<() => void>();

  /** Called on every change, frame or not: hidden windows get no animation frames, so no renders. */
  const watchers = new Set<(prev: State, next: State) => void>();

  let isNotifyScheduled = false;

  function notifyListeners() {
    isNotifyScheduled = false;

    for (const listener of listeners) listener();
  }

  function getState() {
    return state;
  }

  function setState(next: State) {
    const prev = state;
    state = next;

    for (const watcher of watchers) watcher(prev, next);

    // Deltas can arrive faster than frames: re-render at most once per frame.
    if (!isNotifyScheduled) {
      isNotifyScheduled = true;
      requestAnimationFrame(notifyListeners);
    }
  }

  function watch(watcher: (prev: State, next: State) => void) {
    watchers.add(watcher);

    return () => watchers.delete(watcher);
  }

  function useStore<A>(select: (state: State) => A): A {
    return useSyncExternalStore(
      (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
      () => select(state),
    );
  }

  return { getState, setState, watch, useStore };
}
