import type { Device, DeviceHub } from "@apcode/contracts";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./storage/jsonFile.ts";

/**
 * iOS simulators through two npm tools, installed on first use: expo-device-hub streams a
 * simulator and takes touch input for the Simulator panel, and agents drive it with the
 * agent-device CLI. Same split as t3code's Device panel.
 */

/** Pinned: the hub's stream and input protocols change between releases. */
const TOOLS = { "expo-device-hub": "0.15.2", "agent-device": "0.21.23" } as const;
type Tool = keyof typeof TOOLS;

/** Only this Mac's simulators: the panel can't reach a remote host's hub. */
export const DEVICES_SUPPORTED = process.platform === "darwin" && !process.env.APCODE_DETACHED;

const NODE_MISSING =
  "The iOS Simulator panel needs Node.js 20 or later. Install it (for example `brew install node`) and try again.";

function toolDir(tool: Tool) {
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
            new Error(
              command === "npm"
                ? NODE_MISSING
                : "The iOS Simulator panel needs Xcode. Install it from the App Store and try again.",
            ),
          );
        reject(new Error(stderr.trim().split("\n").slice(-5).join("\n") || error.message));
      },
    ),
  );
}

async function isInstalled(tool: Tool) {
  return (
    (await readFile(join(toolDir(tool), ".installed"), "utf8").catch(() => "")) === TOOLS[tool]
  );
}

async function install(tool: Tool) {
  if (await isInstalled(tool)) return;
  const dir = toolDir(tool);
  const staging = `${dir}.staging`;
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
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
}

export type Devices = ReturnType<typeof createDevices>;

export function createDevices(onAttach: (threadId: string, deviceId: string | null) => void) {
  const attached = new Map<string, string>();
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

  // ponytail: a daemon killed with SIGKILL leaves the hub running; reap it by pid file if that shows up.
  function launchHub() {
    return new Promise<DeviceHub>((resolve, reject) => {
      const child = spawn(
        "node",
        [
          join(toolDir("expo-device-hub"), "node_modules/expo-device-hub/dist/server/cli.mjs"),
          "--host",
          "127.0.0.1",
          "--require-token",
          "--platform",
          "ios",
          "--hide-sidebar",
          "--hide-boot-device",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        },
      );
      hubProcess = child;
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("The simulator hub didn't start within 30 seconds."));
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
        reject(new Error(`The simulator hub stopped (exit ${code}): ${output.slice(-500)}`));
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
      throw new Error(`The simulator hub answered ${response.status}: ${await response.text()}`);
    return response;
  }

  // The hub leaves out simulators that were never booted, so ask simctl.
  async function list(): Promise<ReadonlyArray<Device>> {
    // SAFETY: the shape of `simctl list --json`.
    const listing = JSON.parse(
      await run("xcrun", ["simctl", "list", "devices", "available", "--json"], 30_000),
    ) as { devices: Record<string, ReadonlyArray<{ udid: string; name: string; state: string }>> };
    return Object.entries(listing.devices)
      .filter(([runtime]) => runtime.includes(".iOS-"))
      .flatMap(([runtime, simulators]) =>
        simulators.map((simulator) => ({
          id: simulator.udid,
          name: simulator.name,
          // "com.apple.CoreSimulator.SimRuntime.iOS-27-0" reads "iOS 27.0".
          version: runtime
            .slice(runtime.lastIndexOf(".") + 1)
            .replace("-", " ")
            .replaceAll("-", "."),
          booted: simulator.state === "Booted",
        })),
      );
  }

  async function attach(threadId: string, deviceId: string | null) {
    if (deviceId) {
      if (!(await list()).some((candidate) => candidate.id === deviceId))
        throw new Error(`No simulator has the id ${deviceId}.`);
      // Boots it if needed, and returns once it's up.
      await run("xcrun", ["simctl", "bootstatus", deviceId, "-b"], 3 * 60_000);
      // Booting doesn't start the stream; a simulator booted elsewhere has none either.
      await hubFetch("/vendor/serve-sim/grid/api/start", {
        method: "POST",
        body: JSON.stringify({ udid: deviceId }),
      });
      attached.set(threadId, deviceId);
    } else attached.delete(threadId);
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
    /** Shows a simulator in the thread's panel for its agent: the one asked for, the thread's, or a booted iPhone. */
    async open(threadId: string, deviceId: string | null) {
      const devices = await list();
      const iPhones = devices.filter((device) => device.name.startsWith("iPhone"));
      const device =
        devices.find((candidate) => candidate.id === (deviceId ?? attached.get(threadId))) ??
        (deviceId
          ? null
          : (iPhones.find((candidate) => candidate.booted) ?? iPhones.at(-1) ?? devices[0]));
      if (!device)
        throw new Error(
          deviceId
            ? `No simulator has the id ${deviceId}. These do:\n${devices.map((d) => `${d.id}  ${d.name} (${d.version})`).join("\n")}`
            : "This Mac has no iOS simulators. Install one in Xcode → Settings → Components, or run `xcodebuild -downloadPlatform iOS`.",
        );
      await attach(threadId, device.id);
      return {
        device,
        cli: join(toolDir("agent-device"), "node_modules/.bin/agent-device"),
      };
    },
    async screenshot(threadId: string) {
      const deviceId = attached.get(threadId);
      if (!deviceId)
        throw new Error("No simulator is open in this thread. Call device_open first.");
      const response = await hubFetch(`/vendor/serve-sim/api/screenshot?device=${deviceId}`, {
        method: "POST",
      });
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    },
  };
}
