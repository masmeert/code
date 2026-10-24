import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DevicePlatform } from "./devices.ts";

/** A phone paired with this daemon, reaching it directly with a token of its own, or through the relay with its key. */
export const PairedPhone = Schema.Struct({
  id: Schema.String,
  /** What the phone calls itself, like "Massimo's iPhone". */
  name: Schema.String,
  platform: DevicePlatform,
  pairedAt: Schema.Number,
  /** When it last connected; null (missing in the daemon's TOML) until its first connection after pairing. */
  lastSeenAt: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});

export type PairedPhone = typeof PairedPhone.Type;

/** What the desktop shows as a QR code for a phone to pair with, valid once until `expiresAt`. */
export const PairingOffer = Schema.Struct({
  /** `masscode://pair?…` carrying the rest, for the QR code. */
  url: Schema.String,
  /** The daemon's Tailscale address; null when Tailscale isn't up, so phones pair through the relay. */
  host: Schema.NullOr(Schema.String),
  /** Its MagicDNS name, which stays when the address changes; null without MagicDNS. */
  dnsName: Schema.NullOr(Schema.String),
  port: Schema.Number,
  code: Schema.String,
  /** This machine's name, so the phone can tell its hosts apart. */
  name: Schema.String,
  expiresAt: Schema.Number,
  /** The daemon's public key, base64url: how the relay routes to it and the key phones pin. */
  hostId: Schema.String,
  /** The relay's WebSocket URL. */
  relayUrl: Schema.String,
});

export type PairingOffer = typeof PairingOffer.Type;

/** What a phone posts to `/pair`, or opens a relay channel with, carrying the code from the offer. */
export const PairingRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  platform: DevicePlatform,
  /**
   * The phone's X25519 key for this host, base64url, so it can come through the relay later. Over
   * the relay the handshake already proves it; missing from phones older than the relay.
   */
  publicKey: Schema.optional(Schema.String),
});

export type PairingRequest = typeof PairingRequest.Type;

/** What pairing answers: the token the phone connects with directly from then on. */
export const PairingGrant = Schema.Struct({
  phoneId: Schema.String,
  token: Schema.String,
  /** The host's name, for a phone that typed its address rather than scanning the offer. */
  name: Schema.String,
  /**
   * The host's database, as its shell reports it: the same host across addresses and ports, and
   * another host for a daemon on another data directory at the same address.
   */
  dataId: Schema.String,
  /** The host's key and relay, so a phone paired directly can also come through the relay; missing from daemons older than it. */
  hostId: Schema.optional(Schema.String),
  relayUrl: Schema.optional(Schema.String),
});

export type PairingGrant = typeof PairingGrant.Type;

/** How phones can reach this daemon right now, for the desktop's phone settings. */
export const PhoneAccess = Schema.Struct({
  /** "off" while phone access is; "connecting" also covers retrying after the relay dropped. */
  relay: Schema.Literals(["off", "connecting", "connected"]),
  /** Why the relay can't be reached, while retrying; null otherwise. */
  relayError: Schema.NullOr(Schema.String),
  /** The Tailscale address phones on the tailnet reach directly; null without Tailscale or with access off. */
  tailscaleAddress: Schema.NullOr(Schema.String),
});

export type PhoneAccess = typeof PhoneAccess.Type;
