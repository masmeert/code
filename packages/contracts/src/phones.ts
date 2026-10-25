import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** What reaches the daemon over Tailscale: a phone, or another computer's MassCode app. */
export const PairingPlatform = Schema.Literals(["ios", "android", "desktop"]);

export type PairingPlatform = typeof PairingPlatform.Type;

/**
 * What a paired device may do, picked by whoever starts the pairing: `full` does all the local
 * app does, `limited` can't pair or unpair others, host the browser panel or touch keep-awake.
 */
export const PairingAccess = Schema.Literals(["full", "limited"]);

export type PairingAccess = typeof PairingAccess.Type;

/** A phone or computer paired with this daemon, reaching it over Tailscale with a token of its own. */
export const PairedPhone = Schema.Struct({
  id: Schema.String,
  /** What the device calls itself, like "Massimo's iPhone". */
  name: Schema.String,
  platform: PairingPlatform,
  /** Missing from pairings made before access levels, which were all limited. */
  access: PairingAccess.pipe(Schema.withDecodingDefaultKey(Effect.succeed("limited" as const))),
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

/** What a phone or computer posts to `/pair` with the code from the offer. */
export const PairingRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  platform: PairingPlatform,
});

export type PairingRequest = typeof PairingRequest.Type;

/** What `/pair` answers: the token the phone connects with from then on. */
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
});

export type PairingGrant = typeof PairingGrant.Type;

/** What a `masscode://pair` link (or its QR code) carries; null for anything else. */
export function parsePairingLink(link: string) {
  // Parsed by hand: contracts run where `URL` may not be typed (no DOM lib).
  const query = /^masscode:\/\/pair\/?\?(.+)$/.exec(link.trim())?.[1];

  if (!query) return null;

  const params = new Map(
    query.split("&").map((pair) => {
      const [key = "", value = ""] = pair.split("=");

      try {
        return [key, decodeURIComponent(value.replaceAll("+", " "))] as const;
      } catch {
        return [key, ""] as const;
      }
    }),
  );

  const host = params.get("host");
  const code = params.get("code");
  const port = Number(params.get("port"));

  return host && code && port
    ? { host, port, code, name: params.get("name") || host, dnsName: params.get("dns") || null }
    : null;
}
