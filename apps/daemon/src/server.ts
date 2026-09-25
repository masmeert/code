import { ClientCommand, isTranscriptEvent, ServerFrame } from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { SessionManager } from "./SessionManager.ts";
import type { BrowserHost } from "./browsers.ts";
import type { TerminalViewer } from "./terminals.ts";

// Browsers don't apply CORS to WebSockets, so any page could connect to localhost.
// Only accept the desktop shell and the Vite dev server.
const ALLOWED_ORIGINS = new Set(["app://apcode", "http://localhost:1420"]);

/**
 * Per-launch secret from the desktop shell (release builds). Origin checks only stop
 * browsers; any local process can claim an origin. Removed from our env so the agents
 * we spawn don't inherit it.
 */
const TOKEN = process.env.APCODE_TOKEN || null;
delete process.env.APCODE_TOKEN;
/** Browsers can't set headers on a WebSocket, so the token rides in as a subprotocol. */
const TOKEN_PROTOCOL_PREFIX = "apcode.";

/** The subprotocol carrying the right token, if the request offers one. */
const tokenProtocol = (req: Request) => {
  if (!TOKEN) return null;
  const expected = Buffer.from(TOKEN_PROTOCOL_PREFIX + TOKEN);
  const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  return (
    offered.find(
      (p) => p.length === expected.length && timingSafeEqual(Buffer.from(p), expected),
    ) ?? null
  );
};

/**
 * A client this far behind (bytes queued in the socket) is dropped rather than buffered
 * without bound; it reconnects and resumes from its cursors. Same idea as t3code's
 * per-subscriber budget.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientCommand));

interface ConnectionData {
  fiber?: Fiber.Fiber<unknown, unknown>;
  /**
   * Threads whose transcript this client follows, each with the publish position its
   * read was taken at: live events up to there are already in what it got.
   */
  threads: Map<string, number>;
  viewer?: TerminalViewer;
  browserHost?: BrowserHost;
}

export const serve = (port: number) =>
  Effect.gen(function* () {
    const manager = yield* SessionManager;

    const send = (ws: ServerWebSocket<ConnectionData>, frame: ServerFrame) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(frame));
      if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES)
        ws.close(4000, "Too far behind; resume from your cursor");
    };

    const connection = (ws: ServerWebSocket<ConnectionData>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { dataId, settings, projects, providers, threads, terminals, live } =
            yield* manager.subscribe;
          send(
            ws,
            ServerFrame.cases.shell.make({
              dataId,
              settings,
              projects,
              providers,
              threads,
              terminals,
            }),
          );
          yield* Stream.runForEach(live, ({ seq, id, event }) =>
            Effect.sync(() => {
              if (isTranscriptEvent(event)) {
                const since = ws.data.threads.get(event.threadId);
                if (since === undefined || seq <= since) return;
              }
              send(ws, ServerFrame.cases.event.make({ id, event }));
            }),
          );
        }),
      );

    /** Transcript subscriptions are per connection, so they're handled here rather than by the manager. */
    const handle = (ws: ServerWebSocket<ConnectionData>, command: ClientCommand) =>
      Effect.suspend(() =>
        ClientCommand.matchOrElse(
          command,
          {
            "thread.subscribe": (command) => {
              const read = manager.readThread(command.threadId, command.after, command.turnLimit);
              if (!read) return Effect.void;
              ws.data.threads.set(command.threadId, read.seq);
              send(ws, read.frame);
              return Effect.void;
            },
            search: (command) => {
              send(
                ws,
                ServerFrame.cases["search.results"].make({
                  requestId: command.requestId,
                  hits: manager.search(command.query),
                }),
              );
              return Effect.void;
            },
            "thread.unsubscribe": (command) => {
              ws.data.threads.delete(command.threadId);
              return Effect.void;
            },
            "thread.loadOlder": (command) => {
              const older = manager.readOlder(command.threadId, command.before, command.turnLimit);
              if (older)
                send(
                  ws,
                  ServerFrame.cases["thread.page"].make({ threadId: command.threadId, ...older }),
                );
              return Effect.void;
            },
            "terminal.open": (command) => {
              if (ws.data.viewer)
                manager.terminals.attach(
                  command.threadId,
                  command.terminalId,
                  command.columns,
                  command.rows,
                  ws.data.viewer,
                );
              return Effect.void;
            },
            "terminal.detach": (command) => {
              if (ws.data.viewer)
                manager.terminals.detach(command.threadId, command.terminalId, ws.data.viewer);
              return Effect.void;
            },
            "terminal.acknowledge": (command) => {
              if (ws.data.viewer)
                manager.terminals.acknowledge(
                  command.threadId,
                  command.terminalId,
                  ws.data.viewer,
                  command.characters,
                );
              return Effect.void;
            },
            "browser.host": () => {
              if (!ws.data.browserHost) {
                ws.data.browserHost = {
                  send: (frame) => send(ws, frame),
                  shows: (threadId) => ws.data.threads.has(threadId),
                };
                manager.browsers.attach(ws.data.browserHost);
              }
              return Effect.void;
            },
            "browser.respond": (command) => {
              if (ws.data.browserHost)
                manager.browsers.respond(
                  ws.data.browserHost,
                  command.requestId,
                  command.result,
                  command.error,
                );
              return Effect.void;
            },
          },
          (command) => manager.dispatch(command),
        ),
      );

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve<ConnectionData>({
          hostname: "127.0.0.1",
          port,
          fetch(req, server) {
            if (new URL(req.url).pathname === "/mcp") return manager.mcp.handle(req);
            const origin = req.headers.get("origin");
            if (!origin || !ALLOWED_ORIGINS.has(origin))
              return new Response("Forbidden origin", { status: 403 });
            const protocol = tokenProtocol(req);
            if (TOKEN && !protocol) return new Response("Unauthorized", { status: 401 });
            // The accepted subprotocol must be echoed back, or the browser drops the connection.
            const data: ConnectionData = { threads: new Map() };
            const upgraded = protocol
              ? server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": protocol } })
              : server.upgrade(req, { data });
            if (upgraded) return undefined;
            return new Response("APCode daemon", { status: 426 });
          },
          websocket: {
            open(ws) {
              ws.data.viewer = { send: (frame) => send(ws, frame) };
              ws.data.fiber = Effect.runFork(connection(ws));
            },
            message(ws, raw) {
              Effect.runFork(
                decodeCommand(raw.toString()).pipe(
                  Effect.flatMap((command) => handle(ws, command)),
                  Effect.catch((error) => Effect.logWarning("command failed", error)),
                ),
              );
            },
            close(ws) {
              if (ws.data.viewer) manager.terminals.detachViewer(ws.data.viewer);
              if (ws.data.browserHost) manager.browsers.detach(ws.data.browserHost);
              if (ws.data.fiber) Effect.runFork(Fiber.interrupt(ws.data.fiber));
            },
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

    yield* Effect.logInfo(`APCode daemon listening on ws://127.0.0.1:${server.port}`);
  });
