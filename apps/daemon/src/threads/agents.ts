/**
 * Each thread's agent: starting and stopping its process, the messages it's sent (now or from
 * the queue), what it reports back, and the harness and model it runs on.
 */
import {
  AttachmentInput,
  type ClientCommand,
  isTurnActive,
  RuntimeEvent,
  type Attachment,
  type CommandRun,
  type LimitStop,
  type ProviderKind,
  type QueuedMessage,
  type TurnOptions,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { coalesceLoads } from "../coalesceLoads.ts";
import type { Devices } from "../devices.ts";
import { CommandError, getErrorMessage } from "../errors.ts";
import {
  captureCheckpoint,
  deleteThreadCheckpoints,
  getCheckpointRef,
  readCheckpointStats,
  readRepoRoot,
  removeWorktreeIfClean,
} from "../git.ts";
import { buildHandoff } from "../handoff.ts";
import { ADAPTERS, getHarnessName } from "../harnesses.ts";
import type { Mcp } from "../mcp.ts";
import type { ProviderError, ProviderSession } from "../providers/ProviderAdapter.ts";
import type { ProviderRegistry } from "../providers/ProviderRegistry.ts";
import type { createSkillCatalog } from "../skills.ts";
import { DATA_DIR } from "../storage/jsonFile.ts";
import type { SettingsStore } from "../storage/SettingsStore.ts";
import type { ThreadStore } from "../storage/ThreadStore.ts";
import type { Terminals } from "../terminals.ts";
import { isBusy, type ThreadEntry } from "./entry.ts";
import type { ThreadRegistry } from "./registry.ts";

/** An agent process idle this long is stopped; the next message resumes it (t3code reaps at 30 min too). */
const SESSION_IDLE_MS = 30 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_GONE =
  "The agent stopped before finishing its turn. Send a message to pick up where it left off.";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** What the agent reads after the user runs a command from its reply. */
export function formatCommandRun({ command, exitCode, output }: CommandRun) {
  // Longer than any backtick run inside, so neither the command nor its output can close it early.
  function buildFence(text: string) {
    return "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
  }

  const ran = `I ran this command from your reply, in the thread's folder:\n\n${buildFence(command)}bash\n${command}\n${buildFence(command)}`;
  return output
    ? `${ran}\n\nIt exited with code ${exitCode} and printed:\n\n${buildFence(output)}\n${output}\n${buildFence(output)}`
    : `${ran}\n\nIt exited with code ${exitCode} and printed nothing.`;
}

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

export type Agents = Effect.Success<ReturnType<typeof createAgents>>;

/** Ends the turns that were going when the daemon died, since nothing else will. */
export const createAgents = Effect.fn("createAgents")(function* ({
  runFork,
  store,
  settingsStore,
  providerRegistry,
  skills,
  terminals,
  devices,
  mcp,
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
}: Pick<
  ThreadRegistry,
  | "threads"
  | "getEntry"
  | "publish"
  | "reportErrorsIn"
  | "followAgentCwd"
  | "setResumeTokens"
  | "setCoverage"
  | "setQueue"
  | "setLimitStop"
  | "forgetStreaming"
> & {
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
  readonly store: typeof ThreadStore.Service;
  readonly settingsStore: typeof SettingsStore.Service;
  readonly providerRegistry: typeof ProviderRegistry.Service;
  readonly skills: Effect.Success<ReturnType<typeof createSkillCatalog>>;
  readonly terminals: Terminals;
  readonly devices: Devices;
  readonly mcp: Pick<Mcp, "issue" | "revoke">;
}) {
  /** Takes in what a thread's agent reports, unless it's from a session since dropped. */
  function receiveAgentEvent(entry: ThreadEntry, generation: number, event: RuntimeEvent) {
    if (entry.generation !== generation || threads.get(entry.info.id) !== entry) return;

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
      emit: (event) => receiveAgentEvent(entry, generation, event),
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

  /** Holds the thread's queue on a usage limit, and asks for the reset when the harness didn't say. */
  function stopForLimit(entry: ThreadEntry, limitStop: LimitStop) {
    setLimitStop(entry, limitStop);
    if (limitStop.resetsAt !== null) return;

    runFork(
      Effect.map(providerRegistry.readLimits(limitStop.provider), ({ limits }) => {
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
      (entry.info.queue ?? []).filter((queued) => queued.id !== message.id),
    );
    runFork(deliverMessage(entry, message).pipe(reportErrorsIn(entry.info.id), Effect.ignore));
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
    const [next] = entry.info.queue ?? [];
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

    forgetStreaming(threadId);

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
        skills: yield* skills.findMentionedSkills(entry.info.provider, entry.info.cwd, text),
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
      (entry.info.queue ?? []).some((queued) => queued.id === messageId)
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
      return setQueue(entry, [...(entry.info.queue ?? []), message]);

    yield* deliverMessage(entry, message, run);
  });

  /** Fails, saying how to fix it, unless `provider`'s CLI is installed and signed in. */
  const ensureHarnessReady = Effect.fn("ensureHarnessReady")(function* (provider: ProviderKind) {
    const name = getHarnessName(yield* settingsStore.get, provider);
    const status = (yield* providerRegistry.list).find((harness) => harness.kind === provider);

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
    const skillNames = yield* skills.loadSkillNames(entry.info.provider, entry.info.cwd);
    publish(
      RuntimeEvent.cases["thread.commands"].make({
        threadId,
        commands: commands.filter((command) => !skillNames.has(command.name)),
      }),
    );
  });

  const readUsage = yield* coalesceLoads(
    Effect.fn("readUsage")(function* (threadId: string) {
      const entry = threads.get(threadId);
      if (!entry) return;

      const { provider, model } = entry.info;
      const resumeToken = entry.resumeTokens[provider];
      let usage = entry.info.usage ?? null;
      // A live session reports its usage when its turn ends.
      if (!usage && resumeToken && !entry.session) {
        const harness = (yield* settingsStore.get).providers[provider];
        usage = yield* ADAPTERS[provider]
          .readUsage({
            cwd: entry.home.path,
            harness,
            resumeToken,
            model: model ?? harness.defaultModel ?? undefined,
          })
          .pipe(Effect.orElseSucceed(() => null));
      }

      publish(RuntimeEvent.cases["thread.usage"].make({ threadId, usage }));
    }),
  );

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

  const setModel = Effect.fn("setModel")(function* ({
    threadId,
    provider,
    model,
  }: Extract<ClientCommand, { _tag: "thread.setModel" }>) {
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

    const [next] = entry.info.queue ?? [];
    if (next) return sendQueued(entry, next);

    yield* send(entry, "Continue where you left off.", options);
  });

  return {
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
  };
});
