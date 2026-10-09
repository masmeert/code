/**
 * iOS simulators and Android emulators through two npm tools, installed on first use:
 * expo-device-hub streams a device and takes touch input for the Simulator panel, and agents
 * drive it with the agent-device CLI. Same split as t3code's Device panel.
 */
import type { Device, DeviceHub, DevicePlatform } from "@masscode/contracts";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./storage/jsonFile.ts";

/** Pinned: the hub's stream and input protocols change between releases. */
const TOOLS = { "expo-device-hub": "0.15.2", "agent-device": "0.21.23" } as const;
type Tool = keyof typeof TOOLS;

/** Only this Mac's devices: the panel can't reach a remote host's hub. */
export const DEVICES_SUPPORTED = process.platform === "darwin" && !process.env.MASSCODE_DETACHED;

/** Devices booted here shut down once no thread has shown them for this long, like Claude Code's. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

const NODE_MISSING =
  "The Simulator panel needs Node.js 20 or later. Install it (for example `brew install node`) and try again.";

const MISSING_COMMAND_MESSAGES = new Map([
  ["npm", NODE_MISSING],
  ["xcrun", "iOS simulators need Xcode. Install it from the App Store and try again."],
]);

const ANDROID_SDK =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const ADB = join(ANDROID_SDK, "platform-tools/adb");

const HUB_PID_FILE = join(DATA_DIR, "tools", "hub.pid");

function toolDirectory(tool: Tool) {
  return join(DATA_DIR, "tools", tool, TOOLS[tool]);
}

function run(command: string, args: ReadonlyArray<string>, timeoutMs: number) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);

        // SAFETY: execFile reports a missing binary as a system error with an errno code.
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return reject(
            new Error(MISSING_COMMAND_MESSAGES.get(command) ?? `${command} isn't installed.`),
          );

        reject(new Error(stderr.trim().split("\n").slice(-5).join("\n") || error.message));
      },
    ),
  );
}

async function isInstalled(tool: Tool) {
  return (
    (await readFile(join(toolDirectory(tool), ".installed"), "utf8").catch(() => "")) ===
    TOOLS[tool]
  );
}

async function install(tool: Tool) {
  if (await isInstalled(tool)) return;

  const directory = toolDirectory(tool);
  const staging = `${directory}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // No install scripts: both packages ship prebuilt, and we don't run code we didn't need to.
  await run(
    "npm",
    [
      "install",
      "--prefix",
      staging,
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      `${tool}@${TOOLS[tool]}`,
    ],
    10 * 60_000,
  );

  await writeFile(join(staging, ".installed"), TOOLS[tool]);
  await rm(directory, { recursive: true, force: true });
  await rename(staging, directory);
}

/** A hub left by a daemon that was killed outright would hold the simulators' capture. */
async function reapOrphanHub() {
  const pid = Number(await readFile(HUB_PID_FILE, "utf8").catch(() => ""));
  if (!pid) return;

  const command = await run("ps", ["-o", "command=", "-p", String(pid)], 5000).catch(() => "");
  if (command.includes("expo-device-hub")) process.kill(pid, "SIGTERM");
}

// The hub leaves out simulators that were never booted, so ask simctl.
async function listSimulators(): Promise<ReadonlyArray<Device>> {
  // SAFETY: the shape of `simctl list --json`.
  const listing = JSON.parse(
    await run("xcrun", ["simctl", "list", "devices", "available", "--json"], 30_000),
  ) as { devices: Record<string, ReadonlyArray<{ udid: string; name: string; state: string }>> };

  return Object.entries(listing.devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([runtime, simulators]) =>
      simulators.map((simulator) => ({
        id: simulator.udid,
        platform: "ios" as const,
        name: simulator.name,
        // "com.apple.CoreSimulator.SimRuntime.iOS-27-0" reads "iOS 27.0".
        version: runtime
          .slice(runtime.lastIndexOf(".") + 1)
          .replace("-", " ")
          .replaceAll("-", "."),
        booted: simulator.state === "Booted",
        streamId: simulator.udid,
      })),
    );
}

// The hub lists emulators through avdmanager, which skips AVDs whose device profile the SDK
// no longer ships; the emulator itself still runs them.
async function listEmulators(): Promise<ReadonlyArray<Device>> {
  const avds = (await run(join(ANDROID_SDK, "emulator/emulator"), ["-list-avds"], 30_000))
    .split("\n")
    .filter((line) => /^[\w.-]+$/.test(line));
  const serials = (await run(ADB, ["devices"], 10_000))
    .split("\n")
    .map((line) => line.split("\t")[0]!)
    .filter((serial) => serial.startsWith("emulator-"));
  const running = new Map(
    await Promise.all(
      serials.map(
        async (serial) =>
          [
            (await run(ADB, ["-s", serial, "emu", "avd", "name"], 10_000)).split(/\r?\n/)[0]!,
            serial,
          ] as const,
      ),
    ),
  );

  return avds.map((name) => ({
    id: name,
    platform: "android" as const,
    name: name.replaceAll("_", " "),
    version: "Android",
    booted: running.has(name),
    streamId: running.get(name) ?? null,
  }));
}

export type Devices = ReturnType<typeof createDevices>;

export function createDevices(onAttach: (threadId: string, deviceId: string | null) => void) {
  const attached = new Map<string, Device>();

  /** Devices booted for a thread, so ours to shut down; with the timer that will once idle. */
  const bootedHere = new Map<
    string,
    { device: Device; idle: ReturnType<typeof setTimeout> | null }
  >();
  let installing: Promise<void> | null = null;
  let hub: Promise<DeviceHub> | null = null;
  let hubProcess: ChildProcess | null = null;

  process.once("exit", () => hubProcess?.kill());

  function setUp() {
    installing ??= Promise.all([install("expo-device-hub"), install("agent-device")]).then(
      () => undefined,
      (error) => {
        installing = null;
        throw error;
      },
    );
    return installing;
  }

  async function launchHub() {
    await reapOrphanHub();

    return new Promise<DeviceHub>((resolve, reject) => {
      const child = spawn(
        "node",
        [
          join(
            toolDirectory("expo-device-hub"),
            "node_modules/expo-device-hub/dist/server/cli.mjs",
          ),
          "--host",
          "127.0.0.1",
          "--require-token",
          // Encodes Android video on the device; the default needs ffmpeg on this Mac.
          "--stream-source",
          "scrcpy",
          "--hide-sidebar",
          "--hide-boot-device",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ANDROID_HOME: ANDROID_SDK, NO_COLOR: "1", FORCE_COLOR: "0" },
        },
      );

      hubProcess = child;
      if (child.pid) void writeFile(HUB_PID_FILE, String(child.pid)).catch(() => {});

      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("The device hub didn't start within 30 seconds."));
      }, 30_000);

      child.stdout.on("data", (chunk) => {
        output += chunk;
        // The hub picks a free port and mints the token itself; both are only in its startup link.
        const match = output.match(/http:\/\/localhost:(\d+)\/\?token=([\w-]+)/);
        if (!match) return;

        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${match[1]}`, token: match[2]! });
      });
      child.stderr.on("data", (chunk) => (output += chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        // SAFETY: spawn errors are system errors with an errno code.
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(NODE_MISSING) : error,
        );
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        hub = null;
        reject(new Error(`The device hub stopped (exit ${code}): ${output.slice(-500)}`));
      });
    });
  }

  function startHub() {
    hub ??= setUp()
      .then(launchHub)
      .catch((error) => {
        hub = null;
        throw error;
      });
    return hub;
  }

  async function hubFetch(path: string, init?: RequestInit) {
    const { origin, token } = await startHub();
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!response.ok)
      throw new Error(`The device hub answered ${response.status}: ${await response.text()}`);

    return response;
  }

  /** Simulators, then emulators; a Mac with only one of Xcode and the Android SDK lists that one. */
  async function list(): Promise<ReadonlyArray<Device>> {
    const listings = await Promise.allSettled([listSimulators(), listEmulators()]);
    const devices = listings.flatMap((listing) =>
      listing.status === "fulfilled" ? listing.value : [],
    );
    const failure = listings.find((listing) => listing.status === "rejected");
    if (devices.length === 0 && failure?.status === "rejected") throw failure.reason;

    return devices;
  }

  function shutDown(device: Device) {
    bootedHere.delete(device.id);
    return (
      device.platform === "ios"
        ? run("xcrun", ["simctl", "shutdown", device.id], 60_000)
        : run(ADB, ["-s", device.streamId ?? "", "emu", "kill"], 30_000)
    ).catch(() => {});
  }

  /** Shuts a device down once idle, if it was booted here and no thread shows it any more. */
  function release(device: Device) {
    const booted = bootedHere.get(device.id);
    if (!booted || [...attached.values()].some((other) => other.id === device.id)) return;

    if (booted.idle) clearTimeout(booted.idle);
    booted.idle = setTimeout(() => void shutDown(booted.device), IDLE_SHUTDOWN_MS);
  }

  async function boot(device: Device): Promise<Device> {
    if (device.platform === "ios") {
      // Boots it if needed, and returns once it's up.
      await run("xcrun", ["simctl", "bootstatus", device.id, "-b"], 3 * 60_000);
      // Booting doesn't start the stream; a simulator booted elsewhere has none either.
      await hubFetch("/vendor/serve-sim/grid/api/start", {
        method: "POST",
        body: JSON.stringify({ udid: device.id }),
      });
      return { ...device, booted: true };
    }

    if (device.booted) return device;

    // SAFETY: the hub's boot answer, as of the pinned version.
    const booted = (await (
      await hubFetch("/api/devices/boot", {
        method: "POST",
        body: JSON.stringify({ platform: "android", id: device.id, name: device.id }),
      })
    ).json()) as { ok: boolean; serial?: string; errors?: ReadonlyArray<{ message: string }> };
    if (!booted.ok || !booted.serial)
      throw new Error(booted.errors?.[0]?.message ?? `${device.name} didn't start.`);

    return { ...device, booted: true, streamId: booted.serial };
  }

  async function attach(threadId: string, deviceId: string | null) {
    const previous = attached.get(threadId);
    if (deviceId) {
      // Before any waiting, so an idle shutdown can't fire while this attach boots it.
      const booted = bootedHere.get(deviceId);
      if (booted?.idle) clearTimeout(booted.idle);
      if (booted) booted.idle = null;

      const found = (await list()).find((candidate) => candidate.id === deviceId);
      if (!found) throw new Error(`No simulator or emulator has the id ${deviceId}.`);

      const device = await boot(found);
      if (!found.booted) bootedHere.set(device.id, { device, idle: null });
      attached.set(threadId, device);
    } else {
      attached.delete(threadId);
    }

    if (previous && previous.id !== deviceId) release(previous);
    onAttach(threadId, deviceId);
  }

  return {
    async list(installIfMissing: boolean) {
      const installed =
        (await isInstalled("expo-device-hub")) && (await isInstalled("agent-device"));
      if (!installed && !installIfMissing) return { installed, hub: null, devices: [] };

      return { installed: true, devices: await list(), hub: await startHub() };
    },
    attach,
    /** The thread is gone or archived: its device shuts down once idle, if booted for it. */
    release(threadId: string) {
      const device = attached.get(threadId);
      if (!device) return;

      attached.delete(threadId);
      release(device);
    },
    /** Shows a device in the thread's panel for its agent: the one asked for, the thread's, or a booted phone. */
    async open(threadId: string, deviceId: string | null, platform: DevicePlatform | null) {
      const devices = await list();
      const phones = devices.filter(
        (device) =>
          (platform === null || device.platform === platform) &&
          (device.platform === "android" || device.name.startsWith("iPhone")),
      );

      const chosen =
        devices.find((candidate) => candidate.id === (deviceId ?? attached.get(threadId)?.id)) ??
        (deviceId ? null : (phones.find((candidate) => candidate.booted) ?? phones.at(-1) ?? null));
      if (!chosen)
        throw new Error(
          devices.length
            ? `No such device. These are on this Mac:\n${devices.map((device) => `${device.id}  ${device.name} (${device.version})`).join("\n")}`
            : "This Mac has no iOS simulators or Android emulators. Add a simulator in Xcode → Settings → Components, or an emulator in Android Studio's Device Manager.",
        );

      await attach(threadId, chosen.id);
      return {
        // SAFETY: attach just set it.
        device: attached.get(threadId)!,
        cli: join(toolDirectory("agent-device"), "node_modules/.bin/agent-device"),
      };
    },
    async screenshot(threadId: string) {
      const device = attached.get(threadId);
      if (!device?.streamId)
        throw new Error("No device is open in this thread. Call device_open first.");

      if (device.platform === "android")
        return new Promise<string>((resolve, reject) =>
          execFile(
            ADB,
            ["-s", device.streamId!, "exec-out", "screencap", "-p"],
            { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
            (error, stdout) => (error ? reject(error) : resolve(stdout.toString("base64"))),
          ),
        );

      const response = await hubFetch(`/vendor/serve-sim/api/screenshot?device=${device.id}`, {
        method: "POST",
      });
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    },
    /** On quit: shut down what was booted here, and stop the hub. */
    async close() {
      await Promise.all(
        [...bootedHere.values()].map(({ device, idle }) => {
          if (idle) clearTimeout(idle);
          return shutDown(device);
        }),
      );

      hubProcess?.kill();
    },
  };
}
