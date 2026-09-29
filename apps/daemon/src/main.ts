import "./shellEnv.ts"; // must stay first: fixes process.env before other modules read it
import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistryLive from "./providers/ProviderRegistry.ts";
import * as SessionManagerLive from "./SessionManager.ts";
import { PORT } from "./port.ts";
import { SessionManager } from "./SessionManager.ts";
import { serve } from "./server.ts";
import * as ProjectsStoreLive from "./storage/ProjectsStore.ts";
import * as SettingsStoreLive from "./storage/SettingsStore.ts";
import * as ThreadStoreLive from "./storage/ThreadStore.ts";

const program = Effect.gen(function* () {
  const manager = yield* SessionManager;
  yield* Effect.addFinalizer(() => manager.shutdown);
  yield* serve(PORT);
  // An update on a remote host waits for running turns: the app asks with SIGUSR2, and the
  // host's supervisor loop starts the new version once we're gone.
  let draining = false;
  process.on("SIGUSR2", () => {
    if (draining) return;
    draining = true;
    const drain = setInterval(() => {
      if (manager.busy()) return;
      clearInterval(drain);
      process.kill(process.pid, "SIGTERM");
    }, 2000);
  });
  return yield* Effect.never;
});

const MainLive = SessionManagerLive.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ProjectsStoreLive.layer, ThreadStoreLive.layer, ProviderRegistryLive.layer),
  ),
  Layer.provideMerge(SettingsStoreLive.layer),
);

// A crashed or force-quit parent never kills us, and an orphan would keep running agents.
// A remote host's daemon is detached on purpose: its agents work on with the laptop shut.
if (!process.env.APCODE_DETACHED) {
  const parentPid = process.ppid;
  const parentWatch = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      // SAFETY: process.kill only throws system errors, which carry an errno code.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      clearInterval(parentWatch);
      process.kill(process.pid, "SIGTERM");
    }
  }, 5000);
  parentWatch.unref();
}

program.pipe(Effect.scoped, Effect.provide(MainLive), BunRuntime.runMain);
