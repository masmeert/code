import {
  ClientCommand,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  RuntimeEvent,
  ServerFrame,
  UNPAIRED,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import ReconnectingWebSocket from "partysocket/ws";
import { RELAY_URL_PREFIX, RelaySocket, type RelayRoute } from "./relay-socket.ts";

/** How to reach a host's daemon: directly on its Tailscale address, through the relay, or both. */
export interface DaemonAddress {
  readonly id: string;
  /** Its Tailscale address; absent for a host paired through the relay alone. */
  readonly address?: string | null;
  readonly dnsName?: string | null;
  readonly port?: number;
  readonly token: string;
  /** Absent for pairings from before the relay. */
  readonly relay?: RelayRoute | null;
}

/** Why a host's socket closed: unreachable for now, unpaired, or a version the other doesn't understand. */
export type ConnectionLoss = "offline" | "unpaired" | "outdated";

interface PendingRequest {
  readonly hostId: string;
  readonly onReply: (frame: ServerFrame) => void;
  readonly onLost: () => void;
}

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame));

const sockets = new Map<string, ReconnectingWebSocket>();

/** Each host's relay route, by host id, for the relay socket partysocket opens by URL. */
const relayRoutes = new Map<string, RelayRoute>();

/**
 * A socket that hasn't opened by now is given up on: an unreachable Tailscale address hangs
 * rather than failing, and the relay should get its turn quickly.
 */
const CONNECT_TIMEOUT_MS = 4_000;

/**
 * What partysocket constructs for each attempt: a plain WebSocket for a direct URL, the relay
 * socket for a relay one. Constructed with `new`, so the object it returns is the socket.
 */
function createSocket(url: string, protocols?: string | string[]) {
  const route = url.startsWith(RELAY_URL_PREFIX)
    ? relayRoutes.get(url.slice(RELAY_URL_PREFIX.length))
    : undefined;

  return route ? new RelaySocket(route) : new WebSocket(url, protocols);
}

/** The URLs to try for a host, in order: direct ones first, since they're quicker, then the relay. */
function listRoutes(host: DaemonAddress) {
  const direct =
    host.address && host.port
      ? [
          // The MagicDNS name survives the host's address changing; the address works without
          // MagicDNS on this phone.
          ...(host.dnsName ? [host.dnsName] : []),
          host.address,
        ].map((name) => `ws://${name}:${host.port}/?protocol=${PROTOCOL_VERSION}`)
      : [];

  return host.relay ? [...direct, `${RELAY_URL_PREFIX}${host.relay.hostId}`] : direct;
}

// One handler each, not a list: Fast Refresh re-runs the module that sets them, which then
// replaces its old handler instead of adding a second one.
let receiveFrame: (hostId: string, frame: ServerFrame) => void = () => {};

let receiveConnectionLoss: (hostId: string, loss: ConnectionLoss) => void = () => {};

/** Requests this phone sent a host, by request id, until the host answers. */
const pendingRequests = new Map<string, PendingRequest>();

/** Hands every frame any host sends to `handler`. */
export function routeFramesTo(handler: (hostId: string, frame: ServerFrame) => void) {
  receiveFrame = handler;
}

/** Tells `handler` when a host's current socket closes, and why. */
export function routeConnectionLossTo(handler: (hostId: string, loss: ConnectionLoss) => void) {
  receiveConnectionLoss = handler;
}

/** The request a frame answers: replies echo its id, as does the thread a `thread.create` started. */
function getAnsweredRequestId(frame: ServerFrame) {
  if (ServerFrame.guards.event(frame))
    return RuntimeEvent.guards["thread.created"](frame.event) ? frame.event.requestId : null;

  return "requestId" in frame ? frame.requestId : null;
}

function settleRequest(requestId: string, settle: (pending: PendingRequest) => void) {
  const pending = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);

  if (pending) settle(pending);
}

export function connect(host: DaemonAddress) {
  const routes = listRoutes(host);
  // Retries take turns between the routes, starting from the one that last worked.
  let preferred = 0;
  let tries = 0;

  if (host.relay) relayRoutes.set(host.relay.hostId, host.relay);

  const socket = new ReconnectingWebSocket(
    () => routes[(preferred + tries++) % routes.length] ?? "",
    [`masscode.${host.token}`],
    {
      minReconnectionDelay: 500,
      maxReconnectionDelay: 30_000,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      WebSocket: createSocket,
    },
  );

  socket.addEventListener("open", () => {
    preferred = Math.max(0, routes.indexOf(socket.url));
    tries = 0;
  });

  socket.addEventListener("message", (message) => {
    try {
      const frame = decodeFrame(String(message.data));

      receiveFrame(host.id, frame);

      const requestId = getAnsweredRequestId(frame);

      if (requestId !== null) settleRequest(requestId, ({ onReply }) => onReply(frame));
    } catch {
      // A frame this version can't read; the next shell says whether the versions match.
    }
  });

  socket.addEventListener("close", (event) => {
    const loss: ConnectionLoss =
      event.code === UNPAIRED
        ? "unpaired"
        : event.code === PROTOCOL_MISMATCH
          ? "outdated"
          : "offline";

    // A socket turned off or replaced closes late, when the host's state is no longer its own.
    if (sockets.get(host.id) === socket) receiveConnectionLoss(host.id, loss);

    for (const [requestId, pending] of pendingRequests)
      if (pending.hostId === host.id) settleRequest(requestId, ({ onLost }) => onLost());

    // Retrying can't fix these; only pairing again or updating can.
    if (loss !== "offline") socket.close();
  });

  sockets.set(host.id, socket);
}

/** Closes the host's socket for good, keeping it as the host's until another replaces it. */
export function closeConnection(hostId: string) {
  sockets.get(hostId)?.close();
}

/** Closes the host's socket and forgets it, so its late close no longer speaks for the host. */
export function disconnect(hostId: string) {
  sockets.get(hostId)?.close();
  sockets.delete(hostId);
}

export function hasConnection(hostId: string) {
  return sockets.has(hostId);
}

/** Tries the host now, without waiting out the backoff. */
export function reconnect(hostId: string) {
  sockets.get(hostId)?.reconnect();
}

/** The host's daemon over HTTP, at the address its open socket reached; null while it isn't open, or open through the relay. */
export function getHttpOrigin(hostId: string) {
  const socket = sockets.get(hostId);

  return socket && socket.readyState === socket.OPEN && socket.url.startsWith("ws")
    ? socket.url.replace(/^ws/, "http")
    : null;
}

/** Whether the host's open socket goes through the relay, where nothing loads over HTTP. */
export function isThroughRelay(hostId: string) {
  const socket = sockets.get(hostId);

  return (
    socket !== undefined &&
    socket.readyState === socket.OPEN &&
    socket.url.startsWith(RELAY_URL_PREFIX)
  );
}

export function send(hostId: string, command: ClientCommand) {
  const socket = sockets.get(hostId);

  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(command));
}

/**
 * Sends the command `build` makes for a fresh request id; `onReply` gets the host's answer, and
 * `onLost` runs instead when the connection closes first. Call what it returns to stop waiting.
 */
export function request(
  hostId: string,
  build: (requestId: string) => ClientCommand,
  onReply: (frame: ServerFrame) => void,
  onLost: () => void,
) {
  const requestId = crypto.randomUUID();
  pendingRequests.set(requestId, { hostId, onReply, onLost });
  send(hostId, build(requestId));

  return () => pendingRequests.delete(requestId);
}
