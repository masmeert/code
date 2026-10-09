import "./shellEnv.ts"; // must stay first: fixes process.env before other modules read it
import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as ProviderRegistryLive from "./providers/ProviderRegistry.ts";
import * as SessionManagerLive from "./SessionManager.ts";
import { PORT } from "./port.ts";
import { SessionManager } from "./SessionManager.ts";
import { serve } from "./server.ts";

/** Whether process `pid` is still running. */
function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: process.kill only throws system errors, which carry an errno code.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const program = Effect.gen(function* () {
  const manager = yield* SessionManager;
  yield* Effect.addFinalizer(() => manager.shutdown);
  yield* serve(PORT);

  // An update on a remote host waits for running turns: the app asks with SIGUSR2, and the
  // host's supervisor loop starts the new version once we're gone.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.callback<void>((resume) => {
        process.on("SIGUSR2", () => resume(Effect.void));
      });

      yield* Effect.repeat(Effect.sleep("2 seconds"), { while: () => manager.hasActiveTurns() });
      process.kill(process.pid, "SIGTERM");
    }),
  );

  // A crashed or force-quit parent never kills us, and an orphan would keep running agents.
  // A remote host's daemon is detached on purpose: its agents work on with the laptop shut.
  if (!process.env.MASSCODE_DETACHED) {
    const parentPid = process.ppid;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.repeat(Effect.sleep("5 seconds"), { while: () => isProcessAlive(parentPid) });
        process.kill(process.pid, "SIGTERM");
      }),
    );
  }

  return yield* Effect.never;
});

program.pipe(
  Effect.scoped,
  Effect.provide(SessionManagerLive.composeLayer(ProviderRegistryLive.layer)),
  BunRuntime.runMain,
);
