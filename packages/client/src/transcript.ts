import {
  type ApprovalDecision,
  type Attachment,
  type CommandRun,
  type MessageSender,
  type PageInfo,
  type ProviderKind,
  RuntimeEvent,
  type ServerFrame,
  type StoredEvent,
  type ToolChange,
  type UserAnswers,
  type UserQuestion,
} from "@masscode/contracts";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** `null` while the tool is still running. */
  readonly output: string | null;
  readonly isError: boolean;
  /** Calls made by the subagent this call started. */
  readonly children?: ReadonlyArray<ToolCall>;
  /** What it changes, for edits, writes and commands; missing on calls stored before it was sent. */
  readonly change?: ToolChange;
}

export type TranscriptItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      /** Sent into a running turn; those can't be rewound to. */
      readonly steer: boolean;
      /** Set when a finished command run sent it, rather than the user typing it. */
      readonly run: CommandRun | null;
      /** The harness it went to; null on messages from before threads could switch harness. */
      readonly provider: ProviderKind | null;
      /** What that harness was told ahead of it, having just been switched to. */
      readonly handoff: {
        readonly from: ProviderKind;
        readonly messages: number;
        readonly text: string;
      } | null;
      /** Null when the user wrote it. */
      readonly from: MessageSender | null;
    }
  /** What a turn changed on disk; `id` is `checkpoint:<messageId>` of the message that started it. */
  | {
      readonly kind: "checkpoint";
      readonly id: string;
      readonly messageId: string;
      readonly files: number;
      readonly additions: number;
      readonly deletions: number;
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  /** The agent's thinking, folded to a line in the transcript. */
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly text: string;
      /** How long it thought; missing while it streams, and when the daemon didn't time it. */
      readonly durationMs?: number;
    }
  | {
      readonly kind: "forked";
      readonly id: string;
      readonly fromThreadId: string;
      readonly fromTitle: string;
    }
  /** Where a thread another thread's agent started begins: that thread. */
  | {
      readonly kind: "startedBy";
      readonly id: string;
      readonly byThreadId: string;
      readonly byTitle: string;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly output: string | null;
      readonly isError: boolean;
      readonly change?: ToolChange;
      /** Calls made by the subagent this call started. Missing on items cached before subagents showed. */
      readonly children?: ReadonlyArray<ToolCall>;
      /** What that subagent is doing now, in its own words; updated every half minute or so. */
      readonly progress?: string;
      readonly tokens?: number;
      /** When that subagent started, back-dated from the run time its progress reports. */
      readonly startedAt?: number;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly title: string;
      readonly detail: string;
      /** The subagent asking, when it isn't the main agent. */
      readonly agent?: string;
      readonly resolved: boolean;
      readonly decision: ApprovalDecision | null;
      /** Set when the agent asks questions rather than for permission. */
      readonly questions?: ReadonlyArray<UserQuestion>;
      /** What was answered; absent until then, and when the questions were skipped. */
      readonly answers?: UserAnswers;
      /** What the tool would change, for edits, writes and commands. */
      readonly change?: ToolChange;
    }
  /** MassCode compacted the conversation while it was idle, before its prompt cache expired. */
  | { readonly kind: "compacted"; readonly id: string; readonly tokens: number }
  /** How the new worktree's setup command from `masscode.toml` ended. */
  | {
      readonly kind: "setup";
      readonly id: string;
      readonly run: CommandRun;
      readonly stopped: boolean;
    }
  /** The user stopped the turn. */
  | { readonly kind: "stopped"; readonly id: string }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly text: string;
      /** The raw error behind `text`, when there's more to it. */
      readonly detail?: string;
    };

/**
 * One thread's messages, loaded when it's opened (the thread list never needs them).
 * Same lifecycle as t3code's thread state: `cached` from the last run, `loading` while
 * the daemon sends it, `live` once caught up and following new events.
 */
export interface Transcript {
  readonly items: ReadonlyArray<TranscriptItem>;
  /** Id of the newest stored event applied; the daemon replays whatever came after it. */
  readonly cursor: number;
  /** Set when only the latest turns are loaded. */
  readonly page: PageInfo | null;
  readonly status: "cached" | "loading" | "live";
  readonly loadingOlder: boolean;
}

/** Searches from the end: the item being updated is almost always the last one. */
export function upsert(
  items: ReadonlyArray<TranscriptItem>,
  id: string,
  next: (prev: TranscriptItem | undefined) => TranscriptItem,
) {
  let index = items.length - 1;

  while (index >= 0 && items[index].id !== id) index--;

  if (index === -1) return [...items, next(undefined)];

  const copy = items.slice();
  copy[index] = next(items[index]);

  return copy;
}

/** Applies a transcript event. Unchanged items keep their identity, so rendering can skip them. */
export function reduceItems(
  items: ReadonlyArray<TranscriptItem>,
  event: RuntimeEvent,
  id: number | null,
): ReadonlyArray<TranscriptItem> {
  return RuntimeEvent.matchOrElse<ReadonlyArray<TranscriptItem>>(
    event,
    {
      "user.message": (message) =>
        upsert(items, message.messageId, () => ({
          kind: "user",
          id: message.messageId,
          text: message.text,
          attachments: message.attachments ?? [],
          steer: message.steer === true,
          run: message.run ?? null,
          provider: message.provider ?? null,
          handoff: message.handoff ?? null,
          from: message.from ?? null,
        })),
      "turn.checkpoint": ({ messageId, files, additions, deletions }) => {
        const checkpoint: TranscriptItem = {
          kind: "checkpoint",
          id: `checkpoint:${messageId}`,
          messageId,
          files,
          additions,
          deletions,
        };

        // Worked out after the turn ends, by which time a queued message may have started the next
        // turn: it goes at the end of its own turn, before the next prompt.
        const start = items.findIndex((item) => item.id === messageId);

        const next =
          start === -1
            ? -1
            : items.findIndex(
                (item, index) => index > start && item.kind === "user" && !item.steer,
              );

        if (next === -1) return upsert(items, checkpoint.id, () => checkpoint);

        return [
          ...items.slice(0, next).filter((item) => item.id !== checkpoint.id),
          checkpoint,
          ...items.slice(next).filter((item) => item.id !== checkpoint.id),
        ];
      },
      "thread.forked": ({ fromThreadId, fromTitle }) =>
        upsert(items, `forked:${fromThreadId}`, () => ({
          kind: "forked",
          id: `forked:${fromThreadId}`,
          fromThreadId,
          fromTitle,
        })),
      "thread.startedBy": ({ byThreadId, byTitle }) =>
        upsert(items, `startedBy:${byThreadId}`, () => ({
          kind: "startedBy",
          id: `startedBy:${byThreadId}`,
          byThreadId,
          byTitle,
        })),
      "thread.compacted": ({ tokens }) => {
        const key = `compacted:${id ?? crypto.randomUUID()}`;

        return upsert(items, key, () => ({ kind: "compacted", id: key, tokens }));
      },
      "worktree.setup": ({ run, stopped }) =>
        upsert(items, "setup", () => ({ kind: "setup", id: "setup", run, stopped })),
      "thread.rewound": (rewound) => {
        const index = items.findIndex((item) => item.id === rewound.messageId);

        return index === -1 ? items : items.slice(0, index);
      },
      "assistant.delta": (delta) =>
        upsert(items, delta.messageId, (prev) => ({
          kind: "assistant",
          id: delta.messageId,
          text: (prev?.kind === "assistant" ? prev.text : "") + delta.delta,
        })),
      "assistant.completed": (completed) =>
        upsert(items, completed.messageId, () => ({
          kind: "assistant",
          id: completed.messageId,
          text: completed.text,
        })),
      "reasoning.delta": (delta) =>
        upsert(items, delta.messageId, (prev) => ({
          kind: "reasoning",
          id: delta.messageId,
          text: (prev?.kind === "reasoning" ? prev.text : "") + delta.delta,
        })),
      "reasoning.completed": (completed) =>
        upsert(items, completed.messageId, () => ({
          kind: "reasoning",
          id: completed.messageId,
          text: completed.text,
          ...(completed.durationMs !== undefined && { durationMs: completed.durationMs }),
        })),
      "turn.completed": ({ stopped }) => {
        if (!stopped) return items;

        const key = `stopped:${id ?? crypto.randomUUID()}`;

        return upsert(items, key, () => ({ kind: "stopped", id: key }));
      },
      "tool.started": (tool) => {
        const call = {
          id: tool.toolId,
          name: tool.name,
          summary: tool.summary,
          output: null,
          isError: false,
          ...(tool.change && { change: tool.change }),
        };

        const parent = items.findLast((item) => item.id === tool.parentToolId);

        if (parent?.kind !== "tool")
          return upsert(items, tool.toolId, () => ({ kind: "tool", ...call }));

        return upsert(items, parent.id, () => ({
          ...parent,
          children: [...(parent.children ?? []).filter((child) => child.id !== call.id), call],
        }));
      },
      "tool.progress": (progress) =>
        items.map((item) =>
          item.kind === "tool" && item.id === progress.toolId
            ? {
                ...item,
                progress: progress.summary ?? item.progress,
                tokens: progress.tokens ?? item.tokens,
                startedAt:
                  progress.durationMs === undefined
                    ? item.startedAt
                    : Date.now() - progress.durationMs,
              }
            : item,
        ),
      "tool.completed": (tool) =>
        items.map((item) => {
          if (item.kind !== "tool") return item;

          if (item.id === tool.toolId)
            return { ...item, output: tool.output, isError: tool.isError };

          if (!item.children?.some((child) => child.id === tool.toolId)) return item;

          return {
            ...item,
            children: item.children.map((child) =>
              child.id === tool.toolId
                ? { ...child, output: tool.output, isError: tool.isError }
                : child,
            ),
          };
        }),
      "approval.requested": (approval) =>
        upsert(items, approval.requestId, () => ({
          kind: "approval",
          id: approval.requestId,
          title: approval.title,
          detail: approval.detail,
          agent: approval.agent,
          resolved: false,
          decision: null,
          questions: approval.questions,
          change: approval.change,
        })),
      "approval.resolved": (approval) =>
        items.map((item) =>
          item.id === approval.requestId && item.kind === "approval"
            ? { ...item, resolved: true, answers: approval.answers }
            : item,
        ),
      error: (error) => {
        const key = id === null ? crypto.randomUUID() : `error:${id}`;
        // Stored before the daemon said in words why a Claude turn ended early.
        const code = /^Turn ended: (\w+)$/.exec(error.message)?.[1];

        return upsert(items, key, () => ({
          kind: "error",
          id: key,
          text: code
            ? "The agent ended this turn early. Send a message to carry on."
            : error.message,
          ...((code ?? error.detail) !== undefined && { detail: code ?? error.detail }),
        }));
      },
    },
    () => items,
  );
}

export function applyStoredEvents(
  items: ReadonlyArray<TranscriptItem>,
  events: ReadonlyArray<StoredEvent>,
  after: number,
) {
  let next = items;

  for (const { id, event } of events) if (id > after) next = reduceItems(next, event, id);

  return next;
}

/** Text of messages still streaming, sent whole with a snapshot or replay: it replaces what the cache had. */
export function applyStreaming(
  items: ReadonlyArray<TranscriptItem>,
  deltas: ReadonlyArray<RuntimeEvent>,
) {
  const texts = new Map<string, { kind: "assistant" | "reasoning"; text: string }>();

  for (const event of deltas) {
    if (RuntimeEvent.isAnyOf(["assistant.delta", "reasoning.delta"])(event))
      texts.set(event.messageId, {
        kind: RuntimeEvent.guards["assistant.delta"](event) ? "assistant" : "reasoning",
        text: (texts.get(event.messageId)?.text ?? "") + event.delta,
      });
  }

  let next = items;

  for (const [messageId, { kind, text }] of texts)
    next = upsert(next, messageId, () => ({ kind, id: messageId, text }));

  return next;
}

type TranscriptFrame<Tag extends ServerFrame["_tag"]> = Extract<ServerFrame, { _tag: Tag }>;

/** A transcript from scratch: the latest turns, plus any message still streaming. */
export function snapshotTranscript(snapshot: TranscriptFrame<"thread.snapshot">): Transcript {
  return {
    items: applyStreaming(applyStoredEvents([], snapshot.events, 0), snapshot.streaming),
    cursor: snapshot.cursor,
    page: snapshot.page,
    status: "live",
    loadingOlder: false,
  };
}

/** Catches a kept transcript up with what it missed while away. */
export function replayTranscript(
  previous: Transcript | undefined,
  replay: TranscriptFrame<"thread.replay">,
): Transcript {
  return {
    items: applyStreaming(
      applyStoredEvents(previous?.items ?? [], replay.events, previous?.cursor ?? 0),
      replay.streaming,
    ),
    cursor: Math.max(previous?.cursor ?? 0, replay.cursor),
    page: previous?.page ?? null,
    status: "live",
    loadingOlder: false,
  };
}

/** Puts older turns ahead of the ones already loaded. */
export function prependPage(
  previous: Transcript,
  page: TranscriptFrame<"thread.page">,
): Transcript {
  const known = new Set(previous.items.map((item) => item.id));

  return {
    ...previous,
    items: [
      ...applyStoredEvents([], page.events, 0).filter((item) => !known.has(item.id)),
      ...previous.items,
    ],
    page: page.page,
    loadingOlder: false,
  };
}
