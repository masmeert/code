import { ClientCommand, type PairingAccess, RuntimeEvent, ServerFrame } from "@masscode/contracts";
import { renderUnicodeCompact } from "uqr";
import { CliError } from "./service.ts";
import type { LocalDaemon } from "./local-daemon.ts";

/** `--access full|limited` from `args`, else asked; full suits a computer, limited a phone. */
export function readAccess(args: ReadonlyArray<string>): PairingAccess {
  const flag = args.find((arg) => arg.startsWith("--access"));
  const value = flag?.includes("=") ? flag.split("=")[1] : flag && args[args.indexOf(flag) + 1];

  if (value === "full" || value === "limited") return value;

  if (flag) throw new CliError(`--access takes \`full\` or \`limited\`, not \`${value ?? ""}\`.`);

  if (!process.stdin.isTTY) return "full";

  const answer = prompt(
    "Give the device full access? It can then pair others and show this machine's web pages. Answer no for a phone. [Y/n]",
  );

  return answer?.trim().toLowerCase().startsWith("n") ? "limited" : "full";
}

/** Shows a one-time code and waits for a device to redeem it. */
export async function pairDevice(daemon: LocalDaemon, access: PairingAccess) {
  const known = new Set(daemon.shell.phones.map((phone) => phone.id));
  const requestId = crypto.randomUUID();

  daemon.send(ClientCommand.cases["pairing.start"].make({ requestId, access }));

  const started = await daemon.waitFor(
    (frame) =>
      ServerFrame.guards["pairing.started"](frame) && frame.requestId === requestId
        ? frame
        : undefined,
    10_000,
  );

  if (!started.offer) throw new CliError(started.error ?? "MassCode couldn't start pairing.");

  const { offer } = started;
  const code = `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`;

  console.log(`
${renderUnicodeCompact(offer.url, { border: 1 })}
On your Mac: MassCode → Settings → Connections → Pair a machine, and paste
  ${offer.url}

Or type ${offer.dnsName ?? offer.host} and the code ${code}. On a phone, scan the QR code.
The code works once, for five minutes. Waiting… (Ctrl+C to stop)
`);

  const paired = await daemon
    .waitFor(
      (frame) =>
        ServerFrame.guards.event(frame) && RuntimeEvent.guards["phones.updated"](frame.event)
          ? frame.event.phones.find((phone) => !known.has(phone.id))
          : undefined,
      Math.max(offer.expiresAt - Date.now(), 0),
    )
    .catch(() => {
      throw new CliError("The code expired. Run `masscode pair` for a new one.");
    });

  console.log(`✓ Paired with ${paired.name}, with ${paired.access} access.`);
}
