import {
  DEFAULT_DAEMON_PORT,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  DEFAULT_SETTINGS,
  type AuthFlow,
  HostStatus,
  type Project,
  type ProviderKind,
  type ProviderSettings,
  type ProviderStatus,
  type RemoteHost,
  type SourceControlStatus,
  type Settings,
  type ApprovalDecision,
  type Attachment,
  type CommandRun,
  ClientCommand,
  type GitAction,
  type PageInfo,
  type PermissionLevel,
  type RepoStatus,
  RuntimeEvent,
  type SearchHit,
  ServerFrame,
  type Skill,
  type SlashCommand,
  type StoredEvent,
  type ThreadInfo,
  type QueuedMessage,
  type TurnOptions,
  type UsageLimit,
  type UserAnswers,
  type UserQuestion,
  fileRestoreBlocker,
  isTranscriptEvent,
  isTurnActive,
} from "@apcode/contracts";
import type { ToolCall } from "@apcode/ui/agents/tool-group";
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
      readonly kind: "forked";
      readonly id: string;
      readonly fromThreadId: string;
      readonly fromTitle: string;
    }
  /** Where a peer review starts: the thread whose work it reviews. */
  | {
      readonly kind: "peerReview";
      readonly id: string;
      readonly ofThreadId: string;
      readonly ofTitle: string;
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
  /** Why this Mac's daemon can't be used: it runs another version of APCode. */
  readonly incompatible: string | null;
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
  /** GitHub and GitLab CLI status; null until Settings asks for it. */
  readonly sourceControl: ReadonlyArray<SourceControlStatus> | null;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  /** Threads whose usage is being read from their harness's log. */
  readonly readingUsage: Readonly<Record<string, boolean>>;
  /** Subscription rate limits per harness, read when the usage panel opens. */
  readonly limits: Partial<Record<ProviderKind, ProviderLimits>>;
  /** The message this window asked to fork from, until the fork appears; `error` says why it didn't. */
  readonly forking: {
    readonly threadId: string;
    readonly messageId: string;
    readonly error: string | null;
  } | null;
  /**
   * The thread this window's peer review dialog is open on; `pending` once asked, until the
   * review thread appears, and `error` says why it didn't.
   */
  readonly peerReview: {
    readonly threadId: string;
    readonly pending: boolean;
    readonly error: string | null;
  } | null;
  /** A thread for this window to switch to: one it created or forked, or a link followed. */
  readonly switchTo: { readonly threadId: string } | null;
  readonly order: ReadonlyArray<string>;
  /** The thread list. Transcripts live apart, so streaming text doesn't re-render the sidebar. */
  readonly threads: Readonly<Record<string, ThreadInfo>>;
  readonly transcripts: Readonly<Record<string, Transcript>>;
  /** Local branches per repo path, fetched on demand by the branch picker. */
  readonly branches: Readonly<Record<string, BranchList>>;
  /** Files per repo path, fetched when an `@` mention starts. */
  readonly files: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Uncommitted changes per repo path, fetched on demand by the diff panel. */
  readonly diffs: Readonly<Record<string, RepoDiff>>;
  /** Working-tree/upstream state per repo path, fetched on demand by the git menu. */
  readonly repos: Readonly<Record<string, RepoState>>;
  /** Slash commands per thread, fetched when the command menu opens. */
  readonly commands: Readonly<Record<string, ReadonlyArray<SlashCommand>>>;
  /** Skills per harness and folder (see `skillsKey`), fetched when a `$` mention starts. */
  readonly skills: Readonly<Record<string, SkillList>>;
  /** One turn's changes, keyed `<threadId>:<messageId>`, fetched by the changes panel. */
  readonly turnDiffs: Readonly<Record<string, RepoDiff>>;
  readonly terminals: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly activeTerminals: Readonly<Record<string, string>>;
  /** Commands from agents' replies still running, per thread; shown in the transcript, not the terminal panel. */
  readonly runs: Readonly<Record<string, ReadonlyArray<RunningCommand>>>;
  /**
   * Remote hosts by SSH alias, each with its own daemon. Their threads and projects are merged
   * into the lists above (ids are UUIDs, so they never clash); the fields above that describe
   * one daemon (settings, providers, sign-in…) are this Mac's.
   */
  readonly hosts: Readonly<Record<string, HostState>>;
  /** The remote host each remote project is on; a project missing here is on this Mac. */
  readonly projectHosts: Readonly<Record<string, string>>;
}

/** A remote daemon's own state, where this Mac's lives at the top of `State`. */
export interface HostState {
  readonly status: HostStatus;
  readonly connected: boolean;
  /** Why its daemon can't be used: it runs another version of APCode. */
  readonly incompatible: string | null;
  readonly dataId: string | null;
  readonly root: boolean;
  readonly settings: Settings | null;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly sourceControl: ReadonlyArray<SourceControlStatus> | null;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  readonly limits: Partial<Record<ProviderKind, ProviderLimits>>;
}

export interface ProviderLimits {
  readonly limits: ReadonlyArray<UsageLimit>;
  readonly error: string | null;
  /** A fresh read is on its way; what's above is from the last one. */
  readonly loading: boolean;
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

export interface SkillList {
  readonly skills: ReadonlyArray<Skill>;
  /** Why the harness couldn't be asked; `skills` then holds what it said last time. */
  readonly error: string | null;
}

/** Where `skills` keeps a harness's skills for a folder. */
export function skillsKey(provider: ProviderKind, path: string) {
  return `${provider}:${path}`;
}

const initial: State = {
  connected: false,
  incompatible: null,
  source: "none",
  dataId: null,
  settings: DEFAULT_SETTINGS,
  projects: [],
  providers: [],
  sourceControl: null,
  authFlows: {},
  limits: {},
  readingUsage: {},
  forking: null,
  peerReview: null,
  switchTo: null,
  order: [],
  threads: {},
  transcripts: {},
  branches: {},
  files: {},
  diffs: {},
  repos: {},
  commands: {},
  skills: {},
  turnDiffs: {},
  terminals: {},
  activeTerminals: {},
  runs: {},
  hosts: {},
  projectHosts: {},
};

/** The remote host a thread runs on; null for this Mac. */
function threadHost(state: State, threadId: string): string | null {
  const projectId = state.threads[threadId]?.projectId;
  return (projectId && state.projectHosts[projectId]) || null;
}

/** The database a thread's cached transcript belongs to: its host's. */
function dataIdOf(state: State, threadId: string) {
  const host = threadHost(state, threadId);
  return host === null ? state.dataId : (state.hosts[host]?.dataId ?? null);
}

/** Whether a thread or project is on `host` (null: this Mac). */
const onHost = (state: State, host: string | null, projectId: string) =>
  (state.projectHosts[projectId] ?? null) === host;

/** `thread.create` commands sent from this window, by request id. */
/** A fork has no options of its own to start its composer from. */
const ownRequests = new Map<string, { readonly open: boolean; readonly options?: TurnOptions }>();
/** What threads created here sent their first message with, so their composer starts from the draft's picks. */
const firstOptions = new Map<string, TurnOptions>();
export const firstTurnOptions = (threadId: string) => firstOptions.get(threadId);

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
        run: message.run ?? null,
        provider: message.provider ?? null,
        handoff: message.handoff ?? null,
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
    Match.tag("thread.forked", ({ fromThreadId, fromTitle }) =>
      upsert(items, `forked:${fromThreadId}`, () => ({
        kind: "forked",
        id: `forked:${fromThreadId}`,
        fromThreadId,
        fromTitle,
      })),
    ),
    Match.tag("thread.peerReview", ({ ofThreadId, ofTitle }) =>
      upsert(items, `peerReview:${ofThreadId}`, () => ({
        kind: "peerReview",
        id: `peerReview:${ofThreadId}`,
        ofThreadId,
        ofTitle,
      })),
    ),
    Match.tag("thread.startedBy", ({ byThreadId, byTitle }) =>
      upsert(items, `startedBy:${byThreadId}`, () => ({
        kind: "startedBy",
        id: `startedBy:${byThreadId}`,
        byThreadId,
        byTitle,
      })),
    ),
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
    Match.tag("tool.started", (tool) => {
      const call = {
        id: tool.toolId,
        name: tool.name,
        summary: tool.summary,
        output: null,
        isError: false,
      };
      const parent = items.findLast((item) => item.id === tool.parentToolId);
      if (parent?.kind !== "tool")
        return upsert(items, tool.toolId, () => ({ kind: "tool", ...call }));
      return upsert(items, parent.id, () => ({
        ...parent,
        children: [...(parent.children ?? []).filter((child) => child.id !== call.id), call],
      }));
    }),
    Match.tag("tool.progress", (progress) =>
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
    ),
    Match.tag("tool.completed", (tool) =>
      items.map((item) => {
        if (item.kind !== "tool") return item;
        if (item.id === tool.toolId) return { ...item, output: tool.output, isError: tool.isError };
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
    ),
    Match.tag("approval.requested", (approval) =>
      upsert(items, approval.requestId, () => ({
        kind: "approval",
        id: approval.requestId,
        title: approval.title,
        detail: approval.detail,
        agent: approval.agent,
        resolved: false,
        decision: null,
        questions: approval.questions,
      })),
    ),
    Match.tag("approval.resolved", (approval) =>
      items.map((item) =>
        item.id === approval.requestId && item.kind === "approval"
          ? { ...item, resolved: true, answers: approval.answers }
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
    // Usually the echo of our own updateSettings: keeping the old object spares every settings reader a re-render.
    Match.tag("settings.updated", ({ settings }) =>
      JSON.stringify(settings) === JSON.stringify(state.settings) ? state : { ...state, settings },
    ),
    Match.tag("project.added", ({ project }) => ({
      ...state,
      projects: [...state.projects.filter((p) => p.id !== project.id), project],
    })),
    Match.tag("project.removed", ({ projectId }) => {
      const { [projectId]: _host, ...projectHosts } = state.projectHosts;
      return { ...state, projects: state.projects.filter((p) => p.id !== projectId), projectHosts };
    }),
    Match.tags({
      "providers.updated": ({ providers }) => ({ ...state, providers }),
      "sourceControl.updated": ({ statuses }) => ({ ...state, sourceControl: statuses }),
    }),
    Match.tags({
      "git.branches": ({ path, current, branches, error }) => ({
        ...state,
        branches: { ...state.branches, [path]: { current, branches, error } },
      }),
      "git.files": ({ path, files }) => ({ ...state, files: { ...state.files, [path]: files } }),
    }),
    Match.tag("git.diff", ({ path, patch, truncated, error }) => ({
      ...state,
      diffs: { ...state.diffs, [path]: { patch, truncated, error } },
    })),
    Match.tags({
      "thread.commands": ({ threadId, commands }) => ({
        ...state,
        commands: { ...state.commands, [threadId]: commands },
      }),
      "skills.listed": ({ provider, path, skills, error }) => ({
        ...state,
        skills: { ...state.skills, [skillsKey(provider, path)]: { skills, error } },
      }),
    }),
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
    Match.tag("thread.created", ({ thread, requestId, hasTranscript }) => {
      const request = requestId === null ? undefined : ownRequests.get(requestId);
      if (requestId !== null) ownRequests.delete(requestId);
      if (request?.options) firstOptions.set(thread.id, request.options);
      const next = {
        ...state,
        forking: request ? null : state.forking,
        peerReview: request ? null : state.peerReview,
        switchTo: request?.open ? { threadId: thread.id } : state.switchTo,
        order: [thread.id, ...state.order.filter((id) => id !== thread.id)],
        threads: { ...state.threads, [thread.id]: thread },
      };
      // A fork's transcript loads like any other's once it's opened.
      if (hasTranscript) return next;
      return {
        ...next,
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
      const { [threadId]: _runs, ...runs } = state.runs;
      const dataId = dataIdOf(state, threadId);
      if (dataId) removeTranscript(dataId, threadId);
      return {
        ...state,
        order: state.order.filter((id) => id !== threadId),
        threads,
        transcripts,
        terminals,
        activeTerminals,
        runs,
      };
    }),
    Match.tag("terminal.opened", ({ threadId, terminalId, command }) => {
      if (command !== undefined) {
        const running = state.runs[threadId] ?? [];
        if (running.some((run) => run.terminalId === terminalId)) return state;
        return {
          ...state,
          runs: { ...state.runs, [threadId]: [...running, { terminalId, command }] },
        };
      }
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
    Match.tags({
      "thread.status": ({ threadId, status }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, status })),
      "thread.model": ({ threadId, provider, model }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, provider, model })),
      "thread.archived": ({ threadId, archivedAt }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, archivedAt })),
      "thread.shelved": ({ threadId, shelved }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, shelved })),
      "thread.seen": ({ threadId, seenRev }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, seenRev })),
      "thread.activity": ({ threadId, activity }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, activity: activity ?? undefined })),
      "thread.request": ({ threadId, request }) =>
        updateThreadInfo(state, threadId, (info) => ({ ...info, request: request ?? undefined })),
      "thread.queue": ({ threadId, queue }) =>
        updateThreadInfo(state, threadId, (info) => ({
          ...info,
          queue: queue.length > 0 ? queue : undefined,
        })),
    }),
    Match.tag("thread.usage", ({ threadId, usage }) => {
      const { [threadId]: _reading, ...readingUsage } = state.readingUsage;
      const next = { ...state, readingUsage };
      return usage ? updateThreadInfo(next, threadId, (info) => ({ ...info, usage })) : next;
    }),
    Match.tag("provider.limits", ({ provider, limits, error }) => ({
      ...state,
      limits: { ...state.limits, [provider]: { limits, error, loading: false } },
    })),
    Match.tag("thread.meta", ({ threadId, title, updatedAt, branch, cwd, worktree }) =>
      updateThreadInfo(state, threadId, (info) => ({
        ...info,
        title,
        updatedAt,
        branch,
        cwd,
        worktree,
      })),
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
    runs: {
      ...state.runs,
      [threadId]: (state.runs[threadId] ?? []).filter((run) => run.terminalId !== terminalId),
    },
  };
}

// ---------------------------------------------------------------------------

let state = initial;
const listeners = new Set<() => void>();
/** Called on every change, frame or not: hidden windows get no animation frames, so no renders. */
const watchers = new Set<(prev: State, next: State) => void>();
export const watchState = (watcher: (prev: State, next: State) => void) => {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
};
let notifyScheduled = false;
const notify = () => {
  notifyScheduled = false;
  for (const listener of listeners) listener();
};

const setState = (next: State) => {
  const prev = state;
  state = next;
  for (const watcher of watchers) watcher(prev, next);
  // Deltas can arrive faster than frames: re-render at most once per frame.
  if (!notifyScheduled) {
    notifyScheduled = true;
    requestAnimationFrame(notify);
  }
  if (
    next.source === "daemon" &&
    next.dataId !== null &&
    (prev.threads !== next.threads ||
      prev.order !== next.order ||
      prev.projects !== next.projects ||
      prev.settings !== next.settings ||
      prev.providers !== next.providers)
  ) {
    // ponytail: only this Mac's shell is cached; remote hosts' threads appear once they connect
    const { dataId, settings, providers } = next;
    const threads = Object.fromEntries(
      Object.entries(next.threads).filter(([, info]) => onHost(next, null, info.projectId)),
    );
    saveShell({
      dataId,
      settings,
      providers,
      projects: next.projects.filter((project) => onHost(next, null, project.id)),
      order: next.order.filter((id) => threads[id]),
      threads,
    });
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
      const dataId = dataIdOf(next, threadId);
      if (!dataId) continue;
      const { items, cursor, page } = transcript;
      saveTranscript(dataId, threadId, { items, cursor, page });
    }
  }
};

/** Threads with an open view, counted (a thread can be open in several places). */
const wanted = new Map<string, number>();
/** Threads whose cached transcript is still being read; subscribing waits for it, to know the cursor. */
const readingCache = new Set<string>();

/** Puts a thread's cached transcript in memory, if it isn't there yet. */
const loadCachedTranscript = async (threadId: string) => {
  const dataId = dataIdOf(state, threadId);
  if (!dataId || state.transcripts[threadId] || readingCache.has(threadId)) return;
  readingCache.add(threadId);
  const cached = await loadTranscript(dataId, threadId);
  readingCache.delete(threadId);
  // The daemon may have answered meanwhile, or a new shell may be from another database.
  if (!cached || dataIdOf(state, threadId) !== dataId || state.transcripts[threadId]) return;
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

/** One daemon's WebSocket, reconnected for as long as its host is in the app. */
interface Connection {
  /** Null for this Mac. */
  readonly host: string | null;
  socket: WebSocket | null;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Commands sent while it's down (the UI is up from cache by then). */
  readonly queued: Array<ClientCommand>;
  removed: boolean;
}

const connections = new Map<string | null, Connection>();

const openSocket = (host: string | null) => {
  const socket = connections.get(host)?.socket;
  return socket?.readyState === WebSocket.OPEN ? socket : null;
};

/** The host's daemon sent its shell on this connection, so its threads can be asked about. */
const hasShell = (host: string | null) =>
  host === null ? state.source === "daemon" : state.hosts[host]?.connected === true;

/** Asks for a thread's transcript: a replay after the cursor when we have one, else the latest turns. */
const subscribe = (threadId: string) => {
  const host = threadHost(state, threadId);
  const socket = openSocket(host);
  if (!socket || !hasShell(host) || readingCache.has(threadId)) return;
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
  socket.send(
    JSON.stringify(
      ClientCommand.cases["thread.subscribe"].make({ threadId, after, turnLimit: TURN_LIMIT }),
    ),
  );
};

const NO_PROVIDERS: ReadonlyArray<ProviderStatus> = [];

const newHost = (status: HostStatus): HostState => ({
  status,
  connected: false,
  incompatible: null,
  dataId: null,
  root: false,
  settings: null,
  providers: NO_PROVIDERS,
  sourceControl: null,
  authFlows: {},
  limits: {},
});

function updateHost(state: State, host: string, update: (current: HostState) => HostState): State {
  const current = state.hosts[host];
  return current ? { ...state, hosts: { ...state.hosts, [host]: update(current) } } : state;
}

/** Notes that `host`'s daemon (this Mac's when null) runs another version, and how to fix it. */
function markIncompatible(host: string | null) {
  setState(
    host === null
      ? {
          ...state,
          incompatible:
            "APCode's daemon is a different version from this window. Quit APCode and open it again.",
        }
      : updateHost(state, host, (current) => ({
          ...current,
          incompatible: `${host} runs a different version of APCode. Restart it from Settings → Connections.`,
        })),
  );
}

/** Replaces one host's threads and projects with what its daemon sent; other hosts' stay. */
const onShell = (connection: Connection, frame: Extract<ServerFrame, { _tag: "shell" }>) => {
  const { host } = connection;
  // A daemon older than the check doesn't say, and may not understand what this window sends.
  if (frame.protocol !== PROTOCOL_VERSION) {
    markIncompatible(host);
    connection.socket?.close();
    return;
  }
  connection.attempt = 0;
  const previousDataId = host === null ? state.dataId : (state.hosts[host]?.dataId ?? null);
  const sameData = frame.dataId === previousDataId;
  const incoming = Object.fromEntries(frame.threads.map((info) => [info.id, info]));
  const others = Object.fromEntries(
    Object.entries(state.threads).filter(([, info]) => !onHost(state, host, info.projectId)),
  );
  const threads = { ...others, ...incoming };
  // Keep transcripts of threads that still exist; they resume from their cursor.
  const transcripts: Record<string, Transcript> = {};
  for (const [threadId, transcript] of Object.entries(state.transcripts)) {
    if (others[threadId] || (sameData && incoming[threadId])) transcripts[threadId] = transcript;
    else if (sameData) removeTranscript(frame.dataId, threadId);
  }
  const terminals: Record<string, Array<string>> = {};
  for (const [threadId, terminalIds] of Object.entries(state.terminals))
    if (others[threadId]) terminals[threadId] = [...terminalIds];
  const runs: Record<string, Array<RunningCommand>> = {};
  for (const [threadId, running] of Object.entries(state.runs))
    if (others[threadId]) runs[threadId] = [...running];
  for (const { threadId, terminalId, command } of frame.terminals)
    if (command !== undefined) (runs[threadId] ??= []).push({ terminalId, command });
  // A run that ended while disconnected is simply gone; its window must not come back as a tab.
  const ownScreens = [...screens.values()].filter(
    (screen) =>
      incoming[screen.threadId] &&
      !state.runs[screen.threadId]?.some((run) => run.terminalId === screen.terminalId),
  );
  for (const { threadId, terminalId } of [
    ...frame.terminals.filter((terminal) => terminal.command === undefined),
    ...ownScreens,
  ]) {
    if (!terminals[threadId]?.includes(terminalId)) (terminals[threadId] ??= []).push(terminalId);
  }
  const projectHosts =
    host === null
      ? state.projectHosts
      : {
          ...Object.fromEntries(
            Object.entries(state.projectHosts).filter(([, projectHost]) => projectHost !== host),
          ),
          ...Object.fromEntries(frame.projects.map((project) => [project.id, host])),
        };
  const merged: State = {
    ...state,
    projects: [
      ...state.projects.filter((project) => !onHost(state, host, project.id)),
      ...frame.projects,
    ],
    projectHosts,
    order: Object.values(threads)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => t.id),
    threads,
    transcripts,
    terminals,
    runs,
    activeTerminals: Object.fromEntries(
      Object.entries(state.activeTerminals).flatMap(([threadId, terminalId]) => {
        const active = terminals[threadId]?.includes(terminalId)
          ? terminalId
          : terminals[threadId]?.at(-1);
        return active ? [[threadId, active]] : [];
      }),
    ),
  };
  setState(
    host === null
      ? {
          ...merged,
          connected: true,
          incompatible: null,
          source: "daemon",
          dataId: frame.dataId,
          settings: frame.settings,
          providers: frame.providers,
        }
      : updateHost(merged, host, (current) => ({
          ...current,
          connected: true,
          incompatible: null,
          dataId: frame.dataId,
          root: frame.root,
          settings: frame.settings,
          providers: frame.providers,
        })),
  );
  for (const threadId of wanted.keys()) {
    if (threadHost(state, threadId) !== host) continue;
    if (transcripts[threadId] || !sameData) subscribe(threadId);
    // Not in memory yet: read the cache first so the daemon only sends what's new.
    else
      void loadCachedTranscript(threadId).then(() => wanted.has(threadId) && subscribe(threadId));
  }
  for (const screen of ownScreens) openScreen(screen);
  if (host !== null) {
    syncSettings(host);
    scanProjects(host);
  } else
    // Hosts that connected first had no projects folder to scan yet.
    for (const [alias, remote] of Object.entries(state.hosts))
      if (remote.connected) scanProjects(alias);
};

/** Answers to requests carrying a `requestId`, by that id. */
const replies = new Map<string, (frame: ServerFrame) => void>();

const answer = (frame: Extract<ServerFrame, { requestId: string }>) => {
  replies.get(frame.requestId)?.(frame);
  replies.delete(frame.requestId);
};

/** Sends a command answered by a frame of its own; null when the host is down or never answers. */
function request<Frame extends ServerFrame>(
  host: string | null,
  command: Extract<ClientCommand, { requestId: string }>,
  timeoutMs: number,
) {
  return new Promise<Frame | null>((resolve) => {
    const socket = openSocket(host);
    if (!socket) return resolve(null);
    // SAFETY: a daemon answers each request with its own kind of frame, carrying the same id.
    replies.set(command.requestId, (frame) => resolve(frame as Frame));
    socket.send(JSON.stringify(command));
    setTimeout(() => {
      if (replies.delete(command.requestId)) resolve(null);
    }, timeoutMs);
  });
}

const onFrame = (connection: Connection, frame: ServerFrame) =>
  ServerFrame.match(frame, {
    shell: (shell) => onShell(connection, shell),
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
    "search.results": answer,
    "folder.entries": answer,
    "project.cloned": answer,
    "terminal.snapshot": ({ threadId, terminalId, data }) =>
      screens.get(screenKey(threadId, terminalId))?.reset(data),
    "terminal.output": ({ threadId, terminalId, data }) =>
      screens.get(screenKey(threadId, terminalId))?.write(data),
    "terminal.error": ({ threadId, terminalId, message }) =>
      screens.get(screenKey(threadId, terminalId))?.fail(message),
    "browser.request": ({ threadId, requestId, action }) =>
      void performBrowserAction(threadId, action).then(
        (result) =>
          send(
            ClientCommand.cases["browser.respond"].make({ requestId, result, error: null }),
            connection.host,
          ),
        (error) =>
          send(
            ClientCommand.cases["browser.respond"].make({
              requestId,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            }),
            connection.host,
          ),
      ),
    event: ({ event, id }) => {
      // A failed fork reports on the thread it was forked from.
      if (
        RuntimeEvent.guards.error(event) &&
        state.forking?.error === null &&
        event.threadId === state.forking.threadId
      )
        setState({ ...state, forking: { ...state.forking, error: event.message } });
      if (
        RuntimeEvent.guards.error(event) &&
        state.peerReview?.pending &&
        event.threadId === state.peerReview.threadId
      )
        setState({
          ...state,
          peerReview: { ...state.peerReview, pending: false, error: event.message },
        });
      if (!isTranscriptEvent(event)) return applyShellEvent(connection.host, event);
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

/** A remote daemon's own events land in its `HostState`; the rest are shared, keyed by thread or path. */
const reduceRemoteShell = (state: State, host: string, event: RuntimeEvent): State =>
  Match.value(event).pipe(
    Match.withReturnType<State>(),
    Match.tag("settings.updated", ({ settings }) =>
      updateHost(state, host, (current) => ({ ...current, settings })),
    ),
    Match.tag("providers.updated", ({ providers }) =>
      updateHost(state, host, (current) => ({ ...current, providers })),
    ),
    Match.tag("sourceControl.updated", ({ statuses }) =>
      updateHost(state, host, (current) => ({ ...current, sourceControl: statuses })),
    ),
    Match.tag("auth.flow", ({ flow }) =>
      updateHost(state, host, (current) => ({
        ...current,
        authFlows: { ...current.authFlows, [flow.provider]: flow },
      })),
    ),
    Match.tag("provider.limits", ({ provider, limits, error }) =>
      updateHost(state, host, (current) => ({
        ...current,
        limits: { ...current.limits, [provider]: { limits, error, loading: false } },
      })),
    ),
    Match.tag("project.added", (added) => {
      const next = reduceShell(state, added);
      return { ...next, projectHosts: { ...next.projectHosts, [added.project.id]: host } };
    }),
    Match.orElse(() => reduceShell(state, event)),
  );

function applyShellEvent(host: string | null, event: RuntimeEvent) {
  const before = state;
  setState(host === null ? reduceShell(state, event) : reduceRemoteShell(state, host, event));
  // A remote host's CLI can't open this Mac's browser, so its sign-in page opens here.
  if (
    host !== null &&
    RuntimeEvent.guards["auth.flow"](event) &&
    event.flow.url &&
    before.hosts[host]?.authFlows[event.flow.provider]?.url !== event.flow.url
  )
    window.open(event.flow.url, "_blank");
}

/**
 * Waits between reconnect attempts, growing while the daemon stays away. Starts short:
 * at launch the sidecar is still booting. Reset once a connection gets its shell.
 */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
/** Each attempt at a remote host runs ssh, so those back off further. */
const REMOTE_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

function retry(connection: Connection) {
  const delays = connection.host === null ? RETRY_DELAYS_MS : REMOTE_RETRY_DELAYS_MS;
  connection.retry = setTimeout(
    () => {
      connection.retry = null;
      void connect(connection);
    },
    delays[Math.min(connection.attempt++, delays.length - 1)],
  );
}

const connect = async (connection: Connection) => {
  const { host } = connection;
  // Asked on every attempt: a daemon that restarts (or updates, on a remote host) comes back on a new port.
  const daemon =
    host === null
      ? ((await window.desktop?.daemon()) ?? null)
      : ((await window.desktop?.hostDaemon(host)) ?? null);
  if (connection.removed) return;
  if (host !== null && !daemon) return retry(connection);
  const ws = new WebSocket(
    `ws://127.0.0.1:${daemon?.port ?? DEFAULT_DAEMON_PORT}/?protocol=${PROTOCOL_VERSION}`,
    daemon ? [`apcode.${daemon.token}`] : undefined,
  );
  connection.socket = ws;
  ws.onopen = () => {
    if (window.desktop) ws.send(JSON.stringify(ClientCommand.cases["browser.host"].make({})));
    for (const command of connection.queued.splice(0)) ws.send(JSON.stringify(command));
  };
  ws.onmessage = (message) =>
    onFrame(connection, Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))(message.data));
  ws.onclose = (event) => {
    if (connection.socket !== ws) return;
    connection.socket = null;
    if (event.code === PROTOCOL_MISMATCH) markIncompatible(host);
    // Keep everything on screen; transcripts fall back to cached until the next connect catches them up.
    const transcripts = Object.fromEntries(
      Object.entries(state.transcripts).map(([id, t]) => [
        id,
        threadHost(state, id) !== host || (t.status === "cached" && !t.loadingOlder)
          ? t
          : { ...t, status: "cached" as const, loadingOlder: false },
      ]),
    );
    setState(
      host === null
        ? { ...state, connected: false, transcripts }
        : updateHost({ ...state, transcripts }, host, (current) => ({
            ...current,
            connected: false,
          })),
    );
    if (!connection.removed) retry(connection);
  };
};

function addConnection(host: string | null) {
  const connection: Connection = {
    host,
    socket: null,
    attempt: 0,
    retry: null,
    queued: [],
    removed: false,
  };
  connections.set(host, connection);
  void connect(connection);
}

/** Drops a removed host's connection and everything it showed. */
function removeConnection(connection: Connection & { readonly host: string }) {
  const { host } = connection;
  connection.removed = true;
  if (connection.retry) clearTimeout(connection.retry);
  connection.socket?.close();
  connections.delete(host);
  const gone = new Set(
    Object.values(state.threads)
      .filter((info) => onHost(state, host, info.projectId))
      .map((info) => info.id),
  );
  const keep = <A>(record: Readonly<Record<string, A>>) =>
    Object.fromEntries(Object.entries(record).filter(([threadId]) => !gone.has(threadId)));
  const { [host]: _removed, ...hosts } = state.hosts;
  setState({
    ...state,
    hosts,
    projects: state.projects.filter((project) => !onHost(state, host, project.id)),
    projectHosts: Object.fromEntries(
      Object.entries(state.projectHosts).filter(([, projectHost]) => projectHost !== host),
    ),
    order: state.order.filter((id) => !gone.has(id)),
    threads: keep(state.threads),
    transcripts: keep(state.transcripts),
    terminals: keep(state.terminals),
    activeTerminals: keep(state.activeTerminals),
    runs: keep(state.runs),
  });
}

/** Follows the desktop app's list of remote hosts: connects new ones, drops removed ones. */
function syncHosts(list: ReadonlyArray<RemoteHost>) {
  const aliases = new Set(list.map((remote) => remote.alias));
  for (const connection of connections.values())
    if (connection.host !== null && !aliases.has(connection.host))
      removeConnection({ ...connection, host: connection.host });
  setState({
    ...state,
    hosts: Object.fromEntries(
      list.map(({ alias, status }) => [
        alias,
        { ...(state.hosts[alias] ?? newHost(status)), status },
      ]),
    ),
  });
  for (const { alias, status } of list) {
    const connection = connections.get(alias);
    if (!connection) addConnection(alias);
    // Back (say, restarted on the new version): don't wait out the backoff.
    else if (HostStatus.guards.connected(status) && connection.retry) {
      clearTimeout(connection.retry);
      connection.retry = null;
      void connect(connection);
    }
  }
}

addConnection(null);
if (window.desktop) {
  window.desktop.onHosts(syncHosts);
  void window.desktop.hosts().then(syncHosts);
}

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
  openSocket(threadHost(state, threadId))?.send(
    JSON.stringify(ClientCommand.cases["thread.unsubscribe"].make({ threadId })),
  );
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
  const socket = openSocket(threadHost(state, threadId));
  if (!transcript?.page?.hasMore || transcript.loadingOlder || !socket) return;
  setState(setTranscript(state, threadId, { ...transcript, loadingOlder: true }));
  socket.send(
    JSON.stringify(
      ClientCommand.cases["thread.loadOlder"].make({
        threadId,
        before: transcript.page.before,
        turnLimit: TURN_LIMIT,
      }),
    ),
  );
};

/** Folders added on a remote host whose project hasn't arrived yet, so commands for them go there. */
const pendingPaths = new Map<string, string>();

/** The host a folder is on: the project or thread folder it's in, longest match first. */
function pathHost(state: State, path: string): string | null {
  const inside = (folder: string) => path === folder || path.startsWith(`${folder}/`);
  const project = state.projects
    .filter((candidate) => inside(candidate.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (project) return state.projectHosts[project.id] ?? null;
  const thread = Object.values(state.threads)
    .filter((candidate) => inside(candidate.cwd))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
  if (thread) return threadHost(state, thread.id);
  return pendingPaths.get(path) ?? null;
}

/** The host a command is for: that of the thread, project or folder it names. */
function commandHost(command: ClientCommand): string | null {
  if ("threadId" in command) return threadHost(state, command.threadId);
  if ("projectId" in command) return state.projectHosts[command.projectId] ?? null;
  if ("path" in command) return pathHost(state, command.path);
  return null;
}

/** Sends to the daemon the command is for, or to `host`'s; held while that one is down. */
export const send = (command: ClientCommand, host = commandHost(command)) => {
  const connection = connections.get(host);
  if (!connection) return;
  const socket = openSocket(host);
  if (socket) socket.send(JSON.stringify(command));
  else connection.queued.push(command);
};

export const useThreadHost = (threadId: string) => useStore((s) => threadHost(s, threadId));
/** Why this thread can't rewind its files, or null when it can; only threads on its host share its folders. */
export const useFileRestoreBlocker = (threadId: string) =>
  useStore((s) => {
    const thread = s.threads[threadId];
    if (!thread) return null;
    const host = threadHost(s, threadId);
    return fileRestoreBlocker(
      thread,
      Object.values(s.threads).filter((other) => onHost(s, host, other.projectId)),
    );
  });
export const usePathHost = (path: string | null) =>
  useStore((s) => (path === null ? null : pathHost(s, path)));
export const useProjectHost = (projectId: string) =>
  useStore((s) => s.projectHosts[projectId] ?? null);

/** A host's harnesses; this Mac's for null. */
export const useProviders = (host: string | null) =>
  useStore((s) => (host === null ? s.providers : (s.hosts[host]?.providers ?? NO_PROVIDERS)));

/** Registers a folder on `host` as a project. */
export function addProjectOn(host: string | null, path: string) {
  if (host !== null) pendingPaths.set(path, host);
  send(ClientCommand.cases["project.add"].make({ path }), host);
}

/** Adds the git repos in `host`'s projects folder, or its home, as projects there. */
export function scanProjects(host: string) {
  if (state.source === "none") return;
  send(
    ClientCommand.cases["project.scan"].make({
      path: state.settings.hostProjectFolders?.[host] || "~",
    }),
    host,
  );
}

/** The folders in `path` on `host`, `path` made absolute; null when the host doesn't answer. */
export const listFolders = (host: string | null, path: string) =>
  request<Extract<ServerFrame, { _tag: "folder.entries" }>>(
    host,
    ClientCommand.cases["folder.list"].make({ path, requestId: crypto.randomUUID() }),
    10_000,
  );

/** Clones a repository into a new folder under `parent` on `host` and adds it as a project. */
export async function cloneProject(
  host: string | null,
  url: string,
  parent: string,
  folder?: string,
  name?: string,
) {
  const cloned = await request<Extract<ServerFrame, { _tag: "project.cloned" }>>(
    host,
    ClientCommand.cases["project.clone"].make({
      url,
      parent,
      folder,
      name,
      requestId: crypto.randomUUID(),
    }),
    // Big repositories take a while; the daemon gives up at 10 minutes.
    11 * 60_000,
  );
  if (cloned?.path && host !== null) pendingPaths.set(cloned.path, host);
  return (
    cloned ?? { path: null, error: "The host stopped answering. Check its connection, then retry." }
  );
}

/** Remote hosts follow this Mac's settings, except their harness launch settings, which are per machine. */
function syncSettings(host: string) {
  const remote = state.hosts[host]?.settings;
  if (!remote || state.source === "none") return;
  const settings = { ...state.settings, providers: remote.providers };
  if (JSON.stringify(settings) !== JSON.stringify(remote))
    send(ClientCommand.cases["settings.update"].make({ settings }), host);
}

export const getSettings = () => state.settings;
export const getHosts = () => state.hosts;

/** Threads asked about once per window: one that has nothing to read keeps having nothing. */
const usageRequested = new Set<string>();

export const readUsage = (threadId: string) => {
  if (usageRequested.has(threadId)) return;
  usageRequested.add(threadId);
  setState({ ...state, readingUsage: { ...state.readingUsage, [threadId]: true } });
  send(ClientCommand.cases["thread.readUsage"].make({ threadId }));
};

export const readLimits = (provider: ProviderKind, host: string | null) => {
  const loading = (limits: State["limits"]) => ({
    ...limits,
    [provider]: { limits: limits[provider]?.limits ?? [], error: null, loading: true },
  });
  setState(
    host === null
      ? { ...state, limits: loading(state.limits) }
      : updateHost(state, host, (current) => ({ ...current, limits: loading(current.limits) })),
  );
  send(ClientCommand.cases["provider.readLimits"].make({ provider }), host);
};

/** Applies settings locally right away (theme etc. shouldn't wait on the daemon), then persists them. */
export const updateSettings = (settings: Settings) => {
  setState({ ...state, settings });
  send(ClientCommand.cases["settings.update"].make({ settings }), null);
  for (const host of Object.keys(state.hosts)) syncSettings(host);
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
  ownRequests.set(requestId, { open, options: command.options });
  send(ClientCommand.cases["thread.create"].make({ requestId, ...command }));
};

export const switchToThread = (threadId: string) => setState({ ...state, switchTo: { threadId } });

/** Starts a new thread with the conversation through a message's turn, and switches to it. */
export const forkThread = (threadId: string, messageId: string) => {
  if (state.forking?.error === null) return;
  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { open: true });
  setState({ ...state, forking: { threadId, messageId, error: null } });
  send(ClientCommand.cases["thread.fork"].make({ threadId, messageId, requestId }));
};

/** Opens the peer review dialog on a thread; the thread's view shows it. */
export const openPeerReview = (threadId: string) => {
  if (state.peerReview?.pending) return;
  setState({ ...state, peerReview: { threadId, pending: false, error: null } });
};

/** Asks the other harness to review the thread; the dialog stays up until the review opens. */
export const startPeerReview = (threadId: string) => {
  if (state.peerReview?.pending) return;
  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { open: true });
  setState({ ...state, peerReview: { threadId, pending: true, error: null } });
  send(ClientCommand.cases["thread.peerReview"].make({ threadId, requestId }));
};

/** Stays up while the review starts, like forking: it opens in a moment and replaces the view. */
export const closePeerReview = () => {
  if (state.peerReview && !state.peerReview.pending) setState({ ...state, peerReview: null });
};

/** Forgets a fork that failed, once its error has been seen. */
export const dismissForkError = () => {
  if (state.forking?.error) setState({ ...state, forking: null });
};

// --- queue ----------------------------------------------------------------------
// A message written while the agent works waits in the daemon (t3code's "queue"), then goes
// out on its own after the agent's next tool call or when the turn ends.

export const queueMessage = (threadId: string, text: string, options: TurnOptions) =>
  send(ClientCommand.cases["thread.send"].make({ threadId, text, options, queue: true }));

/** Sends a queued message right away, into the running turn. */
export const sendQueuedNow = (threadId: string, messageId: string) =>
  send(ClientCommand.cases["thread.sendQueued"].make({ threadId, messageId }));

/** Takes queued messages back out (all of them without `messageId`), for the composer. */
export const takeQueued = (threadId: string, messageId?: string): ReadonlyArray<QueuedMessage> => {
  const queue = state.threads[threadId]?.queue ?? [];
  const taken = messageId ? queue.filter((message) => message.id === messageId) : queue;
  if (taken.length)
    send(
      ClientCommand.cases["thread.unqueue"].make({
        threadId,
        messageIds: taken.map((message) => message.id),
      }),
    );
  return taken;
};

// --- search --------------------------------------------------------------------

/** Full-text search over every thread's messages, newest first. */
export const searchMessages = async (query: string): Promise<ReadonlyArray<SearchHit>> => {
  const answers = await Promise.all(
    [...connections.keys()].map((host) =>
      request<Extract<ServerFrame, { _tag: "search.results" }>>(
        host,
        ClientCommand.cases.search.make({ query, requestId: crypto.randomUUID() }),
        // An answer that never comes (the connection dropped) shouldn't hold a caller forever.
        5000,
      ),
    ),
  );
  return answers.flatMap((answer) => answer?.hits ?? []);
};

// --- terminals -------------------------------------------------------------------

export interface RunningCommand {
  readonly terminalId: string;
  readonly command: string;
}

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
  openSocket(commandHost(command))?.send(JSON.stringify(command));
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

/**
 * Runs a command from an agent's reply in a terminal of its own, shown under the transcript once
 * the daemon has started it; when it exits, its output goes to the agent as the next message.
 */
export function runCommand(threadId: string, command: string, options: TurnOptions) {
  send(
    ClientCommand.cases["terminal.run"].make({
      threadId,
      terminalId: crypto.randomUUID(),
      command,
      columns: 100,
      rows: 12,
      options,
    }),
  );
}

/** Also stops a running command, without telling its agent. */
export function closeTerminal(threadId: string, terminalId: string) {
  send(ClientCommand.cases["terminal.close"].make({ threadId, terminalId }));
  setState(withoutTerminal(state, threadId, terminalId));
}

/** Marks a thread's latest activity as seen, which clears its unread state. */
export const markSeen = (threadId: string) => {
  const info = state.threads[threadId];
  if (info && !isSeen(info))
    send(ClientCommand.cases["thread.seen"].make({ threadId, rev: info.updatedAt }));
};

/** Shelve/Unshelve from the thread menu; holds until the thread's next turn starts. */
export const setShelved = (threadId: string, shelved: boolean) =>
  send(ClientCommand.cases["thread.shelve"].make({ threadId, shelved }));

/** Nothing new (an error included) since you last opened the thread. */
export const isSeen = (info: ThreadInfo) => info.seenRev >= info.updatedAt;

/** Working threads, or ones waiting on you, can't be shelved by hand. */
export const canShelve = (info: ThreadInfo) => !isTurnActive(info.status);

export const respondApproval = (
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
  reply?: { readonly permission?: PermissionLevel; readonly answers?: UserAnswers },
) => {
  const transcript = state.transcripts[threadId];
  if (transcript) {
    const items = transcript.items.map((item) =>
      item.id === requestId && item.kind === "approval" ? { ...item, decision } : item,
    );
    setState(setTranscript(state, threadId, { ...transcript, items }));
  }
  send(ClientCommand.cases["approval.respond"].make({ threadId, requestId, decision, ...reply }));
};

export const useStore = <A>(select: (state: State) => A): A =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
