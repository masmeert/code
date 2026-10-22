import {
  type AppChoice,
  judgeApp,
  type KeepAwakeSettings,
  type MacApp,
  OWN_BUNDLE_ID,
} from "@masscode/contracts";
import { runJavaScript, runTool } from "./mac-power.ts";

/** An app with a Dock icon, running now. */
interface RunningApp extends MacApp {
  readonly path: string;
}

/** A process paused while the lid is closed. Its start time tells it apart from a later one given the same pid. */
export interface FrozenProcess {
  readonly pid: number;
  readonly startedAt: string;
  readonly bundleId: string;
  readonly name: string;
}

const LIST_APPS_SCRIPT = String.raw`
ObjC.import("AppKit");
const workspace = $.NSWorkspace.sharedWorkspace;
const fileManager = $.NSFileManager.defaultManager;
const withInstalled = __WITH_INSTALLED__;
function displayName(path) {
  return ObjC.unwrap(fileManager.displayNameAtPath(path)).replace(/\.app$/, "");
}
function iconOf(path) {
  const image = workspace.iconForFile(path);
  const cgImage = image.CGImageForProposedRectContextHints($.NSMakeRect(0, 0, 40, 40), $(), $());
  const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cgImage);
  if (rep.isNil()) return null;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return "data:image/png;base64," + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}
const apps = new Map();
const running = workspace.runningApplications;
for (let index = 0; index < running.count; index++) {
  const app = running.objectAtIndex(index);
  if (Number(app.activationPolicy) !== 0 || app.bundleURL.isNil()) continue;
  const bundleId = ObjC.unwrap(app.bundleIdentifier);
  const path = ObjC.unwrap(app.bundleURL.path);
  if (bundleId && !apps.has(bundleId)) apps.set(bundleId, { bundleId, name: displayName(path), path, running: true });
}
if (withInstalled) {
  const home = ObjC.unwrap($.NSHomeDirectory());
  for (const folder of ["/Applications", "/Applications/Utilities", home + "/Applications", "/System/Applications", "/System/Applications/Utilities"]) {
    const entries = ObjC.deepUnwrap(fileManager.contentsOfDirectoryAtPathError(folder, $())) || [];
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const path = folder + "/" + entry;
      const bundle = $.NSBundle.bundleWithPath(path);
      if (bundle.isNil()) continue;
      const bundleId = ObjC.unwrap(bundle.bundleIdentifier);
      if (bundleId && !apps.has(bundleId)) apps.set(bundleId, { bundleId, name: displayName(path), path, running: false });
    }
  }
}
JSON.stringify([...apps.values()].map((app) => (withInstalled ? { ...app, icon: iconOf(app.path) } : app)));
`;

async function listApps(withInstalled: boolean) {
  const output = await runJavaScript(
    LIST_APPS_SCRIPT.replace("__WITH_INSTALLED__", String(withInstalled)),
    30_000,
  );

  if (output === null) return null;

  // SAFETY: the script above prints this shape.
  return JSON.parse(output) as ReadonlyArray<
    RunningApp & { running: boolean; icon?: string | null }
  >;
}

/** Running apps first, then installed ones. */
export async function listAppChoices() {
  const apps = await listApps(true);

  if (!apps) return null;

  return apps
    .filter((app) => app.bundleId !== OWN_BUNDLE_ID)
    .map((app): AppChoice => ({
      bundleId: app.bundleId,
      name: app.name,
      icon: app.icon ?? null,
      running: app.running,
    }))
    .toSorted(
      (first, second) =>
        Number(second.running) - Number(first.running) || first.name.localeCompare(second.name),
    );
}

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly startedAt: string;
  readonly executable: string;
}

/** This user's processes. `lstart` is a fixed five words, so the executable path (spaces and all) is the rest. */
async function listProcesses() {
  const output = await runTool("/bin/ps", ["-x", "-o", "pid=,ppid=,lstart=,comm="]);

  return (output ?? "").split("\n").flatMap((line): Array<ProcessRow> => {
    const match = line.match(
      /^\s*(?<pid>\d+)\s+(?<parentPid>\d+)\s+(?<startedAt>\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(?<executable>.+)$/,
    )?.groups;

    return match?.pid && match.parentPid && match.startedAt && match.executable
      ? [
          {
            pid: Number(match.pid),
            parentPid: Number(match.parentPid),
            startedAt: match.startedAt.replace(/\s+/g, " "),
            executable: match.executable,
          },
        ]
      : [];
  });
}

/** When the process started, as the journal and recovery script compare it; null once it's gone. */
export async function readStartTime(pid: number) {
  const output = await runTool("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
  const startedAt = output?.trim().replace(/\s+/g, " ");

  return startedAt || null;
}

/**
 * The processes of the running apps `settings` pauses, helpers included. Never this daemon, what
 * started it, or what it started: the agents.
 */
export async function findProcessesToFreeze(settings: KeepAwakeSettings) {
  const [apps, processes] = await Promise.all([listApps(false), listProcesses()]);
  const targets = (apps ?? []).filter((app) => judgeApp(app.bundleId, settings)[0] === "freeze");

  if (targets.length === 0) return [];

  const parents = new Map(processes.map((row) => [row.pid, row.parentPid]));
  const spared = new Set<number>();

  for (let pid: number | undefined = process.pid; pid && pid > 1; pid = parents.get(pid))
    spared.add(pid);

  let added = true;

  while (added) {
    added = false;

    for (const row of processes)
      if (!spared.has(row.pid) && spared.has(row.parentPid) && row.parentPid !== 1) {
        spared.add(row.pid);
        added = true;
      }
  }

  return processes.flatMap((row): Array<FrozenProcess> => {
    const app = targets.find((target) => row.executable.startsWith(`${target.path}/`));

    return app && !spared.has(row.pid)
      ? [{ pid: row.pid, startedAt: row.startedAt, bundleId: app.bundleId, name: app.name }]
      : [];
  });
}

export function signalProcess(pid: number, signal: "SIGSTOP" | "SIGCONT") {
  try {
    process.kill(pid, signal);

    return true;
  } catch {
    return false;
  }
}

/** Resumes each process that's still the one paused; a pid reused since is left alone. */
export async function thawProcesses(frozen: ReadonlyArray<FrozenProcess>) {
  if (frozen.length === 0) return;

  const current = new Map((await listProcesses()).map((row) => [row.pid, row.startedAt]));

  for (const entry of frozen)
    if (current.get(entry.pid) === entry.startedAt) signalProcess(entry.pid, "SIGCONT");
}
