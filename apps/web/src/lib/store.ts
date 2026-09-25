import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_SETTINGS,
  type AuthFlow,
  type Project,
  type ProviderKind,
  type ProviderStatus,
  type Settings,
  type ApprovalDecision,
  type Attachment,
  type ClientCommand,
  type GitAction,
  type PageInfo,
  type RepoStatus,
  type RuntimeEvent,
  type SearchHit,
  type ServerFrame,
  type SlashCommand,
  type StoredEvent,
  type ThreadInfo,
  type TurnOptions,
  isTranscriptEvent,
} from "@apcode/contracts";
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
export interface SeenMark {
  readonly rev: number;
  readonly at: number;
  readonly manual?: boolean;
}

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
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<
      string,
      number | SeenMark
    >;
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
): ReadonlyArray<TranscriptItem> => {
  switch (event._tag) {
    case "user.message":
      return upsert(items, event.messageId, () => ({
        kind: "user",
        id: event.messageId,
        text: event.text,
        attachments: event.attachments ?? [],
        steer: event.steer === true,
      }));
    case "turn.checkpoint": {
      const { messageId, files, additions, deletions } = event;
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
    }
    case "thread.rewound": {
      const index = items.findIndex((item) => item.id === event.messageId);
      return index === -1 ? items : items.slice(0, index);
    }
    case "assistant.delta":
      return upsert(items, event.messageId, (prev) => ({
        kind: "assistant",
        id: event.messageId,
        text: (prev?.kind === "assistant" ? prev.text : "") + event.delta,
      }));
    case "assistant.completed":
      return upsert(items, event.messageId, () => ({
        kind: "assistant",
        id: event.messageId,
        text: event.text,
      }));
    case "tool.started":
      return upsert(items, event.toolId, () => ({
        kind: "tool",
        id: event.toolId,
        name: event.name,
        summary: event.summary,
        output: null,
        isError: false,
      }));
    case "tool.completed":
      return items.map((item) =>
        item.id === event.toolId && item.kind === "tool"
          ? { ...item, output: event.output, isError: event.isError }
          : item,
      );
    case "approval.requested":
      return upsert(items, event.requestId, () => ({
        kind: "approval",
        id: event.requestId,
        title: event.title,
        detail: event.detail,
        resolved: false,
        decision: null,
      }));
    case "approval.resolved":
      return items.map((item) =>
        item.id === event.requestId && item.kind === "approval"
          ? { ...item, resolved: true }
          : item,
      );
    case "error": {
      const key = id === null ? crypto.randomUUID() : `error:${id}`;
      return upsert(items, key, () => ({ kind: "error", id: key, text: event.message }));
    }
    default:
      return items;
  }
};

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
    if (event._tag === "assistant.delta")
      texts.set(event.messageId, (texts.get(event.messageId) ?? "") + event.delta);
  let next = items;
  for (const [messageId, text] of texts)
    next = upsert(next, messageId, () => ({ kind: "assistant", id: messageId, text }));
  return next;
};

/** Everything but transcripts: the thread list, settings, projects, git state… */
const reduceShell = (state: State, event: RuntimeEvent): State => {
  switch (event._tag) {
    case "settings.updated":
      return { ...state, settings: event.settings };
    case "project.added":
      return {
        ...state,
        projects: [...state.projects.filter((p) => p.id !== event.project.id), event.project],
      };
    case "project.removed":
      return { ...state, projects: state.projects.filter((p) => p.id !== event.projectId) };
    case "providers.updated":
      return { ...state, providers: event.providers };
    case "git.branches": {
      const { current, branches, error } = event;
      return {
        ...state,
        branches: { ...state.branches, [event.path]: { current, branches, error } },
      };
    }
    case "git.diff": {
      const { patch, truncated, error } = event;
      return { ...state, diffs: { ...state.diffs, [event.path]: { patch, truncated, error } } };
    }
    case "thread.commands":
      return { ...state, commands: { ...state.commands, [event.threadId]: event.commands } };
    case "checkpoint.diff": {
      const { patch, truncated, error } = event;
      return {
        ...state,
        turnDiffs: {
          ...state.turnDiffs,
          [`${event.threadId}:${event.messageId}`]: { patch, truncated, error },
        },
      };
    }
    case "git.status": {
      const { status, action, error } = event;
      return { ...state, repos: { ...state.repos, [event.path]: { status, action, error } } };
    }
    case "auth.flow":
      return { ...state, authFlows: { ...state.authFlows, [event.flow.provider]: event.flow } };
    case "thread.created": {
      const mine = event.requestId !== null && ownRequests.delete(event.requestId);
      return {
        ...state,
        createdHere: mine ? { threadId: event.thread.id } : state.createdHere,
        order: [event.thread.id, ...state.order.filter((id) => id !== event.thread.id)],
        threads: { ...state.threads, [event.thread.id]: event.thread },
        // Brand new: nothing to fetch, it's live from its first event.
        transcripts: {
          ...state.transcripts,
          [event.thread.id]: {
            items: [],
            cursor: 0,
            page: null,
            status: "live",
            loadingOlder: false,
          },
        },
      };
    }
    case "thread.removed": {
      const { [event.threadId]: _thread, ...threads } = state.threads;
      const { [event.threadId]: _transcript, ...transcripts } = state.transcripts;
      const { [event.threadId]: _terminals, ...terminals } = state.terminals;
      const { [event.threadId]: _activeTerminal, ...activeTerminals } = state.activeTerminals;
      if (state.dataId) removeTranscript(state.dataId, event.threadId);
      return {
        ...state,
        order: state.order.filter((id) => id !== event.threadId),
        threads,
        transcripts,
        terminals,
        activeTerminals,
      };
    }
    case "terminal.opened": {
      const terminalIds = state.terminals[event.threadId] ?? [];
      if (terminalIds.includes(event.terminalId)) return state;
      return {
        ...state,
        terminals: { ...state.terminals, [event.threadId]: [...terminalIds, event.terminalId] },
      };
    }
    case "terminal.closed":
      return withoutTerminal(state, event.threadId, event.terminalId);
    case "thread.status":
    case "thread.model":
    case "thread.archived":
    case "thread.meta": {
      const info = state.threads[event.threadId];
      if (!info) return state;
      const next: ThreadInfo =
        event._tag === "thread.status"
          ? { ...info, status: event.status }
          : event._tag === "thread.model"
            ? { ...info, model: event.model }
            : event._tag === "thread.archived"
              ? { ...info, archivedAt: event.archivedAt }
              : { ...info, title: event.title, updatedAt: event.updatedAt, branch: event.branch };
      return { ...state, threads: { ...state.threads, [event.threadId]: next } };
    }
    default:
      return state;
  }
};

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
    JSON.stringify({
      _tag: "thread.subscribe",
      threadId,
      after,
      turnLimit: TURN_LIMIT,
    } satisfies ClientCommand),
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

const onFrame = (frame: ServerFrame) => {
  switch (frame._tag) {
    case "shell":
      return onShell(frame);
    case "thread.snapshot": {
      const items = applyStreaming(foldStored([], frame.events, 0), frame.streaming);
      return setState(
        setTranscript(state, frame.threadId, {
          items,
          cursor: frame.cursor,
          page: frame.page,
          status: "live",
          loadingOlder: false,
        }),
      );
    }
    case "thread.replay": {
      const prev = state.transcripts[frame.threadId];
      const base = prev?.items ?? [];
      const items = applyStreaming(
        foldStored(base, frame.events, prev?.cursor ?? 0),
        frame.streaming,
      );
      const cursor = Math.max(prev?.cursor ?? 0, frame.cursor);
      return setState(
        setTranscript(state, frame.threadId, {
          items,
          cursor,
          page: prev?.page ?? null,
          status: "live",
          loadingOlder: false,
        }),
      );
    }
    case "thread.page": {
      const prev = state.transcripts[frame.threadId];
      if (!prev) return;
      const known = new Set(prev.items.map((item) => item.id));
      const older = foldStored([], frame.events, 0).filter((item) => !known.has(item.id));
      return setState(
        setTranscript(state, frame.threadId, {
          ...prev,
          items: [...older, ...prev.items],
          page: frame.page,
          loadingOlder: false,
        }),
      );
    }
    case "search.results":
      searches.get(frame.requestId)?.(frame.hits);
      searches.delete(frame.requestId);
      return;
    case "terminal.snapshot":
      return screens.get(screenKey(frame.threadId, frame.terminalId))?.reset(frame.data);
    case "terminal.output":
      return screens.get(screenKey(frame.threadId, frame.terminalId))?.write(frame.data);
    case "terminal.error":
      return screens.get(screenKey(frame.threadId, frame.terminalId))?.fail(frame.message);
    case "browser.request":
      performBrowserAction(frame.threadId, frame.action).then(
        (result) =>
          send({ _tag: "browser.respond", requestId: frame.requestId, result, error: null }),
        (error: unknown) =>
          send({
            _tag: "browser.respond",
            requestId: frame.requestId,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return;
    case "event": {
      const { event, id } = frame;
      if (!isTranscriptEvent(event)) {
        // The guard's false branch over-narrows: thread events that aren't transcript ones land here too.
        const shellEvent = event as RuntimeEvent;
        const before =
          shellEvent._tag === "thread.status"
            ? state.threads[shellEvent.threadId]?.status
            : undefined;
        setState(reduceShell(state, shellEvent));
        // The turn ended: the next held message goes out.
        if (
          shellEvent._tag === "thread.status" &&
          shellEvent.status === "idle" &&
          before !== "idle"
        )
          sendNextFollowUp(shellEvent.threadId);
        return;
      }
      const transcript = state.transcripts[event.threadId];
      // Not following this thread, or already have it (a replay can overlap live events).
      if (!transcript || (id !== null && id <= transcript.cursor)) return;
      const items = reduceItems(transcript.items, event, id);
      return setState(
        setTranscript(state, event.threadId, {
          ...transcript,
          items,
          cursor: id ?? transcript.cursor,
        }),
      );
    }
  }
};

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
    if (window.desktop) ws.send(JSON.stringify({ _tag: "browser.host" } satisfies ClientCommand));
    for (const command of queued.splice(0)) ws.send(JSON.stringify(command));
  };
  ws.onmessage = (message) => onFrame(JSON.parse(message.data as string) as ServerFrame);
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
    socket!.send(JSON.stringify({ _tag: "thread.unsubscribe", threadId } satisfies ClientCommand));
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
    JSON.stringify({
      _tag: "thread.loadOlder",
      threadId,
      before: transcript.page.before,
      turnLimit: TURN_LIMIT,
    } satisfies ClientCommand),
  );
};

/** Commands sent while the daemon is still starting (the UI is up from cache by then). */
const queued: ClientCommand[] = [];

export const send = (command: ClientCommand) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  else queued.push(command);
};

/** Applies settings locally right away (theme etc. shouldn't wait on the daemon), then persists them. */
export const updateSettings = (settings: Settings) => {
  setState({ ...state, settings });
  send({ _tag: "settings.update", settings });
};

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
  send({ _tag: "thread.create", requestId, ...command });
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
  send({ _tag: "thread.send", threadId, text: followUp.text, options: followUp.options });
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
  send({ _tag: "thread.send", threadId, text: next.text, options: next.options });
};

// --- search --------------------------------------------------------------------

const searches = new Map<string, (hits: ReadonlyArray<SearchHit>) => void>();

/** Full-text search over every thread's messages, newest first. */
export const searchMessages = (query: string) =>
  new Promise<ReadonlyArray<SearchHit>>((resolve) => {
    if (!socketOpen()) return resolve([]);
    const requestId = crypto.randomUUID();
    searches.set(requestId, resolve);
    send({ _tag: "search", query, requestId });
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
  sendIfConnected({
    _tag: "terminal.open",
    threadId: screen.threadId,
    terminalId: screen.terminalId,
    ...screen.size(),
  });
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
    sendIfConnected({
      _tag: "terminal.detach",
      threadId: screen.threadId,
      terminalId: screen.terminalId,
    });
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
  send({ _tag: "terminal.close", threadId, terminalId });
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
 * doesn't jump sections under you). A manual Settle skips the wait.
 */
export const isSettled = (info: ThreadInfo, seen: State["seen"], now: number, delayMs: number) => {
  const mark = seen[info.id];
  return (
    canSettle(info) && isSeen(info, seen) && (mark?.manual === true || now - mark!.at >= delayMs)
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
  send({ _tag: "approval.respond", threadId, requestId, decision });
};

export const useStore = <A>(select: (state: State) => A): A =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
