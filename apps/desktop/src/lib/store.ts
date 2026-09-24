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
  type RuntimeEvent,
  type ServerFrame,
  type ThreadInfo,
  type TurnOptions,
} from "@apcode/contracts";
import { useSyncExternalStore } from "react";

export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly attachments: ReadonlyArray<Attachment> }
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

export interface ThreadState {
  readonly info: ThreadInfo;
  readonly items: ReadonlyArray<TranscriptItem>;
}

export interface State {
  readonly connected: boolean;
  readonly settings: Settings;
  readonly projects: ReadonlyArray<Project>;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  /** Set when a thread this window asked for appears, so the window can open it. */
  readonly createdHere: { readonly threadId: string } | null;
  readonly order: ReadonlyArray<string>;
  readonly threads: Readonly<Record<string, ThreadState>>;
  /** When each thread was last looked at (its `updatedAt` then); shared across windows via localStorage. */
  readonly seen: Readonly<Record<string, SeenMark>>;
  /** Local branches per repo path, fetched on demand by the branch picker. */
  readonly branches: Readonly<Record<string, BranchList>>;
  /** Uncommitted changes per repo path, fetched on demand by the diff panel. */
  readonly diffs: Readonly<Record<string, RepoDiff>>;
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
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number | SeenMark>;
    // Marks used to be the bare `updatedAt`.
    return Object.fromEntries(Object.entries(raw).map(([id, mark]) => [id, typeof mark === "number" ? { rev: mark, at: mark } : mark]));
  } catch {
    return {};
  }
};

const initial: State = {
  connected: false,
  settings: DEFAULT_SETTINGS,
  projects: [],
  providers: [],
  authFlows: {},
  createdHere: null,
  order: [],
  threads: {},
  seen: readSeen(),
  branches: {},
  diffs: {},
};

/** Request ids of `thread.create` commands sent from this window. */
const ownRequests = new Set<string>();

const upsert = (items: ReadonlyArray<TranscriptItem>, id: string, next: (prev: TranscriptItem | undefined) => TranscriptItem) => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return [...items, next(undefined)];
  const copy = items.slice();
  copy[index] = next(items[index]);
  return copy;
};

const reduce = (state: State, event: RuntimeEvent): State => {
  if (event._tag === "settings.updated") return { ...state, settings: event.settings };
  if (event._tag === "project.added") return { ...state, projects: [...state.projects, event.project] };
  if (event._tag === "project.removed") {
    return { ...state, projects: state.projects.filter((p) => p.id !== event.projectId) };
  }
  if (event._tag === "providers.updated") return { ...state, providers: event.providers };
  if (event._tag === "git.branches") {
    const { current, branches, error } = event;
    return { ...state, branches: { ...state.branches, [event.path]: { current, branches, error } } };
  }
  if (event._tag === "git.diff") {
    const { patch, truncated, error } = event;
    return { ...state, diffs: { ...state.diffs, [event.path]: { patch, truncated, error } } };
  }
  if (event._tag === "auth.flow") return { ...state, authFlows: { ...state.authFlows, [event.flow.provider]: event.flow } };
  if (event._tag === "thread.created") {
    const mine = event.requestId !== null && ownRequests.delete(event.requestId);
    return {
      ...state,
      createdHere: mine ? { threadId: event.thread.id } : state.createdHere,
      order: [event.thread.id, ...state.order.filter((id) => id !== event.thread.id)],
      threads: { ...state.threads, [event.thread.id]: { info: event.thread, items: [] } },
    };
  }
  const threadId = event.threadId;
  if (threadId === null) return state;
  const thread = state.threads[threadId];
  if (!thread) return state;

  if (event._tag === "thread.removed") {
    const { [threadId]: _closed, ...threads } = state.threads;
    return { ...state, order: state.order.filter((id) => id !== threadId), threads };
  }

  let { info, items } = thread;
  switch (event._tag) {
    case "thread.status":
      info = { ...info, status: event.status };
      break;
    case "thread.model":
      info = { ...info, model: event.model };
      break;
    case "thread.archived":
      info = { ...info, archivedAt: event.archivedAt };
      break;
    case "thread.meta":
      info = { ...info, title: event.title, updatedAt: event.updatedAt, branch: event.branch };
      break;
    case "user.message":
      items = [...items, { kind: "user", id: event.messageId, text: event.text, attachments: event.attachments ?? [] }];
      break;
    case "assistant.delta":
      items = upsert(items, event.messageId, (prev) => ({
        kind: "assistant",
        id: event.messageId,
        text: (prev?.kind === "assistant" ? prev.text : "") + event.delta,
      }));
      break;
    case "assistant.completed":
      items = upsert(items, event.messageId, () => ({ kind: "assistant", id: event.messageId, text: event.text }));
      break;
    case "tool.started":
      items = upsert(items, event.toolId, () => ({
        kind: "tool",
        id: event.toolId,
        name: event.name,
        summary: event.summary,
        output: null,
        isError: false,
      }));
      break;
    case "tool.completed":
      items = items.map((item) =>
        item.id === event.toolId && item.kind === "tool" ? { ...item, output: event.output, isError: event.isError } : item,
      );
      break;
    case "approval.requested":
      items = [...items, { kind: "approval", id: event.requestId, title: event.title, detail: event.detail, resolved: false, decision: null }];
      break;
    case "approval.resolved":
      items = items.map((item) => (item.id === event.requestId && item.kind === "approval" ? { ...item, resolved: true } : item));
      break;
    case "error":
      items = [...items, { kind: "error", id: crypto.randomUUID(), text: event.message }];
      break;
    case "turn.completed":
      break;
  }
  return { ...state, threads: { ...state.threads, [threadId]: { info, items } } };
};

// ---------------------------------------------------------------------------

let state = initial;
const listeners = new Set<() => void>();
const setState = (next: State) => {
  state = next;
  for (const listener of listeners) listener();
};

let socket: WebSocket | null = null;

const connect = () => {
  const ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`);
  socket = ws;
  ws.onmessage = (message) => {
    const frame = JSON.parse(message.data as string) as ServerFrame;
    if (frame._tag === "snapshot") {
      let next: State = {
        ...initial,
        connected: true,
        settings: frame.settings,
        projects: frame.projects,
        providers: frame.providers,
        seen: state.seen,
        branches: state.branches,
        diffs: state.diffs,
      };
      for (const info of frame.threads) {
        next = {
          ...next,
          order: [info.id, ...next.order],
          threads: { ...next.threads, [info.id]: { info, items: [] } },
        };
      }
      for (const event of frame.events) if (event._tag !== "thread.created") next = reduce(next, event);
      // First run with seen-tracking: everything that already exists counts as looked at.
      if (!hasSeenKey()) next = { ...next, seen: Object.fromEntries(frame.threads.map((t) => [t.id, { rev: t.updatedAt, at: 0 }])) };
      setState(next);
      if (!hasSeenKey()) writeSeen(next.seen);
    } else {
      setState(reduce(state, frame.event));
    }
  };
  ws.onclose = () => {
    setState({ ...state, connected: false });
    setTimeout(connect, 1000);
  };
};
connect();

export const send = (command: ClientCommand) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
};

/** Creates a thread from a draft by sending its first message. */
export const createThread = (input: { path: string; provider: ProviderKind; model: string | null; text: string; options: TurnOptions }) => {
  const requestId = crypto.randomUUID();
  ownRequests.add(requestId);
  send({ _tag: "thread.create", requestId, ...input });
};

/** Marks a thread's latest activity as seen; it settles once idle and the settle delay has passed. */
export const markSeen = (threadId: string) => {
  const thread = state.threads[threadId];
  if (!thread || state.seen[threadId]?.rev === thread.info.updatedAt) return;
  setSeen(threadId, { rev: thread.info.updatedAt, at: Date.now() });
};

/**
 * Manual override from the thread menu. Settling is immediate, skipping the delay;
 * unsettling brings it back as new activity, so it waits to be seen again.
 */
export const setSettled = (threadId: string, settled: boolean) => {
  const thread = state.threads[threadId];
  if (thread) setSeen(threadId, { rev: settled ? thread.info.updatedAt : 0, at: Date.now(), manual: true });
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
export const isSeen = (info: ThreadInfo, seen: State["seen"]) => (seen[info.id]?.rev ?? 0) >= info.updatedAt;

/**
 * Settled threads need nothing from you: not working, not waiting on approval,
 * seen, and seen at least `delayMs` ago (so a thread you just watched finish
 * doesn't jump sections under you). A manual Settle skips the wait.
 */
export const isSettled = (info: ThreadInfo, seen: State["seen"], now: number, delayMs: number) => {
  const mark = seen[info.id];
  return canSettle(info) && isSeen(info, seen) && (mark?.manual === true || now - mark!.at >= delayMs);
};

/** Working threads, or ones waiting on you, can't be settled by hand. */
export const canSettle = (info: ThreadInfo) => info.status !== "running" && info.status !== "awaiting-approval";

export const respondApproval = (threadId: string, requestId: string, decision: ApprovalDecision) => {
  const thread = state.threads[threadId];
  if (thread) {
    const items = thread.items.map((item) =>
      item.id === requestId && item.kind === "approval" ? { ...item, decision } : item,
    );
    setState({ ...state, threads: { ...state.threads, [threadId]: { ...thread, items } } });
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
