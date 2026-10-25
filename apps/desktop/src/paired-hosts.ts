import { PairingGrant, type PairHostRequest, parsePairingLink } from "@masscode/contracts";
import { net, safeStorage } from "electron";
import * as Schema from "effect/Schema";
import { connect, createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { findFreePort } from "./free-port.ts";

/**
 * Machines that run MassCode on their own (`masscode connect`) and paired with this app: reached
 * straight over Tailscale with a token of this app's own, instead of started over SSH.
 */

/** Where `masscode connect` listens on the tailnet, for an address typed without a port. */
const DEFAULT_PAIRING_PORT = 47822;

/** A pairing as saved in hosts.toml, its token encrypted with the system keychain. */
export const SavedPairing = Schema.Struct({
  alias: Schema.String,
  address: Schema.String,
  dnsName: Schema.NullOr(Schema.String),
  port: Schema.Number,
  dataId: Schema.String,
  deviceId: Schema.String,
  encryptedToken: Schema.String,
});

export type SavedPairing = typeof SavedPairing.Type;

export interface Pairing {
  readonly name: string;
  readonly address: string;
  /** Its MagicDNS name, tried first: it stays when the address changes. */
  readonly dnsName: string | null;
  readonly port: number;
  /** The machine's database: pairing it again replaces the old pairing. */
  readonly dataId: string;
  readonly deviceId: string;
  readonly token: string;
}

const decodeGrant = Schema.decodeUnknownSync(PairingGrant);

export function listAddresses(pairing: Pick<Pairing, "dnsName" | "address">) {
  return pairing.dnsName ? [pairing.dnsName, pairing.address] : [pairing.address];
}

/** What `masscode pair` printed, or what was typed, as addresses to try, a port and a code. */
function parseTarget({ target, code }: PairHostRequest) {
  const link = parsePairingLink(target);

  if (link)
    return {
      addresses: link.dnsName ? [link.dnsName, link.host] : [link.host],
      port: link.port,
      code: link.code,
    };

  // A name or address, maybe with a port or a scheme pasted along.
  const [address = "", port] = target
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .split(":");

  return {
    addresses: address ? [address] : [],
    port: Number(port) || DEFAULT_PAIRING_PORT,
    code: code.replace(/\D/g, ""),
  };
}

/** Trades the code for a token of this app's own; throws an Error that says what to do. */
export async function requestPairing(request: PairHostRequest): Promise<Pairing> {
  const { addresses, port, code } = parseTarget(request);

  if (addresses.length === 0)
    throw new Error("Paste the link `masscode pair` shows, or type the machine's name.");

  if (code.length !== 6)
    throw new Error("Type the 6-digit code `masscode pair` shows on the machine.");

  for (const address of addresses) {
    const response = await net
      .fetch(`http://${address}:${port}/pair`, {
        method: "POST",
        body: JSON.stringify({
          code,
          name: hostname().replace(/\.local$/, ""),
          platform: "desktop",
        }),
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => null);

    if (!response) continue;

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok)
      throw new Error(
        Schema.is(Schema.Struct({ error: Schema.String }))(body)
          ? body.error
          : `The machine refused to pair (${response.status}).`,
      );

    const grant = decodeGrant(body);

    return {
      name: grant.name,
      address: addresses.at(-1) ?? address,
      dnsName: addresses.length > 1 ? (addresses[0] ?? null) : null,
      port,
      dataId: grant.dataId,
      deviceId: grant.phoneId,
      token: grant.token,
    };
  }

  throw new Error(
    `Couldn't reach ${addresses[0]} over Tailscale. Check that Tailscale runs on both machines and that \`masscode status\` there says it's running.`,
  );
}

export function savePairing(alias: string, pairing: Pairing): SavedPairing {
  return {
    alias,
    address: pairing.address,
    dnsName: pairing.dnsName,
    port: pairing.port,
    dataId: pairing.dataId,
    deviceId: pairing.deviceId,
    encryptedToken: safeStorage.encryptString(pairing.token).toString("base64"),
  };
}

/** Null when the keychain can't decrypt it, say after moving to another Mac: pair again. */
export function loadPairing(saved: SavedPairing): Pairing | null {
  try {
    const { alias, encryptedToken, ...rest } = saved;

    return {
      name: alias,
      ...rest,
      token: safeStorage.decryptString(Buffer.from(encryptedToken, "base64")),
    };
  } catch {
    return null;
  }
}

/** The first of `addresses` taking connections on `port`, or null when none answers in time. */
export async function findReachableAddress(addresses: ReadonlyArray<string>, port: number) {
  for (const address of addresses) {
    const isReachable = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: address, port, timeout: 5000 });

      function settle(reachable: boolean) {
        socket.destroy();
        resolve(reachable);
      }

      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    });

    if (isReachable) return address;
  }

  return null;
}

/**
 * A local port piped to the machine, so the window reaches it as it does any daemon: at
 * 127.0.0.1, which is all its content security policy allows.
 */
export async function openRelay(findAddress: () => string, port: number) {
  const localPort = await findFreePort();

  const server: Server = createServer((client) => {
    const upstream = connect({ host: findAddress(), port });
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(localPort, "127.0.0.1", resolve),
  );

  return { server, port: localPort };
}
