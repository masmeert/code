/**
 * What agents do to other threads through MassCode's MCP tools: start, message, wait on and stop
 * them. A thread an agent sent work to reports back to it as a message once its turn ends.
 */
import {
  isTurnActive,
  MessageSender,
  type PermissionLevel,
  RuntimeEvent,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CommandError } from "../errors.ts";
import { readBranch } from "../git.ts";
import type { SendMessageInput, StartThreadInput } from "../mcp.ts";
import type { ProjectsStore } from "../storage/projects-store.ts";
import type { ThreadStore } from "../storage/thread-store.ts";
import type { Agents } from "./agents.ts";
import {
  buildThreadInfo,
  deriveRequestUuid,
  deriveTitle,
  getPermissionRank,
  type ThreadEntry,
} from "./entry.ts";
import type { ThreadOpener } from "./opening.ts";
import type { ThreadRegistry } from "./registry.ts";

/** Long enough for any answer worth passing on whole; read_thread has the rest. */
const MAX_REPORT_CHARS = 8000;

export function createOrchestration({
  store,
  projectsStore,
  threads,
  getEntry,
  publish,
  subscribe,
  reportErrorsIn,
  send,
  interrupt,
  ensureHarnessReady,
  createWorktree,
  setUpWorktree,
  openThread,
}: Pick<ThreadRegistry, "threads" | "getEntry" | "publish" | "subscribe" | "reportErrorsIn"> &
  Pick<Agents, "send" | "interrupt" | "ensureHarnessReady"> &
  Pick<ThreadOpener, "createWorktree" | "setUpWorktree" | "openThread"> & {
    readonly store: typeof ThreadStore.Service;
    readonly projectsStore: typeof ProjectsStore.Service;
  }) {
  /** Callers waiting on a thread, by `${callerId}\0${threadId}`: their wait returns what a report would say. */
  const waiting = new Map<string, number>();

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

  /** Waits for the thread's turn to end, up to `timeoutMs`; the caller then gets no report of it. */
  const waitForTurn = Effect.fn("waitForTurn")(function* (
    callerId: string,
    entry: ThreadEntry,
    timeoutMs: number,
  ) {
    const deadline = Date.now() + timeoutMs;
    const key = `${callerId}\0${entry.info.id}`;
    waiting.set(key, (waiting.get(key) ?? 0) + 1);

    return yield* Effect.gen(function* () {
      // ponytail: polls the thread's status; a per-thread signal if many agents wait at once.
      while (entry.isSettingUp || isTurnActive(entry.info.status)) {
        if (Date.now() >= deadline) return { ...summarizeThread(entry), timedOut: true };
        yield* Effect.sleep("200 millis");
      }

      entry.report?.to.delete(callerId);

      return { ...summarizeThread(entry), ...readLastTurn(entry.info.id) };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const count = waiting.get(key)! - 1;

          if (count === 0) waiting.delete(key);
          else waiting.set(key, count);
        }),
      ),
    );
  });

  /** Tells the threads that sent work into `entry`'s turn, now ended, how it went. */
  function reportTurn(entry: ThreadEntry) {
    const { report } = entry;
    entry.report = null;

    if (!report) return Effect.void;

    const { id: threadId, title } = entry.info;
    const { answer, error } = readLastTurn(threadId);

    const text = [
      `"${title}" (thread ${threadId}) finished the turn you sent it${error ? ", with an error" : ""}.`,
      answer
        ? `Its answer:\n\n${answer.length > MAX_REPORT_CHARS ? `${answer.slice(0, MAX_REPORT_CHARS)}…` : answer}`
        : "It gave no answer.",
      ...(error ? [`Error: ${error}`] : []),
      "read_thread shows the whole thread; send_message carries it on.",
    ].join("\n\n");

    return Effect.forEach(
      [...report.to],
      (recipientId) => {
        const recipient = threads.get(recipientId);

        if (
          !recipient ||
          recipient.info.archivedAt !== null ||
          waiting.has(`${recipientId}\0${threadId}`)
        )
          return Effect.void;

        return send(
          recipient,
          text,
          { effort: null, permission: recipient.permission ?? "ask", attachments: [] },
          {
            queue: true,
            messageId: deriveRequestUuid(threadId, `report:${report.turn}`),
            from: MessageSender.cases.report.make({ threadId, title }),
          },
        ).pipe(reportErrorsIn(recipientId), Effect.ignore);
      },
      { discard: true },
    );
  }

  /** Reports each turn that ends, for as long as the daemon runs. */
  const followTurns = Effect.flatMap(subscribe, (events) =>
    Stream.runForEach(events, ({ event }) => {
      if (!RuntimeEvent.guards["thread.status"](event) || isTurnActive(event.status))
        return Effect.void;

      const entry = threads.get(event.threadId);

      return entry && !entry.isSettingUp ? reportTurn(entry) : Effect.void;
    }),
  );

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
      yield* send(
        entry,
        input.prompt,
        { effort: null, permission, attachments: [] },
        { from: MessageSender.cases.agent.make({ threadId: callerId, title: caller.info.title }) },
      ).pipe(reportErrorsIn(entry.info.id));
    }

    return input.wait
      ? yield* waitForTurn(callerId, entry, (input.timeoutSeconds ?? 600) * 1000)
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
        from: MessageSender.cases.agent.make({ threadId: callerId, title: caller.info.title }),
      },
    );

    return summarizeThread(target);
  });

  return {
    followTurns,
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
    waitForThread: (callerId: string, threadId: string, timeoutMs: number) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) => waitForTurn(callerId, entry, timeoutMs)),
    stopThread: (_callerId: string, threadId: string) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) =>
        Effect.as(interrupt(entry), summarizeThread(entry)),
      ),
  };
}
