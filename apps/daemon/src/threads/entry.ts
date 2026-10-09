/** A thread's in-memory state, and what follows from it alone. */
import {
  DEFAULT_AUTO_SHELVE_DAYS,
  isTurnActive,
  PermissionLevel,
  type RuntimeEvent,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Semaphore from "effect/Semaphore";
import { createHash } from "node:crypto";
import type { ProviderSession } from "../providers/ProviderAdapter.ts";
import type { Coverage, ResumeTokens, ShelveOverride, ThreadHome } from "../storage/ThreadStore.ts";

export interface ThreadEntry {
  info: ThreadInfo;
  readonly home: ThreadHome;
  /** Null until the first message after creation or restart; agent processes start lazily. */
  session: ProviderSession | null;
  resumeTokens: ResumeTokens;
  coverage: Coverage;
  shelveOverride: ShelveOverride;
  /** Last time the thread's agent did or was asked anything; the reaper stops long-idle sessions. */
  activeAt: number;
  /** The user message that started the turn in progress; its snapshots bracket the turn. */
  currentTurn: string | null;
  /**
   * One message (or compaction) goes to the agent at a time: one sent while the agent is still
   * starting waits for it, then joins the turn it started.
   */
  readonly lock: Semaphore.Semaphore;
  /** Goes up whenever the session is dropped or replaced: what an older one sends after is ignored. */
  generation: number;
  /**
   * Stop was pressed during the turn: the queue waits for the user instead of starting the next
   * message, and a turn still starting is interrupted as soon as it has.
   */
  isStopRequested: boolean;
  /** Tool calls made inside subagents: one ending isn't a point the main agent takes messages at. */
  readonly subagentTools: Set<string>;
  /** Access of the last message sent: the most the thread's agent can give threads it starts. */
  permission: PermissionLevel | null;
  /** Its new worktree's setup command is running, and messages queue until it ends. */
  isSettingUp: boolean;
}

export function createEntry(
  info: ThreadInfo,
  home: ThreadHome,
  resumeTokens: ResumeTokens = {},
  coverage: Coverage = {},
  shelveOverride: ShelveOverride = null,
): ThreadEntry {
  return {
    info,
    home,
    session: null,
    resumeTokens,
    coverage,
    shelveOverride,
    activeAt: Date.now(),
    currentTurn: null,
    lock: Semaphore.makeUnsafe(1),
    generation: 0,
    isStopRequested: false,
    subagentTools: new Set(),
    permission: null,
    isSettingUp: false,
  };
}

/** A thread just made: idle, with nothing to read yet. */
export function buildThreadInfo(
  fields: Pick<
    ThreadInfo,
    | "id"
    | "projectId"
    | "provider"
    | "model"
    | "cwd"
    | "title"
    | "branch"
    | "worktree"
    | "startedBy"
  >,
): ThreadInfo {
  const now = Date.now();
  return {
    ...fields,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    seenRev: 0,
    shelved: false,
  };
}

/**
 * Shelved threads aren't working or waiting on you, and were either shelved by hand or idle
 * for `autoShelveDays`, read or not (as in t3code). A turn starting clears the hand-set override.
 */
export function isShelved(
  info: ThreadInfo,
  shelveOverride: ShelveOverride,
  now: number,
  settings: Settings,
) {
  if (isTurnActive(info.status)) return false;
  if (shelveOverride !== null) return shelveOverride === "shelved";

  return (
    settings.autoShelve !== false &&
    now - info.updatedAt >= (settings.autoShelveDays ?? DEFAULT_AUTO_SHELVE_DAYS) * 86_400_000
  );
}

export function isBusy(entry: ThreadEntry) {
  return isTurnActive(entry.info.status);
}

/** The thread has run on more than one harness, so no single harness's conversation holds all of it. */
export function hasSwitchedHarness(entry: ThreadEntry) {
  return (
    Object.keys(entry.coverage).length > 0 ||
    Object.keys(entry.resumeTokens).some((provider) => provider !== entry.info.provider)
  );
}

/** Where a harness's conversation is cut: at the first of `from`, the user messages to drop. */
export function getForkPoint(cut: {
  readonly before: number;
  readonly from: ReadonlyArray<Extract<RuntimeEvent, { _tag: "user.message" }>>;
}) {
  return {
    messageId: cut.from[0]?.messageId ?? null,
    keep: cut.before,
    dropTurns: cut.from.filter((message) => !message.steer).length,
  };
}

/** Levels go from least to most access, so a higher rank gives more. */
export function getPermissionRank(level: PermissionLevel) {
  return PermissionLevel.literals.indexOf(level);
}

/** The same id for the same caller and request, so a retried tool call finds what the first one made. */
export function deriveRequestUuid(caller: string, requestId: string) {
  const hex = createHash("sha256").update(`${caller}\0${requestId}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A thread is named after its first message, like a chat title. */
export function deriveTitle(text: string, fallback: string) {
  const line = text.trim().split("\n")[0]!.trim();
  if (!line) return fallback;

  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
