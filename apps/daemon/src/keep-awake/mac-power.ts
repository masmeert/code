import { type ChildProcess, execFile, spawn } from "node:child_process";

/** Runs a system tool; null when it fails or times out. */
export function runTool(file: string, args: ReadonlyArray<string>, timeoutMs = 10_000) {
  return new Promise<string | null>((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

export function runJavaScript(script: string, timeoutMs = 10_000) {
  return runTool("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], timeoutMs);
}

const EXTERNAL_SCREENS_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
const screens = $.NSScreen.screens;
let count = 0;
for (let index = 0; index < screens.count; index++) {
  const id = ObjC.unwrap(screens.objectAtIndex(index).deviceDescription.objectForKey("NSScreenNumber"));
  if (!$.CGDisplayIsBuiltin(id)) count++;
}
count;
`;

/** The lid is shut with no external display in use: nobody is at this Mac. */
export async function readLidClosed() {
  const output = await runTool("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]);

  if (output?.match(/"AppleClamshellState" = (Yes|No)/)?.[1] !== "Yes") return false;

  return Number((await runJavaScript(EXTERNAL_SCREENS_SCRIPT))?.trim() ?? 0) === 0;
}

/** Null on a Mac without a battery, or one that can't be read. */
export async function readBattery() {
  const output = await runTool("/usr/bin/pmset", ["-g", "batt"]);
  const percent = output?.match(/(\d+)%/)?.[1];

  if (!output || percent === undefined) return null;

  return { percent: Number(percent), onBattery: output.includes("'Battery Power'") };
}

/** ProcessInfo's thermal state: 0 nominal, 1 fair, 2 serious, 3 critical. */
export async function readThermalState() {
  const output = await runJavaScript("$.NSProcessInfo.processInfo.thermalState");

  return Number(output?.trim() ?? 0);
}

export async function readSleepDisabled() {
  const output = await runTool("/usr/bin/pmset", ["-g"]);
  const value = output?.match(/SleepDisabled\s+(\d)/)?.[1];

  return value === undefined ? null : value === "1";
}

/** Needs the sudoers rule that setting up lid-closed access installs. */
export async function setSleepDisabled(isDisabled: boolean) {
  return (
    (await runTool("/usr/bin/sudo", [
      "-n",
      "/usr/bin/pmset",
      "-a",
      "disablesleep",
      isDisabled ? "1" : "0",
    ])) !== null
  );
}

/**
 * The battery profile's power mode: newer macOS calls it `powermode` (1 is Low Power), older
 * `lowpowermode`. Null on a Mac without a battery.
 */
export async function readBatteryPowerMode() {
  const output = await runTool("/usr/bin/pmset", ["-g", "custom"]);
  const battery = output?.split(/^AC Power:/m)[0]?.split(/^Battery Power:/m)[1];
  const match = battery?.match(/^\s*(?<key>powermode|lowpowermode)\s+(?<value>\d)/m)?.groups;

  // SAFETY: the pattern only matches those two keys.
  return match?.key && match.value
    ? { key: match.key as "powermode" | "lowpowermode", value: match.value }
    : null;
}

export async function setBatteryPowerMode(key: "powermode" | "lowpowermode", value: string) {
  return (await runTool("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-b", key, value])) !== null;
}

export function sleepDisplay() {
  return runTool("/usr/bin/pmset", ["displaysleepnow"]);
}

export function sleepNow() {
  return runTool("/usr/bin/pmset", ["sleepnow"]);
}

/** Null when there's no output device to ask. */
export async function readMuted() {
  const output = (
    await runTool("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"])
  )?.trim();

  if (output !== "true" && output !== "false") return null;

  return output === "true";
}

export function setMuted(isMuted: boolean) {
  return runTool("/usr/bin/osascript", [
    "-e",
    `set volume ${isMuted ? "with" : "without"} output muted`,
  ]);
}

/** Keeps the Mac from idle sleep (not lid-close sleep) until the process is killed, or this one exits. */
export function preventIdleSleep(): ChildProcess {
  return spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
}
