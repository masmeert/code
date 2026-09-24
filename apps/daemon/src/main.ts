import { BunRuntime } from "@effect/platform-bun";
import { DEFAULT_DAEMON_PORT } from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistryLive from "./providers/ProviderRegistry.ts";
import * as SessionManagerLive from "./SessionManager.ts";
import { SessionManager } from "./SessionManager.ts";
import { serve } from "./server.ts";
import * as ProjectsStoreLive from "./storage/ProjectsStore.ts";
import * as SettingsStoreLive from "./storage/SettingsStore.ts";
import * as ThreadStoreLive from "./storage/ThreadStore.ts";

const port = Number(process.env.APCODE_PORT ?? DEFAULT_DAEMON_PORT);

const program = Effect.gen(function* () {
  const manager = yield* SessionManager;
  yield* Effect.addFinalizer(() => manager.shutdown);
  yield* serve(port);
  return yield* Effect.never;
});

const MainLive = SessionManagerLive.layer.pipe(
  Layer.provide(
    Layer.mergeAll(SettingsStoreLive.layer, ProjectsStoreLive.layer, ThreadStoreLive.layer, ProviderRegistryLive.layer),
  ),
);

program.pipe(Effect.scoped, Effect.provide(MainLive), BunRuntime.runMain);
