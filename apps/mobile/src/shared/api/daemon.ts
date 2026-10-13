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

/** Where a host's daemon listens, and the token it gave this phone. */
export interface DaemonAddress {
  readonly id: string;
  readonly address: string;
  readonly dnsName?: string | null;
  readonly port: number;
  readonly token: string;
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
  let attempt = 0;

  const socket = new ReconnectingWebSocket(
    // The MagicDNS name survives the host's address changing; the address works without MagicDNS
    // on this phone. Retries take turns between them.
    () =>
      `ws://${host.dnsName && attempt++ % 2 === 0 ? host.dnsName : host.address}:${host.port}/?protocol=${PROTOCOL_VERSION}`,
    [`masscode.${host.token}`],
    { minReconnectionDelay: 500, maxReconnectionDelay: 30_000 },
  );

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

/** The host's daemon over HTTP, at the address its open socket reached; null while it isn't open. */
export function getHttpOrigin(hostId: string) {
  const socket = sockets.get(hostId);

  return socket && socket.readyState === socket.OPEN ? socket.url.replace(/^ws/, "http") : null;
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
