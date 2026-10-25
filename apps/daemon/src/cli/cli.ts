import { ClientCommand } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { findTailnetAddress, findTailnetName } from "../phones.ts";
import { DATA_DIR } from "../storage/toml-file.ts";
import { SettingsStore, layer as SettingsStoreLayer } from "../storage/settings-store.ts";
import { VERSION } from "../version.ts";
import { checkHarnesses } from "./harnesses.ts";
import { openLocalDaemon, openLocalDaemonOrFail } from "./local-daemon.ts";
import { pairDevice, readAccess } from "./pairing.ts";
import { installRelease } from "./release.ts";
import {
  BIN_DIR,
  checkServiceSupport,
  CliError,
  enableLinger,
  installService,
  isServiceActive,
  isServiceInstalled,
  restartService,
  restartServiceWhenIdle,
  uninstallService,
} from "./service.ts";

const USAGE = `MassCode ${VERSION}: run coding agents on this machine, driven from the MassCode app.

  masscode connect     Run MassCode in the background, reachable over Tailscale, and pair a device
  masscode pair        Pair another computer or phone (--access full|limited)
  masscode status      Show the service, Tailscale, paired devices and agent CLIs
  masscode update      Move to the latest release, or a given one: masscode update 0.1.16
  masscode uninstall   Stop and remove MassCode, keeping threads and settings in ${DATA_DIR}
  masscode --version`;

function findTailnet() {
  const address = findTailnetAddress();

  if (!address)
    throw new CliError(
      "Tailscale isn't up on this machine. Run `sudo tailscale up`, sign in, then run this again.",
    );

  return Effect.runPromise(findTailnetName()).then((dnsName) => ({ address, dnsName }));
}

/** Phones and computers reach the daemon only with remote access on. */
async function turnOnRemoteAccess() {
  const daemon = await openLocalDaemon();

  if (daemon) {
    const { settings } = daemon.shell;

    if (!settings.remoteAccess)
      daemon.send(
        ClientCommand.cases["settings.update"].make({
          settings: { ...settings, remoteAccess: true },
        }),
      );

    daemon.close();

    return;
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SettingsStore;
      const settings = yield* store.get;

      if (!settings.remoteAccess) yield* store.update({ ...settings, remoteAccess: true });
    }).pipe(Effect.provide(SettingsStoreLayer)),
  );
}

async function connect(args: ReadonlyArray<string>) {
  checkServiceSupport();

  const access = readAccess(args);
  const { address, dnsName } = await findTailnet();
  console.log(`✓ Tailscale: reachable as ${dnsName ?? address}`);

  await turnOnRemoteAccess();

  if (await installService()) restartService();

  console.log("✓ MassCode runs in the background");

  if (!enableLinger())
    console.log(
      `✗ MassCode starts when you sign in, not at boot. To start it at boot, run: sudo loginctl enable-linger ${userInfo().username}`,
    );

  console.log("");
  const hasAgent = await checkHarnesses();

  if (!hasAgent)
    console.log("\nSet up at least one agent CLI above before starting threads on this machine.");

  const daemon = await openLocalDaemon(15_000);

  if (!daemon)
    throw new CliError(
      "MassCode's service didn't start. See why with: journalctl --user -u masscode -n 50",
    );

  try {
    await pairDevice(daemon, access);
  } finally {
    daemon.close();
  }
}

async function pair(args: ReadonlyArray<string>) {
  const access = readAccess(args);
  const daemon = await openLocalDaemonOrFail();

  try {
    await pairDevice(daemon, access);
  } finally {
    daemon.close();
  }
}

async function status() {
  console.log(`MassCode ${VERSION}`);

  if (process.platform === "linux")
    console.log(
      isServiceActive()
        ? "✓ Running in the background"
        : isServiceInstalled()
          ? "✗ Stopped. Start it with: systemctl --user start masscode"
          : "· Not set up. Run: masscode connect",
    );

  const address = findTailnetAddress();
  const dnsName = address ? await Effect.runPromise(findTailnetName()) : null;
  console.log(
    address
      ? `✓ Tailscale: reachable as ${dnsName ?? address}`
      : "✗ Tailscale isn't up. Run: sudo tailscale up",
  );

  const daemon = await openLocalDaemon();

  if (daemon) {
    const { phones, settings } = daemon.shell;
    daemon.close();

    if (!settings.remoteAccess)
      console.log("✗ Remote access is off, so paired devices can't connect. Run: masscode connect");

    console.log(
      phones.length === 0 ? "· No paired devices. Run: masscode pair" : "\nPaired devices:",
    );

    for (const phone of phones)
      console.log(
        `  ${phone.name} (${{ ios: "iPhone", android: "Android", desktop: "computer" }[phone.platform]}, ${phone.access} access)`,
      );
  }

  console.log("");
  await checkHarnesses();
}

async function update(args: ReadonlyArray<string>) {
  checkServiceSupport();

  const requested = args[0]?.replace(/^v/, "") ?? null;
  console.log(requested ? `Installing MassCode ${requested}…` : "Looking for the latest MassCode…");

  const installed = await installRelease(requested);

  if (installed === VERSION) {
    console.log(`✓ Already on MassCode ${VERSION}`);

    return;
  }

  if (isServiceActive()) {
    restartServiceWhenIdle();
    console.log(`✓ Installed ${installed}. MassCode restarts on it once its agents are idle.`);
  } else console.log(`✓ Installed ${installed}`);
}

async function uninstall(args: ReadonlyArray<string>) {
  checkServiceSupport();

  if (
    !args.includes("--yes") &&
    !confirm("Stop MassCode, interrupting running agents, and remove it from this machine?")
  )
    return;

  await uninstallService();
  await rm(BIN_DIR, { recursive: true, force: true });
  await rm(join(homedir(), ".local", "bin", "masscode"), { force: true });
  console.log(
    `✓ Removed MassCode. Threads and settings stay in ${DATA_DIR}; delete it to remove them too.`,
  );
}

/** Runs `masscode <command>`; returns the exit code. */
export async function runCli([command, ...args]: ReadonlyArray<string>) {
  try {
    switch (command) {
      case "connect":
        await connect(args);
        break;
      case "pair":
        await pair(args);
        break;
      case "status":
        await status();
        break;
      case "update":
        await update(args);
        break;
      case "uninstall":
        await uninstall(args);
        break;
      case "--version":
      case "-v":
        console.log(VERSION);
        break;
      default:
        console.log(USAGE);
    }

    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;

    console.error(`✗ ${error.message}`);

    return 1;
  }
}
