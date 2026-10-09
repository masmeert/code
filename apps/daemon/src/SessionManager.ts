import {
  AttachmentInput,
  ClientCommand,
  DEFAULT_AUTO_SHELVE_DAYS,
  fileRestoreBlocker,
  isAwaitingUser,
  isTurnActive,
  PermissionLevel,
  PROVIDER_NAME,
  ProviderKind,
  RuntimeEvent,
  ServerFrame,
  type Attachment,
  type GitAction,
  type LimitStop,
  type PageInfo,
  type QueuedMessage,
  type PullRequest,
  type RepoStatus,
  type SourceControlKind,
  type Project,
  type ProviderStatus,
  type SearchHit,
  type Settings,
  type StoredEvent,
  type CommandRun,
  type TerminalInfo,
  type ThreadInfo,
  type TurnOptions,
  WORKTREE_SETUP_TERMINAL_ID,
} from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  addWorktree,
  fastForwardDefaultBranch,
  captureCheckpoint,
  checkoutBranch,
  getCheckpointRef,
  commitAll,
  copyCheckpoints,
  createBranch,
  deleteCheckpoints,
  deleteThreadCheckpoints,
  hasCheckpoint,
  listBranches,
  listFiles,
  mergeIntoBase,
  pushBranch,
  readBranch,
  readCheckpointDiff,
  readCheckpointStats,
  readDiff,
  readPullRequestRange,
  readRecentSubjects,
  readRemoteUrl,
  readStatus,
  removeWorktreeIfClean,
  readRepoRoot,
  restoreCheckpoint,
} from "./git.ts";
import { expandHome, listFolders } from "./folders.ts";
import { buildHandoff } from "./handoff.ts";
import { ClaudeAdapter } from "./providers/ClaudeAdapter.ts";
import {
  detectSourceControl,
  mergePullRequest,
  openPullRequest,
  probeSourceControl,
  readPullRequest,
  readPullRequestTemplate,
} from "./sourceControl.ts";
import { generateCommitMessage, generatePullRequest, generateThreadTitle } from "./writer.ts";
import { CodexAdapter } from "./providers/CodexAdapter.ts";
import { CursorAdapter } from "./providers/CursorAdapter.ts";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderSession,
} from "./providers/ProviderAdapter.ts";
import { ProviderRegistry } from "./providers/ProviderRegistry.ts";
import { DATA_DIR } from "./storage/jsonFile.ts";
import { type ProjectNotFound, ProjectsStore } from "./storage/ProjectsStore.ts";
import { SettingsStore } from "./storage/SettingsStore.ts";
import {
  type Coverage,
  isPersisted,
  type ResumeTokens,
  type ShelveOverride,
  type ThreadHome,
  ThreadStore,
} from "./storage/ThreadStore.ts";
import { type Browsers, createBrowsers } from "./browsers.ts";
import { createDevices, type Devices } from "./devices.ts";
import { createMcp, type Mcp, type SendMessageInput, type StartThreadInput } from "./mcp.ts";
import { createTerminals, type Terminals } from "./terminals.ts";
import { readProjectConfig } from "./projectConfig.ts";
import { createSkillCatalog } from "./skills.ts";
import { CommandError, getErrorMessage } from "./errors.ts";

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  cursor: CursorAdapter,
};

interface SequencedEvent {
  /** Publish order, in memory only; lets a connection skip what a transcript read already covered. */
  readonly seq: number;
  /** Stored events' id, the clients' resume cursor. */
  readonly id: number | null;
  readonly event: RuntimeEvent;
}

/** A transcript read, taken at publish position `seq`. */
interface ThreadRead {
  readonly seq: number;
  readonly frame: Extract<ServerFrame, { _tag: "thread.snapshot" | "thread.replay" }>;
}

/** A client further behind than this gets a fresh snapshot instead of a replay. */
const MAX_REPLAY = 2000;

/** Same, by size: a replay this big costs more than the snapshot (t3code's budget is 8MB too). */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/**
 * Streamed text is merged into one delta per message per window before it goes out,
 * instead of a frame (and a client re-render) per token. Any other event flushes first,
 * so order is kept.
 */
const DELTA_FLUSH_MS = 40;

/** An agent process idle this long is stopped; the next message resumes it (t3code reaps at 30 min too). */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Harnesses can still refuse right at the reset (MonoCode waits this long too). */
const LIMIT_RESET_GRACE_MS = 30_000;

const REAP_INTERVAL_MS = 5 * 60 * 1000;

type TextDelta = Extract<RuntimeEvent, { _tag: "assistant.delta" | "reasoning.delta" }>;

const isTextDelta = RuntimeEvent.isAnyOf(["assistant.delta", "reasoning.delta"]);

/**
 * Shelved threads aren't working or waiting on you, and were either shelved by hand or idle
 * for `autoShelveDays`, read or not (as in t3code). A turn starting clears the hand-set override.
 */
function isShelved(
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

interface ThreadEntry {
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
  /** Messages waiting for the running turn, as `info.queue` shows them. */
  queue: ReadonlyArray<QueuedMessage>;
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

/** A read-only side conversation about one reply (BTW), never stored. */
interface SideChat {
  /** Null while its agent starts. */
  session: ProviderSession | null;
}

function createEntry(
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
    queue: info.queue ?? [],
    isStopRequested: false,
    subagentTools: new Set(),
    permission: null,
    isSettingUp: false,
  };
}

/** Levels go from least to most access, so a higher rank gives more. */
function getPermissionRank(level: PermissionLevel) {
  return PermissionLevel.literals.indexOf(level);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same id for the same caller and request, so a retried tool call finds what the first one made. */
function deriveRequestUuid(caller: string, requestId: string) {
  const hex = createHash("sha256").update(`${caller}\0${requestId}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const AGENT_GONE =
  "The agent stopped before finishing its turn. Send a message to pick up where it left off.";

/**
 * Runs `load` for a key one at a time. Calls made while it runs share a single
 * follow-up run, so a burst of refreshes costs at most two, and no caller gets a
 * result that started before it asked.
 */
function coalesceLoads<A>(load: (key: string) => Promise<A>) {
  const inFlight = new Map<string, Promise<A>>();
  const queued = new Map<string, Promise<A>>();

  function startLoad(key: string): Promise<A> {
    const promise: Promise<A> = load(key).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return (key: string): Promise<A> => {
    const current = inFlight.get(key);
    if (!current) return startLoad(key);

    const next = queued.get(key);
    if (next) return next;

    const follow = current
      .catch(() => undefined)
      .then(() => {
        queued.delete(key);
        return startLoad(key);
      });
    queued.set(key, follow);
    return follow;
  };
}

export class SessionManager extends Context.Service<
  SessionManager,
  {
    readonly dispatch: (
      command: ClientCommand,
    ) => Effect.Effect<void, CommandError | ProviderError | ProjectNotFound>;
    /** Subscribes, then snapshots the shell synchronously, so the stream continues exactly where it ends. */
    readonly subscribe: Effect.Effect<
      {
        readonly dataId: string;
        readonly settings: Settings;
        readonly projects: ReadonlyArray<Project>;
        readonly providers: ReadonlyArray<ProviderStatus>;
        readonly threads: ReadonlyArray<ThreadInfo>;
        readonly terminals: ReadonlyArray<TerminalInfo>;
        readonly live: Stream.Stream<SequencedEvent>;
      },
      never,
      Scope.Scope
    >;
    readonly terminals: Terminals;
    readonly browsers: Browsers;
    readonly devices: Devices;
    readonly mcp: Mcp;
    /**
     * A thread's transcript: what was missed since `after`, or the latest `turnLimit` turns.
     * Synchronous, so live events with a `seq` above the read's are exactly the ones it lacks.
     */
    readonly readThread: (
      threadId: string,
      after: number | null,
      turnLimit: number,
    ) => ThreadRead | null;
    readonly readOlder: (
      threadId: string,
      before: number,
      turnLimit: number,
    ) => { readonly events: ReadonlyArray<StoredEvent>; readonly page: PageInfo } | null;
    /** Messages matching `query`, newest first, in threads that still exist. */
    readonly search: (query: string) => ReadonlyArray<SearchHit>;
    readonly shutdown: Effect.Effect<void>;
    /** Some thread's turn is going, the agent working or waiting on the user. */
    readonly hasActiveTurns: () => boolean;
  }
>()("masscode/SessionManager") {}

/** What the agent reads after the user runs a command from its reply. */
function formatCommandRun({ command, exitCode, output }: CommandRun) {
  // Longer than any backtick run inside, so neither the command nor its output can close it early.
  function buildFence(text: string) {
    return "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
  }

  const ran = `I ran this command from your reply, in the thread's folder:\n\n${buildFence(command)}bash\n${command}\n${buildFence(command)}`;
  return output
    ? `${ran}\n\nIt exited with code ${exitCode} and printed:\n\n${buildFence(output)}\n${output}\n${buildFence(output)}`
    : `${ran}\n\nIt exited with code ${exitCode} and printed nothing.`;
}

/** The harness's name as the user set it in Settings, else its own; the same one the app shows. */
function getHarnessName(settings: Settings, provider: ProviderKind) {
  return settings.providers[provider].displayName?.trim() || PROVIDER_NAME[provider];
}

/** A thread is named after its first message, like a chat title. */
function deriveTitle(text: string, fallback: string) {
  const line = text.trim().split("\n")[0]!.trim();
  if (!line) return fallback;

  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
const WORKTREES_DIR = join(DATA_DIR, "worktrees");

/** Puts every attachment on disk: paths pass through, pasted bytes are written under the data dir. */
function resolveAttachments(inputs: ReadonlyArray<AttachmentInput>) {
  return Effect.tryPromise({
    try: () =>
      Promise.all(
        inputs.map((input) =>
          AttachmentInput.match(input, {
            path: async ({ path }): Promise<Attachment> => ({
              name: basename(path),
              path,
              isImage: IMAGE_EXTENSIONS.has(extname(path).toLowerCase()),
            }),
            data: async (pasted): Promise<Attachment> => {
              await mkdir(ATTACHMENTS_DIR, { recursive: true });
              const extension =
                extname(pasted.name) || `.${pasted.mediaType.split("/")[1] ?? "bin"}`;
              const path = join(ATTACHMENTS_DIR, `${crypto.randomUUID()}${extension}`);
              await writeFile(path, Buffer.from(pasted.data, "base64"));
              return { name: pasted.name, path, isImage: pasted.mediaType.startsWith("image/") };
            },
          }),
        ),
      ),
    catch: (error) =>
      new CommandError({ message: `Couldn't attach files: ${getErrorMessage(error)}` }),
  });
}

const make = Effect.gen(function* () {
  // Every effect started from a callback runs here, so closing the daemon's scope interrupts it.
  const fibers = yield* FiberSet.make();
  const runFork = yield* FiberSet.runtime(fibers)();
  const runPromise = yield* FiberSet.runtimePromise(fibers)();

  const settingsStore = yield* SettingsStore;
  const projectsStore = yield* ProjectsStore;
  const store = yield* ThreadStore;
  const registry = yield* ProviderRegistry;
  const pubsub = yield* PubSub.unbounded<SequencedEvent>();
  const threads = new Map<string, ThreadEntry>();
  /** Messages and thoughts still streaming, as one delta of all their text so far, keyed by id; dropped once they complete. */
  const streaming = new Map<string, TextDelta>();
  /** Deltas waiting for the next flush, merged per message. */
  const pendingDeltas = new Map<string, TextDelta>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  let latestSettings = yield* settingsStore.get;

  // --- restore -------------------------------------------------------------
  for (const { info, home, resumeTokens, coverage, shelveOverride, queue } of yield* store.load) {
    threads.set(
      info.id,
      createEntry(
        {
          ...info,
          shelved: isShelved(info, shelveOverride, Date.now(), latestSettings),
          ...(queue.length > 0 && { queue }),
        },
        home,
        resumeTokens,
        coverage,
        shelveOverride,
      ),
    );
  }

  /**
   * Set as the daemon goes away: agents still running then mustn't touch its state. Their
   * callbacks run outside any fiber, so closing the scope doesn't stop them.
   */
  let isShuttingDown = false;
  yield* Effect.addFinalizer(() => Effect.sync(() => void (isShuttingDown = true)));

  // Approvals pending when the daemon stopped died with their agent process.
  for (const [requestId, threadId] of store.listUnresolvedApprovals()) {
    store.appendEvent(
      threadId,
      RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }),
    );
  }

  // Threads from before auto-titles are still named after their project folder.
  for (const entry of threads.values()) {
    if (entry.info.title !== basename(entry.info.cwd)) continue;

    const text = store.readFirstUserMessage(entry.info.id);
    if (text === null) continue;

    entry.info = { ...entry.info, title: deriveTitle(text, entry.info.title) };
    store.setMeta(entry.info.id, { title: entry.info.title, updatedAt: entry.info.updatedAt });
  }

  // --- event flow ----------------------------------------------------------
  registry.setListener({
    onProviders: (providers) =>
      publish(RuntimeEvent.cases["providers.updated"].make({ providers: [...providers] })),
    onFlow: (flow) => publish(RuntimeEvent.cases["auth.flow"].make({ flow })),
  });

  /** Re-reads the branch (a turn may have switched it) and announces the thread's current meta. */
  function refreshMeta(entry: ThreadEntry) {
    const { cwd } = entry.info;
    void readBranch(cwd).then((branch) => {
      if (threads.get(entry.info.id) !== entry || entry.info.cwd !== cwd) return;

      entry.info = { ...entry.info, branch };
      const { id: threadId, title, updatedAt, worktree } = entry.info;
      publish(
        RuntimeEvent.cases["thread.meta"].make({
          threadId,
          title,
          updatedAt,
          branch,
          cwd,
          worktree,
        }),
      );
    });
  }

  function setTitle(entry: ThreadEntry, title: string) {
    entry.info = { ...entry.info, title };
    store.setMeta(entry.info.id, { title, updatedAt: entry.info.updatedAt });
    refreshMeta(entry);
  }

  /** The agent switched into a worktree or back out of one: the thread's folder follows it. */
  async function followAgentCwd(entry: ThreadEntry, reported: string) {
    // The agent may report the home folder with its symlinks resolved.
    const [real, home] = await Promise.all([realpath(reported), realpath(entry.home.path)]).catch(
      () => [reported, entry.home.path],
    );
    const cwd = real === home ? entry.home.path : reported;
    if (cwd === entry.info.cwd || threads.get(entry.info.id) !== entry) return;

    // The turn's start snapshot is of the folder it left, so there's nothing to compare its end with.
    entry.currentTurn = null;
    entry.info = { ...entry.info, cwd, worktree: entry.home.isWorktree || cwd !== entry.home.path };
    store.setAgentCwd(entry.info.id, cwd === entry.home.path ? null : cwd);
    refreshMeta(entry);
  }

  /** Marks activity on a thread: new message or finished turn. */
  function markUpdated(threadId: string) {
    const entry = threads.get(threadId);
    if (!entry) return;

    entry.info = { ...entry.info, updatedAt: Date.now() };
    store.setMeta(threadId, { title: entry.info.title, updatedAt: entry.info.updatedAt });
    refreshMeta(entry);
  }

  function flushDeltas() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingDeltas.size === 0) return;

    const batch = [...pendingDeltas.values()];
    pendingDeltas.clear();
    for (const event of batch) recordAndPublish(event);
  }

  function publish(event: RuntimeEvent) {
    if (isTextDelta(event)) {
      const pending = pendingDeltas.get(event.messageId);
      pendingDeltas.set(
        event.messageId,
        pending ? { ...pending, delta: pending.delta + event.delta } : event,
      );
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);
      return;
    }

    flushDeltas();
    recordAndPublish(event);
  }

  function recordAndPublish(event: RuntimeEvent) {
    if (isShuttingDown) return;

    let id: number | null = null;
    if (isTextDelta(event)) {
      const sent = streaming.get(event.messageId)?.delta ?? "";
      streaming.set(event.messageId, { ...event, delta: sent + event.delta });
    } else if (isPersisted(event)) {
      if (RuntimeEvent.isAnyOf(["assistant.completed", "reasoning.completed"])(event))
        streaming.delete(event.messageId);
      id = store.appendEvent(event.threadId, event);
    }

    if (RuntimeEvent.guards["thread.status"](event)) {
      const entry = threads.get(event.threadId);
      if (entry) entry.info = { ...entry.info, status: event.status };
      if (entry && isTurnActive(event.status) && entry.shelveOverride !== null)
        setShelveOverride(entry, null);
    }

    if (RuntimeEvent.guards["thread.usage"](event) && event.usage) {
      const entry = threads.get(event.threadId);
      if (entry) {
        entry.info = { ...entry.info, usage: event.usage };
        store.setUsage(event.threadId, event.usage);
      }
    }

    if ("threadId" in event && event.threadId) {
      const entry = threads.get(event.threadId);
      if (entry) entry.activeAt = Date.now();
    }

    PubSub.publishUnsafe(pubsub, { seq: ++seq, id, event });

    if ("threadId" in event && event.threadId) {
      const entry = threads.get(event.threadId);
      if (entry) trackLiveState(entry, event);
    }

    if (RuntimeEvent.isAnyOf(["user.message", "turn.completed"])(event))
      markUpdated(event.threadId);

    if (RuntimeEvent.guards["settings.updated"](event)) {
      latestSettings = event.settings;
      for (const entry of threads.values()) refreshShelved(entry);
    }

    if ("threadId" in event && event.threadId) {
      const entry = threads.get(event.threadId);
      if (entry) refreshShelved(entry);
    }
  }

  /** Keeps the thread's in-flight tool call and pending request current, announcing each change. */
  function trackLiveState(entry: ThreadEntry, event: RuntimeEvent) {
    const threadId = entry.info.id;
    const { activity, request } = entry.info;
    const hasStoppedRunning =
      RuntimeEvent.guards["thread.status"](event) && event.status !== "running";
    const nextActivity = RuntimeEvent.guards["tool.started"](event)
      ? { toolId: event.toolId, tool: event.name, summary: event.summary }
      : hasStoppedRunning ||
          (RuntimeEvent.guards["tool.completed"](event) && event.toolId === activity?.toolId)
        ? undefined
        : activity;
    const nextRequest = RuntimeEvent.guards["approval.requested"](event)
      ? {
          requestId: event.requestId,
          title: event.title,
          detail: event.detail,
          asksQuestions: event.questions !== undefined,
        }
      : (RuntimeEvent.guards["thread.status"](event) && !isAwaitingUser(event.status)) ||
          (RuntimeEvent.guards["approval.resolved"](event) &&
            event.requestId === request?.requestId)
        ? undefined
        : request;
    if (nextActivity === activity && nextRequest === request) return;

    const { activity: _activity, request: _request, ...rest } = entry.info;
    let info: ThreadInfo = rest;
    if (nextActivity) info = { ...info, activity: nextActivity };
    if (nextRequest) info = { ...info, request: nextRequest };
    entry.info = info;

    if (nextActivity !== activity)
      publish(
        RuntimeEvent.cases["thread.activity"].make({ threadId, activity: nextActivity ?? null }),
      );
    if (nextRequest !== request)
      publish(
        RuntimeEvent.cases["thread.request"].make({ threadId, request: nextRequest ?? null }),
      );
  }

  /** Announces the thread's shelved state when it changed. */
  function refreshShelved(entry: ThreadEntry) {
    const shelved = isShelved(entry.info, entry.shelveOverride, Date.now(), latestSettings);
    if (shelved === entry.info.shelved) return;

    entry.info = { ...entry.info, shelved };
    publish(RuntimeEvent.cases["thread.shelved"].make({ threadId: entry.info.id, shelved }));
    if (!shelved) return;

    terminals.closeIdle(entry.info.id);
    // Shelved threads never have a turn going; like the idle reaper, the next message resumes from the token.
    if (entry.session) runFork(dropSession(entry, null));
  }

  // Idle threads shelve with time alone; the threshold is in days, so a check a minute is plenty.
  // Resuming at a usage limit's reset rides along: a minute late is fine, and it survives sleep.
  const shelveAndResumeAtReset = Effect.sync(() => {
    for (const entry of threads.values()) {
      refreshShelved(entry);
      const stop = entry.info.limitStop;
      if (
        stop?.resumeAtReset &&
        stop.resetsAt !== null &&
        Date.now() >= stop.resetsAt + LIMIT_RESET_GRACE_MS
      )
        runFork(
          resumeAfterLimit(entry, stop.resumeAtReset).pipe(reportErrorsOn(entry), Effect.ignore),
        );
    }
  });
  yield* Effect.forkScoped(Effect.schedule(shelveAndResumeAtReset, Schedule.spaced("1 minute")));

  function setShelveOverride(entry: ThreadEntry, override: ShelveOverride) {
    entry.shelveOverride = override;
    store.setShelveOverride(entry.info.id, override);
  }

  for (const entry of threads.values()) refreshMeta(entry);

  const terminals = createTerminals({
    findFolder: (threadId) => threads.get(threadId)?.info.cwd ?? null,
    onOpened: (terminal) => publish(RuntimeEvent.cases["terminal.opened"].make(terminal)),
    onClosed: (terminal) => publish(RuntimeEvent.cases["terminal.closed"].make(terminal)),
  });
  const browsers = createBrowsers();
  const devices = createDevices((threadId, deviceId) =>
    publish(RuntimeEvent.cases["thread.device"].make({ threadId, deviceId })),
  );
  const skills = createSkillCatalog({
    readSkills: (provider, cwd) =>
      Effect.flatMap(settingsStore.get, (settings) =>
        ADAPTERS[provider].listSkills({ cwd, harness: settings.providers[provider] }),
      ),
    onListed: (provider, path, listing) =>
      publish(
        RuntimeEvent.cases["skills.listed"].make({
          provider,
          path,
          skills: listing.skills.map(({ name, description }) => ({ name, description })),
          error: listing.error,
        }),
      ),
  });

  const getEntry = Effect.fn("getEntry")(function* (threadId: string) {
    const entry = threads.get(threadId);
    if (!entry) return yield* new CommandError({ message: `No thread ${threadId}` });

    return entry;
  });

  function setResumeTokens(entry: ThreadEntry, tokens: ResumeTokens) {
    entry.resumeTokens = tokens;
    store.setResumeTokens(entry.info.id, tokens);
  }

  function setCoverage(entry: ThreadEntry, coverage: Coverage) {
    entry.coverage = coverage;
    store.setCoverage(entry.info.id, coverage);
  }

  /** The thread has run on more than one harness, so no single harness's conversation holds all of it. */
  function hasSwitchedHarness(entry: ThreadEntry) {
    return (
      Object.keys(entry.coverage).length > 0 ||
      Object.keys(entry.resumeTokens).some((provider) => provider !== entry.info.provider)
    );
  }

  /** Starts (or resumes) the agent process for a thread if it isn't running. Call it holding `entry.lock`. */
  const ensureSession = Effect.fn("ensureSession")(function* (
    entry: ThreadEntry,
    options: TurnOptions,
  ) {
    if (entry.session) return entry.session;

    const threadId = entry.info.id;
    const generation = ++entry.generation;
    const settings = yield* settingsStore.get;
    const session = yield* ADAPTERS[entry.info.provider].start({
      threadId,
      cwd: entry.home.path,
      harness: settings.providers[entry.info.provider],
      model: entry.info.model ?? settings.providers[entry.info.provider].defaultModel ?? undefined,
      resumeToken: entry.resumeTokens[entry.info.provider],
      effort: options.effort,
      permission: options.permission,
      onResumeToken: (token) =>
        setResumeTokens(entry, { ...entry.resumeTokens, [entry.info.provider]: token }),
      onCwd: (cwd) => void followAgentCwd(entry, cwd),
      emit: (event) => {
        if (entry.generation !== generation || threads.get(threadId) !== entry) return;

        // The agent process ending isn't the thread ending: drop the session so the next message
        // resumes it. A crash has already said what happened.
        if (
          RuntimeEvent.guards["thread.status"](event) &&
          (event.status === "closed" || event.status === "error")
        ) {
          runFork(
            event.status === "closed"
              ? dropSession(entry, AGENT_GONE)
              : dropSession(entry, null, "error"),
          );
          return;
        }

        if (RuntimeEvent.guards["thread.limitStop"](event)) {
          if (event.limitStop) stopForLimit(entry, event.limitStop);
          return;
        }

        publish(event);
        if (RuntimeEvent.guards["turn.completed"](event)) endTurn(entry);
        sendQueuedOnCue(entry, event);
      },
      mcpServer: mcp.issue(threadId),
    });
    if (entry.generation !== generation) {
      yield* session.close;
      return yield* new CommandError({
        message: "The agent stopped as it started. Send the message again.",
      });
    }

    entry.session = session;
    return session;
  });

  /**
   * Snapshots the folder after a turn and announces what the turn changed. Runs in the
   * background: the turn is over either way.
   */
  function endTurn(entry: ThreadEntry) {
    const messageId = entry.currentTurn;
    entry.currentTurn = null;
    if (!messageId) return;

    const { id: threadId, cwd } = entry.info;
    void (async () => {
      if (!(await captureCheckpoint(cwd, getCheckpointRef(threadId, messageId, "end")))) return;
      const stats = await readCheckpointStats(cwd, threadId, messageId);
      if (!stats || stats.files === 0 || threads.get(threadId) !== entry) return;
      publish(RuntimeEvent.cases["turn.checkpoint"].make({ threadId, messageId, ...stats }));
    })();
  }

  /**
   * Forgets the thread's agent process, closing it if it's still up; what it sends after is
   * ignored. A turn it had going ends here, since nothing else would end it: `reason` says why in
   * the transcript (null when the agent already did), and the thread goes to `status`.
   */
  const dropSession = Effect.fn("dropSession")(function* (
    entry: ThreadEntry,
    reason: string | null,
    status: "idle" | "error" = "idle",
  ) {
    const session = entry.session;
    entry.session = null;
    entry.generation++;
    entry.subagentTools.clear();

    const threadId = entry.info.id;
    const isTurnCut = threads.get(threadId) === entry && isTurnActive(entry.info.status);
    if (isTurnCut) {
      publish(RuntimeEvent.cases["turn.completed"].make({ threadId, durationMs: null }));
      endTurn(entry);
      if (reason) publish(RuntimeEvent.cases.error.make({ threadId, message: reason }));
    }

    if (isTurnCut || status === "error")
      publish(RuntimeEvent.cases["thread.status"].make({ threadId, status }));

    if (session) yield* session.close;
  });

  // Turns going when the daemon died: nothing else will end them.
  for (const { threadId, messageId } of store.listUnfinishedTurns()) {
    const entry = threads.get(threadId);
    if (!entry) continue;

    publish(RuntimeEvent.cases["turn.completed"].make({ threadId, durationMs: null }));
    publish(
      RuntimeEvent.cases.error.make({
        threadId,
        message:
          "MassCode stopped while this turn was running. Send a message to pick up where it left off.",
      }),
    );
    entry.currentTurn = messageId;
    endTurn(entry);
  }

  function setQueue(entry: ThreadEntry, queue: ReadonlyArray<QueuedMessage>) {
    entry.queue = queue;
    const { queue: _queue, ...info } = entry.info;
    entry.info = queue.length > 0 ? { ...info, queue } : info;
    store.setQueue(entry.info.id, queue);
    publish(
      RuntimeEvent.cases["thread.queue"].make({ threadId: entry.info.id, queue: [...queue] }),
    );
  }

  function setLimitStop(entry: ThreadEntry, limitStop: LimitStop | null) {
    const { limitStop: _limitStop, ...info } = entry.info;
    entry.info = limitStop ? { ...info, limitStop } : info;
    store.setLimitStop(entry.info.id, limitStop);
    publish(RuntimeEvent.cases["thread.limitStop"].make({ threadId: entry.info.id, limitStop }));
  }

  /** Holds the thread's queue on a usage limit, and asks for the reset when the harness didn't say. */
  function stopForLimit(entry: ThreadEntry, limitStop: LimitStop) {
    setLimitStop(entry, limitStop);
    if (limitStop.resetsAt !== null) return;

    runFork(
      Effect.map(registry.readLimits(limitStop.provider), ({ limits }) => {
        const spent = limits.flatMap((limit) =>
          limit.usedPercent >= 100 && limit.resetsAt !== null ? [limit.resetsAt] : [],
        );
        const current = entry.info.limitStop;
        if (spent.length > 0 && current?.resetsAt === null && threads.get(entry.info.id) === entry)
          setLimitStop(entry, { ...current, resetsAt: Math.max(...spent) });
      }),
    );
  }

  /** Sends a queued message, reporting on the thread if it can't go. */
  function sendQueued(entry: ThreadEntry, message: QueuedMessage) {
    setQueue(
      entry,
      entry.queue.filter((queued) => queued.id !== message.id),
    );
    runFork(
      deliverMessage(entry, message).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            publish(
              RuntimeEvent.cases.error.make({ threadId: entry.info.id, message: error.message }),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * The agent takes messages in after a tool call of its own ends (t3code sends queued ones
   * there too), and when its turn is over: the next queued message goes out then.
   */
  function sendQueuedOnCue(entry: ThreadEntry, event: RuntimeEvent) {
    if (RuntimeEvent.guards["tool.started"](event) && event.parentToolId)
      entry.subagentTools.add(event.toolId);

    const hasToolEnded =
      RuntimeEvent.guards["tool.completed"](event) &&
      !entry.subagentTools.delete(event.toolId) &&
      isTurnActive(entry.info.status);
    const hasTurnEnded = RuntimeEvent.guards["thread.status"](event) && event.status === "idle";
    const [next] = entry.queue;
    if (next && !entry.isStopRequested && !entry.info.limitStop && (hasToolEnded || hasTurnEnded))
      sendQueued(entry, next);
  }

  /** Stops the thread's turn and holds its queue, then does the same for threads its agent started. */
  const interrupt = Effect.fn("interrupt")(function* (
    entry: ThreadEntry,
  ): Effect.fn.Return<void, ProviderError> {
    if (isTurnActive(entry.info.status)) entry.isStopRequested = true;
    if (entry.session) yield* entry.session.interrupt;
    for (const started of threads.values())
      if (started.info.startedBy === entry.info.id && isTurnActive(started.info.status))
        yield* Effect.ignore(interrupt(started));
  });

  /** Runs `action` against the thread's live session, if it has one. */
  function runOnLiveSession(
    threadId: string,
    action: (session: ProviderSession) => Effect.Effect<void, ProviderError>,
  ) {
    return Effect.flatMap(getEntry(threadId), (entry) =>
      entry.session ? action(entry.session) : Effect.void,
    );
  }

  const removeThread = Effect.fn("removeThread")(function* (threadId: string) {
    const entry = threads.get(threadId);
    if (!entry) return;

    threads.delete(threadId);
    terminals.closeThread(threadId);
    devices.release(threadId);
    mcp.revoke(threadId);
    yield* dropSession(entry, null);
    store.deleteThread(threadId);

    const { home } = entry;
    void (async () => {
      await deleteThreadCheckpoints(entry.info.cwd, threadId);
      // A worktree with work left in it stays for the user to deal with; its branch stays until merged.
      // A fork shares its thread's worktree, so the last one out removes it.
      if (
        home.isWorktree &&
        ![...threads.values()].some((other) => other.home.path === home.path)
      ) {
        const root = await readRepoRoot(home.path);
        if (root) await removeWorktreeIfClean(root);
      }
    })();

    for (const [messageId, message] of streaming)
      if (message.threadId === threadId) streaming.delete(messageId);
    for (const [messageId, delta] of pendingDeltas)
      if (delta.threadId === threadId) pendingDeltas.delete(messageId);

    publish(RuntimeEvent.cases["thread.removed"].make({ threadId }));
  });

  const setArchived = Effect.fn("setArchived")(function* (entry: ThreadEntry, isArchived: boolean) {
    if ((entry.info.archivedAt !== null) === isArchived) return;

    const archivedAt = isArchived ? Date.now() : null;
    entry.info = { ...entry.info, archivedAt };
    store.setArchived(entry.info.id, archivedAt);
    publish(RuntimeEvent.cases["thread.archived"].make({ threadId: entry.info.id, archivedAt }));
    if (!isArchived) return;

    terminals.closeThread(entry.info.id);
    devices.release(entry.info.id);
    mcp.revoke(entry.info.id);
    // An archived thread shouldn't keep an agent process around; the next message resumes it.
    yield* dropSession(entry, "Archiving the thread stopped its agent.");
  });

  /** Sends a message: into the running turn, or as the start of a new one. */
  const deliverMessage = Effect.fn("deliverMessage")(
    function* (entry: ThreadEntry, message: QueuedMessage, run?: CommandRun) {
      const threadId = entry.info.id;
      // Writing in an archived thread brings it back.
      yield* setArchived(entry, false);

      const { text, attachments, effort, fast, permission } = message;
      const settings = yield* settingsStore.get;
      const turn = {
        // SAFETY: send() lets only UUIDs through.
        messageId: message.id as `${string}-${string}-${string}-${string}-${string}`,
        text,
        attachments,
        effort,
        fast,
        permission,
        skills: yield* Effect.promise(() =>
          skills.findMentionedSkills(entry.info.provider, entry.info.cwd, text),
        ),
        handoff: null,
      };

      const { provider } = entry.info;
      // The harness was switched to and hasn't seen what happened since it last took part.
      const since = entry.coverage[provider];
      const handoff =
        since === undefined
          ? null
          : buildHandoff({
              events: store.readAfter(threadId, since).map((stored) => stored.event),
              isFresh: entry.resumeTokens[provider] === undefined,
              getHarnessName: (kind) => getHarnessName(settings, kind),
            });
      const event = RuntimeEvent.cases["user.message"].make({
        threadId,
        messageId: message.id,
        text,
        ...(attachments.length > 0 && { attachments }),
        ...(run && { run }),
        provider,
        ...(handoff && { handoff }),
      });
      entry.permission = permission;

      // A turn is running: the message joins it.
      if (entry.session && isTurnActive(entry.info.status)) {
        publish({ ...event, steer: true });
        return yield* entry.session.steer(turn);
      }

      entry.isStopRequested = false;
      if (entry.info.limitStop) setLimitStop(entry, null);
      publish(event);
      publish(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));

      // Snapshot the folder before the agent touches it, so the turn's changes can be shown and undone.
      entry.currentTurn = message.id;
      yield* Effect.promise(() =>
        captureCheckpoint(entry.info.cwd, getCheckpointRef(threadId, message.id, "start")),
      );
      const session = yield* ensureSession(entry, { effort, permission, attachments: [] }).pipe(
        Effect.tap((session) => session.send({ ...turn, handoff: handoff?.text ?? null })),
        // The turn never got going; the session may be what's broken, so the next message starts afresh.
        Effect.tapError(() => dropSession(entry, null, "error")),
      );

      // Caught up now; until the turn got going, the next attempt hands over the same again.
      if (since !== undefined) {
        const { [provider]: _caughtUp, ...behind } = entry.coverage;
        setCoverage(entry, behind);
      }

      // Stop came while the agent was starting, with no turn yet to interrupt.
      if (entry.isStopRequested) yield* session.interrupt;
    },
    (effect, entry) => entry.lock.withPermit(effect),
  );

  /**
   * Reports a failure on the thread itself. For commands that start a thread, whose failure
   * would otherwise go to no thread, since the command names none.
   */
  function reportErrorsOn(entry: ThreadEntry) {
    return <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tapError(effect, (error) =>
        Effect.sync(() =>
          publish(
            RuntimeEvent.cases.error.make({ threadId: entry.info.id, message: error.message }),
          ),
        ),
      );
  }

  /**
   * Sends a message, or queues it with `queue` while a turn runs. A `messageId` already sent
   * or queued is a retry, and does nothing.
   */
  const send = Effect.fn("send")(function* (
    entry: ThreadEntry,
    text: string,
    options: TurnOptions,
    {
      run,
      queue = false,
      messageId = crypto.randomUUID(),
    }: { run?: CommandRun; queue?: boolean | undefined; messageId?: string | undefined } = {},
  ) {
    if (!UUID_PATTERN.test(messageId))
      return yield* new CommandError({ message: `Message ids must be UUIDs, not "${messageId}"` });
    if (
      store.hasMessage(entry.info.id, messageId) ||
      entry.queue.some((queued) => queued.id === messageId)
    )
      return;

    const message: QueuedMessage = {
      id: messageId,
      text,
      attachments: yield* resolveAttachments(options.attachments),
      effort: options.effort,
      fast: options.fast,
      permission: options.permission,
    };
    if ((queue && isTurnActive(entry.info.status)) || entry.isSettingUp)
      return setQueue(entry, [...entry.queue, message]);

    yield* deliverMessage(entry, message, run);
  });

  function isBusy(entry: ThreadEntry) {
    return isTurnActive(entry.info.status);
  }

  /**
   * Rewinds to before a user message: the provider's conversation first (the step that
   * can refuse), then the transcript, then, if asked, the files.
   */
  const rewind = Effect.fn("rewind")(function* (
    command: Extract<ClientCommand, { _tag: "thread.rewind" }>,
  ) {
    const entry = yield* getEntry(command.threadId);
    const { id: threadId, cwd, provider } = entry.info;
    if (isBusy(entry))
      return yield* new CommandError({ message: "Stop the agent before rewinding" });

    const found = store.findUserMessage(threadId, command.messageId);
    if (!found) return yield* new CommandError({ message: "That message is gone" });
    if (found.event.steer)
      return yield* new CommandError({ message: "A message sent mid-turn can't be rewound to" });

    if (command.restoreFiles) {
      const blocker = fileRestoreBlocker(
        entry.info,
        [...threads.values()].map((other) => other.info),
      );
      if (blocker) return yield* new CommandError({ message: blocker });
      if (!(yield* Effect.promise(() => hasCheckpoint(cwd, threadId, command.messageId)))) {
        return yield* new CommandError({
          message: "There's no snapshot of the files from that point",
        });
      }
    }

    yield* dropSession(entry, null);

    const resumeToken = entry.resumeTokens[provider];
    if (hasSwitchedHarness(entry)) {
      // Each harness's own conversation holds only its turns, so none can be cut back to the
      // same point: the next message starts this one afresh, handed what's left of the thread.
      setResumeTokens(entry, {});
      setCoverage(entry, { [provider]: 0 });
    } else if (resumeToken) {
      const token = yield* ADAPTERS[provider].rewind({
        cwd: entry.home.path,
        harness: (yield* settingsStore.get).providers[provider],
        resumeToken,
        messageId: command.messageId,
        keep: found.before,
        dropTurns: found.from.filter((message) => !message.steer).length,
      });
      setResumeTokens(entry, token ? { [provider]: token } : {});
    }

    store.truncate(threadId, found.seq);
    publish(RuntimeEvent.cases["thread.rewound"].make({ threadId, messageId: command.messageId }));
    markUpdated(threadId);

    const error = command.restoreFiles
      ? yield* Effect.promise(() => restoreCheckpoint(cwd, threadId, command.messageId))
      : null;
    void deleteCheckpoints(
      cwd,
      threadId,
      found.from.map((message) => message.messageId),
    );
    if (error)
      return yield* new CommandError({
        message: `Rewound the conversation, but couldn't restore the files: ${error}`,
      });
  });

  /**
   * Starts a new thread with the conversation through a message's turn: the provider's copy
   * first (the step that can refuse), then the transcript and file snapshots.
   */
  const fork = Effect.fn("fork")(function* (
    command: Extract<ClientCommand, { _tag: "thread.fork" }>,
  ) {
    const source = yield* getEntry(command.threadId);
    const { cwd, provider } = source.info;
    if (isBusy(source))
      return yield* new CommandError({ message: "Stop the agent before forking" });

    const cut = store.findTurnsAfter(source.info.id, command.messageId);
    if (!cut) return yield* new CommandError({ message: "That message is gone" });

    const sourceToken = source.resumeTokens[provider];
    // A thread that switched harness forks like a rewind: afresh, handed the conversation.
    const resumeToken =
      sourceToken && !hasSwitchedHarness(source)
        ? yield* ADAPTERS[provider].fork({
            cwd: source.home.path,
            harness: (yield* settingsStore.get).providers[provider],
            resumeToken: sourceToken,
            messageId: cut.from[0]?.messageId ?? null,
            keep: cut.before,
            dropTurns: cut.from.filter((message) => !message.steer).length,
          })
        : null;

    const now = Date.now();
    const info: ThreadInfo = {
      id: crypto.randomUUID(),
      projectId: source.info.projectId,
      provider,
      model: source.info.model,
      cwd,
      title: source.info.title.startsWith("Fork of ")
        ? source.info.title
        : deriveTitle(`Fork of ${source.info.title}`, source.info.title),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      branch: source.info.branch,
      archivedAt: null,
      worktree: source.info.worktree,
      seenRev: 0,
      shelved: false,
    };

    const coverage: Coverage = hasSwitchedHarness(source) ? { [provider]: 0 } : {};
    threads.set(
      info.id,
      createEntry(info, source.home, resumeToken ? { [provider]: resumeToken } : {}, coverage),
    );
    store.insertThread(info, source.home);
    store.copyEvents(source.info.id, info.id, cut.seq);
    store.appendEvent(
      info.id,
      RuntimeEvent.cases["thread.forked"].make({
        threadId: info.id,
        fromThreadId: source.info.id,
        fromTitle: source.info.title,
      }),
    );
    if (resumeToken) store.setResumeTokens(info.id, { [provider]: resumeToken });
    store.setCoverage(info.id, coverage);

    publish(
      RuntimeEvent.cases["thread.created"].make({
        thread: info,
        requestId: command.requestId,
        hasTranscript: true,
      }),
    );
    void copyCheckpoints(
      cwd,
      source.info.id,
      info.id,
      cut.from.map((message) => message.messageId),
    );
  });

  /** Side chats (BTW) by id; closing one forgets it. */
  const sideChats = new Map<string, SideChat>();

  /** Side chat events go out unstored and unbatched, to the connection that asked. */
  function publishSideChat(event: RuntimeEvent) {
    if (!isShuttingDown) PubSub.publishUnsafe(pubsub, { seq: ++seq, id: null, event });
  }

  /**
   * Starts a side chat's agent in plan mode, with no MassCode tools, on a copy of the thread's
   * conversation through the turn of `messageId`. Resolves to what to hand it with the first
   * question when there's no copy, and to null when the chat was closed while it started.
   */
  const startSideChat = Effect.fn("startSideChat")(function* (
    source: ThreadEntry,
    messageId: string,
    sideChatId: string,
  ) {
    const { id: threadId, provider } = source.info;
    yield* ensureHarnessReady(provider);

    const cut = store.findTurnsAfter(threadId, messageId);
    if (!cut) return yield* new CommandError({ message: "That reply is gone" });

    const settings = yield* settingsStore.get;
    const harness = settings.providers[provider];
    const sourceToken = source.resumeTokens[provider];
    // A running turn is still writing the harness's log, and some harnesses can't copy theirs:
    // the agent then starts afresh, handed the transcript instead.
    const resumeToken =
      sourceToken && !hasSwitchedHarness(source) && !isBusy(source)
        ? yield* ADAPTERS[provider]
            .fork({
              cwd: source.home.path,
              harness,
              resumeToken: sourceToken,
              messageId: cut.from[0]?.messageId ?? null,
              keep: cut.before,
              dropTurns: cut.from.filter((message) => !message.steer).length,
            })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    const handoff = resumeToken
      ? null
      : buildHandoff({
          events: store
            .readAfter(threadId, 0)
            .filter((stored) => cut.seq === null || stored.id < cut.seq)
            .map((stored) => stored.event),
          isFresh: true,
          getHarnessName: (kind) => getHarnessName(settings, kind),
        });

    const chat: SideChat = { session: null };
    sideChats.set(sideChatId, chat);
    const session = yield* ADAPTERS[provider].start({
      threadId: sideChatId,
      cwd: source.home.path,
      harness,
      model: source.info.model ?? harness.defaultModel ?? undefined,
      resumeToken: resumeToken ?? undefined,
      effort: null,
      permission: "plan",
      onResumeToken: () => {},
      onCwd: () => {},
      emit: (event) => {
        if (sideChats.get(sideChatId) !== chat) return;

        // Read-only: whatever the agent asks to do beyond reading is refused.
        if (RuntimeEvent.guards["approval.requested"](event)) {
          if (chat.session)
            runFork(Effect.ignore(chat.session.respondApproval(event.requestId, "deny")));
          return;
        }

        if (
          RuntimeEvent.guards["thread.status"](event) &&
          (event.status === "closed" || event.status === "error")
        )
          sideChats.delete(sideChatId);
        publishSideChat(event);
      },
      mcpServer: null,
    });
    if (sideChats.get(sideChatId) !== chat) {
      yield* session.close;
      return null;
    }

    chat.session = session;
    return { session, handoff: handoff?.text ?? null };
  });

  const askSideChat = Effect.fn("askSideChat")(
    function* ({
      threadId,
      messageId,
      sideChatId,
      text,
    }: Extract<ClientCommand, { _tag: "sideChat.ask" }>) {
      const source = yield* getEntry(threadId);
      const session = sideChats.get(sideChatId)?.session;
      if (sideChats.has(sideChatId) && !session)
        return yield* new CommandError({
          message: "The side chat is still starting. Ask again in a moment.",
        });

      const questionId = crypto.randomUUID();
      publishSideChat(
        RuntimeEvent.cases["user.message"].make({
          threadId: sideChatId,
          messageId: questionId,
          text,
          provider: source.info.provider,
        }),
      );
      publishSideChat(
        RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "running" }),
      );

      const started = session
        ? { session, handoff: null }
        : yield* startSideChat(source, messageId, sideChatId);
      if (!started)
        return publishSideChat(
          RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "idle" }),
        );

      yield* started.session.send({
        // SAFETY: from crypto.randomUUID() above.
        messageId: questionId as `${string}-${string}-${string}-${string}-${string}`,
        text: session
          ? text
          : `This is a by-the-way question about our conversation, asked on the side: answer it without changing any files or making a plan.\n\n${text}`,
        attachments: [],
        effort: null,
        permission: "plan",
        skills: [],
        handoff: started.handoff,
      });
    },
    (effect, { sideChatId }) =>
      Effect.tapError(effect, (error) =>
        Effect.sync(() => {
          publishSideChat(
            RuntimeEvent.cases.error.make({ threadId: sideChatId, message: error.message }),
          );
          publishSideChat(
            RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "idle" }),
          );
        }),
      ),
  );

  const closeSideChat = Effect.fn("closeSideChat")(function* (sideChatId: string) {
    const chat = sideChats.get(sideChatId);
    sideChats.delete(sideChatId);
    if (chat?.session) yield* chat.session.close;
  });

  /** Fails, saying how to fix it, unless `provider`'s CLI is installed and signed in. */
  const ensureHarnessReady = Effect.fn("ensureHarnessReady")(function* (provider: ProviderKind) {
    const name = getHarnessName(yield* settingsStore.get, provider);
    const status = (yield* registry.list).find((harness) => harness.kind === provider);

    if (status?.checking)
      return yield* new CommandError({
        message: `Still checking whether ${name} is set up. Try again in a moment.`,
      });
    if (!status?.installed)
      return yield* new CommandError({
        message: `${name} isn't installed on this machine. Install its CLI, then try again.`,
      });
    if (!status.linked)
      return yield* new CommandError({
        message: `${name} isn't signed in. Sign in under Settings → Harnesses, then try again.`,
      });
  });

  const compact = Effect.fn("compact")(function* (threadId: string) {
    const entry = yield* getEntry(threadId);
    if (isBusy(entry))
      return yield* new CommandError({ message: "Wait for the agent to finish before compacting" });
    if (!entry.resumeTokens[entry.info.provider] && !entry.session) return;

    yield* entry.lock.withPermit(
      ensureSession(entry, { effort: null, permission: "ask", attachments: [] }).pipe(
        Effect.flatMap((session) => session.compact),
      ),
    );
  });

  const listCommands = Effect.fn("listCommands")(function* (threadId: string) {
    const entry = yield* getEntry(threadId);
    const commands = entry.session
      ? yield* entry.session.commands.pipe(Effect.orElseSucceed(() => []))
      : [];

    // Claude reports its skills as commands too; they're offered under `$` instead.
    const skillNames = yield* Effect.promise(() =>
      skills.loadSkillNames(entry.info.provider, entry.info.cwd),
    );
    publish(
      RuntimeEvent.cases["thread.commands"].make({
        threadId,
        commands: commands.filter((command) => !skillNames.has(command.name)),
      }),
    );
  });

  /** Stops agent processes nobody has used in a while; they resume from their token on the next message. */
  const reapIdleSessions = Effect.gen(function* () {
    const now = Date.now();
    for (const entry of threads.values()) {
      const { status } = entry.info;
      if (!entry.session || isTurnActive(status)) continue;
      if (now - entry.activeAt < SESSION_IDLE_MS) continue;

      yield* dropSession(entry, null);
    }
  });
  yield* Effect.forkScoped(Effect.schedule(reapIdleSessions, Schedule.spaced(REAP_INTERVAL_MS)));

  /** Announces the branches at `path`; `error` reports a failed checkout alongside them. */
  function publishBranches(path: string, error: string | null = null) {
    return Effect.promise(() => listBranches(path)).pipe(
      Effect.map(({ current, branches }) =>
        publish(RuntimeEvent.cases["git.branches"].make({ path, current, branches, error })),
      ),
    );
  }

  // Asking the host means a network call, so answers are kept a while (t3code keeps them 60 s).
  const PULL_REQUEST_TTL_MS = 60_000;
  const hosts = new Map<string, Promise<SourceControlKind | null>>();
  const pullRequests = new Map<string, { at: number; pr: Promise<PullRequest | null> }>();

  /** The repo state at `path`, with its host and the branch's pull request. */
  async function readRepo(path: string): Promise<RepoStatus | null> {
    const status = await readStatus(path);
    if (!status) return null;

    const url = await readRemoteUrl(path);
    let host = hosts.get(url ?? "");
    if (!host) {
      host = detectSourceControl(url);
      hosts.set(url ?? "", host);
    }
    const sourceControl = await host;

    const key = `${path}\0${status.branch}`;
    let cached = pullRequests.get(key);
    if (
      sourceControl &&
      status.branch &&
      (!cached || Date.now() - cached.at > PULL_REQUEST_TTL_MS)
    ) {
      cached = { at: Date.now(), pr: readPullRequest(path, sourceControl, status.branch) };
      pullRequests.set(key, cached);
    }

    return { ...status, sourceControl, pullRequest: (sourceControl && (await cached?.pr)) || null };
  }

  function forgetPullRequest(path: string) {
    for (const key of pullRequests.keys())
      if (key.startsWith(`${path}\0`)) pullRequests.delete(key);
  }

  /** Announces the repo state at `path`; `action`/`error` report the git action it answers. */
  function publishStatus(
    path: string,
    action: GitAction | null = null,
    error: string | null = null,
  ) {
    return Effect.promise(() => readRepo(path)).pipe(
      Effect.map((status) =>
        publish(RuntimeEvent.cases["git.status"].make({ path, status, action, error })),
      ),
    );
  }

  // At most one fetch per repo this often, however many windows ask (t3code fetches every 30 s).
  const AUTO_PULL_INTERVAL_MS = 30_000;
  const pulledAt = new Map<string, number>();

  // Plain refreshes (every window, every finished tool call) coalesce per repo.
  const refreshStatus = coalesceLoads(async (path) => {
    const { autoPull: enabled } = await runPromise(settingsStore.get);
    if (enabled && Date.now() - (pulledAt.get(path) ?? 0) > AUTO_PULL_INTERVAL_MS) {
      pulledAt.set(path, Date.now());
      await fastForwardDefaultBranch(path);
    }

    const status = await readRepo(path);
    publish(RuntimeEvent.cases["git.status"].make({ path, status, action: null, error: null }));
  });

  const readLimits = coalesceLoads(async (provider) => {
    if (!Schema.is(ProviderKind)(provider)) return;

    const { limits, error } = await runPromise(registry.readLimits(provider));
    publish(RuntimeEvent.cases["provider.limits"].make({ provider, limits: [...limits], error }));
  });

  const readUsage = coalesceLoads(async (threadId) => {
    const entry = threads.get(threadId);
    if (!entry) return;

    const { provider, model } = entry.info;
    const resumeToken = entry.resumeTokens[provider];
    // A live session reports its usage when its turn ends.
    const usage =
      entry.info.usage ??
      (resumeToken && !entry.session
        ? await runPromise(
            Effect.flatMap(settingsStore.get, (settings) =>
              ADAPTERS[provider].readUsage({
                cwd: entry.home.path,
                harness: settings.providers[provider],
                resumeToken,
                model: model ?? settings.providers[provider].defaultModel ?? undefined,
              }),
            ).pipe(Effect.orElseSucceed(() => null)),
          )
        : null);
    publish(RuntimeEvent.cases["thread.usage"].make({ threadId, usage }));
  });

  const refreshDiff = coalesceLoads((path) =>
    readDiff(path).then((diff) => publish(RuntimeEvent.cases["git.diff"].make({ path, ...diff }))),
  );

  /**
   * Who writes thread titles and source control text at `path`: the commit model in settings,
   * else the last harness's default.
   */
  function buildWriterInput(path: string, settings: Settings, recent: ReadonlyArray<string>) {
    const split = settings.commitModel?.indexOf(":") ?? -1;
    const commitProvider = settings.commitModel?.slice(0, split);
    const isPinned = split > 0 && Schema.is(ProviderKind)(commitProvider);
    const provider = isPinned ? commitProvider : settings.lastProvider;
    const model = isPinned
      ? settings.commitModel!.slice(split + 1)
      : settings.providers[provider].defaultModel;

    return {
      cwd: path,
      provider,
      harness: settings.providers[provider],
      model: model || undefined,
      settings,
      recent,
    };
  }

  /** A message for everything uncommitted at `path`, from the commit model in settings. */
  const writeCommitMessage = Effect.fn("writeCommitMessage")(function* (path: string) {
    const settings = yield* settingsStore.get;
    const [diff, recent] = yield* Effect.promise(() =>
      Promise.all([readDiff(path), readRecentSubjects(path, 20)]),
    );
    if (diff.error) return { error: diff.error };
    if (!diff.patch) return { error: "Nothing to commit" };

    return yield* Effect.tryPromise({
      try: () =>
        generateCommitMessage({ ...buildWriterInput(path, settings, recent), patch: diff.patch }),
      catch: (error) => `Couldn't write a commit message: ${getErrorMessage(error)}`,
    }).pipe(
      Effect.map((message) => ({ message })),
      Effect.catch((error) => Effect.succeed({ error })),
    );
  });

  /**
   * Pushes the branch if the host doesn't have all of it, writes the title and body with the
   * commit model, and opens the pull request. Resolves to an error message on failure.
   */
  async function createPullRequest(path: string) {
    const status = await readRepo(path);
    if (!status?.sourceControl) return "This repo's remote isn't on GitHub or GitLab";
    if (!status.branch) return "Check out a branch first";
    if (status.branch === status.defaultBranch)
      return `You're on ${status.branch}; create a branch for the pull request first`;
    if (status.changes) return "Commit your changes before opening a pull request";

    const isOpen = status.pullRequest?.state === "open" || status.pullRequest?.state === "draft";
    if (isOpen) return `#${status.pullRequest.number} is already open for this branch`;

    if (!status.upstream || status.ahead) {
      const pushed = await pushBranch(path);
      if (pushed) return pushed;
    }

    const [settings, range, recent, root] = await Promise.all([
      runPromise(settingsStore.get),
      readPullRequestRange(path, status.branch),
      readRecentSubjects(path, 20),
      readRepoRoot(path),
    ]);
    if (!range) return "Couldn't find the branch to open the pull request against";
    if (!range.commits) return `This branch has no commits that ${range.base} doesn't have`;

    // t3code only follows templates on GitHub; GitLab keeps its own in .gitlab/.
    const template =
      settings.followTemplates !== false && status.sourceControl === "github" && root
        ? await readPullRequestTemplate(root)
        : null;

    let text: { title: string; body: string };
    try {
      text = await generatePullRequest({
        ...buildWriterInput(path, settings, recent),
        ...range,
        head: status.branch,
        template,
      });
    } catch (error) {
      return `Couldn't write the pull request: ${getErrorMessage(error)}`;
    }
    return openPullRequest(path, status.sourceControl, {
      base: range.base,
      head: status.branch,
      ...text,
    });
  }

  /** Commits and pushes on one repo run one at a time. */
  const gitLocks = new Map<string, Semaphore.Semaphore>();

  function runWithRepoLock<A, E>(path: string, effect: Effect.Effect<A, E>) {
    return Effect.gen(function* () {
      let lock = gitLocks.get(path);
      if (!lock) {
        lock = yield* Semaphore.make(1);
        gitLocks.set(path, lock);
      }

      return yield* lock.withPermit(effect);
    });
  }

  /**
   * A worktree of the project's repo on a new branch named after the thread, under the
   * data dir. Resolves to the thread's folder in it (the project may be a repo subfolder).
   */
  const createWorktree = Effect.fn("createWorktree")(function* (
    projectPath: string,
    title: string,
    threadId: string,
  ) {
    const root = yield* Effect.promise(() => readRepoRoot(projectPath));
    if (!root)
      return yield* new CommandError({
        message: "New worktrees need the project to be a git repo",
      });

    const slug = `${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "thread"
    }-${threadId.slice(0, 6)}`;
    const path = join(WORKTREES_DIR, basename(root), slug);
    const { worktreeFromOrigin } = yield* settingsStore.get;
    const error = yield* Effect.promise(() =>
      addWorktree(projectPath, path, `masscode/${slug}`, worktreeFromOrigin === true),
    );
    if (error) return yield* new CommandError({ message: `Couldn't create a worktree: ${error}` });

    return join(path, relative(root, projectPath));
  });

  /**
   * Runs `masscode.toml`'s worktree setup in the thread's new worktree; unless told not to wait,
   * messages queue until it ends.
   */
  const setUpWorktree = Effect.fn("setUpWorktree")(function* (
    entry: ThreadEntry,
    projectPath: string,
  ) {
    const threadId = entry.info.id;
    const config = yield* Effect.promise(() => readProjectConfig(projectPath));
    if (config instanceof Error)
      return publish(
        RuntimeEvent.cases.error.make({
          threadId,
          message: `${config.message}. The worktree's setup didn't run; fix the file and start a new thread.`,
        }),
      );

    const command = config.worktree?.setup?.trim();
    if (!command) return;

    const setupError = terminals.run(
      threadId,
      WORKTREE_SETUP_TERMINAL_ID,
      command,
      120,
      30,
      ({ exitCode, output, wasStopped }) => {
        if (threads.get(threadId) !== entry) return;

        publish(
          RuntimeEvent.cases["worktree.setup"].make({
            threadId,
            run: { command, exitCode, output },
            stopped: wasStopped,
          }),
        );
        if (!entry.isSettingUp) return;

        entry.isSettingUp = false;
        const [next] = entry.queue;
        if (next && entry.info.archivedAt === null) sendQueued(entry, next);
      },
      { MASSCODE_PROJECT_ROOT: projectPath },
    );
    if (setupError)
      return publish(
        RuntimeEvent.cases.error.make({
          threadId,
          message: `Couldn't run the worktree setup: ${setupError.message}`,
        }),
      );

    entry.isSettingUp = config.worktree?.wait_for_setup !== false;
  });

  /**
   * Adds a thread and announces it; the first line of `text` names it until the writer model's
   * summary lands.
   */
  const openThread = Effect.fn("openThread")(function* (
    info: ThreadInfo,
    home: ThreadHome,
    text: string,
    requestId: string | null,
  ) {
    const entry = createEntry(info, home);
    threads.set(info.id, entry);
    store.insertThread(info, home);
    publish(RuntimeEvent.cases["thread.created"].make({ thread: info, requestId }));

    const { title } = info;
    void generateThreadTitle({
      ...buildWriterInput(info.cwd, yield* settingsStore.get, []),
      text,
    })
      .then((summary) => {
        // Unless it's been renamed meanwhile.
        if (threads.get(info.id) === entry && entry.info.title === title)
          setTitle(entry, deriveTitle(summary, title));
      })
      .catch(() => {});

    return entry;
  });

  const createThread = Effect.fn("createThread")(function* (
    command: Extract<ClientCommand, { _tag: "thread.create" }>,
  ) {
    const { project, isNew } = yield* projectsStore.ensure(command.path);
    if (isNew) publish(RuntimeEvent.cases["project.added"].make({ project }));

    const now = Date.now();
    const id = crypto.randomUUID();
    const title = deriveTitle(command.text, project.name);
    const cwd =
      command.workspace === "worktree"
        ? yield* createWorktree(project.path, title, id)
        : project.path;

    const entry = yield* openThread(
      {
        id,
        projectId: project.id,
        provider: command.provider,
        model: command.model,
        cwd,
        title,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        branch: yield* Effect.promise(() => readBranch(cwd)),
        archivedAt: null,
        worktree: command.workspace === "worktree",
        seenRev: 0,
        shelved: false,
      },
      { path: cwd, isWorktree: command.workspace === "worktree" },
      command.text,
      command.requestId,
    );
    if (command.workspace === "worktree") yield* setUpWorktree(entry, project.path);

    // New chats preselect whichever harness was used last.
    const settings = yield* settingsStore.get;
    if (settings.lastProvider !== command.provider) {
      const next = yield* settingsStore.update({ ...settings, lastProvider: command.provider });
      publish(RuntimeEvent.cases["settings.updated"].make({ settings: next }));
    }

    yield* send(entry, command.text, command.options).pipe(reportErrorsOn(entry), Effect.ignore);
  });

  // --- orchestration: what agents do through MassCode's MCP tools -------------------------

  /** A thread as the tools describe it. */
  function summarizeThread({ info }: ThreadEntry) {
    return {
      threadId: info.id,
      title: info.title,
      provider: info.provider,
      model: info.model,
      status: info.status,
      ...(info.startedBy && { startedBy: info.startedBy }),
    };
  }

  /** The thread's last answer, and the error it ended on, if it did. */
  function readLastTurn(threadId: string) {
    let answer: string | null = null;
    let error: string | null = null;
    for (const { event } of store.readTurns(threadId, 1).events) {
      if (RuntimeEvent.guards["assistant.completed"](event)) answer = event.text;
      if (RuntimeEvent.guards.error(event)) error = event.message;
    }

    return { answer, ...(error && { error }) };
  }

  /** The most `caller`'s agent can give another: its own access. */
  function checkPermissionCeiling(caller: ThreadEntry, wanted: PermissionLevel | null | undefined) {
    const ceiling = caller.permission ?? "ask";
    const level = wanted ?? ceiling;

    return getPermissionRank(level) <= getPermissionRank(ceiling)
      ? Effect.succeed(level)
      : Effect.fail(
          new CommandError({
            message: `Your thread runs with "${ceiling}" access, so it can't give another "${level}". Ask for "${ceiling}" or less.`,
          }),
        );
  }

  function getTargetEntry(threadId: string) {
    return Effect.mapError(
      getEntry(threadId),
      () =>
        new CommandError({
          message: `There's no thread ${threadId}. list_threads shows the ones in your project.`,
        }),
    );
  }

  /** Waits for the thread's turn to end, up to `timeoutMs`. */
  const waitForTurn = Effect.fn("waitForTurn")(function* (entry: ThreadEntry, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    // ponytail: polls the thread's status; a per-thread signal if many agents wait at once.
    while (entry.isSettingUp || isTurnActive(entry.info.status)) {
      if (Date.now() >= deadline) return { ...summarizeThread(entry), timedOut: true };
      yield* Effect.sleep("200 millis");
    }

    return { ...summarizeThread(entry), ...readLastTurn(entry.info.id) };
  });

  const startThread = Effect.fn("startThread")(function* (
    callerId: string,
    input: StartThreadInput,
  ) {
    const caller = yield* getEntry(callerId);
    const id = input.requestId ? deriveRequestUuid(callerId, input.requestId) : crypto.randomUUID();
    let entry = threads.get(id);
    if (!entry) {
      const permission = yield* checkPermissionCeiling(caller, input.permission);
      const provider = input.provider ?? caller.info.provider;
      yield* ensureHarnessReady(provider);

      const project = (yield* projectsStore.list).find(
        (candidate) => candidate.id === caller.info.projectId,
      );
      const title = deriveTitle(input.prompt, caller.info.title);
      const cwd = input.worktree
        ? yield* createWorktree(project?.path ?? caller.info.cwd, title, id)
        : caller.info.cwd;
      const now = Date.now();
      entry = yield* openThread(
        {
          id,
          projectId: caller.info.projectId,
          provider,
          model: input.model ?? (provider === caller.info.provider ? caller.info.model : null),
          cwd,
          title,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          branch: yield* Effect.promise(() => readBranch(cwd)),
          archivedAt: null,
          worktree: input.worktree === true || caller.info.worktree,
          seenRev: 0,
          shelved: false,
          startedBy: callerId,
        },
        // Same folder as the caller, which keeps it if it's a worktree made for the caller.
        input.worktree
          ? { path: cwd, isWorktree: true }
          : cwd === caller.home.path
            ? caller.home
            : { path: cwd, isWorktree: false },
        input.prompt,
        null,
      );
      if (input.worktree) yield* setUpWorktree(entry, project?.path ?? caller.info.cwd);

      publish(
        RuntimeEvent.cases["thread.startedBy"].make({
          threadId: id,
          byThreadId: callerId,
          byTitle: caller.info.title,
        }),
      );
      yield* send(entry, input.prompt, { effort: null, permission, attachments: [] }).pipe(
        reportErrorsOn(entry),
      );
    }

    return input.wait
      ? yield* waitForTurn(entry, (input.timeoutSeconds ?? 600) * 1000)
      : summarizeThread(entry);
  });

  const sendMessage = Effect.fn("sendMessage")(function* (
    callerId: string,
    input: SendMessageInput,
  ) {
    const caller = yield* getEntry(callerId);
    const target = yield* getTargetEntry(input.threadId);
    if (target === caller)
      return yield* new CommandError({
        message: "That's your own thread; reply in your turn instead.",
      });

    const ceiling = caller.permission ?? "ask";
    // The target's own level, unless that's more than the caller may give.
    const fallback =
      target.permission && getPermissionRank(target.permission) < getPermissionRank(ceiling)
        ? target.permission
        : ceiling;
    const permission = yield* checkPermissionCeiling(caller, input.permission ?? fallback);
    yield* send(
      target,
      input.text,
      { effort: null, permission, attachments: [] },
      {
        queue: input.queue,
        messageId: input.requestId ? deriveRequestUuid(callerId, input.requestId) : undefined,
      },
    );

    return summarizeThread(target);
  });

  const orchestration = {
    listThreads: (callerId: string) =>
      Effect.map(getEntry(callerId), (caller) => ({
        threads: [...threads.values()]
          .filter(
            (entry) =>
              entry !== caller &&
              entry.info.projectId === caller.info.projectId &&
              entry.info.archivedAt === null,
          )
          .sort((first, second) => second.info.updatedAt - first.info.updatedAt)
          .slice(0, 50)
          .map(summarizeThread),
      })),
    readThread: (_callerId: string, threadId: string, after: number | undefined) =>
      Effect.map(getTargetEntry(threadId), (entry) => {
        const messages = store.readAfter(threadId, after ?? 0).flatMap(({ id, event }) =>
          RuntimeEvent.isAnyOf(["user.message", "assistant.completed"])(event)
            ? [
                {
                  position: id,
                  from: RuntimeEvent.guards["user.message"](event) ? "user" : "assistant",
                  text: event.text.length > 8000 ? `${event.text.slice(0, 8000)}…` : event.text,
                },
              ]
            : [],
        );

        return {
          ...summarizeThread(entry),
          messages: messages.slice(0, 50),
          ...(messages.length > 50 && { more: true }),
        };
      }),
    startThread,
    sendMessage,
    waitForThread: (_callerId: string, threadId: string, timeoutMs: number) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) => waitForTurn(entry, timeoutMs)),
    stopThread: (_callerId: string, threadId: string) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) =>
        Effect.as(interrupt(entry), summarizeThread(entry)),
      ),
  };

  const mcp = createMcp(
    (threadId, action) => browsers.request(threadId, action),
    orchestration,
    devices,
  );

  /**
   * Moves the thread to another harness for its next turns. Nothing is handed over yet: the
   * next message takes what the new harness missed, so switching back and forth costs nothing.
   */
  const switchHarness = Effect.fn("switchHarness")(function* (
    entry: ThreadEntry,
    provider: ProviderKind,
    model: string | null,
  ) {
    if (isBusy(entry))
      return yield* new CommandError({
        message: "Stop the agent, or wait for its turn to end, before switching harness",
      });

    yield* ensureHarnessReady(provider);
    yield* dropSession(entry, null);

    const threadId = entry.info.id;
    const from = entry.info.provider;
    // Messages from before switching existed don't say where they went: here, to `from`.
    store.tagUserMessages(threadId, from);
    setCoverage(entry, {
      ...entry.coverage,
      // The harness left has everything so far, unless it hadn't caught up yet itself.
      [from]: entry.coverage[from] ?? store.readCursor(threadId),
      // One with no conversation of its own gets all of it.
      ...(entry.resumeTokens[provider] === undefined && { [provider]: 0 }),
    });
    entry.info = { ...entry.info, provider, model };
    store.setProvider(threadId, provider, model);
    publish(RuntimeEvent.cases["thread.model"].make({ threadId, provider, model }));
  });

  /** Picks a thread up after a usage limit stopped it, on `provider` when given. */
  const resumeAfterLimit = Effect.fn("resumeAfterLimit")(function* (
    entry: ThreadEntry,
    options: TurnOptions,
    provider?: ProviderKind,
  ) {
    if (!entry.info.limitStop || isBusy(entry)) return;

    if (provider && provider !== entry.info.provider) yield* switchHarness(entry, provider, null);
    setLimitStop(entry, null);

    const [next] = entry.queue;
    if (next) return sendQueued(entry, next);

    yield* send(entry, "Continue where you left off.", options);
  });

  /** Announces the branches after `run` switched or created one, and the meta of threads in `path`. */
  const changeBranch = Effect.fn("changeBranch")(function* (
    path: string,
    run: () => Promise<string | null>,
  ) {
    const error = yield* Effect.promise(run);
    yield* publishBranches(path, error);
    for (const entry of threads.values()) if (entry.info.cwd === path) refreshMeta(entry);
  });

  function dispatch(
    command: ClientCommand,
  ): Effect.Effect<void, CommandError | ProviderError | ProjectNotFound> {
    return ClientCommand.match(command, {
      "thread.create": createThread,
      "thread.send": (command) =>
        Effect.flatMap(getEntry(command.threadId), (entry) =>
          send(entry, command.text, command.options, command),
        ),
      "thread.sendQueued": ({ threadId, messageId }) =>
        Effect.map(getEntry(threadId), (entry) => {
          const message = entry.queue.find((queued) => queued.id === messageId);
          if (message) sendQueued(entry, message);
        }),
      "thread.unqueue": ({ threadId, messageIds }) =>
        Effect.map(getEntry(threadId), (entry) =>
          setQueue(
            entry,
            entry.queue.filter((queued) => !messageIds.includes(queued.id)),
          ),
        ),
      "thread.resumeAfterLimit": ({ threadId, options, provider }) =>
        Effect.flatMap(getEntry(threadId), (entry) => resumeAfterLimit(entry, options, provider)),
      "thread.resumeAtReset": ({ threadId, options }) =>
        Effect.map(getEntry(threadId), (entry) => {
          const stop = entry.info.limitStop;
          if (stop) setLimitStop(entry, { ...stop, resumeAtReset: options });
        }),
      "thread.dismissLimitStop": ({ threadId }) =>
        Effect.map(getEntry(threadId), (entry) => {
          if (entry.info.limitStop) setLimitStop(entry, null);
        }),
      "thread.rewind": rewind,
      "thread.fork": fork,
      "sideChat.ask": askSideChat,
      "sideChat.close": ({ sideChatId }) => closeSideChat(sideChatId),
      "thread.compact": (command) => compact(command.threadId),
      "thread.listCommands": (command) => listCommands(command.threadId),
      "skills.list": (command) =>
        Effect.sync(() => skills.requestListing(command.provider, command.path)),
      "thread.readUsage": (command) => Effect.promise(() => readUsage(command.threadId)),
      "checkpoint.diff": (command) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(command.threadId);
          const diff = yield* Effect.promise(() =>
            readCheckpointDiff(entry.info.cwd, command.threadId, command.messageId),
          );
          publish(
            RuntimeEvent.cases["checkpoint.diff"].make({
              threadId: command.threadId,
              messageId: command.messageId,
              ...diff,
            }),
          );
        }),
      "git.listBranches": (command) => publishBranches(command.path),
      "git.listFiles": ({ path }) =>
        Effect.promise(() => listFiles(path)).pipe(
          Effect.map((files) => publish(RuntimeEvent.cases["git.files"].make({ path, files }))),
        ),
      "git.diff": (command) => Effect.promise(() => refreshDiff(command.path)),
      "git.checkout": ({ path, branch }) => changeBranch(path, () => checkoutBranch(path, branch)),
      "git.createBranch": ({ path, branch }) =>
        changeBranch(path, () => createBranch(path, branch)),
      "git.status": (command) => Effect.promise(() => refreshStatus(command.path)),
      "git.commit": (command) => {
        const { path } = command;
        const action: GitAction = command.push ? "commit-push" : "commit";
        return runWithRepoLock(
          path,
          Effect.gen(function* () {
            const written = command.message.trim()
              ? { message: command.message }
              : yield* writeCommitMessage(path);
            let error =
              "error" in written
                ? written.error
                : yield* Effect.promise(() => commitAll(path, written.message));
            if (!error && command.push) error = yield* Effect.promise(() => pushBranch(path));

            yield* publishStatus(path, action, error);

            const diff = yield* Effect.promise(() => readDiff(path));
            publish(RuntimeEvent.cases["git.diff"].make({ path, ...diff }));
          }),
        );
      },
      "git.push": ({ path }) =>
        runWithRepoLock(
          path,
          Effect.gen(function* () {
            const error = yield* Effect.promise(() => pushBranch(path));
            yield* publishStatus(path, "push", error);
          }),
        ),
      "git.createPullRequest": ({ path }) =>
        runWithRepoLock(
          path,
          Effect.gen(function* () {
            const error = yield* Effect.promise(() => createPullRequest(path));
            forgetPullRequest(path);
            yield* publishStatus(path, "pull-request", error);
          }),
        ),
      "git.mergePullRequest": ({ path, method }) =>
        runWithRepoLock(
          path,
          Effect.gen(function* () {
            const status = yield* Effect.promise(() => readRepo(path));
            const sourceControl = status?.sourceControl;
            const pullRequest = status?.pullRequest;
            const error =
              !sourceControl ||
              !pullRequest ||
              (pullRequest.state !== "open" && pullRequest.state !== "draft")
                ? "This branch has no open pull request"
                : yield* Effect.promise(() =>
                    mergePullRequest(path, sourceControl, pullRequest.number, method),
                  );
            forgetPullRequest(path);
            yield* publishStatus(path, "merge", error);
          }),
        ),
      "git.mergeIntoBase": ({ path }) =>
        runWithRepoLock(
          path,
          Effect.gen(function* () {
            const error = yield* Effect.promise(() => mergeIntoBase(path));
            yield* publishStatus(path, "merge-into-base", error);
          }),
        ),
      "sourceControl.refresh": () =>
        Effect.promise(async () => {
          hosts.clear();
          publish(
            RuntimeEvent.cases["sourceControl.updated"].make({
              statuses: await probeSourceControl(),
            }),
          );
        }),
      "thread.setModel": ({ threadId, provider, model }) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(threadId);
          if (provider && provider !== entry.info.provider)
            return yield* switchHarness(entry, provider, model);

          entry.info = { ...entry.info, model };
          store.setModel(threadId, model);
          publish(
            RuntimeEvent.cases["thread.model"].make({
              threadId,
              provider: entry.info.provider,
              model,
            }),
          );
          if (entry.session) yield* entry.session.setModel(model);
        }),
      "project.add": (command) =>
        projectsStore
          .ensure(command.path)
          .pipe(
            Effect.map(({ project, isNew }) =>
              isNew ? publish(RuntimeEvent.cases["project.added"].make({ project })) : undefined,
            ),
          ),
      "project.scan": (command) =>
        Effect.gen(function* () {
          async function findRepos(folder: string, levels: number): Promise<Array<string>> {
            if (existsSync(join(folder, ".git"))) return [folder];
            if (levels === 0) return [];
            const { path, folders } = await listFolders(folder);
            return (
              await Promise.all(folders.map((name) => findRepos(join(path, name), levels - 1)))
            ).flat();
          }

          // Three levels, never inside a repo: the home folder's default still finds ~/code/group/repo,
          // without walking dependency and cache trees.
          const repos = yield* Effect.promise(() =>
            findRepos(resolve(expandHome(command.path)), 3),
          );
          yield* Effect.forEach(repos, (folder) =>
            projectsStore.ensure(folder).pipe(
              Effect.map(({ project, isNew }) =>
                isNew ? publish(RuntimeEvent.cases["project.added"].make({ project })) : undefined,
              ),
              Effect.ignore,
            ),
          );
        }),
      "providers.refresh": () => registry.refresh,
      "provider.link": (command) => registry.link(command.provider),
      "provider.linkCode": (command) => registry.submitCode(command.provider, command.code),
      "provider.linkCancel": (command) => registry.cancelLink(command.provider),
      "provider.unlink": (command) => registry.unlink(command.provider),
      "provider.readLimits": (command) => Effect.promise(() => readLimits(command.provider)),
      "thread.interrupt": (command) => Effect.flatMap(getEntry(command.threadId), interrupt),
      "thread.stopAgent": (command) =>
        runOnLiveSession(
          command.threadId,
          (session) => session.stopAgent?.(command.toolId) ?? Effect.void,
        ),
      "approval.respond": (command) =>
        runOnLiveSession(command.threadId, (session) =>
          session.respondApproval(command.requestId, command.decision, command),
        ),
      "thread.close": (command) => removeThread(command.threadId),
      "thread.archive": (command) =>
        Effect.flatMap(getEntry(command.threadId), (entry) => setArchived(entry, command.archived)),
      // A window showing an older update than another already marked can't take the mark back.
      "thread.seen": ({ threadId, rev }) =>
        Effect.map(getEntry(threadId), (entry) => {
          if (rev <= entry.info.seenRev) return;

          entry.info = { ...entry.info, seenRev: rev };
          store.setSeenRev(threadId, rev);
          publish(RuntimeEvent.cases["thread.seen"].make({ threadId, seenRev: rev }));
        }),
      "thread.rename": ({ threadId, title }) =>
        Effect.map(getEntry(threadId), (entry) =>
          setTitle(entry, deriveTitle(title, entry.info.title)),
        ),
      "thread.shelve": ({ threadId, shelved }) =>
        Effect.map(getEntry(threadId), (entry) => {
          setShelveOverride(entry, shelved ? "shelved" : "active");
          refreshShelved(entry);
        }),
      "project.remove": (command) =>
        Effect.gen(function* () {
          if (!(yield* projectsStore.remove(command.projectId))) return;

          const owned = [...threads.values()].filter(
            (entry) => entry.info.projectId === command.projectId,
          );
          yield* Effect.forEach(owned, (entry) => removeThread(entry.info.id), { discard: true });
          publish(RuntimeEvent.cases["project.removed"].make({ projectId: command.projectId }));
        }),
      "terminal.write": (command) =>
        Effect.sync(() => terminals.write(command.threadId, command.terminalId, command.data)),
      "terminal.resize": (command) =>
        Effect.sync(() =>
          terminals.resize(command.threadId, command.terminalId, command.columns, command.rows),
        ),
      "terminal.close": (command) =>
        Effect.sync(() => terminals.close(command.threadId, command.terminalId)),
      "terminal.run": ({ threadId, terminalId, command, columns, rows, options }) =>
        Effect.flatMap(getEntry(threadId), (entry) => {
          const runError = terminals.run(threadId, terminalId, command, columns, rows, (exit) => {
            if (exit.wasStopped) return;
            const run = { command, exitCode: exit.exitCode, output: exit.output };
            runFork(
              send(entry, formatCommandRun(run), options, { run }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
                    publish(RuntimeEvent.cases.error.make({ threadId, message: error.message })),
                  ),
                ),
              ),
            );
          });
          return runError
            ? Effect.fail(
                new CommandError({ message: `Couldn't run the command: ${runError.message}` }),
              )
            : Effect.void;
        }),
      // Per connection; the server answers these.
      "thread.subscribe": () => Effect.void,
      "thread.unsubscribe": () => Effect.void,
      "thread.loadOlder": () => Effect.void,
      search: () => Effect.void,
      "folder.list": () => Effect.void,
      "project.config": () => Effect.void,
      "project.saveConfig": () => Effect.void,
      "image.sign": () => Effect.void,
      "project.clone": () => Effect.void,
      "terminal.open": () => Effect.void,
      "terminal.detach": () => Effect.void,
      "terminal.acknowledge": () => Effect.void,
      "browser.host": () => Effect.void,
      "browser.respond": () => Effect.void,
      "device.list": () => Effect.void,
      "device.attach": () => Effect.void,
      "settings.update": (command) =>
        Effect.gen(function* () {
          const before = yield* settingsStore.get;
          const settings = yield* settingsStore.update(command.settings);
          publish(RuntimeEvent.cases["settings.updated"].make({ settings }));

          // A different binary, config dir or env can mean another version or account.
          function serializeLaunchSettings(value: Settings) {
            return JSON.stringify(
              ProviderKind.literals.map((kind) => {
                const { binaryPath, configDir, env, launchArgs } = value.providers[kind];
                return [binaryPath, configDir, env, launchArgs];
              }),
            );
          }

          if (serializeLaunchSettings(before) !== serializeLaunchSettings(settings))
            yield* registry.refresh;
        }),
    });
  }

  return SessionManager.of({
    dispatch: (command) =>
      dispatch(command).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            publish(
              RuntimeEvent.cases.error.make({
                threadId: "threadId" in command ? command.threadId : null,
                message: error.message,
              }),
            ),
          ),
        ),
      ),
    subscribe: Effect.map(
      Effect.all([PubSub.subscribe(pubsub), settingsStore.get, projectsStore.list, registry.list]),
      ([subscription, settings, projects, providers]) => ({
        dataId: store.dataId,
        settings,
        projects,
        providers,
        threads: [...threads.values()].map((entry) => entry.info),
        terminals: terminals.list(),
        live: Stream.fromSubscription(subscription),
      }),
    ),
    terminals,
    browsers,
    devices,
    mcp,
    readThread: (threadId, after, turnLimit) => {
      if (!threads.has(threadId)) return null;

      const live = [...streaming.values()].filter((delta) => delta.threadId === threadId);
      const cursor = store.readCursor(threadId);
      // A cursor past the end means the cache is from another database: start over.
      // Sized before anything is decoded, so a huge gap never gets read.
      if (after !== null && after <= cursor) {
        const { count, bytes } = store.measureAfter(threadId, after);
        if (count <= MAX_REPLAY && bytes <= MAX_REPLAY_BYTES) {
          return {
            seq,
            frame: ServerFrame.cases["thread.replay"].make({
              threadId,
              events: store.readAfter(threadId, after),
              streaming: live,
              cursor,
            }),
          };
        }
      }
      const { events, page } = store.readTurns(threadId, turnLimit);
      return {
        seq,
        frame: ServerFrame.cases["thread.snapshot"].make({
          threadId,
          events,
          streaming: live,
          cursor,
          page,
        }),
      };
    },
    readOlder: (threadId, before, turnLimit) => {
      if (!threads.has(threadId)) return null;

      const { events, page } = store.readTurns(threadId, turnLimit, before);
      return { events, page: page ?? { before, hasMore: false } };
    },
    search: (query) => store.search(query, 50).filter((hit) => threads.has(hit.threadId)),
    hasActiveTurns: () => [...threads.values()].some(isBusy),
    shutdown: Effect.gen(function* () {
      flushDeltas();
      terminals.closeAll();

      yield* Effect.promise(() => devices.close());
      yield* Effect.forEach([...sideChats.keys()], closeSideChat, { discard: true });
      yield* Effect.forEach(
        [...threads.values()],
        (entry) =>
          dropSession(
            entry,
            "MassCode quit while this turn was running. Send a message to pick up where it left off.",
          ),
        { discard: true },
      );
    }),
  });
});

export const layer = Layer.effect(SessionManager, make);
