import {
  AttachmentInput,
  ClientCommand,
  ProviderKind,
  RuntimeEvent,
  ServerFrame,
  type Attachment,
  type GitAction,
  type PageInfo,
  type PullRequest,
  type RepoStatus,
  type SourceControlKind,
  type Project,
  type ProviderStatus,
  type SearchHit,
  type Settings,
  type StoredEvent,
  type TerminalInfo,
  type ThreadInfo,
  type TurnOptions,
} from "@apcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
  addWorktree,
  autoPull,
  captureCheckpoint,
  checkoutBranch,
  checkpointRef,
  commitAll,
  copyCheckpoints,
  createBranch,
  deleteCheckpoints,
  deleteThreadCheckpoints,
  hasCheckpoint,
  listBranches,
  listFiles,
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
  repoRoot,
  restoreCheckpoint,
} from "./git.ts";
import { ClaudeAdapter } from "./providers/ClaudeAdapter.ts";
import {
  detectSourceControl,
  mergePullRequest,
  openPullRequest,
  probeSourceControl,
  readPullRequest,
  readPullRequestTemplate,
} from "./sourceControl.ts";
import { generateCommitMessage, generatePullRequest } from "./writer.ts";
import { CodexAdapter } from "./providers/CodexAdapter.ts";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderSession,
} from "./providers/ProviderAdapter.ts";
import { ProviderRegistry } from "./providers/ProviderRegistry.ts";
import { DATA_DIR } from "./storage/jsonFile.ts";
import { ProjectsStore } from "./storage/ProjectsStore.ts";
import { SettingsStore } from "./storage/SettingsStore.ts";
import { isPersisted, ThreadStore } from "./storage/ThreadStore.ts";
import { type Browsers, createBrowsers } from "./browsers.ts";
import { createMcp, type Mcp } from "./mcp.ts";
import { createTerminals, type Terminals } from "./terminals.ts";

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
};

export interface SequencedEvent {
  /** Publish order, in memory only; lets a connection skip what a transcript read already covered. */
  readonly seq: number;
  /** Stored events' id, the clients' resume cursor. */
  readonly id: number | null;
  readonly event: RuntimeEvent;
}

/** A transcript read, taken at publish position `seq`. */
export interface ThreadRead {
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
    threads.set(info.id, {
      info,
      session: null,
      resumeToken,
      activeAt: Date.now(),
      currentTurn: null,
      lock: yield* Semaphore.make(1),
    });
  }
  // Approvals pending when the daemon stopped died with their agent process.
  for (const [requestId, threadId] of store.unresolvedApprovals()) {
    store.appendEvent(
      threadId,
      RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }),
    );
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
    providers: (providers) =>
      publish(RuntimeEvent.cases["providers.updated"].make({ providers: [...providers] })),
    flow: (flow) => publish(RuntimeEvent.cases["auth.flow"].make({ flow })),
  });

  /** Re-reads the branch (a turn may have switched it) and announces the thread's current meta. */
  const refreshMeta = (entry: ThreadEntry) => {
    void readBranch(entry.info.cwd).then((branch) => {
      if (threads.get(entry.info.id) !== entry) return;
      entry.info = { ...entry.info, branch };
      const { id: threadId, title, updatedAt } = entry.info;
      publish(RuntimeEvent.cases["thread.meta"].make({ threadId, title, updatedAt, branch }));
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
    if (RuntimeEvent.guards["assistant.delta"](event)) {
      const pending = pendingDeltas.get(event.messageId);
      pendingDeltas.set(
        event.messageId,
        pending ? { ...pending, delta: pending.delta + event.delta } : event,
      );
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);
      return;
    }
    flushDeltas();
    emit(event);
  };

  const emit = (event: RuntimeEvent) => {
    let id: number | null = null;
    if (RuntimeEvent.guards["assistant.delta"](event)) {
      const text = streaming.get(event.messageId)?.text ?? "";
      streaming.set(event.messageId, { threadId: event.threadId, text: text + event.delta });
    } else if (isPersisted(event)) {
      if (RuntimeEvent.guards["assistant.completed"](event)) streaming.delete(event.messageId);
      id = store.appendEvent(event.threadId, event);
    }
    if (RuntimeEvent.guards["thread.status"](event)) {
      const entry = threads.get(event.threadId);
      if (entry) entry.info = { ...entry.info, status: event.status };
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
    if (RuntimeEvent.isAnyOf(["user.message", "turn.completed"])(event)) touch(event.threadId);
  };

  for (const entry of threads.values()) refreshMeta(entry);

  const terminals = createTerminals({
    folderOf: (threadId) => threads.get(threadId)?.info.cwd ?? null,
    opened: (terminal) => publish(RuntimeEvent.cases["terminal.opened"].make(terminal)),
    closed: (terminal) => publish(RuntimeEvent.cases["terminal.closed"].make(terminal)),
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
            threadId,
            cwd: entry.info.cwd,
            harness: settings.providers[entry.info.provider],
            model:
              entry.info.model ?? settings.providers[entry.info.provider].defaultModel ?? undefined,
            resumeToken: entry.resumeToken ?? undefined,
            effort: options.effort,
            permission: options.permission,
            onResumeToken: (token) => {
              entry.resumeToken = token;
              store.setResumeToken(threadId, token);
            },
            emit: (event) => {
              // The agent process ending isn't the thread ending: drop the session so the next message resumes it.
              if (RuntimeEvent.guards["thread.status"](event) && event.status === "closed") {
                entry.session = null;
                if (threads.has(threadId))
                  publish(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
                return;
              }
              publish(event);
              if (RuntimeEvent.guards["turn.completed"](event)) endTurn(entry);
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
      publish(RuntimeEvent.cases["turn.checkpoint"].make({ threadId, messageId, ...stats }));
    })();
  };

  /** Runs `f` against the thread's live session, if it has one. */
  const withLiveSession = (
    threadId: string,
    f: (session: ProviderSession) => Effect.Effect<void, ProviderError>,
  ) =>
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
        // A fork shares its thread's worktree, so the last one out removes it.
        if (worktree && ![...threads.values()].some((other) => other.info.cwd === cwd)) {
          const root = await repoRoot(cwd);
          if (root) await removeWorktreeIfClean(root);
        }
      })();
      for (const [messageId, message] of streaming)
        if (message.threadId === threadId) streaming.delete(messageId);
      for (const [messageId, delta] of pendingDeltas)
        if (delta.threadId === threadId) pendingDeltas.delete(messageId);
      publish(RuntimeEvent.cases["thread.removed"].make({ threadId }));
    });

  const setArchived = (entry: ThreadEntry, archived: boolean) =>
    Effect.gen(function* () {
      if ((entry.info.archivedAt !== null) === archived) return;
      const archivedAt = archived ? Date.now() : null;
      entry.info = { ...entry.info, archivedAt };
      store.setArchived(entry.info.id, archivedAt);
      publish(RuntimeEvent.cases["thread.archived"].make({ threadId: entry.info.id, archivedAt }));
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
      const turn = {
        messageId,
        text,
        attachments,
        effort: options.effort,
        permission: options.permission,
      };
      const message = RuntimeEvent.cases["user.message"].make(
        attachments.length
          ? { threadId, messageId, text, attachments }
          : { threadId, messageId, text },
      );
      // A turn is running: the message joins it.
      const { status } = entry.info;
      if (entry.session && (status === "running" || status === "awaiting-approval")) {
        publish({ ...message, steer: true });
        return yield* entry.session.steer(turn);
      }
      publish(message);
      publish(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
      // Snapshot the folder before the agent touches it, so the turn's changes can be shown and undone.
      entry.currentTurn = messageId;
      yield* Effect.promise(() =>
        captureCheckpoint(entry.info.cwd, checkpointRef(threadId, messageId, "start")),
      );
      const session = yield* ensureSession(entry, options).pipe(
        Effect.tapError(() =>
          Effect.sync(() =>
            publish(RuntimeEvent.cases["thread.status"].make({ threadId, status: "error" })),
          ),
        ),
      );
      yield* session.send(turn);
    });

  const isBusy = (entry: ThreadEntry) =>
    entry.info.status === "running" || entry.info.status === "awaiting-approval";

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
      if (found.event.steer)
        return yield* Effect.fail(fail("A message sent mid-turn can't be rewound to"));
      if (command.restoreFiles) {
        if (
          [...threads.values()].some(
            (other) => other !== entry && other.info.cwd === cwd && isBusy(other),
          )
        ) {
          return yield* Effect.fail(
            fail(
              "Another thread is working in this folder; restoring files would undo its changes too",
            ),
          );
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
          harness: (yield* settingsStore.get).providers[provider],
          resumeToken: entry.resumeToken,
          messageId: command.messageId,
          keep: found.before,
          dropTurns: found.from.filter((message) => !message.steer).length,
        });
        entry.resumeToken = token;
        store.setResumeToken(threadId, token);
      }
      store.truncate(threadId, found.seq);
      publish(
        RuntimeEvent.cases["thread.rewound"].make({ threadId, messageId: command.messageId }),
      );
      touch(threadId);
      const error = command.restoreFiles
        ? yield* Effect.promise(() => restoreCheckpoint(cwd, threadId, command.messageId))
        : null;
      void deleteCheckpoints(
        cwd,
        threadId,
        found.from.map((message) => message.messageId),
      );
      if (error)
        return yield* Effect.fail(
          fail(`Rewound the conversation, but couldn't restore the files: ${error}`),
        );
    });

  /** Starts a new thread with the conversation through a message's turn: the provider's copy first (the step that can refuse), then the transcript and file snapshots. */
  const fork = (command: Extract<ClientCommand, { _tag: "thread.fork" }>) =>
    Effect.gen(function* () {
      const source = yield* getEntry(command.threadId);
      const { cwd, provider } = source.info;
      if (isBusy(source)) return yield* Effect.fail(fail("Stop the agent before forking"));
      const cut = store.findTurnsAfter(source.info.id, command.messageId);
      if (!cut) return yield* Effect.fail(fail("That message is gone"));
      const resumeToken = source.resumeToken
        ? yield* ADAPTERS[provider].fork({
            cwd,
            harness: (yield* settingsStore.get).providers[provider],
            resumeToken: source.resumeToken,
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
          : titleFrom(`Fork of ${source.info.title}`, source.info.title),
        status: "idle",
        createdAt: now,
        updatedAt: now,
        branch: source.info.branch,
        archivedAt: null,
        worktree: source.info.worktree,
      };
      threads.set(info.id, {
        info,
        session: null,
        resumeToken,
        activeAt: now,
        currentTurn: null,
        lock: yield* Semaphore.make(1),
      });
      store.insertThread(info);
      store.copyEvents(source.info.id, info.id, cut.seq);
      if (resumeToken) store.setResumeToken(info.id, resumeToken);
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

  const compact = (threadId: string) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(threadId);
      if (isBusy(entry))
        return yield* Effect.fail(fail("Wait for the agent to finish before compacting"));
      if (!entry.resumeToken && !entry.session) return;
      const session = yield* ensureSession(entry, {
        effort: null,
        permission: "ask",
        attachments: [],
      });
      yield* session.compact;
    });

  const listCommands = (threadId: string) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(threadId);
      const commands = entry.session
        ? yield* entry.session.commands.pipe(Effect.orElseSucceed(() => []))
        : [];
      publish(RuntimeEvent.cases["thread.commands"].make({ threadId, commands: [...commands] }));
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
      Effect.map(({ current, branches }) =>
        publish(RuntimeEvent.cases["git.branches"].make({ path, current, branches, error })),
      ),
    );

  // Asking the host means a network call, so answers are kept a while (t3code keeps them 60 s).
  const PULL_REQUEST_TTL_MS = 60_000;
  const hosts = new Map<string, Promise<SourceControlKind | null>>();
  const pullRequests = new Map<string, { at: number; pr: Promise<PullRequest | null> }>();

  /** The repo state at `path`, with its host and the branch's pull request. */
  const readRepo = async (path: string): Promise<RepoStatus | null> => {
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
  };
  const forgetPullRequest = (path: string) => {
    for (const key of pullRequests.keys())
      if (key.startsWith(`${path}\0`)) pullRequests.delete(key);
  };

  /** Announces the repo state at `path`; `action`/`error` report the git action it answers. */
  const publishStatus = (
    path: string,
    action: GitAction | null = null,
    error: string | null = null,
  ) =>
    Effect.promise(() => readRepo(path)).pipe(
      Effect.map((status) =>
        publish(RuntimeEvent.cases["git.status"].make({ path, status, action, error })),
      ),
    );

  // At most one fetch per repo this often, however many windows ask (t3code fetches every 30 s).
  const AUTO_PULL_INTERVAL_MS = 30_000;
  const pulledAt = new Map<string, number>();
  // Plain refreshes (every window, every finished tool call) coalesce per repo.
  const refreshStatus = coalesced(async (path) => {
    const { autoPull: enabled } = await Effect.runPromise(settingsStore.get);
    if (enabled && Date.now() - (pulledAt.get(path) ?? 0) > AUTO_PULL_INTERVAL_MS) {
      pulledAt.set(path, Date.now());
      await autoPull(path);
    }
    const status = await readRepo(path);
    publish(RuntimeEvent.cases["git.status"].make({ path, status, action: null, error: null }));
  });
  const readLimits = coalesced(async (provider) => {
    if (!Schema.is(ProviderKind)(provider)) return;
    const { limits, error } = await Effect.runPromise(registry.readLimits(provider));
    publish(RuntimeEvent.cases["provider.limits"].make({ provider, limits: [...limits], error }));
  });
  const readUsage = coalesced(async (threadId) => {
    const entry = threads.get(threadId);
    if (!entry) return;
    const { provider, cwd, model } = entry.info;
    const { resumeToken } = entry;
    // A live session reports its usage when its turn ends.
    const usage =
      entry.info.usage ??
      (resumeToken && !entry.session
        ? await Effect.runPromise(
            Effect.flatMap(settingsStore.get, (settings) =>
              ADAPTERS[provider].readUsage({
                cwd,
                harness: settings.providers[provider],
                resumeToken,
                model: model ?? settings.providers[provider].defaultModel ?? undefined,
              }),
            ).pipe(Effect.orElseSucceed(() => null)),
          )
        : null);
    publish(RuntimeEvent.cases["thread.usage"].make({ threadId, usage }));
  });
  const refreshDiff = coalesced((path) =>
    readDiff(path).then((diff) => publish(RuntimeEvent.cases["git.diff"].make({ path, ...diff }))),
  );

  /** Who writes source control text at `path`: the commit model in settings, else the last harness's default. */
  const writerFor = (path: string, settings: Settings, recent: ReadonlyArray<string>) => {
    const split = settings.commitModel?.indexOf(":") ?? -1;
    const commitProvider = settings.commitModel?.slice(0, split);
    const pinned = split > 0 && Schema.is(ProviderKind)(commitProvider);
    const provider = pinned ? commitProvider : settings.lastProvider;
    const model = pinned
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
  };

  /** A message for everything uncommitted at `path`, from the commit model in settings. */
  const writeCommitMessage = (path: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsStore.get;
      const [diff, recent] = yield* Effect.promise(() =>
        Promise.all([readDiff(path), readRecentSubjects(path, 20)]),
      );
      if (diff.error) return { error: diff.error };
      if (!diff.patch) return { error: "Nothing to commit" };
      return yield* Effect.tryPromise({
        try: () =>
          generateCommitMessage({ ...writerFor(path, settings, recent), patch: diff.patch }),
        catch: (e) =>
          `Couldn't write a commit message: ${e instanceof Error ? e.message : String(e)}`,
      }).pipe(
        Effect.map((message) => ({ message })),
        Effect.catch((error) => Effect.succeed({ error })),
      );
    });

  /**
   * Pushes the branch if the host doesn't have all of it, writes the title and body with the
   * commit model, and opens the pull request. Resolves to an error message on failure.
   */
  const createPullRequest = async (path: string) => {
    const status = await readRepo(path);
    if (!status?.sourceControl) return "This repo's remote isn't on GitHub or GitLab";
    if (!status.branch) return "Check out a branch first";
    if (status.branch === status.defaultBranch)
      return `You're on ${status.branch}; create a branch for the pull request first`;
    if (status.changes) return "Commit your changes before opening a pull request";
    const open = status.pullRequest?.state === "open" || status.pullRequest?.state === "draft";
    if (open) return `#${status.pullRequest!.number} is already open for this branch`;
    if (!status.upstream || status.ahead) {
      const pushed = await pushBranch(path);
      if (pushed) return pushed;
    }
    const [settings, range, recent, root] = await Promise.all([
      Effect.runPromise(settingsStore.get),
      readPullRequestRange(path, status.branch),
      readRecentSubjects(path, 20),
      repoRoot(path),
    ]);
    if (!range) return "Couldn't find the branch to open the pull request against";
    if (!range.commits) return `This branch has no commits that ${range.base} doesn't have`;
    // t3code only follows templates on GitHub; GitLab keeps its own in .gitlab/.
    const template =
      settings.followTemplates !== false && status.sourceControl === "github" && root
        ? await readPullRequestTemplate(root)
        : null;
    try {
      const text = await generatePullRequest({
        ...writerFor(path, settings, recent),
        ...range,
        head: status.branch,
        template,
      });
      return await openPullRequest(path, status.sourceControl, {
        base: range.base,
        head: status.branch,
        ...text,
      });
    } catch (e) {
      return `Couldn't write the pull request: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

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
        addWorktree(projectPath, path, `apcode/${slug}`, worktreeFromOrigin === true),
      );
      if (error) return yield* Effect.fail(fail(`Couldn't create a worktree: ${error}`));
      return join(path, relative(root, projectPath));
    });

  const create = (command: Extract<ClientCommand, { _tag: "thread.create" }>) =>
    Effect.gen(function* () {
      const { project, created } = yield* projectsStore
        .ensure(command.path)
        .pipe(Effect.mapError((e) => fail(e.message)));
      if (created) publish(RuntimeEvent.cases["project.added"].make({ project }));

      const now = Date.now();
      const id = crypto.randomUUID();
      const title = titleFrom(command.text, project.name);
      const cwd =
        command.workspace === "worktree"
          ? yield* makeWorktree(project.path, title, id)
          : project.path;
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
      const entry: ThreadEntry = {
        info,
        session: null,
        resumeToken: null,
        activeAt: now,
        currentTurn: null,
        lock: yield* Semaphore.make(1),
      };
      threads.set(info.id, entry);
      store.insertThread(info);
      publish(
        RuntimeEvent.cases["thread.created"].make({ thread: info, requestId: command.requestId }),
      );

      // New chats preselect whichever harness was used last.
      const settings = yield* settingsStore.get;
      if (settings.lastProvider !== command.provider) {
        const next = yield* settingsStore.update({ ...settings, lastProvider: command.provider });
        publish(RuntimeEvent.cases["settings.updated"].make({ settings: next }));
      }
      yield* send(entry, command.text, command.options);
    });

  /** Announces the branches after `run` switched or created one, and the meta of threads in `path`. */
  function changeBranch(path: string, run: () => Promise<string | null>) {
    return Effect.gen(function* () {
      const error = yield* Effect.promise(run);
      yield* publishBranches(path, error);
      for (const entry of threads.values()) if (entry.info.cwd === path) refreshMeta(entry);
    });
  }

  function dispatch(command: ClientCommand): Effect.Effect<void, ProviderError> {
    return ClientCommand.match(command, {
      "thread.create": create,
      "thread.send": (command) =>
        Effect.flatMap(getEntry(command.threadId), (entry) =>
          send(entry, command.text, command.options),
        ),
      "thread.rewind": rewind,
      "thread.fork": fork,
      "thread.compact": (command) => compact(command.threadId),
      "thread.listCommands": (command) => listCommands(command.threadId),
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
        return withRepoLock(
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
        withRepoLock(
          path,
          Effect.gen(function* () {
            const error = yield* Effect.promise(() => pushBranch(path));
            yield* publishStatus(path, "push", error);
          }),
        ),
      "git.createPullRequest": ({ path }) =>
        withRepoLock(
          path,
          Effect.gen(function* () {
            const error = yield* Effect.promise(() => createPullRequest(path));
            forgetPullRequest(path);
            yield* publishStatus(path, "pull-request", error);
          }),
        ),
      "git.mergePullRequest": ({ path, method }) =>
        withRepoLock(
          path,
          Effect.gen(function* () {
            const status = yield* Effect.promise(() => readRepo(path));
            const pr = status?.pullRequest;
            const error =
              !status?.sourceControl || !pr || (pr.state !== "open" && pr.state !== "draft")
                ? "This branch has no open pull request"
                : yield* Effect.promise(() =>
                    mergePullRequest(path, status.sourceControl!, pr.number, method),
                  );
            forgetPullRequest(path);
            yield* publishStatus(path, "merge", error);
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
      "thread.setModel": (command) =>
        Effect.gen(function* () {
          const entry = yield* getEntry(command.threadId);
          entry.info = { ...entry.info, model: command.model };
          store.setModel(entry.info.id, command.model);
          publish(
            RuntimeEvent.cases["thread.model"].make({
              threadId: entry.info.id,
              model: command.model,
            }),
          );
          if (entry.session) yield* entry.session.setModel(command.model);
        }),
      "project.add": (command) =>
        projectsStore.ensure(command.path).pipe(
          Effect.mapError((e) => fail(e.message)),
          Effect.map(({ project, created }) =>
            created ? publish(RuntimeEvent.cases["project.added"].make({ project })) : undefined,
          ),
        ),
      "providers.refresh": () => registry.refresh,
      "provider.link": (command) => registry.link(command.provider),
      "provider.linkCode": (command) => registry.submitCode(command.provider, command.code),
      "provider.linkCancel": (command) => registry.cancelLink(command.provider),
      "provider.unlink": (command) => registry.unlink(command.provider),
      "provider.readLimits": (command) => Effect.promise(() => readLimits(command.provider)),
      "thread.interrupt": (command) => withLiveSession(command.threadId, (s) => s.interrupt),
      "thread.stopAgent": (command) =>
        withLiveSession(command.threadId, (s) => s.stopAgent?.(command.toolId) ?? Effect.void),
      "approval.respond": (command) =>
        withLiveSession(command.threadId, (s) =>
          s.respondApproval(command.requestId, command.decision, command.permission),
        ),
      "thread.close": (command) => removeThread(command.threadId),
      "thread.archive": (command) =>
        Effect.flatMap(getEntry(command.threadId), (entry) => setArchived(entry, command.archived)),
      "project.remove": (command) =>
        Effect.gen(function* () {
          if (!(yield* projectsStore.remove(command.projectId))) return;
          const owned = [...threads.values()].filter((t) => t.info.projectId === command.projectId);
          yield* Effect.forEach(owned, (t) => removeThread(t.info.id), { discard: true });
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
      // Per connection; the server answers these.
      "thread.subscribe": () => Effect.void,
      "thread.unsubscribe": () => Effect.void,
      "thread.loadOlder": () => Effect.void,
      search: () => Effect.void,
      "terminal.open": () => Effect.void,
      "terminal.detach": () => Effect.void,
      "terminal.acknowledge": () => Effect.void,
      "browser.host": () => Effect.void,
      "browser.respond": () => Effect.void,
      "settings.update": (command) =>
        Effect.gen(function* () {
          const before = yield* settingsStore.get;
          const settings = yield* settingsStore.update(command.settings);
          publish(RuntimeEvent.cases["settings.updated"].make({ settings }));
          // A different binary, config dir or env can mean another version or account.
          const launchOf = (value: Settings) =>
            JSON.stringify(
              ProviderKind.literals.map((kind) => {
                const { binaryPath, configDir, env, launchArgs } = value.providers[kind];
                return [binaryPath, configDir, env, launchArgs];
              }),
            );
          if (launchOf(before) !== launchOf(settings)) yield* registry.refresh;
        }),
    });
  }

  return SessionManager.of({
    dispatch: (command) =>
      dispatch(command).pipe(
        Effect.tapError((e) =>
          Effect.sync(() =>
            publish(
              RuntimeEvent.cases.error.make({
                threadId: "threadId" in command ? command.threadId : null,
                message: e.message,
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
        if (message.threadId === threadId)
          live.push(
            RuntimeEvent.cases["assistant.delta"].make({
              threadId,
              messageId,
              delta: message.text,
            }),
          );
      }
      const cursor = store.cursor(threadId);
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
    shutdown: Effect.suspend(() => {
      flushDeltas();
      terminals.closeAll();
      return Effect.forEach([...threads.values()], (t) => t.session?.close ?? Effect.void, {
        discard: true,
      });
    }),
  });
});

export const layer = Layer.effect(SessionManager, make);
