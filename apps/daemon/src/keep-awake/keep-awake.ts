import {
  DEFAULT_KEEP_AWAKE_BATTERY_FLOOR,
  DEFAULT_KEEP_AWAKE_MAX_HOURS,
  type KeepAwakeReason,
  type KeepAwakeSettings,
  type KeepAwakeStatus,
} from "@masscode/contracts";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type FrozenProcess,
  findProcessesToFreeze,
  listAppChoices,
  readStartTime,
  signalProcess,
  thawProcesses,
} from "./mac-apps.ts";
import {
  preventIdleSleep,
  readBattery,
  readBatteryPowerMode,
  readLidClosed,
  readMuted,
  readSleepDisabled,
  readThermalState,
  setBatteryPowerMode,
  setMuted,
  setSleepDisabled,
  sleepDisplay,
  sleepNow,
} from "./mac-power.ts";
import {
  ensureRecoveryAgent,
  hasSystemAccess,
  installSystemAccess,
  JOURNAL_PATH,
  removeSystemAccess,
} from "./system-access.ts";

/** Everything a session changed and has yet to undo, as the recovery script reads it. */
interface Journal {
  ownerPid: number;
  ownerStartedAt: string;
  /** Set once sleep was turned off: what to set it back to. */
  sleepDisabledBefore?: boolean | undefined;
  powerMode?: { key: "powermode" | "lowpowermode"; value: string } | undefined;
  unmute?: boolean | undefined;
  frozen: Array<FrozenProcess>;
}

const TICK_MS = 2000;

/** Battery, heat, newly started apps and the display are looked at this often. */
const CHECK_EVERY_TICKS = 15;

/** A pause between turns this short doesn't end a session agents started. */
const AGENTS_GRACE_MS = 5 * 60_000;

const HOUR_MS = 3_600_000;

/**
 * Keeps this Mac awake, the lid closed included, while agents work or for a time picked by
 * hand. With the lid closed it pauses the apps settings name, mutes, and saves power. Every
 * change is journaled first, and undone at the end, at the next start after a crash, or by the
 * recovery agent once this daemon is gone.
 */
export function createKeepAwake(options: {
  readSettings: () => Promise<KeepAwakeSettings | undefined>;
  hasActiveTurns: () => boolean;
  onStatus: (status: KeepAwakeStatus) => void;
}) {
  const isAvailable = process.platform === "darwin" && !process.env.MASSCODE_DETACHED;
  let access: KeepAwakeStatus["access"] = "missing";
  let session: { reason: KeepAwakeReason; startedAt: number; endsAt: number } | null = null;
  let manualUntil: number | null = null;
  /** When the current stretch of agent work started; null while agents are idle. */
  let agentsSince: number | null = null;
  let lastBusyAt = 0;
  /** The user or a guard ended this stretch of agent work; the next one starts afresh. */
  let isAgentsStretchStopped = false;
  let isLidClosed = false;
  let notice: string | null = null;
  let journal: Journal | null = null;
  let ownerStartedAt = "";
  let idleSleepBlocker: ChildProcess | null = null;
  let ticks = 0;
  let queue = Promise.resolve();
  let isQueueBusy = false;
  let lastPublished = "";

  function readStatus(): KeepAwakeStatus {
    return {
      available: isAvailable,
      access,
      session,
      lidClosed: isLidClosed,
      frozen: [
        ...new Map(
          (journal?.frozen ?? []).map((entry) => [
            entry.bundleId,
            { bundleId: entry.bundleId, name: entry.name },
          ]),
        ).values(),
      ],
      notice,
    };
  }

  function publish() {
    const status = readStatus();
    const serialized = JSON.stringify(status);

    if (serialized === lastPublished) return;

    lastPublished = serialized;
    options.onStatus(status);
  }

  /** Runs `task` after whatever is running, so two never change the Mac at once. */
  function serialize(task: () => Promise<void>) {
    const run = queue.then(async () => {
      isQueueBusy = true;

      try {
        await task();
      } catch (error) {
        console.error("Keeping the Mac awake failed:", error);
      } finally {
        isQueueBusy = false;
        publish();
      }
    });

    queue = run;

    return run;
  }

  async function saveJournal() {
    if (!journal) return rm(JOURNAL_PATH, { force: true });

    await mkdir(dirname(JOURNAL_PATH), { recursive: true });
    // Written aside then moved over, so the recovery script never reads half a journal.
    await writeFile(`${JOURNAL_PATH}.tmp`, JSON.stringify(journal));
    await rename(`${JOURNAL_PATH}.tmp`, JOURNAL_PATH);
  }

  async function readJournal() {
    try {
      // SAFETY: only this module writes the journal, in this shape.
      return JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as Journal;
    } catch {
      return null;
    }
  }

  /** Undoes what `entry` says a session changed: the apps, sound and power mode, then sleep. */
  async function undo(entry: Journal) {
    await thawProcesses(entry.frozen);

    if (entry.unmute) await setMuted(false);

    if (entry.powerMode) await setBatteryPowerMode(entry.powerMode.key, entry.powerMode.value);

    return entry.sleepDisabledBefore === undefined || setSleepDisabled(entry.sleepDisabledBefore);
  }

  async function closeLid(settings: KeepAwakeSettings) {
    if (!journal) return;

    isLidClosed = true;
    await freezeApps(settings);

    if (settings.muteWhenClosed !== false && (await readMuted()) === false) {
      journal.unmute = true;
      await saveJournal();
      await setMuted(true);
    }

    await saveBatteryPower(settings);
    await sleepDisplay();
  }

  /** Pauses the apps settings name that aren't paused yet: on close, and ones started since. */
  async function freezeApps(settings: KeepAwakeSettings) {
    if (!journal) return;

    const known = new Set(journal.frozen.map((entry) => `${entry.pid}:${entry.startedAt}`));

    const added = (await findProcessesToFreeze(settings)).filter(
      (entry) => !known.has(`${entry.pid}:${entry.startedAt}`),
    );

    if (added.length === 0) return;

    journal.frozen.push(...added);
    await saveJournal();

    for (const entry of added) signalProcess(entry.pid, "SIGSTOP");
  }

  /** Low Power Mode on battery while the lid is closed, and whenever the Mac runs hot. */
  async function saveBatteryPower(settings: KeepAwakeSettings) {
    if (!journal || journal.powerMode) return;

    const [battery, thermalState] = await Promise.all([readBattery(), readThermalState()]);

    const isWanted =
      (settings.lowPowerWhenClosed !== false && battery?.onBattery === true) || thermalState >= 2;

    const mode = await readBatteryPowerMode();

    if (!isWanted || !mode || mode.value === "1") return;

    journal.powerMode = mode;
    await saveJournal();

    if (!(await setBatteryPowerMode(mode.key, "1"))) {
      journal.powerMode = undefined;
      await saveJournal();
    }
  }

  async function openLid() {
    isLidClosed = false;

    if (!journal) return;

    await thawProcesses(journal.frozen);
    journal.frozen = [];

    if (journal.unmute) await setMuted(false);

    journal.unmute = undefined;

    if (journal.powerMode)
      await setBatteryPowerMode(journal.powerMode.key, journal.powerMode.value);

    journal.powerMode = undefined;
    await saveJournal();
  }

  /**
   * Undoes a journal left by a MassCode that's gone, or by an end of ours that failed; null once
   * there's none, else why a session can't start.
   */
  async function recoverLeftJournal() {
    const left = await readJournal();

    if (!left) return null;

    if (
      left.ownerPid !== process.pid &&
      (await readStartTime(left.ownerPid)) === left.ownerStartedAt
    )
      return "Another copy of MassCode is keeping this Mac awake. Quit it first.";

    if (!(await undo(left)))
      return "MassCode couldn't set sleep back to what it was. Set up lid-closed access again below.";

    await rm(JOURNAL_PATH, { force: true });

    return null;
  }

  async function begin(reason: KeepAwakeReason, endsAt: number) {
    notice = await recoverLeftJournal();

    if (notice) return;

    session = { reason, startedAt: Date.now(), endsAt };
    journal = { ownerPid: process.pid, ownerStartedAt, frozen: [] };

    if (access === "ready") {
      const isDisabled = await readSleepDisabled();

      if (isDisabled === false) {
        journal.sleepDisabledBefore = false;
        await saveJournal();

        if (!(await setSleepDisabled(true))) {
          journal.sleepDisabledBefore = undefined;
          access = "missing";
          notice =
            "MassCode lost its permission to keep this Mac awake with the lid closed. Set it up again below.";
        }
      }

      await saveJournal();
    }

    // Without lid-closed access, idle sleep at least waits.
    if (access !== "ready") idleSleepBlocker = preventIdleSleep();
  }

  async function end() {
    if (!session) return;

    const wasLidClosed = isLidClosed;
    await openLid();
    idleSleepBlocker?.kill();
    idleSleepBlocker = null;

    if (journal && (await undo(journal))) {
      journal = null;
      await saveJournal();
    }

    session = null;

    // Sleep is allowed again; a Mac whose lid is shut goes now rather than at the next check.
    if (wasLidClosed && (await readLidClosed())) await sleepNow();
  }

  /** Ends the session for `reason`, and keeps it off until the user starts one or agents start a new stretch. */
  async function stopFor(reason: string) {
    notice = reason;
    manualUntil = null;

    if (agentsSince !== null) isAgentsStretchStopped = true;

    await end();
  }

  /** Battery and heat; returns whether the session may go on. */
  async function checkGuards(settings: KeepAwakeSettings) {
    const [battery, thermalState] = await Promise.all([readBattery(), readThermalState()]);
    const floor = settings.batteryFloor ?? DEFAULT_KEEP_AWAKE_BATTERY_FLOOR;

    if (battery?.onBattery && floor > 0 && battery.percent <= floor) {
      await stopFor(
        `Stopped at ${battery.percent}% battery so the Mac keeps enough charge. Plug it in to keep agents running with the lid closed.`,
      );

      return false;
    }

    if (thermalState >= 3) {
      await stopFor("Stopped because the Mac got critically hot. Let it cool down first.");

      return false;
    }

    return true;
  }

  async function tick() {
    const settings = (await options.readSettings()) ?? { enabled: false };
    const now = Date.now();

    if (options.hasActiveTurns()) {
      lastBusyAt = now;
      agentsSince ??= now;
    } else if (agentsSince !== null && now - lastBusyAt > AGENTS_GRACE_MS) {
      agentsSince = null;
      isAgentsStretchStopped = false;
    }

    if (manualUntil !== null && now >= manualUntil) manualUntil = null;

    const maxHours = settings.maxHours ?? DEFAULT_KEEP_AWAKE_MAX_HOURS;
    const agentsEndAt = agentsSince === null ? null : agentsSince + maxHours * HOUR_MS;

    if (agentsEndAt !== null && now >= agentsEndAt && !isAgentsStretchStopped) {
      isAgentsStretchStopped = true;

      if (session?.reason === "agents")
        notice = `Stopped after ${maxHours} ${maxHours === 1 ? "hour" : "hours"} of agent work, the limit you set.`;
    }

    const wantsAgents =
      settings.whileAgentsWork !== false && agentsEndAt !== null && !isAgentsStretchStopped;

    const reason: KeepAwakeReason | null = !settings.enabled
      ? null
      : manualUntil !== null
        ? "manual"
        : wantsAgents
          ? "agents"
          : null;

    if (reason === null) return end();

    const endsAt = reason === "manual" ? (manualUntil ?? now) : (agentsEndAt ?? now);
    const isChecking = !session || ticks++ % CHECK_EVERY_TICKS === 0;

    if (isChecking && !(await checkGuards(settings))) return;

    if (!session) await begin(reason, endsAt);
    else session = { ...session, reason, endsAt };

    if (!session || access !== "ready") return;

    const isClosed = await readLidClosed();

    if (isClosed && !isLidClosed) await closeLid(settings);
    else if (!isClosed && isLidClosed) await openLid();
    else if (isClosed && isChecking) {
      await freezeApps(settings);
      await saveBatteryPower(settings);
      // A notification can light the display under the lid.
      await sleepDisplay();
    }
  }

  async function start() {
    if (!isAvailable) return;

    ownerStartedAt = (await readStartTime(process.pid)) ?? "";

    await recoverLeftJournal();
    access = (await hasSystemAccess()) ? "ready" : "missing";

    if (access === "ready") await ensureRecoveryAgent().catch(() => {});
  }

  if (isAvailable) void serialize(start);

  const timer = isAvailable
    ? setInterval(() => {
        if (!isQueueBusy) void serialize(tick);
      }, TICK_MS)
    : null;

  return {
    readStatus,
    start: (minutes: number) =>
      serialize(async () => {
        manualUntil = Date.now() + minutes * 60_000;
        notice = null;
        await tick();
      }),
    stop: () =>
      serialize(async () => {
        notice = null;
        manualUntil = null;

        if (agentsSince !== null) isAgentsStretchStopped = true;

        await end();
      }),
    setUp: () =>
      serialize(async () => {
        if (!isAvailable) return;

        access = "installing";
        notice = null;
        publish();

        const error = await installSystemAccess();
        access = error ? "missing" : "ready";
        notice = error;

        // A session running without access picks the lid up from here on.
        if (!error) await end();
      }),
    remove: () =>
      serialize(async () => {
        if (!isAvailable) return;

        await end();

        notice = await removeSystemAccess();

        if (!notice) access = "missing";
      }),
    listApps: listAppChoices,
    close: () => {
      if (timer) clearInterval(timer);

      return serialize(end);
    },
  };
}

export type KeepAwake = ReturnType<typeof createKeepAwake>;
