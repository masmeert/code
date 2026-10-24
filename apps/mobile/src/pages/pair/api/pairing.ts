import {
  PairingGrant,
  PROTOCOL_VERSION,
  RelayHello,
  RelayWelcome,
  type PairingRequest,
} from "@masscode/contracts";
import {
  connectThroughRelay,
  encodeBase64Url,
  generateKeyPair,
  type KeyPair,
} from "@masscode/secure-channel";
import Constants from "expo-constants";
import * as Schema from "effect/Schema";
import type { PairedHost } from "@/entities/host";

/** What a host's pairing code carries: its relay route, its Tailscale address, or both. */
export interface PairingOffer {
  readonly code: string;
  readonly name: string;
  readonly host?: string | null;
  readonly port?: number | null;
  readonly dnsName?: string | null;
  readonly hostId?: string | null;
  readonly relayUrl?: string | null;
}

/** What the host's pairing QR code carries; null for any other code. */
export function parsePairingLink(link: string): PairingOffer | null {
  try {
    const url = new URL(link);

    if (url.protocol !== "masscode:" || url.host !== "pair") return null;

    const code = url.searchParams.get("code");
    const host = url.searchParams.get("host");
    const port = Number(url.searchParams.get("port")) || null;
    const hostId = url.searchParams.get("id");
    const relayUrl = url.searchParams.get("relay");

    if (!code || !((host && port) || (hostId && relayUrl))) return null;

    return {
      code,
      name: url.searchParams.get("name") ?? host ?? "Computer",
      host,
      port,
      dnsName: url.searchParams.get("dns"),
      hostId,
      relayUrl,
    };
  } catch {
    return null;
  }
}

const decodeGrant = Schema.decodeUnknownSync(PairingGrant);

const decodeWelcome = Schema.decodeUnknownSync(Schema.fromJsonString(RelayWelcome));

const PAIRING_TIMEOUT_MS = 15_000;

function outdated(name: string) {
  return new Error(
    `This app and MassCode on ${name} are different versions. Update the older one, then pair again.`,
  );
}

/** Pairs through the relay: the handshake proves this phone's key, and the code proves it scanned the offer. */
async function pairThroughRelay(
  offer: PairingOffer & { readonly hostId: string; readonly relayUrl: string },
  request: PairingRequest,
  keyPair: KeyPair,
) {
  let failure = `Couldn't reach ${offer.name}. Check it's awake with MassCode open and phone access on, and that this phone is online.`;

  const connection = connectThroughRelay({
    relayUrl: offer.relayUrl,
    hostId: offer.hostId,
    keyPair,
    hello: JSON.stringify(RelayHello.cases.pair.make({ protocol: PROTOCOL_VERSION, request })),
    onText: () => {},
    onClose: (code, reason) => {
      if (code >= 4000 && reason) failure = reason;
    },
  });

  const timeout = setTimeout(() => connection.close(1000, ""), PAIRING_TIMEOUT_MS);

  const text = await connection.welcome
    .catch(() => {
      throw new Error(failure);
    })
    .finally(() => clearTimeout(timeout));

  connection.close();

  const welcome = (() => {
    try {
      return decodeWelcome(text);
    } catch {
      throw outdated(offer.name);
    }
  })();

  if (RelayWelcome.guards.refused(welcome)) throw new Error(welcome.reason);

  if (!RelayWelcome.guards.paired(welcome)) throw outdated(offer.name);

  return welcome.grant;
}

/** Pairs over Tailscale, posting the code to the host's phone port. */
async function pairDirectly(
  offer: PairingOffer & { readonly host: string; readonly port: number },
  request: PairingRequest,
) {
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

  try {
    return decodeGrant(body);
  } catch {
    throw outdated(offer.name);
  }
}

/**
 * Trades the host's one-time code for credentials of this phone's own: a token for Tailscale and
 * a key for the relay. Pairs through the relay when the offer names one, since that works from
 * any network. Throws an Error saying what went wrong.
 */
export async function pairWithHost(offer: PairingOffer): Promise<PairedHost> {
  const keyPair = generateKeyPair();

  const request: PairingRequest = {
    code: offer.code,
    name: Constants.deviceName ?? "iPhone",
    platform: "ios",
    publicKey: encodeBase64Url(keyPair.publicKey),
  };

  const { hostId, relayUrl, host, port } = offer;

  const grant =
    hostId && relayUrl
      ? await pairThroughRelay({ ...offer, hostId, relayUrl }, request, keyPair)
      : host && port
        ? await pairDirectly({ ...offer, host, port }, request)
        : null;

  if (!grant) throw new Error("That pairing code doesn't say where the computer is.");

  // The scanned key outranks what a direct pairing's answer claims: that's the key the code pinned.
  const relayHostId = hostId ?? grant.hostId;
  const grantedRelayUrl = relayUrl ?? grant.relayUrl;

  return {
    id: grant.phoneId,
    name: grant.name,
    address: host ?? null,
    dnsName: offer.dnsName ?? null,
    ...(port && { port }),
    token: grant.token,
    dataId: grant.dataId,
    relay:
      relayHostId && grantedRelayUrl
        ? {
            relayUrl: grantedRelayUrl,
            hostId: relayHostId,
            secretKey: encodeBase64Url(keyPair.secretKey),
          }
        : null,
  };
}
