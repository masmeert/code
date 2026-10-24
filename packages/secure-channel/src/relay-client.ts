import { createChannel, type Channel } from "./channel.ts";
import { hostNoisePublicKey } from "./identity.ts";
import { createInitiatorHandshake, type KeyPair } from "./noise.ts";

/** Both ends of a relay channel start Noise with this, so a handshake can't be replayed into another protocol. */
export const RELAY_PROLOGUE = new TextEncoder().encode("masscode-relay:v1");

/** A close the phone gives itself when the host breaks the protocol, since no close code came with it. */
const PROTOCOL_ERROR = 1002;

/**
 * A phone's session with a host through the relay. The first message carries `hello`, encrypted
 * to the host's key; `welcome` resolves with the host's answer. Text frames then flow both ways,
 * encrypted end to end. `onClose` fires once, with the host's close code when it sent one, else
 * the relay's.
 */
export function connectThroughRelay(options: {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly keyPair: KeyPair;
  readonly hello: string;
  readonly onText: (text: string) => void;
  readonly onClose: (code: number, reason: string) => void;
}) {
  const socket = new WebSocket(`${options.relayUrl}/hosts/${options.hostId}?role=phone`);
  socket.binaryType = "arraybuffer";

  const handshake = createInitiatorHandshake({
    staticKeyPair: options.keyPair,
    remoteStaticPublicKey: hostNoisePublicKey(options.hostId),
    prologue: RELAY_PROLOGUE,
  });

  let resolveWelcome: (payload: string) => void = () => {};
  let rejectWelcome: (error: Error) => void = () => {};

  // Not `Promise.withResolvers`, which Hermes lacks.
  const welcome = new Promise<string>((resolve, reject) => {
    resolveWelcome = resolve;
    rejectWelcome = reject;
  });

  let channel: Channel | null = null;
  let closed = false;

  // A rejection nobody awaits would crash Hermes and Bun alike; `onClose` reports it too.
  welcome.catch(() => {});

  function finish(code: number, reason: string) {
    if (closed) return;

    closed = true;
    rejectWelcome(new Error(reason || `Closed with ${code}`));

    try {
      socket.close(code >= 3000 || code === 1000 ? code : 1000, reason.slice(0, 120));
    } catch {
      // Already closing.
    }

    options.onClose(code, reason);
  }

  socket.addEventListener("open", () => {
    socket.send(handshake.writeFirstMessage(new TextEncoder().encode(options.hello)));
  });

  socket.addEventListener("message", (event) => {
    if (closed) return;

    if (typeof event.data === "string") return finish(PROTOCOL_ERROR, "The relay sent text");

    const message = new Uint8Array(event.data);

    try {
      if (!channel) {
        const reply = handshake.readSecondMessage(message);
        channel = createChannel(reply.session);
        resolveWelcome(new TextDecoder().decode(reply.payload));

        return;
      }

      const opened = channel.open(message);

      if (opened?.type === "text") options.onText(opened.text);
      else if (opened?.type === "close") finish(opened.code, opened.reason);
    } catch {
      finish(PROTOCOL_ERROR, "The connection to your computer was tampered with or broke");
    }
  });

  socket.addEventListener("close", (event) => finish(event.code, event.reason));

  return {
    welcome,
    /** Dropped unless the session is open, as a WebSocket that isn't open would. */
    send(text: string) {
      if (closed || !channel || socket.readyState !== WebSocket.OPEN) return;

      for (const message of channel.sealText(text)) socket.send(message);
    },
    close(code = 1000, reason = "") {
      finish(code, reason);
    },
  };
}
