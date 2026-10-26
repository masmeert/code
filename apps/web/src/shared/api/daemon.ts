import {
  ClientCommand,
  DEFAULT_DAEMON_PORT,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  ServerFrame,
  UNPAIRED,
} from "@masscode/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** One daemon's WebSocket, reconnected for as long as its host is in the app. */
interface Connection {
  /** Null for this Mac. */
  readonly host: string | null;
  socket: WebSocket | null;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Commands sent while it's down (the UI is up from cache by then). */
  readonly queued: Array<ClientCommand>;
  isRemoved: boolean;
}

type ReplyFrame = Extract<ServerFrame, { requestId: string }>;

const connections = new Map<string | null, Connection>();

const frameListeners = new Set<(frame: ServerFrame, host: string | null) => void>();

const closeListeners = new Set<(host: string | null) => void>();

const incompatibleListeners = new Set<(host: string | null) => void>();

const unpairedListeners = new Set<(host: string) => void>();

let findCommandHost: (command: ClientCommand) => string | null = () => null;

/** Frames that answer a request carrying a `requestId`; they go to whoever sent it, not to `onFrame`. */
const REPLY_TAGS = new Set<ServerFrame["_tag"]>([
  "search.results",
  "folder.entries",
  "project.config",
  "project.configSaved",
  "image.signed",
  "project.cloned",
  "device.listed",
  "device.attached",
  "keepAwake.apps",
  "service.killed",
  "pairing.started",
  "thread.createFailed",
]);

/** Answers to requests carrying a `requestId`, by that id. */
const replies = new Map<string, (frame: ServerFrame) => void>();

function isReply(frame: ServerFrame): frame is ReplyFrame {
  return REPLY_TAGS.has(frame._tag);
}

function resolveReply(frame: ReplyFrame) {
  replies.get(frame.requestId)?.(frame);
  replies.delete(frame.requestId);
}

/** Every frame a daemon sends, but replies, with the host it came from (null: this Mac). */
export function onFrame(listener: (frame: ServerFrame, host: string | null) => void) {
  frameListeners.add(listener);

  return () => frameListeners.delete(listener);
}

/** A host's socket closed; it's retried unless the host was removed. */
export function onDisconnect(listener: (host: string | null) => void) {
  closeListeners.add(listener);

  return () => closeListeners.delete(listener);
}

/** A host's daemon runs another version of MassCode. */
/** A paired machine refused this app's token: it was unpaired there. */
export function onUnpaired(listener: (host: string) => void) {
  unpairedListeners.add(listener);

  return () => unpairedListeners.delete(listener);
}

export function onIncompatible(listener: (host: string | null) => void) {
  incompatibleListeners.add(listener);

  return () => incompatibleListeners.delete(listener);
}

/** Decides which host a command goes to when `send` isn't told. */
export function routeCommandsWith(findHost: (command: ClientCommand) => string | null) {
  findCommandHost = findHost;
}

function findOpenSocket(host: string | null) {
  const socket = connections.get(host)?.socket;

  return socket?.readyState === WebSocket.OPEN ? socket : null;
}

export function isConnectionOpen(host: string | null) {
  return findOpenSocket(host) !== null;
}

/** The open socket's address as http, the base of the host's signed file URLs; null while it's down. */
export function getConnectionHttpUrl(host: string | null) {
  return findOpenSocket(host)?.url.replace(/^ws/, "http") ?? null;
}

/** Hosts with a connection, up or not: this Mac (null) and the remote hosts in the app. */
export function listDaemonHosts() {
  return [...connections.keys()];
}

export function hasConnection(host: string | null) {
  return connections.has(host);
}

function notifyIncompatible(host: string | null) {
  for (const listener of incompatibleListeners) listener(host);
}

/**
 * Waits between reconnect attempts, growing while the daemon stays away. Starts short:
 * at launch the sidecar is still booting. Reset once a connection gets its shell.
 */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

/** Each attempt at a remote host runs ssh, so those back off further. */
const REMOTE_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

function scheduleReconnect(connection: Connection) {
  const delays = connection.host === null ? RETRY_DELAYS_MS : REMOTE_RETRY_DELAYS_MS;
  connection.retry = setTimeout(
    () => {
      connection.retry = null;
      void connect(connection);
    },
    delays[Math.min(connection.attempt++, delays.length - 1)],
  );
}

const decodeServerFrame = Schema.decodeUnknownResult(Schema.fromJsonString(ServerFrame));

function receiveFrame(connection: Connection, frame: ServerFrame) {
  if (isReply(frame)) return resolveReply(frame);

  if (ServerFrame.guards.shell(frame)) {
    // A daemon older than the check doesn't say, and may not understand what this window sends.
    if (frame.protocol !== PROTOCOL_VERSION) {
      notifyIncompatible(connection.host);
      connection.socket?.close();

      return;
    }

    connection.attempt = 0;
  }

  for (const listener of frameListeners) listener(frame, connection.host);
}

async function connect(connection: Connection) {
  const { host } = connection;

  // Asked on every attempt: a daemon that restarts (or updates, on a remote host) comes back on a new port.
  const daemon =
    host === null
      ? ((await window.desktop?.daemon()) ?? null)
      : ((await window.desktop?.hostDaemon(host)) ?? null);

  if (connection.isRemoved) return;

  if (host !== null && !daemon) return scheduleReconnect(connection);

  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon?.port ?? DEFAULT_DAEMON_PORT}/?protocol=${PROTOCOL_VERSION}`,
    daemon ? [`masscode.${daemon.token}`] : undefined,
  );

  connection.socket = socket;
  socket.onopen = () => {
    if (window.desktop) send(ClientCommand.cases["browser.host"].make({}), host);

    for (const command of connection.queued.splice(0)) send(command, host);
  };

  socket.onmessage = (message) => {
    const decoded = decodeServerFrame(message.data);

    if (Result.isSuccess(decoded)) receiveFrame(connection, decoded.success);
    else
      console.error(
        "Dropped a frame from the daemon that this window can't read:",
        decoded.failure,
      );
  };

  socket.onclose = (event) => {
    if (connection.socket !== socket) return;

    connection.socket = null;

    if (event.code === PROTOCOL_MISMATCH) notifyIncompatible(host);

    if (event.code === UNPAIRED && host !== null)
      for (const listener of unpairedListeners) listener(host);

    for (const listener of closeListeners) listener(host);

    if (!connection.isRemoved) scheduleReconnect(connection);
  };
}

export function connectTo(host: string | null) {
  const connection: Connection = {
    host,
    socket: null,
    attempt: 0,
    retry: null,
    queued: [],
    isRemoved: false,
  };

  connections.set(host, connection);
  void connect(connection);
}

export function disconnectFrom(host: string) {
  const connection = connections.get(host);

  if (!connection) return;

  connection.isRemoved = true;

  if (connection.retry) clearTimeout(connection.retry);
  connection.socket?.close();
  connections.delete(host);
}

/**
 * Skips the rest of the backoff, for a host that's back (say, restarted on the new version) or
 * when the user asks to retry; later retries start short again.
 */
export function reconnectNow(host: string | null) {
  const connection = connections.get(host);

  if (!connection?.retry) return;

  clearTimeout(connection.retry);
  connection.retry = null;
  connection.attempt = 0;
  void connect(connection);
}

/**
 * Whether `send` would hold this command until its host reconnects, so a caller can show the
 * action as pending rather than done.
 */
export function willQueue(command: ClientCommand, host = findCommandHost(command)) {
  return connections.has(host) && !findOpenSocket(host);
}

/** Sends to the daemon the command is for, or to `host`'s; held while that one is down. */
export function send(command: ClientCommand, host = findCommandHost(command)) {
  const connection = connections.get(host);

  if (!connection) return;

  const socket = findOpenSocket(host);

  if (socket) socket.send(JSON.stringify(command));
  else connection.queued.push(command);
}

export function sendIfConnected(command: ClientCommand) {
  findOpenSocket(findCommandHost(command))?.send(JSON.stringify(command));
}

/**
 * Sends a command the daemon answers with a `replyTag` frame carrying the same id; null when the
 * host is down or never answers.
 */
export function sendRequest<const ReplyTag extends ReplyFrame["_tag"]>(
  host: string | null,
  command: Extract<ClientCommand, { requestId: string }>,
  replyTag: ReplyTag,
  timeoutMs: number,
) {
  return new Promise<Extract<ServerFrame, { _tag: ReplyTag }> | null>((resolve) => {
    const socket = findOpenSocket(host);

    if (!socket) return resolve(null);

    replies.set(command.requestId, (frame) =>
      resolve(ServerFrame.isAnyOf([replyTag])(frame) ? frame : null),
    );
    socket.send(JSON.stringify(command));
    setTimeout(() => {
      if (replies.delete(command.requestId)) resolve(null);
    }, timeoutMs);
  });
}
