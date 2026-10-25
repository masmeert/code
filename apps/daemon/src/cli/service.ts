import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../storage/toml-file.ts";

/** Each installed version, and `masscode` pointing at the current one. */
export const BIN_DIR = join(DATA_DIR, "bin");

/** The service's token and the port it listens on, for `masscode pair` and `status` to reach it. */
const SERVICE_DIR = join(DATA_DIR, "service");

const TOKEN_FILE = join(SERVICE_DIR, "env");

const PORT_FILE = join(SERVICE_DIR, "port");

const UNIT_NAME = "masscode.service";

const UNIT_PATH = join(homedir(), ".config", "systemd", "user", UNIT_NAME);

export class CliError extends Error {}

/** Runs a command to completion; never throws, so callers decide what a failure means. */
export function run(command: ReadonlyArray<string>) {
  try {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });

    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function runSystemctl(...args: ReadonlyArray<string>) {
  const result = run(["systemctl", "--user", ...args]);

  if (!result.ok && /failed to connect to bus|no medium found/i.test(result.stderr))
    throw new CliError(
      "Couldn't reach your systemd user session. Sign in to this machine over SSH or at its keyboard (not with `su` or `sudo -u`), then run this again.",
    );

  return result;
}

/** A quoted `KEY=value` for a unit file, so paths with spaces stay one value. */
function toUnitEnvironment(key: string, value: string) {
  return `Environment="${key}=${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildUnit() {
  return [
    "[Unit]",
    "Description=MassCode",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart="${join(BIN_DIR, "masscode")}"`,
    // An update asks the daemon to exit once its agents are idle; it comes back on the new version.
    "Restart=always",
    "RestartSec=2",
    toUnitEnvironment("MASSCODE_DETACHED", "1"),
    toUnitEnvironment("MASSCODE_PORT", "0"),
    toUnitEnvironment("MASSCODE_PORT_FILE", PORT_FILE),
    toUnitEnvironment("MASSCODE_DATA_DIR", DATA_DIR),
    // The daemon reads PATH and the rest from this login shell, as the CLIs see it in a terminal.
    toUnitEnvironment("SHELL", userInfo().shell ?? "/bin/sh"),
    // Unlike the lines above, systemd takes this path only unquoted.
    `EnvironmentFile=${TOKEN_FILE}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function checkServiceSupport() {
  if (process.platform !== "linux")
    throw new CliError(
      "`masscode connect` sets up Linux machines. On a Mac, open the MassCode app instead.",
    );

  if (!Bun.which("systemctl"))
    throw new CliError(
      "This machine doesn't run systemd, which keeps MassCode running in the background. Containers usually don't: run `masscode connect` on the host or in a VM.",
    );
}

export function isServiceInstalled() {
  return existsSync(UNIT_PATH);
}

export function isServiceActive() {
  return isServiceInstalled() && runSystemctl("is-active", "--quiet", UNIT_NAME).ok;
}

/** Writes the unit and starts it at boot; true when it was already running on an older unit. */
export async function installService() {
  await mkdir(SERVICE_DIR, { recursive: true, mode: 0o700 });

  if (!existsSync(TOKEN_FILE))
    await writeFile(TOKEN_FILE, `MASSCODE_TOKEN=${randomBytes(32).toString("hex")}\n`, {
      mode: 0o600,
    });

  await chmod(TOKEN_FILE, 0o600);

  const unit = buildUnit();
  const isUnitChanged = !existsSync(UNIT_PATH) || (await readFile(UNIT_PATH, "utf8")) !== unit;

  if (isUnitChanged) {
    await mkdir(join(UNIT_PATH, ".."), { recursive: true });
    await writeFile(UNIT_PATH, unit);
    runSystemctl("daemon-reload");
  }

  const wasActive = isServiceActive();
  const enabled = runSystemctl("enable", "--now", UNIT_NAME);

  if (!enabled.ok)
    throw new CliError(
      `Couldn't start MassCode's service: ${enabled.stderr || "systemctl failed"}`,
    );

  return wasActive && isUnitChanged;
}

/** Restarts it now, interrupting running agents. */
export function restartService() {
  const restarted = runSystemctl("restart", UNIT_NAME);

  if (!restarted.ok)
    throw new CliError(`Couldn't restart MassCode: ${restarted.stderr || "systemctl failed"}`);
}

/** Asks the running daemon to exit once its agents are idle; systemd starts the new version. */
export function restartServiceWhenIdle() {
  runSystemctl("kill", "--kill-whom=main", "--signal=SIGUSR2", UNIT_NAME);
}

export async function uninstallService() {
  if (isServiceInstalled()) runSystemctl("disable", "--now", UNIT_NAME);

  await rm(UNIT_PATH, { force: true });
  runSystemctl("daemon-reload");
  await rm(SERVICE_DIR, { recursive: true, force: true });
}

/**
 * Lingering starts user services at boot instead of at sign-in. False when it's off and
 * this user isn't allowed to turn it on.
 */
export function enableLinger() {
  const { username } = userInfo();

  if (run(["loginctl", "show-user", username, "--property=Linger"]).stdout === "Linger=yes")
    return true;

  return run(["loginctl", "enable-linger", username]).ok;
}

/** Where the service's daemon listens, with the token it accepts; null when it isn't running. */
export async function readServiceEndpoint() {
  if (!existsSync(PORT_FILE) || !existsSync(TOKEN_FILE)) return null;

  const port = Number(await readFile(PORT_FILE, "utf8"));
  const token = (await readFile(TOKEN_FILE, "utf8")).match(/^MASSCODE_TOKEN=(\S+)$/m)?.[1];

  return port > 0 && token ? { port, token } : null;
}
