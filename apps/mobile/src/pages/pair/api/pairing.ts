import { PairingGrant, type PairingRequest } from "@masscode/contracts";
import Constants from "expo-constants";
import * as Schema from "effect/Schema";
import type { PairedHost } from "@/entities/host";

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
    name: Constants.deviceName ?? "iPhone",
    platform: "ios",
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
