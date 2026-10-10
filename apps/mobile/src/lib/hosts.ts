import { PairingGrant, type PairingRequest } from "@masscode/contracts";
import Constants from "expo-constants";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";

/** A host this phone paired with: where its daemon listens, and the token it gave this phone. */
export const PairedHost = Schema.Struct({
  /** This phone's id on that host. */
  id: Schema.String,
  name: Schema.String,
  /** Its Tailscale address when it paired. */
  address: Schema.String,
  /** Its MagicDNS name, which keeps working when the address changes; absent without MagicDNS. */
  dnsName: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.Number,
  token: Schema.String,
  /** Which host it is, wherever it listens; absent for pairings from before hosts said. */
  dataId: Schema.optional(Schema.String),
  /** Turned off on this phone: kept paired, but not connected to. Absent counts as on. */
  enabled: Schema.optional(Schema.Boolean),
});

export type PairedHost = typeof PairedHost.Type;

/** What the host's pairing QR code carries; null for any other code. */
export function parsePairingLink(link: string) {
  try {
    const url = new URL(link);

    if (url.protocol !== "masscode:" || url.host !== "pair") return null;

    const host = url.searchParams.get("host");
    const code = url.searchParams.get("code");
    const port = Number(url.searchParams.get("port"));

    return host && code && port
      ? {
          host,
          port,
          code,
          name: url.searchParams.get("name") ?? host,
          dnsName: url.searchParams.get("dns"),
        }
      : null;
  } catch {
    return null;
  }
}

const decodeGrant = Schema.decodeUnknownSync(PairingGrant);

/** Trades the host's one-time code for a token of this phone's own; throws an Error saying what went wrong. */
export async function pairWithHost(offer: {
  readonly host: string;
  readonly port: number;
  readonly code: string;
  readonly name: string;
  readonly dnsName?: string | null;
}): Promise<PairedHost> {
  const request: PairingRequest = {
    code: offer.code,
    name: Constants.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone"),
    platform: Platform.OS === "ios" ? "ios" : "android",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const response = await fetch(`http://${offer.host}:${offer.port}/pair`, {
    method: "POST",
    body: JSON.stringify(request),
    signal: controller.signal,
  })
    .catch(() => {
      throw new Error(
        `Couldn't reach ${offer.name} at ${offer.host}. Check Tailscale is on, on this phone and the computer, and that MassCode is open there.`,
      );
    })
    .finally(() => clearTimeout(timeout));

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok)
    throw new Error(
      body && body instanceof Object && "error" in body && body.error
        ? String(body.error)
        : `${offer.name} refused to pair (${response.status}).`,
    );

  const grant = (() => {
    try {
      return decodeGrant(body);
    } catch {
      throw new Error(
        `This app and MassCode on ${offer.name} are different versions. Update the older one, then pair again.`,
      );
    }
  })();

  return {
    id: grant.phoneId,
    name: grant.name,
    address: offer.host,
    dnsName: offer.dnsName ?? null,
    port: offer.port,
    token: grant.token,
    dataId: grant.dataId,
  };
}
