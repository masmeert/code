import {
  ClientCommand,
  isTranscriptEvent,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  ServerFrame,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASSET_ROUTE_PREFIX, serveAsset, signImage } from "./assets.ts";
import { listFolders } from "./folders.ts";
import { cloneRepository } from "./git.ts";
import { setPort } from "./port.ts";
import { parseProjectConfig, readProjectConfigText, writeProjectConfig } from "./projectConfig.ts";
import { SessionManager } from "./SessionManager.ts";
import type { BrowserHost } from "./browsers.ts";
import type { TerminalViewer } from "./terminals.ts";

// Browsers don't apply CORS to WebSockets, so any page could connect to localhost.
// Only accept the desktop shell and the Vite dev server.
const ALLOWED_ORIGINS = new Set(["app://masscode", "http://localhost:1420"]);

/**
 * Per-launch secret from the desktop shell (release builds). Origin checks only stop
 * browsers; any local process can claim an origin. Removed from our env so the agents
 * we spawn don't inherit it.
 */
const TOKEN = process.env.MASSCODE_TOKEN || null;
delete process.env.MASSCODE_TOKEN;

/** Browsers can't set headers on a WebSocket, so the token rides in as a subprotocol. */
const TOKEN_PROTOCOL_PREFIX = "masscode.";

/** The subprotocol carrying the right token, if the request offers one. */
function tokenProtocol(request: Request) {
  if (!TOKEN) return null;

  const expected = Buffer.from(TOKEN_PROTOCOL_PREFIX + TOKEN);
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  return (
    offered.find(
      (protocol) =>
        protocol.length === expected.length && timingSafeEqual(Buffer.from(protocol), expected),
    ) ?? null
  );
}

/**
 * A client this far behind (bytes queued in the socket) is dropped rather than buffered
 * without bound; it reconnects and resumes from its cursors. Same idea as t3code's
 * per-subscriber budget.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientCommand));

interface ConnectionData {
  /** The protocol the client says it speaks; null from clients older than the check. */
  protocol: string | null;
  fiber?: Fiber.Fiber<unknown, unknown>;
  /**
   * Threads whose transcript this client follows, each with the publish position its
   * read was taken at: live events up to there are already in what it got.
   */
  threads: Map<string, number>;
  /** Side chats this client asked in, by id, with their thread; they end when it goes. */
  sideChats: Map<string, string>;
  viewer?: TerminalViewer;
  browserHost?: BrowserHost;
}

export function serve(port: number) {
  return Effect.gen(function* () {
    const manager = yield* SessionManager;

    function send(socket: ServerWebSocket<ConnectionData>, frame: ServerFrame) {
      if (socket.readyState !== WebSocket.OPEN) return;

      socket.send(JSON.stringify(frame));
      if (socket.getBufferedAmount() > MAX_BUFFERED_BYTES)
        socket.close(4000, "Too far behind; resume from your cursor");
    }

    function connection(socket: ServerWebSocket<ConnectionData>) {
      return Effect.scoped(
        Effect.gen(function* () {
          const { dataId, settings, projects, providers, threads, terminals, live } =
            yield* manager.subscribe;
          send(
            socket,
            ServerFrame.cases.shell.make({
              dataId,
              settings,
              projects,
              providers,
              threads,
              terminals,
              root: process.getuid?.() === 0,
              protocol: PROTOCOL_VERSION,
            }),
          );
          yield* Stream.runForEach(live, ({ seq, id, event }) =>
            Effect.sync(() => {
              if (isTranscriptEvent(event)) {
                const since = socket.data.threads.get(event.threadId);
                if (since === undefined || seq <= since) return;
              }
              send(socket, ServerFrame.cases.event.make({ id, event }));
            }),
          );
        }),
      );
    }

    /** Transcript subscriptions are per connection, so they're handled here rather than by the manager. */
    function handle(socket: ServerWebSocket<ConnectionData>, command: ClientCommand) {
      return Effect.suspend(() =>
        ClientCommand.matchOrElse(
          command,
          {
            "thread.subscribe": (command) => {
              const read = manager.readThread(command.threadId, command.after, command.turnLimit);
              if (!read) return Effect.void;

              socket.data.threads.set(command.threadId, read.seq);
              send(socket, read.frame);
              return Effect.void;
            },
            search: (command) => {
              send(
                socket,
                ServerFrame.cases["search.results"].make({
                  requestId: command.requestId,
                  hits: manager.search(command.query),
                }),
              );
              return Effect.void;
            },
            "folder.list": ({ path, requestId }) =>
              Effect.promise(async () =>
                send(
                  socket,
                  ServerFrame.cases["folder.entries"].make({
                    requestId,
                    ...(await listFolders(path)),
                  }),
                ),
              ),
            "project.config": ({ path, requestId }) =>
              Effect.promise(async () => {
                const text = await readProjectConfigText(path);
                const config = text === null ? {} : parseProjectConfig(path, text);
                send(
                  socket,
                  ServerFrame.cases["project.config"].make({
                    requestId,
                    config: config instanceof Error ? {} : config,
                    text,
                    error: config instanceof Error ? config.message : null,
                  }),
                );
              }),
            "project.saveConfig": ({ path, config, requestId }) =>
              Effect.promise(async () =>
                send(
                  socket,
                  ServerFrame.cases["project.configSaved"].make({
                    requestId,
                    error: await writeProjectConfig(path, config),
                  }),
                ),
              ),
            "image.sign": ({ path, cwd, requestId }) =>
              Effect.promise(async () =>
                send(
                  socket,
                  ServerFrame.cases["image.signed"].make({
                    requestId,
                    url: await signImage(path, cwd),
                  }),
                ),
              ),
            "project.clone": ({ url, parent, folder, name, requestId }) =>
              Effect.gen(function* () {
                const { path: parentPath } = yield* Effect.promise(() => listFolders(parent));
                const cloned = yield* Effect.promise(() => cloneRepository(url, parentPath, name));
                const path = cloned.path && join(cloned.path, folder ?? "");
                if (path)
                  yield* manager.dispatch(ClientCommand.cases["project.add"].make({ path }));
                send(
                  socket,
                  ServerFrame.cases["project.cloned"].make({
                    requestId,
                    path,
                    error: cloned.error,
                  }),
                );
              }),
            "sideChat.ask": (command) => {
              socket.data.sideChats.set(command.sideChatId, command.threadId);
              socket.data.threads.set(command.sideChatId, 0);
              return manager.dispatch(command);
            },
            "sideChat.close": (command) => {
              socket.data.sideChats.delete(command.sideChatId);
              socket.data.threads.delete(command.sideChatId);
              return manager.dispatch(command);
            },
            "thread.unsubscribe": (command) => {
              socket.data.threads.delete(command.threadId);
              return Effect.void;
            },
            "thread.loadOlder": (command) => {
              const older = manager.readOlder(command.threadId, command.before, command.turnLimit);
              if (older)
                send(
                  socket,
                  ServerFrame.cases["thread.page"].make({ threadId: command.threadId, ...older }),
                );
              return Effect.void;
            },
            "terminal.open": (command) => {
              if (socket.data.viewer)
                manager.terminals.attach(
                  command.threadId,
                  command.terminalId,
                  command.columns,
                  command.rows,
                  socket.data.viewer,
                  command.input,
                );
              return Effect.void;
            },
            "terminal.detach": (command) => {
              if (socket.data.viewer)
                manager.terminals.detach(command.threadId, command.terminalId, socket.data.viewer);
              return Effect.void;
            },
            "terminal.acknowledge": (command) => {
              if (socket.data.viewer)
                manager.terminals.acknowledge(
                  command.threadId,
                  command.terminalId,
                  socket.data.viewer,
                  command.characters,
                );
              return Effect.void;
            },
            "browser.host": () => {
              if (!socket.data.browserHost) {
                socket.data.browserHost = {
                  send: (frame) => send(socket, frame),
                  shows: (threadId) => socket.data.threads.has(threadId),
                };
                manager.browsers.attach(socket.data.browserHost);
              }
              return Effect.void;
            },
            "device.list": ({ requestId, install }) =>
              Effect.promise(async () => {
                const listed = await manager.devices.list(install).then(
                  (listing) => ({ ...listing, error: null }),
                  (error: Error) => ({
                    installed: false,
                    hub: null,
                    devices: [],
                    error: error.message,
                  }),
                );
                send(socket, ServerFrame.cases["device.listed"].make({ requestId, ...listed }));
              }),
            "device.attach": ({ requestId, threadId, deviceId }) =>
              Effect.promise(async () => {
                const error = await manager.devices.attach(threadId, deviceId).then(
                  () => null,
                  (error: Error) => error.message,
                );
                send(socket, ServerFrame.cases["device.attached"].make({ requestId, error }));
              }),
            "browser.respond": (command) => {
              if (socket.data.browserHost)
                manager.browsers.respond(
                  socket.data.browserHost,
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
    }

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve<ConnectionData>({
          hostname: "127.0.0.1",
          port,
          fetch(request, server) {
            const { pathname, searchParams } = new URL(request.url);
            if (pathname === "/mcp" || pathname.startsWith("/mcp/"))
              return manager.mcp.handle(request);
            if (pathname.startsWith(ASSET_ROUTE_PREFIX))
              return serveAsset(pathname.slice(ASSET_ROUTE_PREFIX.length));

            const origin = request.headers.get("origin");
            if (!origin || !ALLOWED_ORIGINS.has(origin))
              return new Response("Forbidden origin", { status: 403 });

            const protocol = tokenProtocol(request);
            if (TOKEN && !protocol) return new Response("Unauthorized", { status: 401 });

            const data: ConnectionData = {
              protocol: searchParams.get("protocol"),
              threads: new Map(),
              sideChats: new Map(),
            };
            // The accepted subprotocol must be echoed back, or the browser drops the connection.
            const upgraded = protocol
              ? server.upgrade(request, { data, headers: { "Sec-WebSocket-Protocol": protocol } })
              : server.upgrade(request, { data });
            if (upgraded) return undefined;
            return new Response("MassCode daemon", { status: 426 });
          },
          websocket: {
            open(socket) {
              // Upgraded before closing: a refused upgrade reaches a browser with no reason attached.
              if (socket.data.protocol !== String(PROTOCOL_VERSION))
                return socket.close(
                  PROTOCOL_MISMATCH,
                  "This app and MassCode on this machine are different versions. Update the older one.",
                );

              socket.data.viewer = { send: (frame) => send(socket, frame) };
              socket.data.fiber = Effect.runFork(connection(socket));
            },
            message(socket, raw) {
              if (socket.data.protocol !== String(PROTOCOL_VERSION)) return;

              Effect.runFork(
                decodeCommand(raw.toString()).pipe(
                  Effect.flatMap((command) => handle(socket, command)),
                  Effect.catch((error) => Effect.logWarning("command failed", error)),
                ),
              );
            },
            close(socket) {
              if (socket.data.viewer) manager.terminals.detachViewer(socket.data.viewer);
              if (socket.data.browserHost) manager.browsers.detach(socket.data.browserHost);
              if (socket.data.fiber) Effect.runFork(Fiber.interrupt(socket.data.fiber));
              for (const [sideChatId, threadId] of socket.data.sideChats)
                Effect.runFork(
                  manager.dispatch(
                    ClientCommand.cases["sideChat.close"].make({ threadId, sideChatId }),
                  ),
                );
            },
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

    // Port 0 lets the OS pick, for remote hosts where another user's daemon may hold ours.
    // SAFETY: a server bound to a TCP hostname always has a port.
    setPort(server.port!);

    const portFile = process.env.MASSCODE_PORT_FILE;
    if (portFile) yield* Effect.promise(() => writeFile(portFile, String(server.port)));

    yield* Effect.logInfo(`MassCode daemon listening on ws://127.0.0.1:${server.port}`);
  });
}
