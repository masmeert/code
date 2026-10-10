import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DevicePlatform } from "./devices.ts";

/** A phone paired with this daemon, reaching it over Tailscale with a token of its own. */
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
  /** The daemon's Tailscale address. */
  host: Schema.String,
  /** Its MagicDNS name, which stays when the address changes; null without MagicDNS. */
  dnsName: Schema.NullOr(Schema.String),
  port: Schema.Number,
  code: Schema.String,
  /** This machine's name, so the phone can tell its hosts apart. */
  name: Schema.String,
  expiresAt: Schema.Number,
});

export type PairingOffer = typeof PairingOffer.Type;

/** What a phone posts to `/pair` with the code from the offer. */
export const PairingRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  platform: DevicePlatform,
});

export type PairingRequest = typeof PairingRequest.Type;

/** What `/pair` answers: the token the phone connects with from then on. */
export const PairingGrant = Schema.Struct({
  phoneId: Schema.String,
  token: Schema.String,
  /** The host's name, for a phone that typed its address rather than scanning the offer. */
  name: Schema.String,
});

export type PairingGrant = typeof PairingGrant.Type;
