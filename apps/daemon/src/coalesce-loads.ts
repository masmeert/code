import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Semaphore from "effect/Semaphore";

/**
 * Runs `load` for a key one at a time. Calls made while it runs share a single follow-up run,
 * so a burst of refreshes costs at most two, and no caller gets a result that started before
 * it asked. Loads still going when the scope closes are interrupted.
 */
export const coalesceLoads = Effect.fn("coalesceLoads")(function* (
  load: (key: string) => Effect.Effect<void>,
) {
  const runFork = yield* FiberSet.makeRuntime();
  // ponytail: a lock per key ever loaded stays around; prune idle ones if keys ever churn by the thousands.
  const locks = new Map<string, Semaphore.Semaphore>();
  const queued = new Map<string, Deferred.Deferred<void>>();

  return (key: string) =>
    Effect.suspend(() => {
      const waiting = queued.get(key);

      if (waiting) return Deferred.await(waiting);

      let lock = locks.get(key);

      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }

      const run = Deferred.makeUnsafe<void>();
      queued.set(key, run);
      runFork(
        lock
          .withPermit(
            Effect.suspend(() => {
              queued.delete(key);

              return load(key);
            }),
          )
          .pipe(Deferred.into(run)),
      );

      return Deferred.await(run);
    });
});
