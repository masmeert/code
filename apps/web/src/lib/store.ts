import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_SETTINGS,
  type AuthFlow,
  type Project,
  type ProviderKind,
  type ProviderSettings,
  type ProviderStatus,
  type Settings,
  type ApprovalDecision,
  type Attachment,
  ClientCommand,
  type GitAction,
  type PageInfo,
  type RepoStatus,
  RuntimeEvent,
  type SearchHit,
  ServerFrame,
  type SlashCommand,
  type StoredEvent,
  type ThreadInfo,
  type TurnOptions,
  isTranscriptEvent,
} from "@apcode/contracts";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";
import { performBrowserAction } from "./browser.ts";
import { loadShell, loadTranscript, removeTranscript, saveShell, saveTranscript } from "./cache.ts";

export type TranscriptItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      /** Sent into a running turn; those can't be rewound to. */
      readonly steer: boolean;
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
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly output: string | null;
      readonly isError: boolean;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly title: string;
      readonly detail: string;
      readonly resolved: boolean;
      readonly decision: ApprovalDecision | null;
    }
  | { readonly kind: "error"; readonly id: string; readonly text: string };

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

export interface State {
  readonly connected: boolean;
  /**
   * Where the data on screen came from: nothing yet, the local cache from the last
   * run (shown while the daemon starts), or the daemon itself.
   */
  readonly source: "none" | "cache" | "daemon";
  /** The daemon database the data on screen belongs to. */
  readonly dataId: string | null;
  readonly settings: Settings;
  readonly projects: ReadonlyArray<Project>;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  /** Set when a thread this window asked for appears, so the window can open it. */
  readonly createdHere: { readonly threadId: string } | null;
  readonly order: ReadonlyArray<string>;
  /** The thread list. Transcripts live apart, so streaming text doesn't re-render the sidebar. */
  readonly threads: Readonly<Record<string, ThreadInfo>>;
  readonly transcripts: Readonly<Record<string, Transcript>>;
  /** When each thread was last looked at (its `updatedAt` then); shared across windows via localStorage. */
  readonly seen: Readonly<Record<string, SeenMark>>;
  /** Local branches per repo path, fetched on demand by the branch picker. */
  readonly branches: Readonly<Record<string, BranchList>>;
  /** Uncommitted changes per repo path, fetched on demand by the diff panel. */
  readonly diffs: Readonly<Record<string, RepoDiff>>;
  /** Working-tree/upstream state per repo path, fetched on demand by the git menu. */
  readonly repos: Readonly<Record<string, RepoState>>;
  /** Slash commands per thread, fetched when the command menu opens. */
  readonly commands: Readonly<Record<string, ReadonlyArray<SlashCommand>>>;
  /** One turn's changes, keyed `<threadId>:<messageId>`, fetched by the changes panel. */
  readonly turnDiffs: Readonly<Record<string, RepoDiff>>;
  /** Messages written while the agent worked, held here until its turn ends. Per window. */
  readonly followUps: Readonly<Record<string, ReadonlyArray<FollowUp>>>;
  readonly terminals: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly activeTerminals: Readonly<Record<string, string>>;
}

export interface FollowUp {
  readonly id: string;
  readonly text: string;
  readonly options: TurnOptions;
}

export interface RepoState {
  /** Null outside a repo. */
  readonly status: RepoStatus | null;
  /** The commit/push the last update answered, and why it failed. */
  readonly action: GitAction | null;
  readonly error: string | null;
}

export interface RepoDiff {
  readonly patch: string;
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface BranchList {
  readonly current: string | null;
  readonly branches: ReadonlyArray<string>;
  /** Why the last checkout failed. */
  readonly error: string | null;
}

/**
 * What you last saw of a thread: its `updatedAt` then (`rev`) and when (`at`).
 * `manual` is a Settle/Unsettle from the menu, which skips the settle delay.
 */
export const SeenMark = Schema.Struct({
  rev: Schema.Number,
  at: Schema.Number,
  manual: Schema.optionalKey(Schema.Boolean),
});
export type SeenMark = typeof SeenMark.Type;

const SEEN_KEY = "apcode.seen";
const hasSeenKey = () => {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true;
  }
};
const writeSeen = (seen: Record<string, SeenMark>) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {}
};
const readSeen = (): Record<string, SeenMark> => {
  try {
    const raw = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Union([Schema.Number, SeenMark]))),
    )(localStorage.getItem(SEEN_KEY) ?? "{}");
    // Marks used to be the bare `updatedAt`.
    return Object.fromEntries(
      Object.entries(raw).map(([id, mark]) => [
        id,
        typeof mark === "number" ? { rev: mark, at: mark } : mark,
      ]),
    );
  } catch {
    return {};
  }
};

const initial: State = {
  connected: false,
  source: "none",
  dataId: null,
  settings: DEFAULT_SETTINGS,
  projects: [],
  providers: [],
  authFlows: {},
  createdHere: null,
  order: [],
  threads: {},
  transcripts: {},
  seen: readSeen(),
  branches: {},
  diffs: {},
  repos: {},
  commands: {},
  turnDiffs: {},
  followUps: {},
  terminals: {},
  activeTerminals: {},
};

/** Request ids of `thread.create` commands sent from this window. */
const ownRequests = new Set<string>();

/** Latest turns loaded when a thread opens, and per "load earlier" (t3code uses the same window). */
const TURN_LIMIT = 10;

/** Searches from the end: the item being updated is almost always the last one. */
const upsert = (
  items: ReadonlyArray<TranscriptItem>,
  id: string,
  next: (prev: TranscriptItem | undefined) => TranscriptItem,
) => {
  let index = items.length - 1;
  while (index >= 0 && items[index]!.id !== id) index--;
  if (index === -1) return [...items, next(undefined)];
  const copy = items.slice();
  copy[index] = next(items[index]);
  return copy;
};

/** Applies a transcript event. Unchanged items keep their identity, so rendering can skip them. */
const reduceItems = (
  items: ReadonlyArray<TranscriptItem>,
  event: RuntimeEvent,
  id: number | null,
): ReadonlyArray<TranscriptItem> =>
  Match.value(event).pipe(
    Match.withReturnType<ReadonlyArray<TranscriptItem>>(),
    Match.tag("user.message", (message) =>
      upsert(items, message.messageId, () => ({
        kind: "user",
        id: message.messageId,
        text: message.text,
        attachments: message.attachments ?? [],
        steer: message.steer === true,
      })),
    ),
    Match.tag("turn.checkpoint", ({ messageId, files, additions, deletions }) => {
      const item: TranscriptItem = {
        kind: "checkpoint",
        id: `checkpoint:${messageId}`,
        messageId,
        files,
        additions,
        deletions,
      };
      // Worked out after the turn ends, by which time a queued message may have started the next
      // turn: it goes at the end of its own turn, before the next prompt.
      const start = items.findIndex((i) => i.id === messageId);
      const next =
        start === -1
          ? -1
          : items.findIndex((i, index) => index > start && i.kind === "user" && !i.steer);
      if (next === -1) return upsert(items, item.id, () => item);
      return [
        ...items.slice(0, next).filter((i) => i.id !== item.id),
        item,
        ...items.slice(next).filter((i) => i.id !== item.id),
      ];
    }),
    Match.tag("thread.rewound", (rewound) => {
      const index = items.findIndex((item) => item.id === rewound.messageId);
      return index === -1 ? items : items.slice(0, index);
    }),
    Match.tag("assistant.delta", (delta) =>
      upsert(items, delta.messageId, (prev) => ({
        kind: "assistant",
        id: delta.messageId,
        text: (prev?.kind === "assistant" ? prev.text : "") + delta.delta,
      })),
    ),
    Match.tag("assistant.completed", (completed) =>
      upsert(items, completed.messageId, () => ({
        kind: "assistant",
        id: completed.messageId,
        text: completed.text,
      })),
    ),
    Match.tag("tool.started", (tool) =>
      upsert(items, tool.toolId, () => ({
        kind: "tool",
        id: tool.toolId,
        name: tool.name,
        summary: tool.summary,
        output: null,
        isError: false,
      })),
    ),
    Match.tag("tool.completed", (tool) =>
      items.map((item) =>
        item.id === tool.toolId && item.kind === "tool"
          ? { ...item, output: tool.output, isError: tool.isError }
          : item,
      ),
    ),
    Match.tag("approval.requested", (approval) =>
      upsert(items, approval.requestId, () => ({
        kind: "approval",
        id: approval.requestId,
        title: approval.title,
        detail: approval.detail,
        resolved: false,
        decision: null,
      })),
    ),
    Match.tag("approval.resolved", (approval) =>
      items.map((item) =>
        item.id === approval.requestId && item.kind === "approval"
          ? { ...item, resolved: true }
          : item,
      ),
    ),
    Match.tag("error", (error) => {
      const key = id === null ? crypto.randomUUID() : `error:${id}`;
      return upsert(items, key, () => ({ kind: "error", id: key, text: error.message }));
    }),
    Match.orElse(() => items),
  );

const foldStored = (
  items: ReadonlyArray<TranscriptItem>,
  events: ReadonlyArray<StoredEvent>,
  after: number,
) => {
  let next = items;
  for (const { id, event } of events) if (id > after) next = reduceItems(next, event, id);
  return next;
};

/** Text of messages still streaming, sent whole with a snapshot or replay: it replaces what the cache had. */
const applyStreaming = (
  items: ReadonlyArray<TranscriptItem>,
  deltas: ReadonlyArray<RuntimeEvent>,
) => {
  const texts = new Map<string, string>();
  for (const event of deltas)
    if (RuntimeEvent.guards["assistant.delta"](event))
      texts.set(event.messageId, (texts.get(event.messageId) ?? "") + event.delta);
  let next = items;
  for (const [messageId, text] of texts)
    next = upsert(next, messageId, () => ({ kind: "assistant", id: messageId, text }));
  return next;
};

/** Everything but transcripts: the thread list, settings, projects, git state… */
const reduceShell = (state: State, event: RuntimeEvent): State =>
  Match.value(event).pipe(
    Match.withReturnType<State>(),
    Match.tag("settings.updated", ({ settings }) => ({ ...state, settings })),
    Match.tag("project.added", ({ project }) => ({
      ...state,
      projects: [...state.projects.filter((p) => p.id !== project.id), project],
    })),
    Match.tag("project.removed", ({ projectId }) => ({
      ...state,
      projects: state.projects.filter((p) => p.id !== projectId),
    })),
    Match.tag("providers.updated", ({ providers }) => ({ ...state, providers })),
    Match.tag("git.branches", ({ path, current, branches, error }) => ({
      ...state,
      branches: { ...state.branches, [path]: { current, branches, error } },
    })),
    Match.tag("git.diff", ({ path, patch, truncated, error }) => ({
      ...state,
      diffs: { ...state.diffs, [path]: { patch, truncated, error } },
    })),
    Match.tag("thread.commands", ({ threadId, commands }) => ({
      ...state,
      commands: { ...state.commands, [threadId]: commands },
    })),
    Match.tag("checkpoint.diff", ({ threadId, messageId, patch, truncated, error }) => ({
      ...state,
      turnDiffs: { ...state.turnDiffs, [`${threadId}:${messageId}`]: { patch, truncated, error } },
    })),
    Match.tag("git.status", ({ path, status, action, error }) => ({
      ...state,
      repos: { ...state.repos, [path]: { status, action, error } },
    })),
    Match.tag("auth.flow", ({ flow }) => ({
      ...state,
      authFlows: { ...state.authFlows, [flow.provider]: flow },
    })),
    Match.tag("thread.created", ({ thread, requestId }) => {
      const mine = requestId !== null && ownRequests.delete(requestId);
      return {
        ...state,
        createdHere: mine ? { threadId: thread.id } : state.createdHere,
        order: [thread.id, ...state.order.filter((id) => id !== thread.id)],
        threads: { ...state.threads, [thread.id]: thread },
        // Brand new: nothing to fetch, it's live from its first event.
        transcripts: {
          ...state.transcripts,
          [thread.id]: {
            items: [],
            cursor: 0,
            page: null,
            status: "live",
            loadingOlder: false,
          },
        },
      };
    }),
    Match.tag("thread.removed", ({ threadId }) => {
      const { [threadId]: _thread, ...threads } = state.threads;
      const { [threadId]: _transcript, ...transcripts } = state.transcripts;
      const { [threadId]: _terminals, ...terminals } = state.terminals;
      const { [threadId]: _activeTerminal, ...activeTerminals } = state.activeTerminals;
      if (state.dataId) removeTranscript(state.dataId, threadId);
      return {
        ...state,
        order: state.order.filter((id) => id !== threadId),
        threads,
        transcripts,
        terminals,
        activeTerminals,
      };
    }),
    Match.tag("terminal.opened", ({ threadId, terminalId }) => {
      const terminalIds = state.terminals[threadId] ?? [];
      if (terminalIds.includes(terminalId)) return state;
      return {
        ...state,
        terminals: { ...state.terminals, [threadId]: [...terminalIds, terminalId] },
      };
    }),
    Match.tag("terminal.closed", ({ threadId, terminalId }) =>
      withoutTerminal(state, threadId, terminalId),
    ),
    Match.tag("thread.status", ({ threadId, status }) =>
      updateThreadInfo(state, threadId, (info) => ({ ...info, status })),
    ),
    Match.tag("thread.model", ({ threadId, model }) =>
      updateThreadInfo(state, threadId, (info) => ({ ...info, model })),
    ),
    Match.tag("thread.archived", ({ threadId, archivedAt }) =>
      updateThreadInfo(state, threadId, (info) => ({ ...info, archivedAt })),
    ),
    Match.tag("thread.meta", ({ threadId, title, updatedAt, branch }) =>
      updateThreadInfo(state, threadId, (info) => ({ ...info, title, updatedAt, branch })),
    ),
    Match.orElse(() => state),
  );

function updateThreadInfo(
  state: State,
  threadId: string,
  update: (info: ThreadInfo) => ThreadInfo,
): State {
  const info = state.threads[threadId];
  if (!info) return state;
  return { ...state, threads: { ...state.threads, [threadId]: update(info) } };
}

const setTranscript = (state: State, threadId: string, transcript: Transcript): State => ({
  ...state,
  transcripts: { ...state.transcripts, [threadId]: transcript },
});

function withoutTerminal(state: State, threadId: string, terminalId: string): State {
  const terminalIds = state.terminals[threadId] ?? [];
  const remaining = terminalIds.filter((id) => id !== terminalId);
  const { [threadId]: active, ...activeTerminals } = state.activeTerminals;
  const nextActive =
    active === terminalId
      ? (remaining[terminalIds.indexOf(terminalId)] ?? remaining.at(-1))
      : active;
  return {
    ...state,
    terminals: { ...state.terminals, [threadId]: remaining },
    activeTerminals: nextActive ? { ...activeTerminals, [threadId]: nextActive } : activeTerminals,
  };
}

// ---------------------------------------------------------------------------

let state = initial;
const listeners = new Set<() => void>();
let notifyScheduled = false;
const notify = () => {
  notifyScheduled = false;
  for (const listener of listeners) listener();
};

const setState = (next: State) => {
  const prev = state;
  state = next;
  // Deltas can arrive faster than frames: re-render at most once per frame.
  if (!notifyScheduled) {
    notifyScheduled = true;
    requestAnimationFrame(notify);
  }
  if (next.dataId === null) return;
  if (
    next.source === "daemon" &&
    (prev.threads !== next.threads ||
      prev.order !== next.order ||
      prev.projects !== next.projects ||
      prev.settings !== next.settings ||
      prev.providers !== next.providers)
  ) {
    const { dataId, settings, projects, providers, order, threads } = next;
    saveShell({ dataId, settings, projects, providers, order, threads });
  }
  if (prev.transcripts !== next.transcripts || prev.threads !== next.threads) {
    for (const [threadId, transcript] of Object.entries(next.transcripts)) {
      if (transcript.status !== "live") continue;
      // Persist once a turn settles, not on every delta: encoding the whole transcript
      // mid-stream is wasted work (t3code does the same). Saved when the turn ends.
      const running = next.threads[threadId]?.status === "running";
      if (running) continue;
      const settled = prev.threads[threadId]?.status === "running";
      if (transcript === prev.transcripts[threadId] && !settled) continue;
      const { items, cursor, page } = transcript;
      saveTranscript(next.dataId, threadId, { items, cursor, page });
    }
  }
};

/** Threads with an open view, counted (a thread can be open in several places). */
const wanted = new Map<string, number>();
/** Threads whose cached transcript is still being read; subscribing waits for it, to know the cursor. */
const readingCache = new Set<string>();

/** Puts a thread's cached transcript in memory, if it isn't there yet. */
const loadCachedTranscript = async (threadId: string) => {
  const dataId = state.dataId;
  if (!dataId || state.transcripts[threadId] || readingCache.has(threadId)) return;
  readingCache.add(threadId);
  const cached = await loadTranscript(dataId, threadId);
  readingCache.delete(threadId);
  // The daemon may have answered meanwhile, or a new shell may be from another database.
  if (!cached || state.dataId !== dataId || state.transcripts[threadId]) return;
  const { items, cursor, page } = cached;
  setState(
    setTranscript(state, threadId, { items, cursor, page, status: "cached", loadingOlder: false }),
  );
};

/**
 * Resolves once the last run's state is on screen (or there is none), so the first
 * paint shows your threads, and the latest one's messages, rather than an empty app.
 */
export const ready: Promise<void> = loadShell().then(async (cached) => {
  // The daemon beat the cache: its data is newer.
  if (!cached || state.source !== "none") return;
  const { dataId, settings, projects, providers, order, threads } = cached;
  setState({ ...state, source: "cache", dataId, settings, projects, providers, order, threads });
  if (order[0]) await loadCachedTranscript(order[0]);
});

let socket: WebSocket | null = null;

const socketOpen = () => socket?.readyState === WebSocket.OPEN;

/** Asks for a thread's transcript: a replay after the cursor when we have one, else the latest turns. */
const subscribe = (threadId: string) => {
  if (!socketOpen() || state.source !== "daemon" || readingCache.has(threadId)) return;
  const transcript = state.transcripts[threadId];
  if (transcript) {
    if (transcript.status === "cached")
      setState(setTranscript(state, threadId, { ...transcript, status: "loading" }));
  } else {
    setState(
      setTranscript(state, threadId, {
        items: [],
        cursor: 0,
        page: null,
        status: "loading",
        loadingOlder: false,
      }),
    );
  }
  const after = transcript && transcript.items.length > 0 ? transcript.cursor : null;
  socket!.send(
    JSON.stringify(
      ClientCommand.cases["thread.subscribe"].make({ threadId, after, turnLimit: TURN_LIMIT }),
    ),
  );
};

const onShell = (frame: Extract<ServerFrame, { _tag: "shell" }>) => {
  attempt = 0;
  const sameData = frame.dataId === state.dataId;
  const threads = Object.fromEntries(frame.threads.map((info) => [info.id, info]));
  // Keep transcripts of threads that still exist; they resume from their cursor.
  const transcripts: Record<string, Transcript> = {};
  if (sameData) {
    for (const [threadId, transcript] of Object.entries(state.transcripts)) {
      if (threads[threadId]) transcripts[threadId] = transcript;
      else removeTranscript(frame.dataId, threadId);
    }
  }
  const terminals: Record<string, Array<string>> = {};
  for (const { threadId, terminalId } of [...frame.terminals, ...screens.values()]) {
    if (!terminals[threadId]?.includes(terminalId)) (terminals[threadId] ??= []).push(terminalId);
  }
  let next: State = {
    ...state,
    connected: true,
    source: "daemon",
    dataId: frame.dataId,
    settings: frame.settings,
    projects: frame.projects,
    providers: frame.providers,
    order: [...frame.threads].sort((a, b) => b.createdAt - a.createdAt).map((t) => t.id),
    threads,
    transcripts,
    terminals,
    activeTerminals: Object.fromEntries(
      Object.entries(state.activeTerminals).flatMap(([threadId, terminalId]) => {
        const active = terminals[threadId]?.includes(terminalId)
          ? terminalId
          : terminals[threadId]?.at(-1);
        return active ? [[threadId, active]] : [];
      }),
    ),
  };
  // First run with seen-tracking: everything that already exists counts as looked at.
  if (!hasSeenKey())
    next = {
      ...next,
      seen: Object.fromEntries(frame.threads.map((t) => [t.id, { rev: t.updatedAt, at: 0 }])),
    };
  setState(next);
  if (!hasSeenKey()) writeSeen(next.seen);
  for (const threadId of wanted.keys()) {
    if (transcripts[threadId] || !sameData) subscribe(threadId);
    // Not in memory yet: read the cache first so the daemon only sends what's new.
    else
      void loadCachedTranscript(threadId).then(() => wanted.has(threadId) && subscribe(threadId));
  }
  for (const screen of screens.values()) openScreen(screen);
};

const onFrame = (frame: ServerFrame) =>
  ServerFrame.match(frame, {
    shell: onShell,
    "thread.snapshot": (snapshot) => {
      const items = applyStreaming(foldStored([], snapshot.events, 0), snapshot.streaming);
      setState(
        setTranscript(state, snapshot.threadId, {
          items,
          cursor: snapshot.cursor,
          page: snapshot.page,
          status: "live",
          loadingOlder: false,
        }),
      );
    },
    "thread.replay": (replay) => {
      const prev = state.transcripts[replay.threadId];
      const base = prev?.items ?? [];
      const items = applyStreaming(
        foldStored(base, replay.events, prev?.cursor ?? 0),
        replay.streaming,
      );
      const cursor = Math.max(prev?.cursor ?? 0, replay.cursor);
      setState(
        setTranscript(state, replay.threadId, {
          items,
          cursor,
          page: prev?.page ?? null,
          status: "live",
          loadingOlder: false,
        }),
      );
    },
    "thread.page": (page) => {
      const prev = state.transcripts[page.threadId];
      if (!prev) return;
      const known = new Set(prev.items.map((item) => item.id));
      const older = foldStored([], page.events, 0).filter((item) => !known.has(item.id));
      setState(
        setTranscript(state, page.threadId, {
          ...prev,
          items: [...older, ...prev.items],
          page: page.page,
          loadingOlder: false,
        }),
      );
    },
    "search.results": ({ requestId, hits }) => {
      searches.get(requestId)?.(hits);
      searches.delete(requestId);
    },
    "terminal.snapshot": ({ threadId, terminalId, data }) =>
      screens.get(screenKey(threadId, terminalId))?.reset(data),
    "terminal.output": ({ threadId, terminalId, data }) =>
      screens.get(screenKey(threadId, terminalId))?.write(data),
    "terminal.error": ({ threadId, terminalId, message }) =>
      screens.get(screenKey(threadId, terminalId))?.fail(message),
    "browser.request": ({ threadId, requestId, action }) =>
      void performBrowserAction(threadId, action).then(
        (result) =>
          send(ClientCommand.cases["browser.respond"].make({ requestId, result, error: null })),
        (error) =>
          send(
            ClientCommand.cases["browser.respond"].make({
              requestId,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
      ),
    event: ({ event, id }) => {
      if (!isTranscriptEvent(event)) return applyShellEvent(event);
      const transcript = state.transcripts[event.threadId];
      // Not following this thread, or already have it (a replay can overlap live events).
      if (!transcript || (id !== null && id <= transcript.cursor)) return;
      const items = reduceItems(transcript.items, event, id);
      setState(
        setTranscript(state, event.threadId, {
          ...transcript,
          items,
          cursor: id ?? transcript.cursor,
        }),
      );
    },
  });

function applyShellEvent(event: RuntimeEvent) {
  const before = state;
  setState(reduceShell(state, event));
  // The turn ended: the next held message goes out.
  if (
    RuntimeEvent.guards["thread.status"](event) &&
    event.status === "idle" &&
    before.threads[event.threadId]?.status !== "idle"
  )
    sendNextFollowUp(event.threadId);
}

/**
 * The daemon's per-launch secret, from the desktop shell. Null in dev, where the daemon
 * runs on its own and only checks origins, and outside the desktop shell.
 */
const daemonToken: Promise<string | null> = window.desktop?.daemonToken() ?? Promise.resolve(null);

/**
 * Waits between reconnect attempts, growing while the daemon stays away. Starts short:
 * at launch the sidecar is still booting. Reset once a connection gets its shell.
 */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
let attempt = 0;

const connect = async () => {
  const token = await daemonToken;
  const ws = new WebSocket(
    `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
    token ? [`apcode.${token}`] : undefined,
  );
  socket = ws;
  ws.onopen = () => {
    if (window.desktop) ws.send(JSON.stringify(ClientCommand.cases["browser.host"].make({})));
    for (const command of queued.splice(0)) ws.send(JSON.stringify(command));
  };
  ws.onmessage = (message) =>
    onFrame(Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))(message.data));
  ws.onclose = () => {
    // Keep everything on screen; transcripts fall back to cached until the next connect catches them up.
    const transcripts = Object.fromEntries(
      Object.entries(state.transcripts).map(([id, t]) => [
        id,
        t.status === "cached" && !t.loadingOlder
          ? t
          : { ...t, status: "cached" as const, loadingOlder: false },
      ]),
    );
    setState({ ...state, connected: false, transcripts });
    setTimeout(
      () => void connect(),
      RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)],
    );
  };
};
void connect();

/** Follows a thread's transcript while a view shows it. */
const openThread = (threadId: string) => {
  const count = wanted.get(threadId) ?? 0;
  wanted.set(threadId, count + 1);
  if (count > 0) return;
  if (state.transcripts[threadId]) subscribe(threadId);
  else void loadCachedTranscript(threadId).then(() => wanted.has(threadId) && subscribe(threadId));
};

const closeThread = (threadId: string) => {
  const count = (wanted.get(threadId) ?? 1) - 1;
  if (count > 0) return void wanted.set(threadId, count);
  wanted.delete(threadId);
  // The transcript stays in memory; reopening replays only what it missed.
  if (socketOpen())
    socket!.send(JSON.stringify(ClientCommand.cases["thread.unsubscribe"].make({ threadId })));
};

/** A thread's transcript, followed live while the calling component is mounted. */
export const useTranscript = (threadId: string): Transcript | null => {
  useEffect(() => {
    openThread(threadId);
    return () => closeThread(threadId);
  }, [threadId]);
  return useStore((s) => s.transcripts[threadId] ?? null);
};

/** Fetches the turns before what's loaded. */
export const loadOlder = (threadId: string) => {
  const transcript = state.transcripts[threadId];
  if (!transcript?.page?.hasMore || transcript.loadingOlder || !socketOpen()) return;
  setState(setTranscript(state, threadId, { ...transcript, loadingOlder: true }));
  socket!.send(
    JSON.stringify(
      ClientCommand.cases["thread.loadOlder"].make({
        threadId,
        before: transcript.page.before,
        turnLimit: TURN_LIMIT,
      }),
    ),
  );
};

/** Commands sent while the daemon is still starting (the UI is up from cache by then). */
const queued: ClientCommand[] = [];

export const send = (command: ClientCommand) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  else queued.push(command);
};

export const getSettings = () => state.settings;

/** Applies settings locally right away (theme etc. shouldn't wait on the daemon), then persists them. */
export const updateSettings = (settings: Settings) => {
  setState({ ...state, settings });
  send(ClientCommand.cases["settings.update"].make({ settings }));
};

/** Changes some of one harness's Settings, keeping the rest. */
export const updateHarness = (provider: ProviderKind, patch: Partial<ProviderSettings>) =>
  updateSettings({
    ...state.settings,
    providers: {
      ...state.settings.providers,
      [provider]: { ...state.settings.providers[provider], ...patch },
    },
  });

/**
 * Creates a thread from a draft by sending its first message. With `open`, this window
 * switches to it once it exists.
 */
export const createThread = (input: {
  path: string;
  provider: ProviderKind;
  model: string | null;
  text: string;
  options: TurnOptions;
  workspace: "local" | "worktree";
  open?: boolean;
}) => {
  const { open = true, ...command } = input;
  const requestId = crypto.randomUUID();
  if (open) ownRequests.add(requestId);
  send(ClientCommand.cases["thread.create"].make({ requestId, ...command }));
};

// --- follow-ups ----------------------------------------------------------------
// A message written while the agent works waits here (t3code's "queue"), then goes
// out on its own when the turn ends. Sending it now steers the running turn instead.

const setFollowUps = (threadId: string, list: ReadonlyArray<FollowUp>) =>
  setState({ ...state, followUps: { ...state.followUps, [threadId]: list } });

export const queueFollowUp = (threadId: string, text: string, options: TurnOptions) =>
  setFollowUps(threadId, [
    ...(state.followUps[threadId] ?? []),
    { id: crypto.randomUUID(), text, options },
  ]);

/** Sends a held message right away, into the running turn. */
export const sendFollowUpNow = (threadId: string, id: string) => {
  const followUp = state.followUps[threadId]?.find((f) => f.id === id);
  if (!followUp) return;
  setFollowUps(
    threadId,
    (state.followUps[threadId] ?? []).filter((f) => f.id !== id),
  );
  send(
    ClientCommand.cases["thread.send"].make({
      threadId,
      text: followUp.text,
      options: followUp.options,
    }),
  );
};

/** Takes held messages back out of the queue (all of them without `id`), for the composer. */
export const takeFollowUps = (threadId: string, id?: string): ReadonlyArray<FollowUp> => {
  const list = state.followUps[threadId] ?? [];
  const taken = id ? list.filter((f) => f.id === id) : list;
  setFollowUps(threadId, id ? list.filter((f) => f.id !== id) : []);
  return taken;
};

const sendNextFollowUp = (threadId: string) => {
  const [next, ...rest] = state.followUps[threadId] ?? [];
  if (!next) return;
  setFollowUps(threadId, rest);
  send(
    ClientCommand.cases["thread.send"].make({ threadId, text: next.text, options: next.options }),
  );
};

// --- search --------------------------------------------------------------------

const searches = new Map<string, (hits: ReadonlyArray<SearchHit>) => void>();

/** Full-text search over every thread's messages, newest first. */
export const searchMessages = (query: string) =>
  new Promise<ReadonlyArray<SearchHit>>((resolve) => {
    if (!socketOpen()) return resolve([]);
    const requestId = crypto.randomUUID();
    searches.set(requestId, resolve);
    send(ClientCommand.cases.search.make({ query, requestId }));
    // An answer that never comes (the connection dropped) shouldn't hold a caller forever.
    setTimeout(() => {
      if (searches.delete(requestId)) resolve([]);
    }, 5000);
  });

// --- terminals -------------------------------------------------------------------

export interface TerminalScreen {
  readonly threadId: string;
  readonly terminalId: string;
  readonly size: () => { readonly columns: number; readonly rows: number };
  readonly reset: (data: string) => void;
  readonly write: (data: string) => void;
  readonly fail: (message: string) => void;
}

const screens = new Map<string, TerminalScreen>();

function screenKey(threadId: string, terminalId: string) {
  return `${threadId}:${terminalId}`;
}

function openScreen(screen: TerminalScreen) {
  sendIfConnected(
    ClientCommand.cases["terminal.open"].make({
      threadId: screen.threadId,
      terminalId: screen.terminalId,
      ...screen.size(),
    }),
  );
}

export function sendIfConnected(command: ClientCommand) {
  if (socketOpen()) socket!.send(JSON.stringify(command));
}

export function attachTerminal(screen: TerminalScreen) {
  const key = screenKey(screen.threadId, screen.terminalId);
  screens.set(key, screen);
  openScreen(screen);
  return () => {
    if (screens.get(key) !== screen) return;
    screens.delete(key);
    sendIfConnected(
      ClientCommand.cases["terminal.detach"].make({
        threadId: screen.threadId,
        terminalId: screen.terminalId,
      }),
    );
  };
}

export function toggleTerminalPanel(threadId: string) {
  if (state.activeTerminals[threadId]) {
    const { [threadId]: _hidden, ...activeTerminals } = state.activeTerminals;
    return setState({ ...state, activeTerminals });
  }
  const latest = state.terminals[threadId]?.at(-1);
  if (latest) showTerminal(threadId, latest);
  else newTerminal(threadId);
}

export function newTerminal(threadId: string) {
  const terminalId = crypto.randomUUID();
  setState({
    ...state,
    terminals: {
      ...state.terminals,
      [threadId]: [...(state.terminals[threadId] ?? []), terminalId],
    },
    activeTerminals: { ...state.activeTerminals, [threadId]: terminalId },
  });
}

export function showTerminal(threadId: string, terminalId: string) {
  setState({ ...state, activeTerminals: { ...state.activeTerminals, [threadId]: terminalId } });
}

export function closeTerminal(threadId: string, terminalId: string) {
  send(ClientCommand.cases["terminal.close"].make({ threadId, terminalId }));
  setState(withoutTerminal(state, threadId, terminalId));
}

/** Marks a thread's latest activity as seen; it settles once idle and the settle delay has passed. */
export const markSeen = (threadId: string) => {
  const info = state.threads[threadId];
  if (!info || state.seen[threadId]?.rev === info.updatedAt) return;
  setSeen(threadId, { rev: info.updatedAt, at: Date.now() });
};

/**
 * Manual override from the thread menu. Settling is immediate, skipping the delay;
 * unsettling brings it back as new activity, so it waits to be seen again.
 */
export const setSettled = (threadId: string, settled: boolean) => {
  const info = state.threads[threadId];
  if (info) setSeen(threadId, { rev: settled ? info.updatedAt : 0, at: Date.now(), manual: true });
};

const setSeen = (threadId: string, mark: SeenMark) => {
  const seen = { ...state.seen, [threadId]: mark };
  setState({ ...state, seen });
  writeSeen(seen);
};

// Other windows mark threads seen too.
window.addEventListener("storage", (e) => {
  if (e.key === SEEN_KEY) setState({ ...state, seen: readSeen() });
});

/** Nothing new (an error included) since you last opened the thread. */
export const isSeen = (info: ThreadInfo, seen: State["seen"]) =>
  (seen[info.id]?.rev ?? 0) >= info.updatedAt;

/**
 * Settled threads need nothing from you: not working, not waiting on approval,
 * seen, and seen at least `delayMs` ago (so a thread you just watched finish
 * doesn't jump sections under you). A manual Settle skips the wait. With
 * `inactiveMs`, threads idle that long settle unread too, unless unsettled by hand.
 */
export const isSettled = (
  info: ThreadInfo,
  seen: State["seen"],
  now: number,
  delayMs: number,
  inactiveMs: number | null,
) => {
  const mark = seen[info.id];
  if (!canSettle(info)) return false;
  if (isSeen(info, seen)) return mark?.manual === true || now - mark!.at >= delayMs;
  return (
    inactiveMs !== null &&
    now - info.updatedAt >= inactiveMs &&
    !(mark?.manual === true && mark.rev === 0)
  );
};

/** Working threads, or ones waiting on you, can't be settled by hand. */
export const canSettle = (info: ThreadInfo) =>
  info.status !== "running" && info.status !== "awaiting-approval";

export const respondApproval = (
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
) => {
  const transcript = state.transcripts[threadId];
  if (transcript) {
    const items = transcript.items.map((item) =>
      item.id === requestId && item.kind === "approval" ? { ...item, decision } : item,
    );
    setState(setTranscript(state, threadId, { ...transcript, items }));
  }
  send(ClientCommand.cases["approval.respond"].make({ threadId, requestId, decision }));
};

export const useStore = <A>(select: (state: State) => A): A =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
