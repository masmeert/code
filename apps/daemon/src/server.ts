import { ClientCommand, type ServerFrame } from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ServerWebSocket } from "bun";
import { SessionManager } from "./SessionManager.ts";

// Browsers don't apply CORS to WebSockets, so any page could connect to localhost.
// Only accept the Tauri webview and the Vite dev server.
const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"]);

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientCommand));

interface ConnectionData {
  fiber?: Fiber.Fiber<unknown, unknown>;
}

export const serve = (port: number) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager;

    const send = (ws: ServerWebSocket<ConnectionData>, frame: ServerFrame) => ws.send(JSON.stringify(frame));

    const connection = (ws: ServerWebSocket<ConnectionData>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, projects, providers, threads, events, live } = yield* manager.subscribe;
          send(ws, { _tag: "snapshot", settings, projects, providers, threads, events });
          yield* Stream.runForEach(live, ({ seq, event }) => Effect.sync(() => send(ws, { _tag: "event", seq, event })));
        }),
      );

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve<ConnectionData>({
          hostname: "127.0.0.1",
          port,
          fetch(req, server) {
            const origin = req.headers.get("origin");
            if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response("Forbidden origin", { status: 403 });
            if (server.upgrade(req, { data: {} })) return undefined;
            return new Response("APCode daemon", { status: 426 });
          },
          websocket: {
            open(ws) {
              ws.data.fiber = Effect.runFork(connection(ws));
            },
            message(_ws, raw) {
              Effect.runFork(
                decodeCommand(typeof raw === "string" ? raw : raw.toString()).pipe(
                  Effect.flatMap(manager.dispatch),
                  Effect.catch((error) => Effect.logWarning("command failed", error)),
                ),
              );
            },
            close(ws) {
              if (ws.data.fiber) Effect.runFork(Fiber.interrupt(ws.data.fiber));
            },
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

    yield* Effect.logInfo(`APCode daemon listening on ws://127.0.0.1:${server.port}`);
  });
