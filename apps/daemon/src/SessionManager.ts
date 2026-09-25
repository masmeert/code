import type {
  Attachment,
  AttachmentInput,
  ClientCommand,
  GitAction,
  PageInfo,
  Project,
  ProviderEvent,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  SearchHit,
  Settings,
  StoredEvent,
  TerminalInfo,
  ThreadInfo,
  TurnOptions,
} from "@apcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { generateCommitMessage } from "./commitMessage.ts";
import {
  addWorktree,
  captureCheckpoint,
  checkoutBranch,
  checkpointRef,
  commitAll,
  createBranch,
  deleteCheckpoints,
  deleteThreadCheckpoints,
  hasCheckpoint,
  listBranches,
  pushBranch,
  readBranch,
  readCheckpointDiff,
  readCheckpointStats,
  readDiff,
  readRecentSubjects,
  readStatus,
  removeWorktreeIfClean,
  repoRoot,
  restoreCheckpoint,
} from "./git.ts";
import { ClaudeAdapter } from "./providers/ClaudeAdapter.ts";
import { CodexAdapter } from "./providers/CodexAdapter.ts";
import { ProviderError, type ProviderAdapter, type ProviderSession } from "./providers/ProviderAdapter.ts";
import { ProviderRegistry } from "./providers/ProviderRegistry.ts";
import { DATA_DIR } from "./storage/jsonFile.ts";
import { ProjectsStore } from "./storage/ProjectsStore.ts";
import { SettingsStore } from "./storage/SettingsStore.ts";
import { isPersisted, ThreadStore } from "./storage/ThreadStore.ts";
import { type Browsers, createBrowsers } from "./browsers.ts";
import { createMcp, type Mcp } from "./mcp.ts";
import { createTerminals, type Terminals } from "./terminals.ts";

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = { claude: ClaudeAdapter, codex: CodexAdapter };

export interface SequencedEvent {
  /** Publish order, in memory only; lets a connection skip what a transcript read already covered. */
  readonly seq: number;
  /** Stored events' id, the clients' resume cursor. */
  readonly id: number | null;
  readonly event: RuntimeEvent;
}

/** A transcript read, taken at publish position `seq`. */
export type ThreadRead =
  | {
      readonly _tag: "thread.snapshot";
      readonly events: ReadonlyArray<StoredEvent>;
      readonly streaming: ReadonlyArray<RuntimeEvent>;
      readonly cursor: number;
      readonly page: PageInfo | null;
      readonly seq: number;
    }
  | {
      readonly _tag: "thread.replay";
      readonly events: ReadonlyArray<StoredEvent>;
      readonly streaming: ReadonlyArray<RuntimeEvent>;
      readonly cursor: number;
      readonly seq: number;
    };

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
const REAP_INTERVAL_MS = 5 * 60 * 1000;

type AssistantDelta = Extract<RuntimeEvent, { _tag: "assistant.delta" }>;

interface ThreadEntry {
  info: ThreadInfo;
  /** Null until the first message after creation or restart; agent processes start lazily. */
  session: ProviderSession | null;
  resumeToken: string | null;
  /** Last time the thread's agent did or was asked anything; the reaper stops long-idle sessions. */
  activeAt: number;
  /** The user message that started the turn in progress; its snapshots bracket the turn. */
  currentTurn: string | null;
  readonly lock: Semaphore.Semaphore;
}

/**
 * Runs `load` for a key one at a time. Calls made while it runs share a single
 * follow-up run, so a burst of refreshes costs at most two, and no caller gets a
 * result that started before it asked.
 */
const coalesced = <A>(load: (key: string) => Promise<A>) => {
  const inFlight = new Map<string, Promise<A>>();
  const queued = new Map<string, Promise<A>>();
  const run = (key: string): Promise<A> => {
    const promise: Promise<A> = load(key).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
  return (key: string): Promise<A> => {
    const current = inFlight.get(key);
    if (!current) return run(key);
    const next = queued.get(key);
    if (next) return next;
    const follow = current
      .catch(() => undefined)
      .then(() => {
        queued.delete(key);
        return run(key);
      });
    queued.set(key, follow);
    return follow;
  };
};

export class SessionManager extends Context.Service<
  SessionManager,
  {
    readonly dispatch: (command: ClientCommand) => Effect.Effect<void, ProviderError>;
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
    readonly mcp: Mcp;
    /**
     * A thread's transcript: what was missed since `after`, or the latest `turnLimit` turns.
     * Synchronous, so live events with a `seq` above the read's are exactly the ones it lacks.
     */
    readonly readThread: (threadId: string, after: number | null, turnLimit: number) => ThreadRead | null;
    readonly readOlder: (
      threadId: string,
      before: number,
      turnLimit: number,
    ) => { readonly events: ReadonlyArray<StoredEvent>; readonly page: PageInfo } | null;
    /** Messages matching `query`, newest first, in threads that still exist. */
    readonly search: (query: string) => ReadonlyArray<SearchHit>;
    readonly shutdown: Effect.Effect<void>;
  }
>()("apcode/SessionManager") {}

const fail = (message: string) => new ProviderError({ provider: "none", message });

/** A thread is named after its first message, like a chat title. */
const titleFrom = (text: string, fallback: string) => {
  const line = text.trim().split("\n")[0]!.trim();
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
const WORKTREES_DIR = join(DATA_DIR, "worktrees");

/** Puts every attachment on disk: paths pass through, pasted bytes are written under the data dir. */
const resolveAttachments = (inputs: ReadonlyArray<AttachmentInput>) =>
  Effect.tryPromise({
    try: () =>
      Promise.all(
        inputs.map(async (input): Promise<Attachment> => {
          if (input._tag === "path") {
            return { name: basename(input.path), path: input.path, isImage: IMAGE_EXTENSIONS.has(extname(input.path).toLowerCase()) };
          }
          await mkdir(ATTACHMENTS_DIR, { recursive: true });
          const extension = extname(input.name) || `.${input.mediaType.split("/")[1] ?? "bin"}`;
          const path = join(ATTACHMENTS_DIR, `${crypto.randomUUID()}${extension}`);
          await writeFile(path, Buffer.from(input.data, "base64"));
          return { name: input.name, path, isImage: input.mediaType.startsWith("image/") };
        }),
      ),
    catch: (e) => fail(`Couldn't attach files: ${e instanceof Error ? e.message : String(e)}`),
  });

const make = Effect.gen(function* () {
  const settingsStore = yield* SettingsStore;
  const projectsStore = yield* ProjectsStore;
  const store = yield* ThreadStore;
  const registry = yield* ProviderRegistry;
  const pubsub = yield* PubSub.unbounded<SequencedEvent>();
  const threads = new Map<string, ThreadEntry>();
  /** Text published so far of messages still streaming, keyed by message id; dropped once the message completes. */
  const streaming = new Map<string, { readonly threadId: string; readonly text: string }>();
  /** Deltas waiting for the next flush, merged per message. */
  const pendingDeltas = new Map<string, AssistantDelta>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  // --- restore -------------------------------------------------------------
  for (const { info, resumeToken } of yield* store.load) {
    threads.set(info.id, { info, session: null, resumeToken, activeAt: Date.now(), currentTurn: null, lock: yield* Semaphore.make(1) });
  }
  // Approvals pending when the daemon stopped died with their agent process.
  for (const [requestId, threadId] of store.unresolvedApprovals()) {
    store.appendEvent(threadId, { _tag: "approval.resolved", threadId, requestId });
  }
  // Threads from before auto-titles are still named after their project folder.
  for (const entry of threads.values()) {
    if (entry.info.title !== basename(entry.info.cwd)) continue;
    const text = store.firstUserMessage(entry.info.id);
    if (text === null) continue;
    entry.info = { ...entry.info, title: titleFrom(text, entry.info.title) };
    store.setMeta(entry.info.id, { title: entry.info.title, updatedAt: entry.info.updatedAt });
  }

  // --- event flow ----------------------------------------------------------
  registry.setListener({
    providers: (providers) => publish({ _tag: "providers.updated", providers: [...providers] }),
    flow: (flow) => publish({ _tag: "auth.flow", flow }),
  });

  /** Re-reads the branch (a turn may have switched it) and announces the thread's current meta. */
  const refreshMeta = (entry: ThreadEntry) => {
    void readBranch(entry.info.cwd).then((branch) => {
      if (threads.get(entry.info.id) !== entry) return;
      entry.info = { ...entry.info, branch };
      const { id: threadId, title, updatedAt } = entry.info;
      publish({ _tag: "thread.meta", threadId, title, updatedAt, branch });
    });
  };

  /** Marks activity on a thread: new message or finished turn. */
  const touch = (threadId: string) => {
    const entry = threads.get(threadId);
    if (!entry) return;
    entry.info = { ...entry.info, updatedAt: Date.now() };
    store.setMeta(threadId, { title: entry.info.title, updatedAt: entry.info.updatedAt });
    refreshMeta(entry);
  };

  const flushDeltas = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingDeltas.size === 0) return;
    const batch = [...pendingDeltas.values()];
    pendingDeltas.clear();
    for (const event of batch) emit(event);
  };

  const publish = (event: RuntimeEvent) => {
    if (event._tag === "assistant.delta") {
      const pending = pendingDeltas.get(event.messageId);
      pendingDeltas.set(event.messageId, pending ? { ...pending, delta: pending.delta + event.delta } : event);
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);
      return;
    }
    flushDeltas();
    emit(event);
  };

  const emit = (event: RuntimeEvent) => {
    let id: number | null = null;
    if (event._tag === "assistant.delta") {
      const text = streaming.get(event.messageId)?.text ?? "";
      streaming.set(event.messageId, { threadId: event.threadId, text: text + event.delta });
    } else if (isPersisted(event)) {
      if (event._tag === "assistant.completed") streaming.delete(event.messageId);
      id = store.appendEvent((event as { threadId: string }).threadId, event);
    }
    if (event._tag === "thread.status") {
      const entry = threads.get(event.threadId);
      if (entry) entry.info = { ...entry.info, status: event.status };
    }
    if ("threadId" in event && event.threadId) {
      const entry = threads.get(event.threadId);
      if (entry) entry.activeAt = Date.now();
    }
    PubSub.publishUnsafe(pubsub, { seq: ++seq, id, event });
    if (event._tag === "user.message" || event._tag === "turn.completed") touch(event.threadId);
  };

  for (const entry of threads.values()) refreshMeta(entry);

  const terminals = createTerminals({
    folderOf: (threadId) => threads.get(threadId)?.info.cwd ?? null,
    opened: (terminal) => publish({ _tag: "terminal.opened", ...terminal }),
    closed: (terminal) => publish({ _tag: "terminal.closed", ...terminal }),
  });
  const browsers = createBrowsers();
  const mcp = createMcp((threadId, action) => browsers.request(threadId, action));

  const getEntry = (threadId: string) =>
    Effect.suspend(() => {
      const entry = threads.get(threadId);
      return entry ? Effect.succeed(entry) : Effect.fail(fail(`No thread ${threadId}`));
    });

  /** Starts (or resumes) the agent process for a thread if it isn't running. */
  const ensureSession = (entry: ThreadEntry, options: TurnOptions) =>
    entry.lock.withPermit(
      Effect.suspend(() => {
        if (entry.session) return Effect.succeed(entry.session);
        const threadId = entry.info.id;
        return Effect.flatMap(settingsStore.get, (settings) =>
          ADAPTERS[entry.info.provider].start({
            cwd: entry.info.cwd,
            model: entry.info.model ?? settings.providers[entry.info.provider].defaultModel ?? undefined,
            resumeToken: entry.resumeToken ?? undefined,
            effort: options.effort,
            permission: options.permission,
            onResumeToken: (token) => {
              entry.resumeToken = token;
              store.setResumeToken(threadId, token);
            },
            emit: (event: ProviderEvent) => {
              // The agent process ending isn't the thread ending: drop the session so the next message resumes it.
              if (event._tag === "thread.status" && event.status === "closed") {
                entry.session = null;
                if (threads.has(threadId)) publish({ _tag: "thread.status", threadId, status: "idle" });
                return;
              }
              publish({ ...event, threadId } as RuntimeEvent);
              if (event._tag === "turn.completed") endTurn(entry);
            },
            mcpServer: mcp.issue(threadId),
          }),
        ).pipe(Effect.tap((session) => Effect.sync(() => (entry.session = session))));
      }),
    );

  /**
   * Snapshots the folder after a turn and announces what the turn changed. Runs in the
   * background: the turn is over either way.
   */
  const endTurn = (entry: ThreadEntry) => {
    const messageId = entry.currentTurn;
    entry.currentTurn = null;
    if (!messageId) return;
    const { id: threadId, cwd } = entry.info;
    void (async () => {
      if (!(await captureCheckpoint(cwd, checkpointRef(threadId, messageId, "end")))) return;
      const stats = await readCheckpointStats(cwd, threadId, messageId);
      if (!stats || stats.files === 0 || threads.get(threadId) !== entry) return;
      publish({ _tag: "turn.checkpoint", threadId, messageId, ...stats });
    })();
  };

  /** Runs `f` against the thread's live session, if it has one. */
  const withLiveSession = (threadId: string, f: (session: ProviderSession) => Effect.Effect<void, ProviderError>) =>
    Effect.flatMap(getEntry(threadId), (entry) => (entry.session ? f(entry.session) : Effect.void));

  const removeThread = (threadId: string) =>
    Effect.gen(function* () {
      const entry = threads.get(threadId);
      if (!entry) return;
      threads.delete(threadId);
      terminals.closeThread(threadId);
      mcp.revoke(threadId);
      if (entry.session) yield* entry.session.close;
      store.deleteThread(threadId);
      const { cwd, worktree } = entry.info;
      void (async () => {
        await deleteThreadCheckpoints(cwd, threadId);
        // A worktree with work left in it stays for the user to deal with; its branch always stays.
        if (worktree) {
          const root = await repoRoot(cwd);
          if (root) await removeWorktreeIfClean(root);
        }
      })();
      for (const [messageId, message] of streaming) if (message.threadId === threadId) streaming.delete(messageId);
      for (const [messageId, delta] of pendingDeltas) if (delta.threadId === threadId) pendingDeltas.delete(messageId);
      publish({ _tag: "thread.removed", threadId });
    });

  const setArchived = (entry: ThreadEntry, archived: boolean) =>
    Effect.gen(function* () {
      if ((entry.info.archivedAt !== null) === archived) return;
      const archivedAt = archived ? Date.now() : null;
      entry.info = { ...entry.info, archivedAt };
      store.setArchived(entry.info.id, archivedAt);
      publish({ _tag: "thread.archived", threadId: entry.info.id, archivedAt });
      if (archived) terminals.closeThread(entry.info.id);
      if (archived) mcp.revoke(entry.info.id);
      // An archived thread shouldn't keep an agent process around; the next message resumes it.
      if (archived && entry.session) {
        const session = entry.session;
        entry.session = null;
        yield* session.close;
      }
    });

  const send = (entry: ThreadEntry, text: string, options: TurnOptions) =>
    Effect.gen(function* () {
      const threadId = entry.info.id;
      // Writing in an archived thread brings it back.
      yield* setArchived(entry, false);
      const attachments = yield* resolveAttachments(options.attachments);
      const messageId = crypto.randomUUID();
      const turn = { messageId, text, attachments, effort: options.effort, permission: options.permission };
      // A turn is running: the message joins it.
      const { status } = entry.info;
      if (entry.session && (status === "running" || status === "awaiting-approval")) {
        publish({ _tag: "user.message", threadId, messageId, text, ...(attachments.length ? { attachments } : {}), steer: true });
        return yield* entry.session.steer(turn);
      }
      publish({ _tag: "user.message", threadId, messageId, text, ...(attachments.length ? { attachments } : {}) });
      publish({ _tag: "thread.status", threadId, status: "running" });
      // Snapshot the folder before the agent touches it, so the turn's changes can be shown and undone.
      entry.currentTurn = messageId;
      yield* Effect.promise(() => captureCheckpoint(entry.info.cwd, checkpointRef(threadId, messageId, "start")));
      const session = yield* ensureSession(entry, options).pipe(
        Effect.tapError(() => Effect.sync(() => publish({ _tag: "thread.status", threadId, status: "error" }))),
      );
      yield* session.send(turn);
    });

  const isBusy = (entry: ThreadEntry) => entry.info.status === "running" || entry.info.status === "awaiting-approval";

  /**
   * Rewinds to before a user message: the provider's conversation first (the step that
   * can refuse), then the transcript, then, if asked, the files.
   */
  const rewind = (command: Extract<ClientCommand, { _tag: "thread.rewind" }>) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(command.threadId);
      const { id: threadId, cwd, provider } = entry.info;
      if (isBusy(entry)) return yield* Effect.fail(fail("Stop the agent before rewinding"));
      const found = store.findUserMessage(threadId, command.messageId);
      if (!found) return yield* Effect.fail(fail("That message is gone"));
      if (found.event.steer) return yield* Effect.fail(fail("A message sent mid-turn can't be rewound to"));
      if (command.restoreFiles) {
        if ([...threads.values()].some((other) => other !== entry && other.info.cwd === cwd && isBusy(other))) {
          return yield* Effect.fail(fail("Another thread is working in this folder; restoring files would undo its changes too"));
        }
        if (!(yield* Effect.promise(() => hasCheckpoint(cwd, threadId, command.messageId)))) {
          return yield* Effect.fail(fail("There's no snapshot of the files from that point"));
        }
      }
      if (entry.session) {
        const session = entry.session;
        entry.session = null;
        yield* session.close;
      }
      if (entry.resumeToken) {
        const token = yield* ADAPTERS[provider].rewind({
          cwd,
          resumeToken: entry.resumeToken,
          messageId: command.messageId,
          keep: found.before,
          dropTurns: found.from.filter((message) => !message.steer).length,
        });
        entry.resumeToken = token;
        store.setResumeToken(threadId, token);
      }
      store.truncate(threadId, found.seq);
      publish({ _tag: "thread.rewound", threadId, messageId: command.messageId });
      touch(threadId);
      const error = command.restoreFiles ? yield* Effect.promise(() => restoreCheckpoint(cwd, threadId, command.messageId)) : null;
      void deleteCheckpoints(cwd, threadId, found.from.map((message) => message.messageId));
      if (error) return yield* Effect.fail(fail(`Rewound the conversation, but couldn't restore the files: ${error}`));
    });

  const compact = (threadId: string) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(threadId);
      if (isBusy(entry)) return yield* Effect.fail(fail("Wait for the agent to finish before compacting"));
      if (!entry.resumeToken && !entry.session) return;
      const session = yield* ensureSession(entry, { effort: null, permission: "ask", attachments: [] });
      yield* session.compact;
    });

  const listCommands = (threadId: string) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(threadId);
      const commands = entry.session ? yield* entry.session.commands.pipe(Effect.orElseSucceed(() => [])) : [];
      publish({ _tag: "thread.commands", threadId, commands: [...commands] });
    });

  /** Stops agent processes nobody has used in a while; they resume from their token on the next message. */
  const reapIdleSessions = Effect.gen(function* () {
    const now = Date.now();
    for (const entry of threads.values()) {
      const { status } = entry.info;
      if (!entry.session || status === "running" || status === "awaiting-approval") continue;
      if (now - entry.activeAt < SESSION_IDLE_MS) continue;
      const session = entry.session;
      entry.session = null;
      yield* session.close;
    }
  });
  const reaper = setInterval(() => Effect.runFork(reapIdleSessions), REAP_INTERVAL_MS);
  yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(reaper)));

  /** Announces the branches at `path`; `error` reports a failed checkout alongside them. */
  const publishBranches = (path: string, error: string | null = null) =>
    Effect.promise(() => listBranches(path)).pipe(
      Effect.map(({ current, branches }) => publish({ _tag: "git.branches", path, current, branches, error })),
    );

  /** Announces the repo state at `path`; `action`/`error` report the commit or push it answers. */
  const publishStatus = (path: string, action: GitAction | null = null, error: string | null = null) =>
    Effect.promise(() => readStatus(path)).pipe(
      Effect.map((status) => publish({ _tag: "git.status", path, status, action, error })),
    );

  // Plain refreshes (every window, every finished tool call) coalesce per repo.
  const refreshStatus = coalesced((path) => readStatus(path).then((status) => publish({ _tag: "git.status", path, status, action: null, error: null })));
  const refreshDiff = coalesced((path) => readDiff(path).then((diff) => publish({ _tag: "git.diff", path, ...diff })));

  /** A message for everything uncommitted at `path`, from the commit model in settings. */
  const writeCommitMessage = (path: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsStore.get;
      const split = settings.commitModel?.indexOf(":") ?? -1;
      const provider = split > 0 ? (settings.commitModel!.slice(0, split) as ProviderKind) : settings.lastProvider;
      const model = split > 0 ? settings.commitModel!.slice(split + 1) : settings.providers[provider].defaultModel;
      const [diff, recent] = yield* Effect.promise(() => Promise.all([readDiff(path), readRecentSubjects(path)]));
      if (diff.error) return { error: diff.error };
      if (!diff.patch) return { error: "Nothing to commit" };
      return yield* Effect.tryPromise({
        try: () => generateCommitMessage({ cwd: path, provider, model: model || undefined, patch: diff.patch, recent }),
        catch: (e) => `Couldn't write a commit message: ${e instanceof Error ? e.message : String(e)}`,
      }).pipe(
        Effect.map((message) => ({ message })),
        Effect.catch((error) => Effect.succeed({ error })),
      );
    });

  /** Commits and pushes on one repo run one at a time. */
  const gitLocks = new Map<string, Semaphore.Semaphore>();
  const withRepoLock = <A, E>(path: string, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      let lock = gitLocks.get(path);
      if (!lock) {
        lock = yield* Semaphore.make(1);
        gitLocks.set(path, lock);
      }
      return yield* lock.withPermit(effect);
    });

  /**
   * A worktree of the project's repo on a new branch named after the thread, under the
   * data dir. Resolves to the thread's folder in it (the project may be a repo subfolder).
   */
  const makeWorktree = (projectPath: string, title: string, threadId: string) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => repoRoot(projectPath));
      if (!root) return yield* Effect.fail(fail("New worktrees need the project to be a git repo"));
      const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thread"}-${threadId.slice(0, 6)}`;
      const path = join(WORKTREES_DIR, basename(root), slug);
      const error = yield* Effect.promise(() => addWorktree(projectPath, path, `apcode/${slug}`));
      if (error) return yield* Effect.fail(fail(`Couldn't create a worktree: ${error}`));
      return join(path, relative(root, projectPath));
    });

  const create = (command: Extract<ClientCommand, { _tag: "thread.create" }>) =>
    Effect.gen(function* () {
      const { project, created } = yield* projectsStore.ensure(command.path).pipe(Effect.mapError((e) => fail(e.message)));
      if (created) publish({ _tag: "project.added", project });

      const now = Date.now();
      const id = crypto.randomUUID();
      const title = titleFrom(command.text, project.name);
      const cwd = command.workspace === "worktree" ? yield* makeWorktree(project.path, title, id) : project.path;
      const info: ThreadInfo = {
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
      };
      const entry: ThreadEntry = { info, session: null, resumeToken: null, activeAt: now, currentTurn: null, lock: yield* Semaphore.make(1) };
      threads.set(info.id, entry);
      store.insertThread(info);
      publish({ _tag: "thread.created", thread: info, requestId: command.requestId });

      // New chats preselect whichever harness was used last.
      const settings = yield* settingsStore.get;
      if (settings.lastProvider !== command.provider) {
        const next = yield* settingsStore.update({ ...settings, lastProvider: command.provider });
        publish({ _tag: "settings.updated", settings: next });
      }
      yield* send(entry, command.text, command.options);
    });

  const dispatch = (command: ClientCommand): Effect.Effect<void, ProviderError> => {
    switch (command._tag) {
      case "thread.create":
        return create(command);
      case "thread.send":
        return Effect.flatMap(getEntry(command.threadId), (entry) => send(entry, command.text, command.options));
      case "thread.rewind":
        return rewind(command);
      case "thread.compact":
        return compact(command.threadId);
      case "thread.listCommands":
        return listCommands(command.threadId);
      case "checkpoint.diff":
        return Effect.gen(function* () {
          const entry = yield* getEntry(command.threadId);
          const diff = yield* Effect.promise(() => readCheckpointDiff(entry.info.cwd, command.threadId, command.messageId));
          publish({ _tag: "checkpoint.diff", threadId: command.threadId, messageId: command.messageId, ...diff });
        });
      case "git.listBranches":
        return publishBranches(command.path);
      case "git.diff":
        return Effect.promise(() => refreshDiff(command.path));
      case "git.checkout":
      case "git.createBranch":
        return Effect.gen(function* () {
          const run = command._tag === "git.checkout" ? checkoutBranch : createBranch;
          const error = yield* Effect.promise(() => run(command.path, command.branch));
          yield* publishBranches(command.path, error);
          for (const entry of threads.values()) if (entry.info.cwd === command.path) refreshMeta(entry);
        });
      case "git.status":
        return Effect.promise(() => refreshStatus(command.path));
      case "git.commit":
      case "git.push": {
        const { path } = command;
        const action: GitAction = command._tag === "git.push" ? "push" : command.push ? "commit-push" : "commit";
        return withRepoLock(
          path,
          Effect.gen(function* () {
            let error: string | null = null;
            if (command._tag === "git.commit") {
              const written = command.message.trim() ? { message: command.message } : yield* writeCommitMessage(path);
              error = "error" in written ? written.error : yield* Effect.promise(() => commitAll(path, written.message));
            }
            if (!error && action !== "commit") error = yield* Effect.promise(() => pushBranch(path));
            yield* publishStatus(path, action, error);
            if (action !== "push") {
              const diff = yield* Effect.promise(() => readDiff(path));
              publish({ _tag: "git.diff", path, ...diff });
            }
          }),
        );
      }
      case "thread.setModel":
        return Effect.gen(function* () {
          const entry = yield* getEntry(command.threadId);
          entry.info = { ...entry.info, model: command.model };
          store.setModel(entry.info.id, command.model);
          publish({ _tag: "thread.model", threadId: entry.info.id, model: command.model });
          if (entry.session) yield* entry.session.setModel(command.model);
        });
      case "project.add":
        return projectsStore.ensure(command.path).pipe(
          Effect.mapError((e) => fail(e.message)),
          Effect.map(({ project, created }) => (created ? publish({ _tag: "project.added", project }) : undefined)),
        );
      case "providers.refresh":
        return registry.refresh;
      case "provider.link":
        return registry.link(command.provider);
      case "provider.linkCode":
        return registry.submitCode(command.provider, command.code);
      case "provider.linkCancel":
        return registry.cancelLink(command.provider);
      case "provider.unlink":
        return registry.unlink(command.provider);
      case "thread.interrupt":
        return withLiveSession(command.threadId, (s) => s.interrupt);
      case "approval.respond":
        return withLiveSession(command.threadId, (s) => s.respondApproval(command.requestId, command.decision));
      case "thread.close":
        return removeThread(command.threadId);
      case "thread.archive":
        return Effect.flatMap(getEntry(command.threadId), (entry) => setArchived(entry, command.archived));
      case "project.remove":
        return Effect.gen(function* () {
          if (!(yield* projectsStore.remove(command.projectId))) return;
          const owned = [...threads.values()].filter((t) => t.info.projectId === command.projectId);
          yield* Effect.forEach(owned, (t) => removeThread(t.info.id), { discard: true });
          publish({ _tag: "project.removed", projectId: command.projectId });
        });
      case "terminal.write":
        return Effect.sync(() => terminals.write(command.threadId, command.terminalId, command.data));
      case "terminal.resize":
        return Effect.sync(() => terminals.resize(command.threadId, command.terminalId, command.columns, command.rows));
      case "terminal.close":
        return Effect.sync(() => terminals.close(command.threadId, command.terminalId));
      // Per connection; the server answers these.
      case "thread.subscribe":
      case "thread.unsubscribe":
      case "thread.loadOlder":
      case "search":
      case "terminal.open":
      case "terminal.detach":
      case "terminal.acknowledge":
      case "browser.host":
      case "browser.respond":
        return Effect.void;
      case "settings.update":
        return settingsStore
          .update(command.settings)
          .pipe(Effect.map((settings) => publish({ _tag: "settings.updated", settings })));
    }
  };

  return SessionManager.of({
    dispatch: (command) =>
      dispatch(command).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => publish({ _tag: "error", threadId: "threadId" in command ? command.threadId : null, message: e.message })),
        ),
      ),
    subscribe: Effect.map(
      Effect.all([PubSub.subscribe(pubsub), settingsStore.get, projectsStore.list, registry.list]),
      ([subscription, settings, projects, providers]) => ({
        dataId: store.dataId,
        settings,
        projects,
        providers,
        threads: [...threads.values()].map((t) => t.info),
        terminals: terminals.list(),
        live: Stream.fromSubscription(subscription),
      }),
    ),
    terminals,
    browsers,
    mcp,
    readThread: (threadId, after, turnLimit) => {
      if (!threads.has(threadId)) return null;
      // Each streaming message's text so far, as one delta.
      const live: Array<RuntimeEvent> = [];
      for (const [messageId, message] of streaming) {
        if (message.threadId === threadId) live.push({ _tag: "assistant.delta", threadId, messageId, delta: message.text });
      }
      const cursor = store.cursor(threadId);
      // A cursor past the end means the cache is from another database: start over.
      // Sized before anything is decoded, so a huge gap never gets read.
      if (after !== null && after <= cursor) {
        const { count, bytes } = store.measureAfter(threadId, after);
        if (count <= MAX_REPLAY && bytes <= MAX_REPLAY_BYTES) {
          return { _tag: "thread.replay", events: store.readAfter(threadId, after), streaming: live, cursor, seq };
        }
      }
      const { events, page } = store.readTurns(threadId, turnLimit);
      return { _tag: "thread.snapshot", events, streaming: live, cursor, page, seq };
    },
    readOlder: (threadId, before, turnLimit) => {
      if (!threads.has(threadId)) return null;
      const { events, page } = store.readTurns(threadId, turnLimit, before);
      return { events, page: page ?? { before, hasMore: false } };
    },
    search: (query) => store.search(query, 50).filter((hit) => threads.has(hit.threadId)),
    shutdown: Effect.suspend(() => {
      flushDeltas();
      terminals.closeAll();
      return Effect.forEach([...threads.values()], (t) => t.session?.close ?? Effect.void, { discard: true });
    }),
  });
});

export const layer = Layer.effect(SessionManager, make);
