import {
  ClientCommand,
  fileRestoreBlocker,
  isTurnActive,
  PermissionLevel,
  ProviderKind,
  RuntimeEvent,
  ServerFrame,
  type SearchHit,
  type Settings,
  type ThreadInfo,
  WORKTREE_SETUP_TERMINAL_ID,
} from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  addWorktree,
  checkoutBranch,
  copyCheckpoints,
  createBranch,
  deleteCheckpoints,
  hasCheckpoint,
  listFiles,
  readBranch,
  readCheckpointDiff,
  readRepoRoot,
  restoreCheckpoint,
} from "./git.ts";
import { expandHome, listFolders } from "./folders.ts";
import { buildHandoff } from "./handoff.ts";
import { generateThreadTitle } from "./writer.ts";
import { ProviderError, type ProviderSession } from "./providers/ProviderAdapter.ts";
import { ProviderRegistry } from "./providers/ProviderRegistry.ts";
import { DATA_DIR } from "./storage/jsonFile.ts";
import * as ProjectsStoreLive from "./storage/ProjectsStore.ts";
import * as SettingsStoreLive from "./storage/SettingsStore.ts";
import * as ThreadStoreLive from "./storage/ThreadStore.ts";
import { type ProjectNotFound, ProjectsStore } from "./storage/ProjectsStore.ts";
import { SettingsStore } from "./storage/SettingsStore.ts";
import { type Coverage, type ThreadHome, ThreadStore } from "./storage/ThreadStore.ts";
import { type Browsers, createBrowsers } from "./browsers.ts";
import { createDevices, type Devices } from "./devices.ts";
import { createMcp, type Mcp, type SendMessageInput, type StartThreadInput } from "./mcp.ts";
import { createTerminals, type Terminals } from "./terminals.ts";
import { readProjectConfig } from "./projectConfig.ts";
import { createSkillCatalog } from "./skills.ts";
import { createRepoPanel } from "./repoPanel.ts";
import { createAgents, formatCommandRun } from "./threads/agents.ts";
import { createThreadRegistry, type SequencedEvent, type ThreadRead } from "./threads/registry.ts";
import { CommandError } from "./errors.ts";
import { coalesceLoads } from "./coalesceLoads.ts";
import { ADAPTERS, buildWriterInput, getHarnessName } from "./harnesses.ts";
import {
  buildThreadInfo,
  createEntry,
  deriveRequestUuid,
  deriveTitle,
  getForkPoint,
  getPermissionRank,
  hasSwitchedHarness,
  isBusy,
  type ThreadEntry,
} from "./threads/entry.ts";

/** Harnesses can still refuse right at the reset (MonoCode waits this long too). */
const LIMIT_RESET_GRACE_MS = 30_000;

const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** A read-only side conversation about one reply (BTW), never stored. */
interface SideChat {
  /** Null while its agent starts. */
  session: ProviderSession | null;
}

export class SessionManager extends Context.Service<
  SessionManager,
  {
    readonly dispatch: (
      command: ClientCommand,
    ) => Effect.Effect<void, CommandError | ProviderError | ProjectNotFound>;
    /** Subscribes, then snapshots the shell synchronously, so the stream continues exactly where it ends. */
    readonly subscribe: Effect.Effect<
      Omit<Extract<ServerFrame, { _tag: "shell" }>, "_tag" | "root" | "protocol"> & {
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
    ) => Omit<Extract<ServerFrame, { _tag: "thread.page" }>, "_tag" | "threadId"> | null;
    /** Messages matching `query`, newest first, in threads that still exist. */
    readonly search: (query: string) => ReadonlyArray<SearchHit>;
    readonly shutdown: Effect.Effect<void>;
    /** Some thread's turn is going, the agent working or waiting on the user. */
    readonly hasActiveTurns: () => boolean;
  }
>()("masscode/SessionManager") {}

const WORKTREES_DIR = join(DATA_DIR, "worktrees");

const make = Effect.gen(function* () {
  // Every effect started from a callback runs here, so closing the daemon's scope interrupts it.
  const runFork = yield* FiberSet.makeRuntime();

  const settingsStore = yield* SettingsStore;
  const projectsStore = yield* ProjectsStore;
  const store = yield* ThreadStore;
  const providerRegistry = yield* ProviderRegistry;
  const {
    threads,
    getEntry,
    publish,
    publishSideChat,
    flushDeltas,
    reportErrorsIn,
    refreshMeta,
    setTitle,
    followAgentCwd,
    markUpdated,
    refreshShelved,
    setShelveOverride,
    setResumeTokens,
    setCoverage,
    setQueue,
    setLimitStop,
    saveSettings,
    subscribe,
    forgetStreaming,
    readThread,
    readOlder,
    search,
  } = yield* createThreadRegistry({
    store,
    settingsStore,
    onShelve: (entry) => {
      terminals.closeIdle(entry.info.id);
      // Shelved threads never have a turn going; like the idle reaper, the next message resumes from the token.
      if (entry.session) runFork(dropSession(entry, null));
    },
  });

  providerRegistry.setListener({
    onProviders: (providers) =>
      publish(RuntimeEvent.cases["providers.updated"].make({ providers: [...providers] })),
    onFlow: (flow) => publish(RuntimeEvent.cases["auth.flow"].make({ flow })),
  });

  const terminals = createTerminals({
    findFolder: (threadId) => threads.get(threadId)?.info.cwd ?? null,
    onOpened: (terminal) => publish(RuntimeEvent.cases["terminal.opened"].make(terminal)),
    onClosed: (terminal) => publish(RuntimeEvent.cases["terminal.closed"].make(terminal)),
  });
  const browsers = createBrowsers();
  const devices = createDevices((threadId, deviceId) =>
    publish(RuntimeEvent.cases["thread.device"].make({ threadId, deviceId })),
  );
  const skills = yield* createSkillCatalog({
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

  const {
    dropSession,
    interrupt,
    runOnLiveSession,
    removeThread,
    setArchived,
    send,
    sendQueued,
    ensureHarnessReady,
    compact,
    listCommands,
    readUsage,
    reapIdleSessions,
    setModel,
    resumeAfterLimit,
  } = yield* createAgents({
    runFork,
    store,
    settingsStore,
    providerRegistry,
    skills,
    terminals,
    devices,
    // The agents' MCP servers serve the orchestration tools, which need the agents: bound late.
    mcp: {
      issue: (threadId) => mcp.issue(threadId),
      revoke: (threadId) => mcp.revoke(threadId),
    },
    threads,
    getEntry,
    publish,
    reportErrorsIn,
    followAgentCwd,
    setResumeTokens,
    setCoverage,
    setQueue,
    setLimitStop,
    forgetStreaming,
  });

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
        ...getForkPoint(found),
        messageId: command.messageId,
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
            ...getForkPoint(cut),
          })
        : null;

    const info = buildThreadInfo({
      id: crypto.randomUUID(),
      projectId: source.info.projectId,
      provider,
      model: source.info.model,
      cwd,
      title: source.info.title.startsWith("Fork of ")
        ? source.info.title
        : deriveTitle(`Fork of ${source.info.title}`, source.info.title),
      branch: source.info.branch,
      worktree: source.info.worktree,
    });

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
              ...getForkPoint(cut),
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
      effect.pipe(
        reportErrorsIn(sideChatId, publishSideChat),
        Effect.tapError(() =>
          Effect.sync(() =>
            publishSideChat(
              RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "idle" }),
            ),
          ),
        ),
      ),
  );

  const closeSideChat = Effect.fn("closeSideChat")(function* (sideChatId: string) {
    const chat = sideChats.get(sideChatId);
    sideChats.delete(sideChatId);
    if (chat?.session) yield* chat.session.close;
  });

  // Idle threads shelve with time alone; the threshold is in days, so a check a minute is plenty.
  // Resuming at a usage limit's reset rides along: a minute late is fine, and it survives sleep.
  yield* Effect.forkScoped(
    Effect.schedule(
      Effect.sync(() => {
        for (const entry of threads.values()) {
          refreshShelved(entry);
          const stop = entry.info.limitStop;
          if (
            stop?.resumeAtReset &&
            stop.resetsAt !== null &&
            Date.now() >= stop.resetsAt + LIMIT_RESET_GRACE_MS
          )
            runFork(
              resumeAfterLimit(entry, stop.resumeAtReset).pipe(
                reportErrorsIn(entry.info.id),
                Effect.ignore,
              ),
            );
        }
      }),
      Schedule.spaced("1 minute"),
    ),
  );

  yield* Effect.forkScoped(Effect.schedule(reapIdleSessions, Schedule.spaced(REAP_INTERVAL_MS)));

  const repoPanel = yield* createRepoPanel({ settingsStore, publish, threads, refreshMeta });

  const readLimits = yield* coalesceLoads(
    Effect.fn("readLimits")(function* (provider: string) {
      if (!Schema.is(ProviderKind)(provider)) return;

      const { limits, error } = yield* providerRegistry.readLimits(provider);
      publish(RuntimeEvent.cases["provider.limits"].make({ provider, limits: [...limits], error }));
    }),
  );

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
        const [next] = entry.info.queue ?? [];
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

    const id = crypto.randomUUID();
    const title = deriveTitle(command.text, project.name);
    const cwd =
      command.workspace === "worktree"
        ? yield* createWorktree(project.path, title, id)
        : project.path;

    const entry = yield* openThread(
      buildThreadInfo({
        id,
        projectId: project.id,
        provider: command.provider,
        model: command.model,
        cwd,
        title,
        branch: yield* Effect.promise(() => readBranch(cwd)),
        worktree: command.workspace === "worktree",
      }),
      { path: cwd, isWorktree: command.workspace === "worktree" },
      command.text,
      command.requestId,
    );
    if (command.workspace === "worktree") yield* setUpWorktree(entry, project.path);

    // New chats preselect whichever harness was used last.
    const settings = yield* settingsStore.get;
    if (settings.lastProvider !== command.provider) {
      yield* saveSettings({ ...settings, lastProvider: command.provider }).pipe(
        reportErrorsIn(null),
        Effect.ignore,
      );
    }

    yield* send(entry, command.text, command.options).pipe(
      reportErrorsIn(entry.info.id),
      Effect.ignore,
    );
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
      entry = yield* openThread(
        buildThreadInfo({
          id,
          projectId: caller.info.projectId,
          provider,
          model: input.model ?? (provider === caller.info.provider ? caller.info.model : null),
          cwd,
          title,
          branch: yield* Effect.promise(() => readBranch(cwd)),
          worktree: input.worktree === true || caller.info.worktree,
          startedBy: callerId,
        }),
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
        reportErrorsIn(entry.info.id),
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

  function dispatch(command: ClientCommand) {
    return ClientCommand.match<Effect.Effect<void, CommandError | ProviderError | ProjectNotFound>>(
      command,
      {
        "thread.create": createThread,
        "thread.send": (command) =>
          Effect.flatMap(getEntry(command.threadId), (entry) =>
            send(entry, command.text, command.options, command),
          ),
        "thread.sendQueued": ({ threadId, messageId }) =>
          Effect.map(getEntry(threadId), (entry) => {
            const message = (entry.info.queue ?? []).find((queued) => queued.id === messageId);
            if (message) sendQueued(entry, message);
          }),
        "thread.unqueue": ({ threadId, messageIds }) =>
          Effect.map(getEntry(threadId), (entry) =>
            setQueue(
              entry,
              (entry.info.queue ?? []).filter((queued) => !messageIds.includes(queued.id)),
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
        "thread.readUsage": (command) => readUsage(command.threadId),
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
        "git.listBranches": (command) => repoPanel.publishBranches(command.path),
        "git.listFiles": ({ path }) =>
          Effect.promise(() => listFiles(path)).pipe(
            Effect.map((files) => publish(RuntimeEvent.cases["git.files"].make({ path, files }))),
          ),
        "git.diff": (command) => repoPanel.refreshDiff(command.path),
        "git.checkout": ({ path, branch }) =>
          repoPanel.changeBranch(path, () => checkoutBranch(path, branch)),
        "git.createBranch": ({ path, branch }) =>
          repoPanel.changeBranch(path, () => createBranch(path, branch)),
        "git.status": (command) => repoPanel.refreshStatus(command.path),
        "git.commit": ({ path, message, push }) => repoPanel.commit(path, message, push),
        "git.push": ({ path }) => repoPanel.push(path),
        "git.createPullRequest": ({ path }) => repoPanel.createPullRequest(path),
        "git.mergePullRequest": ({ path, method }) => repoPanel.mergePullRequest(path, method),
        "git.mergeIntoBase": ({ path }) => repoPanel.mergeIntoBase(path),
        "sourceControl.refresh": () => repoPanel.refreshSourceControl,
        "thread.setModel": setModel,
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
                  isNew
                    ? publish(RuntimeEvent.cases["project.added"].make({ project }))
                    : undefined,
                ),
                Effect.ignore,
              ),
            );
          }),
        "providers.refresh": () => providerRegistry.refresh,
        "provider.link": (command) => providerRegistry.link(command.provider),
        "provider.linkCode": (command) =>
          providerRegistry.submitCode(command.provider, command.code),
        "provider.linkCancel": (command) => providerRegistry.cancelLink(command.provider),
        "provider.unlink": (command) => providerRegistry.unlink(command.provider),
        "provider.readLimits": (command) => readLimits(command.provider),
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
          Effect.flatMap(getEntry(command.threadId), (entry) =>
            setArchived(entry, command.archived),
          ),
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
                  reportErrorsIn(threadId),
                  Effect.ignore,
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
            // A different binary, config dir or env can mean another version or account.
            function serializeLaunchSettings(value: Settings) {
              return JSON.stringify(
                ProviderKind.literals.map((kind) => {
                  const { binaryPath, configDir, env, launchArgs } = value.providers[kind];
                  return [binaryPath, configDir, env, launchArgs];
                }),
              );
            }

            const before = yield* settingsStore.get;
            // The settings apply even when they can't be saved, so the harnesses follow them either way.
            yield* saveSettings(command.settings).pipe(
              Effect.ensuring(
                serializeLaunchSettings(before) === serializeLaunchSettings(command.settings)
                  ? Effect.void
                  : providerRegistry.refresh,
              ),
            );
          }),
      },
    );
  }

  return SessionManager.of({
    dispatch: (command) =>
      dispatch(command).pipe(reportErrorsIn("threadId" in command ? command.threadId : null)),
    subscribe: Effect.gen(function* () {
      const live = yield* subscribe;

      return {
        dataId: store.dataId,
        settings: yield* settingsStore.get,
        projects: yield* projectsStore.list,
        providers: yield* providerRegistry.list,
        threads: [...threads.values()].map((entry) => entry.info),
        terminals: terminals.list(),
        live,
      };
    }),
    terminals,
    browsers,
    devices,
    mcp,
    readThread,
    readOlder,
    search,
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

/** The manager on its stores, with `registry` for the harnesses: the daemon's, or the tests' stub. */
export function composeLayer<E, R>(registry: Layer.Layer<ProviderRegistry, E, R>) {
  return layer.pipe(
    Layer.provide(Layer.mergeAll(ProjectsStoreLive.layer, ThreadStoreLive.layer, registry)),
    Layer.provideMerge(SettingsStoreLive.layer),
  );
}
