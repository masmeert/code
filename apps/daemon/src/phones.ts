import {
  PairedPhone,
  type PairingGrant,
  type PairingOffer,
  type PairingRequest,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { CommandError } from "./errors.ts";
import { openJsonFile } from "./storage/jsonFile.ts";

/** Where paired phones reach the daemon, on its Tailscale address. */
export const REMOTE_PORT = Number(process.env.MASSCODE_REMOTE_PORT) || 47822;

const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Wrong codes a pairing takes before it's burnt, so a 6-digit code can't be guessed. */
const PAIRING_ATTEMPTS = 5;

const StoredPhone = Schema.Struct({ ...PairedPhone.fields, tokenHash: Schema.String });

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

/** Phones paired with this daemon, and the one-time codes that pair them. */
export function createPhones(options: {
  readonly isRemoteAccessOn: Effect.Effect<boolean>;
  readonly onChanged: (phones: ReadonlyArray<PairedPhone>) => void;
}) {
  return Effect.gen(function* () {
    const file = yield* openJsonFile("phones.json", Schema.Array(StoredPhone), []);
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
      return Effect.flatMap(
        options.isRemoteAccessOn,
        (isOn): Effect.Effect<PairingOffer, CommandError> => {
          if (!isOn)
            return Effect.fail(
              new CommandError({
                message: "Phone access is off. Turn it on in Settings → Phone, then pair again.",
              }),
            );

          const host = findTailnetAddress();

          if (!host)
            return Effect.fail(
              new CommandError({
                message:
                  "Tailscale isn't running on this Mac. Open Tailscale, sign in, and try again.",
              }),
            );

          const code = String(randomInt(1_000_000)).padStart(6, "0");
          const name = hostname().replace(/\.local$/, "");
          pairing = {
            code,
            expiresAt: Date.now() + PAIRING_TTL_MS,
            attemptsLeft: PAIRING_ATTEMPTS,
          };

          const query = new URLSearchParams({ host, port: String(REMOTE_PORT), code, name });

          return Effect.succeed({
            url: `masscode://pair?${query}`,
            host,
            port: REMOTE_PORT,
            code,
            name,
            expiresAt: pairing.expiresAt,
          });
        },
      );
    }

    /** Trades the current code for a token of the phone's own; the code works once. */
    function redeem(request: PairingRequest) {
      return Effect.suspend((): Effect.Effect<PairingGrant, CommandError> => {
        const current = pairing;

        if (!current || Date.now() > current.expiresAt || current.code !== request.code) {
          if (current && --current.attemptsLeft <= 0) pairing = null;

          return Effect.fail(
            new CommandError({
              message: "That code is wrong or has expired. Start pairing again on your Mac.",
            }),
          );
        }

        pairing = null;

        const token = randomBytes(32).toString("base64url");
        const phone = { id: randomUUID(), name: request.name, platform: request.platform };

        return file.get.pipe(
          Effect.flatMap((stored) =>
            save([
              ...stored,
              { ...phone, pairedAt: Date.now(), lastSeenAt: null, tokenHash: hashToken(token) },
            ]),
          ),
          Effect.as({ phoneId: phone.id, token }),
        );
      });
    }

    function unpair(phoneId: string) {
      return file.get.pipe(
        Effect.flatMap((stored) => save(stored.filter((phone) => phone.id !== phoneId))),
        Effect.asVoid,
      );
    }

    /** The paired phone's id, noting it was seen; null for a token no phone holds. */
    function authenticate(token: string) {
      const tokenHash = hashToken(token);

      return Effect.flatMap(file.get, (stored) => {
        const phone = stored.find((candidate) => candidate.tokenHash === tokenHash);

        if (!phone) return Effect.succeed(null);

        // Being seen is only bookkeeping; a failed write mustn't lock the phone out.
        return save(
          stored.map((candidate) =>
            candidate.id === phone.id ? { ...candidate, lastSeenAt: Date.now() } : candidate,
          ),
        ).pipe(Effect.ignore, Effect.as(phone.id));
      });
    }

    /** Where phones can reach the daemon: its Tailscale address while phone access is on, else null. */
    const remoteAddress = Effect.map(options.isRemoteAccessOn, (isOn) =>
      isOn ? findTailnetAddress() : null,
    );

    return { list, startPairing, redeem, unpair, authenticate, remoteAddress };
  });
}

export type Phones = Effect.Success<ReturnType<typeof createPhones>>;
