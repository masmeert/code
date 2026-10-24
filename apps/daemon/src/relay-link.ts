import { RelayControl, RelayHello, RelayWelcome } from "@masscode/contracts";
import {
  createChannel,
  createResponderHandshake,
  decodeBase64Url,
  encodeBase64Url,
  hostIdFromSecret,
  hostNoiseKeyPair,
  openEnvelope,
  RELAY_PROLOGUE,
  sealEnvelope,
  signRelayChallenge,
  type Channel,
} from "@masscode/secure-channel";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(RelayControl));

const decodeHello = Schema.decodeUnknownOption(Schema.fromJsonString(RelayHello));

const PING_INTERVAL_MS = 25_000;

/** Pings unanswered this long mean the relay is gone even though the socket hasn't noticed. */
const SILENCE_LIMIT_MS = 60_000;

const MIN_RETRY_MS = 1_000;

const MAX_RETRY_MS = 30_000;

/** What the relay closes a host with when the key doesn't match its id. */
const UNPROVEN = 4401;

/** One phone's open session, as the server sees it: a socket that happens to be encrypted. */
export interface RelaySession {
  readonly isOpen: () => boolean;
  readonly bufferedBytes: () => number;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface RelaySessionHandlers {
  onText(text: string): void;
  onClose(): void;
}

/** What the server decides about a phone from its hello and the key its handshake proved. */
export interface Admission {
  readonly welcome: RelayWelcome;
  /** For an `accepted` welcome: wires the session up, returning where its frames go. */
  readonly start?: (session: RelaySession) => RelaySessionHandlers;
}

type ChannelState =
  | { readonly stage: "handshake" }
  | { readonly stage: "admitting" }
  | {
      readonly stage: "open";
      readonly channel: Channel;
      /** Null only while the server wires the session up, which may already send through it. */
      handlers: RelaySessionHandlers | null;
    };

/**
 * This daemon's connection out to the relay, so phones reach it from anywhere. It proves the host
 * id, then answers each phone's Noise handshake and carries its session; the relay only ever sees
 * ciphertext. It reconnects with backoff until stopped.
 */
export function startRelayLink(options: {
  readonly relayUrl: string;
  readonly hostSecret: Uint8Array;
  readonly admit: (hello: RelayHello | null, publicKey: string) => Promise<Admission>;
  readonly onStatus: (relay: "connecting" | "connected", error: string | null) => void;
}) {
  const hostId = hostIdFromSecret(options.hostSecret);
  const noiseKeyPair = hostNoiseKeyPair(options.hostSecret);
  const channels = new Map<number, ChannelState>();
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryMs = MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function sendTo(channelId: number, payload: Uint8Array) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(sealEnvelope(channelId, payload));
  }

  /** Forgets a phone's channel, telling its session it ended if it had one. */
  function forget(channelId: number) {
    const state = channels.get(channelId);
    channels.delete(channelId);

    if (state?.stage === "open") state.handlers?.onClose();
  }

  /** Ends a phone's channel from this side, asking the relay to drop its socket. */
  function closeChannel(channelId: number) {
    forget(channelId);

    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(RelayControl.cases.close.make({ channel: channelId })));
  }

  function forgetAllChannels() {
    for (const channelId of channels.keys()) forget(channelId);
  }

  async function answerHandshake(channelId: number, message: Uint8Array) {
    channels.set(channelId, { stage: "admitting" });

    const handshake = createResponderHandshake({
      staticKeyPair: noiseKeyPair,
      prologue: RELAY_PROLOGUE,
    });

    const { payload, remoteStaticPublicKey } = handshake.readFirstMessage(message);
    const hello = Option.getOrNull(decodeHello(new TextDecoder().decode(payload)));
    const admission = await options.admit(hello, encodeBase64Url(remoteStaticPublicKey));

    // The phone may have gone, or the link moved to a new socket, while the server decided.
    if (channels.get(channelId)?.stage !== "admitting") return;

    const reply = handshake.writeSecondMessage(
      new TextEncoder().encode(JSON.stringify(admission.welcome)),
    );

    sendTo(channelId, reply.message);

    if (!admission.start || !RelayWelcome.guards.accepted(admission.welcome))
      return closeChannel(channelId);

    const state: ChannelState = {
      stage: "open",
      channel: createChannel(reply.session),
      handlers: null,
    };

    const { channel } = state;

    const session: RelaySession = {
      isOpen: () => channels.get(channelId) === state && socket?.readyState === WebSocket.OPEN,
      bufferedBytes: () => socket?.bufferedAmount ?? 0,
      send(text) {
        if (!session.isOpen()) return;

        for (const sealed of channel.sealText(text)) sendTo(channelId, sealed);
      },
      close(code, reason) {
        if (!session.isOpen()) return;

        sendTo(channelId, channel.sealClose(code, reason));
        closeChannel(channelId);
      },
    };

    channels.set(channelId, state);
    state.handlers = admission.start(session);
  }

  function receivePhoneBytes(channelId: number, message: Uint8Array) {
    const state = channels.get(channelId);

    if (state?.stage === "handshake") {
      answerHandshake(channelId, message).catch(() => closeChannel(channelId));

      return;
    }

    if (state?.stage !== "open") return closeChannel(channelId);

    try {
      const opened = state.channel.open(message);

      if (opened?.type === "text") state.handlers?.onText(opened.text);
      else if (opened?.type === "close") closeChannel(channelId);
    } catch {
      // A message that doesn't open was tampered with or lost; the session can't go on.
      closeChannel(channelId);
    }
  }

  function receiveControl(control: RelayControl) {
    RelayControl.match(control, {
      challenge: ({ nonce }) => {
        const nonceBytes = decodeBase64Url(nonce);

        if (!nonceBytes) return;

        socket?.send(
          JSON.stringify(
            RelayControl.cases.proof.make({
              signature: signRelayChallenge(options.hostSecret, nonceBytes),
            }),
          ),
        );
      },
      proof: () => {},
      ready: () => {
        retryMs = MIN_RETRY_MS;
        options.onStatus("connected", null);
      },
      open: ({ channel }) => {
        channels.set(channel, { stage: "handshake" });
      },
      close: ({ channel }) => forget(channel),
    });
  }

  function connect() {
    retryTimer = null;

    if (stopped) return;

    const current = new WebSocket(`${options.relayUrl}/hosts/${hostId}?role=host`);
    current.binaryType = "arraybuffer";
    socket = current;
    let lastHeardAt = Date.now();

    current.addEventListener("open", () => {
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeardAt > SILENCE_LIMIT_MS) return current.close();

        current.send("ping");
      }, PING_INTERVAL_MS);
    });

    current.addEventListener("message", (event) => {
      lastHeardAt = Date.now();

      if (event.data instanceof ArrayBuffer) {
        const envelope = openEnvelope(new Uint8Array(event.data));

        if (envelope) receivePhoneBytes(envelope.channel, envelope.payload);

        return;
      }

      if (event.data === "pong") return;

      const control = Option.getOrNull(decodeControl(event.data));

      if (control) receiveControl(control);
    });

    current.addEventListener("close", (event) => {
      if (socket !== current) return;

      socket = null;

      if (pingTimer) clearInterval(pingTimer);

      forgetAllChannels();

      if (stopped) return;

      options.onStatus(
        "connecting",
        event.code === UNPROVEN
          ? "The relay turned this computer's key away. Restart MassCode; if it keeps happening, update it."
          : `Can't reach the relay at ${options.relayUrl}. Check this computer's internet connection; MassCode keeps retrying.`,
      );
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  }

  options.onStatus("connecting", null);
  connect();

  return {
    stop() {
      stopped = true;

      if (retryTimer) clearTimeout(retryTimer);

      if (pingTimer) clearInterval(pingTimer);

      forgetAllChannels();
      socket?.close();
      socket = null;
    },
  };
}

export type RelayLink = ReturnType<typeof startRelayLink>;
