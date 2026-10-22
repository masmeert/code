/**
 * What agents do to other threads through MassCode's MCP tools: start, message, wait on and stop
 * them. A thread an agent sent work to reports back to it as a message once its turn ends.
 */
import {
  isAwaitingUser,
  isTurnActive,
  MessageSender,
  type PermissionLevel,
  type ProviderKind,
  RuntimeEvent,
  type StoredEvent,
  type UserAnswers,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CommandError } from "../errors.ts";
import { readBranch } from "../git.ts";
import type {
  AnswerQuestionsInput,
  SendMessageInput,
  StartThreadInput,
  WatchPullRequestInput,
} from "../mcp.ts";
import { clip } from "../handoff.ts";
import { getHarnessName } from "../harnesses.ts";
import type { ProviderRegistry } from "../providers/provider-registry.ts";
import type { ProjectsStore } from "../storage/projects-store.ts";
import type { SettingsStore } from "../storage/settings-store.ts";
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
import type { PullRequestWatch } from "./pull-request-watch.ts";
import type { SequencedEvent, ThreadRegistry } from "./registry.ts";

/** A tool call the main agent made, as read_thread's activity view lists it. */
interface ToolActivity {
  readonly position: number;
  readonly tool: string;
  readonly summary: string;
  failed?: string;
}

/** An approval or questions, as read_thread's activity view lists them. */
interface RequestActivity {
  readonly position: number;
  readonly request: string;
  readonly questions?: ReadonlyArray<string>;
  resolved: boolean;
  answers?: UserAnswers | undefined;
}

type TimelineItem =
  | {
      readonly position: number;
      readonly from: "user" | "assistant";
      readonly text: string;
      readonly sentBy?: {
        readonly kind: string;
        readonly threadId?: string;
        readonly title?: string;
        readonly number?: number;
        readonly url?: string;
      };
      readonly handedOverFrom?: ProviderKind;
    }
  | ToolActivity
  | RequestActivity
  | { readonly position: number; readonly error: string }
  | {
      readonly position: number;
      readonly changed: {
        readonly files: number;
        readonly additions: number;
        readonly deletions: number;
      };
    };

/** Long enough for any answer worth passing on whole; read_thread has the rest. */
const MAX_REPORT_CHARS = 8000;

export function createOrchestration({
  store,
  projectsStore,
  settingsStore,
  providerRegistry,
  threads,
  getEntry,
  publish,
  reportErrorsIn,
  setQueue,
  send,
  interrupt,
  ensureHarnessReady,
  findHarnessProblem,
  createWorktree,
  setUpWorktree,
  openThread,
  pullRequestWatch,
}: Pick<ThreadRegistry, "threads" | "getEntry" | "publish" | "reportErrorsIn" | "setQueue"> &
  Pick<Agents, "send" | "interrupt" | "ensureHarnessReady" | "findHarnessProblem"> &
  Pick<ThreadOpener, "createWorktree" | "setUpWorktree" | "openThread"> & {
    readonly store: typeof ThreadStore.Service;
    readonly projectsStore: typeof ProjectsStore.Service;
    readonly settingsStore: typeof SettingsStore.Service;
    readonly providerRegistry: typeof ProviderRegistry.Service;
    readonly pullRequestWatch: Pick<PullRequestWatch, "watch" | "unwatch">;
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

  /**
   * A thread's messages, saying who sent each user message that the user didn't write; with
   * `withActivity`, also its tool calls, requests, errors and file changes, in order.
   */
  function readTimeline(events: ReadonlyArray<StoredEvent>, withActivity: boolean) {
    const items: Array<TimelineItem> = [];
    const tools = new Map<string, ToolActivity>();
    const requests = new Map<string, RequestActivity>();

    for (const { id: position, event } of events) {
      if (RuntimeEvent.guards["user.message"](event)) {
        const { from, handoff } = event;

        items.push({
          position,
          from: "user",
          text: clip(event.text, MAX_REPORT_CHARS),
          ...(from && {
            sentBy: MessageSender.match(from, {
              agent: ({ threadId, title }) => ({ kind: "agent", threadId, title }),
              report: ({ threadId, title }) => ({ kind: "report", threadId, title }),
              restart: () => ({ kind: "masscode-restart" }),
              pullRequest: ({ number, url }) => ({ kind: "pull-request", number, url }),
            }),
          }),
          ...(withActivity && handoff && { handedOverFrom: handoff.from }),
        });
      } else if (RuntimeEvent.guards["assistant.completed"](event) && event.text) {
        items.push({ position, from: "assistant", text: clip(event.text, MAX_REPORT_CHARS) });
      } else if (!withActivity) {
        continue;
      } else if (RuntimeEvent.guards["tool.started"](event) && !event.parentToolId) {
        const tool: ToolActivity = {
          position,
          tool: event.name,
          summary: clip(event.summary, 300),
        };

        tools.set(event.toolId, tool);
        items.push(tool);
      } else if (RuntimeEvent.guards["tool.completed"](event) && event.isError) {
        const tool = tools.get(event.toolId);

        if (tool) tool.failed = clip(event.output, 500);
      } else if (RuntimeEvent.guards["approval.requested"](event)) {
        const request: RequestActivity = {
          position,
          request: event.title,
          ...(event.questions && {
            questions: event.questions.map((question) => question.question),
          }),
          resolved: false,
        };

        requests.set(event.requestId, request);
        items.push(request);
      } else if (RuntimeEvent.guards["approval.resolved"](event)) {
        const request = requests.get(event.requestId);

        if (request) {
          request.resolved = true;
          request.answers = event.answers;
        }
      } else if (RuntimeEvent.guards.error(event)) {
        items.push({ position, error: clip(event.message, 500) });
      } else if (RuntimeEvent.guards["turn.checkpoint"](event)) {
        const { files, additions, deletions } = event;
        items.push({ position, changed: { files, additions, deletions } });
      }
    }

    return items;
  }

  /** What the thread waits on the user for, with the questions when it asks some; null when nothing. */
  function readPendingRequest({ info }: ThreadEntry) {
    const { request } = info;

    if (!request || !isAwaitingUser(info.status)) return null;

    const asked = store
      .readTurns(info.id, 1)
      .events.map(({ event }) => event)
      .findLast(
        (event) =>
          RuntimeEvent.guards["approval.requested"](event) && event.requestId === request.requestId,
      );

    const questions =
      asked && RuntimeEvent.guards["approval.requested"](asked) ? asked.questions : undefined;

    if (!questions)
      return {
        requestId: request.requestId,
        title: request.title,
        detail: request.detail,
        howToAnswer:
          "Only the user can approve or deny this, in the thread. Tell them, or stop it with stop_thread.",
      };

    return {
      requestId: request.requestId,
      title: request.title,
      questions: questions.map(({ id, header, question, options, multiSelect }) => ({
        id,
        header,
        question,
        options: options.map(({ label, description }) => ({ label, description })),
        multiSelect,
      })),
      howToAnswer: "Answer with answer_questions, or ask the user.",
    };
  }

  /** The most `caller`'s agent can give another: its own access. */
  function checkPermissionCeiling(caller: ThreadEntry, wanted: PermissionLevel | null | undefined) {
    const ceiling = caller.turnSettings?.permission ?? "ask";
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

  /**
   * Waits for the thread's turn to end, or to stop on the user, up to `timeoutMs`. The caller gets
   * no report of a turn it saw end.
   */
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
        const waitingOn = readPendingRequest(entry);

        if (waitingOn) return { ...summarizeThread(entry), waitingOn };

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
    const recipients = listRecipients(entry);
    entry.report = null;

    if (!report) return Effect.void;

    const { id: threadId, title } = entry.info;
    const { answer, error } = readLastTurn(threadId);

    const text = [
      `"${title}" (thread ${threadId}) finished the turn you sent it${error ? ", with an error" : ""}.`,
      answer ? `Its answer:\n\n${clip(answer, MAX_REPORT_CHARS)}` : "It gave no answer.",
      ...(error ? [`Error: ${error}`] : []),
      "read_thread shows the whole thread; send_message carries it on.",
    ].join("\n\n");

    return Effect.forEach(
      recipients,
      (recipient) =>
        send(
          recipient,
          text,
          {
            effort: null,
            permission: recipient.turnSettings?.permission ?? "ask",
            attachments: [],
          },
          {
            queue: true,
            messageId: deriveRequestUuid(threadId, `report:${report.turn}`),
            from: MessageSender.cases.report.make({ threadId, title }),
          },
        ).pipe(reportErrorsIn(recipient.info.id), Effect.ignore),
      { discard: true },
    );
  }

  /** Threads that sent work into `entry`'s turn and aren't waiting on it, so need telling. */
  function listRecipients(entry: ThreadEntry) {
    return [...(entry.report?.to ?? [])].flatMap((recipientId) => {
      const recipient = threads.get(recipientId);

      return recipient &&
        recipient.info.archivedAt === null &&
        !waiting.has(`${recipientId}\0${entry.info.id}`)
        ? [recipient]
        : [];
    });
  }

  /** Users rarely watch threads agents started, so a question goes to the agents that sent the work. */
  function forwardQuestions(entry: ThreadEntry) {
    const pending = readPendingRequest(entry);

    if (!pending?.questions) return Effect.void;

    const { id: threadId, title } = entry.info;

    const questions = pending.questions.map(
      ({ id, header, question, options, multiSelect }) =>
        `- ${header} (id "${id}", ${multiSelect ? "any number" : "one"}): ${question}\n${options.map(({ label, description }) => `  - ${label}${description ? `: ${description}` : ""}`).join("\n")}`,
    );

    const text = `"${title}" (thread ${threadId}) stopped to ask you:\n\n${questions.join("\n")}\n\nAnswer with answer_questions (request ${pending.requestId}), or ask the user.`;

    return Effect.forEach(
      listRecipients(entry),
      (recipient) =>
        send(
          recipient,
          text,
          {
            effort: null,
            permission: recipient.turnSettings?.permission ?? "ask",
            attachments: [],
          },
          {
            queue: true,
            messageId: deriveRequestUuid(threadId, `question:${pending.requestId}`),
            from: MessageSender.cases.report.make({ threadId, title }),
          },
        ).pipe(reportErrorsIn(recipient.info.id), Effect.ignore),
      { discard: true },
    );
  }

  /** Questions answered before the agents they went to got them don't need asking any more. */
  function withdrawQuestions(entry: ThreadEntry, requestId: string) {
    const messageId = deriveRequestUuid(entry.info.id, `question:${requestId}`);

    for (const recipient of listRecipients(entry)) {
      const queue = recipient.info.queue ?? [];

      if (queue.some((queued) => queued.id === messageId))
        setQueue(
          recipient,
          queue.filter((queued) => queued.id !== messageId),
        );
    }
  }

  /** Reports each turn that ends, and each question asked, for as long as the daemon runs. */
  function followTurns(events: Stream.Stream<SequencedEvent>) {
    return Stream.runForEach(events, ({ event }) => {
      const entry = "threadId" in event && event.threadId ? threads.get(event.threadId) : undefined;

      if (!entry) return Effect.void;

      if (RuntimeEvent.guards["approval.resolved"](event))
        return Effect.sync(() => withdrawQuestions(entry, event.requestId));

      if (!RuntimeEvent.guards["thread.status"](event)) return Effect.void;

      if (event.status === "awaiting-answer") return forwardQuestions(entry);

      return isTurnActive(event.status) || entry.isSettingUp ? Effect.void : reportTurn(entry);
    });
  }

  const answerQuestions = Effect.fn("answerQuestions")(function* (
    _callerId: string,
    input: AnswerQuestionsInput,
  ) {
    const target = yield* getTargetEntry(input.threadId);
    const pending = readPendingRequest(target);

    if (!pending?.questions || pending.requestId !== input.requestId || !target.session)
      return yield* new CommandError({
        message: `"${target.info.title}" isn't waiting on those questions any more. read_thread shows where it is.`,
      });

    const known = new Set(pending.questions.map((question) => question.id));
    const unknown = Object.keys(input.answers).filter((id) => !known.has(id));

    if (unknown.length > 0)
      return yield* new CommandError({
        message: `No question has the id ${unknown.map((id) => `"${id}"`).join(", ")}. The ids are ${[...known].map((id) => `"${id}"`).join(", ")}.`,
      });

    yield* target.session.respondApproval(input.requestId, "allow", { answers: input.answers });

    return summarizeThread(target);
  });

  /** What the caller runs on, and each harness it can start threads on, with its models. */
  const listHarnesses = Effect.fn("listHarnesses")(function* (callerId: string) {
    const caller = yield* getEntry(callerId);
    const settings = yield* settingsStore.get;

    const harnesses = yield* Effect.forEach(yield* providerRegistry.list, (status) =>
      Effect.map(findHarnessProblem(status.kind), (problem) => ({
        provider: status.kind,
        name: getHarnessName(settings, status.kind),
        ...(problem ? { unavailable: problem } : { available: true }),
        models: status.models.map(({ id, label, recommended, efforts }) => ({
          id,
          label,
          ...(recommended && { recommended }),
          ...(efforts && { efforts }),
        })),
      })),
    );

    return {
      yours: {
        provider: caller.info.provider,
        model: caller.info.model,
        permission: caller.turnSettings?.permission ?? "ask",
      },
      harnesses,
    };
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

      const { models } = (yield* providerRegistry.list).find(
        (status) => status.kind === provider,
      ) ?? { models: [] };

      if (input.model && models.length > 0 && !models.some((model) => model.id === input.model))
        return yield* new CommandError({
          message: `${getHarnessName(yield* settingsStore.get, provider)} has no model "${input.model}". Its models are ${models.map((model) => `"${model.id}"`).join(", ")}.`,
        });

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

    const ceiling = caller.turnSettings?.permission ?? "ask";

    // The target's own level, unless that's more than the caller may give.
    const fallback =
      target.turnSettings &&
      getPermissionRank(target.turnSettings.permission) < getPermissionRank(ceiling)
        ? target.turnSettings.permission
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
    listHarnesses,
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
    readThread: (
      _callerId: string,
      threadId: string,
      after: number | undefined,
      view: "messages" | "activity" = "messages",
    ) =>
      Effect.map(getTargetEntry(threadId), (entry) => {
        const items = readTimeline(store.readAfter(threadId, after ?? 0), view === "activity");

        return {
          ...summarizeThread(entry),
          [view]: items.slice(0, 50),
          ...(items.length > 50 && { more: true }),
        };
      }),
    startThread,
    sendMessage,
    answerQuestions,
    watchPullRequest: Effect.fn("watchPullRequest")(function* (
      callerId: string,
      input: WatchPullRequestInput,
    ) {
      const caller = yield* getEntry(callerId);

      if (input.stop) {
        pullRequestWatch.unwatch(caller);

        return { watching: null };
      }

      const { number, url, title, checks } = yield* pullRequestWatch.watch(
        caller,
        input.pullRequest ?? null,
      );

      return { watching: { number, url, title }, checks };
    }),
    waitForThread: (callerId: string, threadId: string, timeoutMs: number) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) => waitForTurn(callerId, entry, timeoutMs)),
    stopThread: (_callerId: string, threadId: string) =>
      Effect.flatMap(getTargetEntry(threadId), (entry) =>
        Effect.as(interrupt(entry), summarizeThread(entry)),
      ),
  };
}
