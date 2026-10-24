import * as Schema from "effect/Schema";
import { PairingGrant, PairingRequest } from "./phones.ts";

/** Where hosts and phones meet when they can't reach each other directly; `MASSCODE_RELAY_URL` overrides it. */
export const DEFAULT_RELAY_URL = "wss://relay.masscode.dev";

/** The relay closes a phone's socket with this when its host isn't connected. */
export const HOST_OFFLINE = 4503;

const RelayChannel = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }));

/** JSON text between the relay and a host; phone traffic travels as binary envelopes beside it. */
export const RelayControl = Schema.TaggedUnion({
  /** Relay → host, first thing on connect: sign this to prove you own the host id. */
  challenge: { nonce: Schema.String },
  /** Host → relay. */
  proof: { signature: Schema.String },
  /** Relay → host: the proof checked out; phones can reach you now. */
  ready: {},
  /** Relay → host: a phone connected on this channel. */
  open: { channel: RelayChannel },
  /** Either way: this phone's connection is gone, or should be. */
  close: { channel: RelayChannel },
});

export type RelayControl = typeof RelayControl.Type;

/** What a phone puts in its first Noise message, encrypted to the host's key. */
export const RelayHello = Schema.TaggedUnion({
  /** A paired phone, known by its key, opening a session. */
  connect: { protocol: Schema.Number },
  /** A new phone redeeming the code it scanned; the handshake proves its key. */
  pair: { protocol: Schema.Number, request: PairingRequest },
});

export type RelayHello = typeof RelayHello.Type;

/** What the host answers in its Noise reply. Anything but `accepted` ends the channel. */
export const RelayWelcome = Schema.TaggedUnion({
  /** The session is open; frames follow as on a direct socket. */
  accepted: {},
  paired: { grant: PairingGrant },
  /** Turned away with a close code like `UNPAIRED` or `PROTOCOL_MISMATCH`, and why. */
  refused: { code: Schema.Number, reason: Schema.String },
});

export type RelayWelcome = typeof RelayWelcome.Type;
