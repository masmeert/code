import {
  PairedPhone,
  type PairingGrant,
  type PairingOffer,
  type PairingRequest,
  type PhoneAccess,
} from "@masscode/contracts";
import { hostIdFromSecret } from "@masscode/secure-channel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { CommandError } from "./errors.ts";
import { openTomlFile } from "./storage/toml-file.ts";

/** Where paired phones on the tailnet reach the daemon directly, on its Tailscale address. */
export const REMOTE_PORT = Number(process.env.MASSCODE_REMOTE_PORT) || 47822;

const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Wrong codes a pairing takes before it's burnt, so a 6-digit code can't be guessed. */
const PAIRING_ATTEMPTS = 5;

const StoredPhone = Schema.Struct({
  ...PairedPhone.fields,
  tokenHash: Schema.String,
  /** Its X25519 key for this host, base64url, which it comes through the relay with; missing for phones paired before the relay. */
  publicKey: Schema.optional(Schema.String),
});

/** What phones call this host: its name without macOS's `.local`. */
function findHostName() {
  return hostname().replace(/\.local$/, "");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** This machine's address on the tailnet (100.64.0.0/10); null when Tailscale isn't up. */
export function findTailnetAddress() {
  return (
    Object.values(networkInterfaces())
      .flat()
      .find((address) => {
        if (address?.family !== "IPv4") return false;

        const [first, second] = address.address.split(".").map(Number);

        return first === 100 && second !== undefined && second >= 64 && second <= 127;
      })?.address ?? null
  );
}

/** The Tailscale CLI: on PATH when installed that way, else inside the Mac app. */
const TAILSCALE_COMMANDS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/**
 * This machine's MagicDNS name, like `my-mac.tail1234.ts.net`, which outlives its address; null
 * without the CLI or MagicDNS.
 */
function findTailnetName() {
  return Effect.promise(async () => {
    for (const command of TAILSCALE_COMMANDS) {
      const output = await new Promise<string | null>((resolve) =>
        execFile(command, ["status", "--json"], { timeout: 3000 }, (error, stdout) =>
          resolve(error ? null : stdout),
        ),
      );

      if (output === null) continue;

      try {
        // SAFETY: the shape of `tailscale status --json`, as far as it's read here.
        const status = JSON.parse(output) as { Self?: { DNSName?: string } };

        return status.Self?.DNSName?.replace(/\.$/, "") || null;
      } catch {
        return null;
      }
    }

    return null;
  });
}

const ACCESS_OFF: PhoneAccess = { relay: "off", relayError: null, tailscaleAddress: null };

/** Phones paired with this daemon, the one-time codes that pair them, and how they reach it. */
export function createPhones(options: {
  readonly dataId: string;
  /** The daemon's identity secret: its public half is the host id phones pin. */
  readonly hostSecret: Uint8Array;
  readonly relayUrl: string;
  readonly isRemoteAccessOn: Effect.Effect<boolean>;
  readonly onChanged: (phones: ReadonlyArray<PairedPhone>) => void;
  readonly onAccessChanged: (access: PhoneAccess) => void;
}) {
  return Effect.gen(function* () {
    const file = yield* openTomlFile("phones", Schema.Array(StoredPhone), []);
    const hostId = hostIdFromSecret(options.hostSecret);
    let access = ACCESS_OFF;

    let pairing: { code: string; expiresAt: number; attemptsLeft: number } | null = null;

    const list = Effect.map(file.get, (stored) =>
      stored.map(({ id, name, platform, pairedAt, lastSeenAt }): PairedPhone => ({
        id,
        name,
        platform,
        pairedAt,
        lastSeenAt,
      })),
    );

    function save(stored: ReadonlyArray<typeof StoredPhone.Type>) {
      return file.set(stored).pipe(
        Effect.andThen(list),
        Effect.tap((phones) => Effect.sync(() => options.onChanged(phones))),
        Effect.mapError(
          (error) => new CommandError({ message: `Couldn't save paired phones: ${error.message}` }),
        ),
      );
    }

    /** A new code, replacing any earlier one, for the desktop to show as a QR code. */
    function startPairing() {
      return Effect.gen(function* (): Effect.fn.Return<PairingOffer, CommandError> {
        if (!(yield* options.isRemoteAccessOn))
          return yield* Effect.fail(
            new CommandError({
              message: "Phone access is off. Turn it on in Settings → Phone, then pair again.",
            }),
          );

        // Only an address the listener is on: a phone pairing at another would never get through.
        const host = access.tailscaleAddress;
        const dnsName = host ? yield* findTailnetName() : null;
        const code = String(randomInt(1_000_000)).padStart(6, "0");
        const name = findHostName();
        const expiresAt = Date.now() + PAIRING_TTL_MS;
        pairing = { code, expiresAt, attemptsLeft: PAIRING_ATTEMPTS };

        const query = new URLSearchParams({
          code,
          name,
          id: hostId,
          relay: options.relayUrl,
          ...(host && { host, port: String(REMOTE_PORT) }),
          ...(dnsName && { dns: dnsName }),
        });

        return {
          url: `masscode://pair?${query}`,
          host,
          dnsName,
          port: REMOTE_PORT,
          code,
          name,
          expiresAt,
          hostId,
          relayUrl: options.relayUrl,
        };
      });
    }

    /**
     * Trades the current code for a token of the phone's own; the code works once. `publicKey` is
     * the key a relay handshake proved, which outranks the one the request claims.
     */
    function redeem(request: PairingRequest, publicKey = request.publicKey) {
      return Effect.suspend((): Effect.Effect<PairingGrant, CommandError> => {
        const current = pairing;

        if (!current || Date.now() > current.expiresAt || current.code !== request.code) {
          if (current && --current.attemptsLeft <= 0) pairing = null;

          return Effect.fail(
            new CommandError({
              message: "That code is wrong or has expired. Start pairing again on your computer.",
            }),
          );
        }

        pairing = null;

        const token = randomBytes(32).toString("base64url");
        const phone = { id: randomUUID(), name: request.name, platform: request.platform };

        return file.get.pipe(
          Effect.flatMap((stored) =>
            save([
              // The same phone pairing again replaces its earlier pairing.
              ...stored.filter((candidate) => !publicKey || candidate.publicKey !== publicKey),
              {
                ...phone,
                pairedAt: Date.now(),
                lastSeenAt: null,
                tokenHash: hashToken(token),
                ...(publicKey && { publicKey }),
              },
            ]),
          ),
          Effect.as({
            phoneId: phone.id,
            token,
            name: findHostName(),
            dataId: options.dataId,
            hostId,
            relayUrl: options.relayUrl,
          }),
        );
      });
    }

    function unpair(phoneId: string) {
      return file.get.pipe(
        Effect.flatMap((stored) => save(stored.filter((phone) => phone.id !== phoneId))),
        Effect.asVoid,
      );
    }

    /** The paired phone's id, noting it was seen; null when no phone matches. */
    function findPhone(matches: (phone: typeof StoredPhone.Type) => boolean) {
      return Effect.flatMap(file.get, (stored) => {
        const phone = stored.find(matches);

        if (!phone) return Effect.succeed(null);

        // Being seen is only bookkeeping; a failed write mustn't lock the phone out.
        return save(
          stored.map((candidate) =>
            candidate.id === phone.id ? { ...candidate, lastSeenAt: Date.now() } : candidate,
          ),
        ).pipe(Effect.ignore, Effect.as(phone.id));
      });
    }

    /** A phone coming in directly, by the token it was granted. */
    function authenticate(token: string) {
      const tokenHash = hashToken(token);

      return findPhone((phone) => phone.tokenHash === tokenHash);
    }

    /** A phone coming through the relay, by the key its handshake proved. */
    function authenticateKey(publicKey: string) {
      return findPhone((phone) => phone.publicKey === publicKey);
    }

    /** Where phones can reach the daemon: its Tailscale address while phone access is on, else null. */
    const remoteAddress = Effect.map(options.isRemoteAccessOn, (isOn) =>
      isOn ? findTailnetAddress() : null,
    );

    function updateAccess(change: Partial<PhoneAccess>) {
      const next = { ...access, ...change };

      if (
        next.relay === access.relay &&
        next.relayError === access.relayError &&
        next.tailscaleAddress === access.tailscaleAddress
      )
        return;

      access = next;
      options.onAccessChanged(access);
    }

    return {
      list,
      startPairing,
      redeem,
      unpair,
      authenticate,
      authenticateKey,
      remoteAddress,
      isRemoteAccessOn: options.isRemoteAccessOn,
      hostSecret: options.hostSecret,
      relayUrl: options.relayUrl,
      readAccess: () => access,
      updateAccess,
    };
  });
}

export type Phones = Effect.Success<ReturnType<typeof createPhones>>;
