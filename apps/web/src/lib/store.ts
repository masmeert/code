import {
  DEFAULT_DAEMON_PORT,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  DEFAULT_SETTINGS,
  type AuthFlow,
  HostStatus,
  type Project,
  type ProjectConfig,
  type ProjectScript,
  type Workspace,
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
} from "@masscode/contracts";
import type { ToolCall } from "@masscode/ui/agents/tool-group";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";
import { normalizeUrl, openPreview, performBrowserAction } from "./browser.ts";
import { showDevice } from "./simulator.ts";
import { loadShell, loadTranscript, removeTranscript, saveShell, saveTranscript } from "./cache.ts";
import { decodeChoice } from "./models.ts";

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
  /** The agent's thinking, folded to a line in the transcript. */
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
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
  /** How the new worktree's setup command from `masscode.toml` ended. */
  | {
      readonly kind: "setup";
      readonly id: string;
      readonly run: CommandRun;
      readonly stopped: boolean;
    }
  | { readonly kind: "error"; readonly id: string; readonly text: string };

/**
 * One thread's messages, loaded when it's opened (the thread list never needs them).
 * Same lifecycle as t3code's thread state: `cached` from the last run, `loading` while
 * the daemon sends it, `live` once caught up and following new events.
 */
interface Transcript {
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
  /** Why this Mac's daemon can't be used: it runs another version of MassCode. */
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
  /** The side chat (BTW) open in this window: read-only questions about one reply, gone once closed. */
  readonly sideChat: {
    readonly id: string;
    readonly threadId: string;
    /** The reply it's about. */
    readonly messageId: string;
    readonly items: ReadonlyArray<TranscriptItem>;
    readonly running: boolean;
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
interface HostState {
  readonly status: HostStatus;
  readonly connected: boolean;
  /** Why its daemon can't be used: it runs another version of MassCode. */
  readonly incompatible: string | null;
  readonly dataId: string | null;
  readonly root: boolean;
  readonly settings: Settings | null;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly sourceControl: ReadonlyArray<SourceControlStatus> | null;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  readonly limits: Partial<Record<ProviderKind, ProviderLimits>>;
}

interface ProviderLimits {
  readonly limits: ReadonlyArray<UsageLimit>;
  readonly error: string | null;
  /** A fresh read is on its way; what's above is from the last one. */
  readonly loading: boolean;
}

interface RepoState {
  /** Null outside a repo. */
  readonly status: RepoStatus | null;
  /** The commit/push the last update answered, and why it failed. */
  readonly action: GitAction | null;
  readonly error: string | null;
}

interface RepoDiff {
  readonly patch: string;
  readonly truncated: boolean;
  readonly error: string | null;
}

interface BranchList {
  readonly current: string | null;
  readonly branches: ReadonlyArray<string>;
  /** Why the last checkout failed. */
  readonly error: string | null;
}

interface SkillList {
  readonly skills: ReadonlyArray<Skill>;
  /** Why the harness couldn't be asked; `skills` then holds what it said last time. */
  readonly error: string | null;
}

/** Where `skills` keeps a harness's skills for a folder. */
export function getSkillsKey(provider: ProviderKind, path: string) {
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
  sideChat: null,
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
function getThreadHost(state: State, threadId: string): string | null {
  const projectId = state.threads[threadId]?.projectId;
  return (projectId && state.projectHosts[projectId]) || null;
}

/** The database a thread's cached transcript belongs to: its host's. */
function getDataId(state: State, threadId: string) {
  const host = getThreadHost(state, threadId);
  return host === null ? state.dataId : (state.hosts[host]?.dataId ?? null);
}

/** Whether a thread or project is on `host` (null: this Mac). */
function isOnHost(state: State, host: string | null, projectId: string) {
  return (state.projectHosts[projectId] ?? null) === host;
}

/**
 * `thread.create` and `thread.fork` commands sent from this window, by request id. A fork has
 * no options of its own to start its composer from.
 */
const ownRequests = new Map<
  string,
  { readonly shouldOpen: boolean; readonly options?: TurnOptions }
>();
/** What threads created here sent their first message with, so their composer starts from the draft's picks. */
const firstOptions = new Map<string, TurnOptions>();

export function findFirstTurnOptions(threadId: string) {
  return firstOptions.get(threadId);
}

/** Latest turns loaded when a thread opens, and per "load earlier" (t3code uses the same window). */
const TURN_LIMIT = 10;

/** Searches from the end: the item being updated is almost always the last one. */
function upsert(
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
function reduceItems(
  items: ReadonlyArray<TranscriptItem>,
  event: RuntimeEvent,
  id: number | null,
): ReadonlyArray<TranscriptItem> {
  return Match.value(event).pipe(
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
          : items.findIndex((item, index) => index > start && item.kind === "user" && !item.steer);
      if (next === -1) return upsert(items, checkpoint.id, () => checkpoint);

      return [
        ...items.slice(0, next).filter((item) => item.id !== checkpoint.id),
        checkpoint,
        ...items.slice(next).filter((item) => item.id !== checkpoint.id),
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
    Match.tag("thread.startedBy", ({ byThreadId, byTitle }) =>
      upsert(items, `startedBy:${byThreadId}`, () => ({
        kind: "startedBy",
        id: `startedBy:${byThreadId}`,
        byThreadId,
        byTitle,
      })),
    ),
    Match.tag("worktree.setup", ({ run, stopped }) =>
      upsert(items, "setup", () => ({ kind: "setup", id: "setup", run, stopped })),
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
    Match.tag("reasoning.delta", (delta) =>
      upsert(items, delta.messageId, (prev) => ({
        kind: "reasoning",
        id: delta.messageId,
        text: (prev?.kind === "reasoning" ? prev.text : "") + delta.delta,
      })),
    ),
    Match.tag("reasoning.completed", (completed) =>
      upsert(items, completed.messageId, () => ({
        kind: "reasoning",
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
}

function applyStoredEvents(
  items: ReadonlyArray<TranscriptItem>,
  events: ReadonlyArray<StoredEvent>,
  after: number,
) {
  let next = items;
  for (const { id, event } of events) if (id > after) next = reduceItems(next, event, id);
  return next;
}

/** Text of messages still streaming, sent whole with a snapshot or replay: it replaces what the cache had. */
function applyStreaming(items: ReadonlyArray<TranscriptItem>, deltas: ReadonlyArray<RuntimeEvent>) {
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

/** Everything but transcripts: the thread list, settings, projects, git state… */
function reduceShell(state: State, event: RuntimeEvent): State {
  return Match.value(event).pipe(
    Match.withReturnType<State>(),
    // Usually the echo of our own updateSettings: keeping the old object spares every settings reader a re-render.
    Match.tag("settings.updated", ({ settings }) =>
      JSON.stringify(settings) === JSON.stringify(state.settings) ? state : { ...state, settings },
    ),
    Match.tag("project.added", ({ project }) => ({
      ...state,
      projects: [...state.projects.filter((existing) => existing.id !== project.id), project],
    })),
    Match.tag("project.removed", ({ projectId }) => {
      const { [projectId]: _host, ...projectHosts } = state.projectHosts;
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== projectId),
        projectHosts,
      };
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
        skills: { ...state.skills, [getSkillsKey(provider, path)]: { skills, error } },
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
        switchTo: request?.shouldOpen ? { threadId: thread.id } : state.switchTo,
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
      const dataId = getDataId(state, threadId);
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
      removeTerminal(state, threadId, terminalId),
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
      "thread.limitStop": ({ threadId, limitStop }) =>
        updateThreadInfo(state, threadId, (info) => ({
          ...info,
          limitStop: limitStop ?? undefined,
        })),
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
}

function updateThreadInfo(
  state: State,
  threadId: string,
  update: (info: ThreadInfo) => ThreadInfo,
): State {
  const info = state.threads[threadId];
  if (!info) return state;

  return { ...state, threads: { ...state.threads, [threadId]: update(info) } };
}

function setTranscript(state: State, threadId: string, transcript: Transcript): State {
  return { ...state, transcripts: { ...state.transcripts, [threadId]: transcript } };
}

function removeTerminal(state: State, threadId: string, terminalId: string): State {
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

let state = initial;
const listeners = new Set<() => void>();
/** Called on every change, frame or not: hidden windows get no animation frames, so no renders. */
const watchers = new Set<(prev: State, next: State) => void>();

export function watchState(watcher: (prev: State, next: State) => void) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

let isNotifyScheduled = false;

function notifyListeners() {
  isNotifyScheduled = false;
  for (const listener of listeners) listener();
}

function setState(next: State) {
  const prev = state;
  state = next;
  for (const watcher of watchers) watcher(prev, next);

  // Deltas can arrive faster than frames: re-render at most once per frame.
  if (!isNotifyScheduled) {
    isNotifyScheduled = true;
    requestAnimationFrame(notifyListeners);
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
      Object.entries(next.threads).filter(([, info]) => isOnHost(next, null, info.projectId)),
    );
    saveShell({
      dataId,
      settings,
      providers,
      projects: next.projects.filter((project) => isOnHost(next, null, project.id)),
      order: next.order.filter((id) => threads[id]),
      threads,
    });
  }

  if (prev.transcripts !== next.transcripts || prev.threads !== next.threads) {
    for (const [threadId, transcript] of Object.entries(next.transcripts)) {
      if (transcript.status !== "live") continue;
      // Persist once a turn settles, not on every delta: encoding the whole transcript
      // mid-stream is wasted work (t3code does the same). Saved when the turn ends.
      if (next.threads[threadId]?.status === "running") continue;
      if (transcript === prev.transcripts[threadId] && prev.threads[threadId]?.status !== "running")
        continue;

      const dataId = getDataId(next, threadId);
      if (!dataId) continue;

      const { items, cursor, page } = transcript;
      saveTranscript(dataId, threadId, { items, cursor, page });
    }
  }
}

/** Threads with an open view, counted (a thread can be open in several places). */
const wanted = new Map<string, number>();
/** Threads whose cached transcript is still being read; subscribing waits for it, to know the cursor. */
const readingCache = new Set<string>();
/** Closed threads' pending drops from memory, cancelled if a view opens them again. */
const evictions = new Map<string, ReturnType<typeof setTimeout>>();

/** Puts a thread's cached transcript in memory, if it isn't there yet. */
async function loadCachedTranscript(threadId: string) {
  const dataId = getDataId(state, threadId);
  if (!dataId || state.transcripts[threadId] || readingCache.has(threadId)) return;

  readingCache.add(threadId);
  const cached = await loadTranscript(dataId, threadId);
  readingCache.delete(threadId);
  // The daemon may have answered meanwhile, or a new shell may be from another database.
  if (!cached || getDataId(state, threadId) !== dataId || state.transcripts[threadId]) return;

  const { items, cursor, page } = cached;
  setState(
    setTranscript(state, threadId, { items, cursor, page, status: "cached", loadingOlder: false }),
  );
}

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
  isRemoved: boolean;
}

const connections = new Map<string | null, Connection>();

function findOpenSocket(host: string | null) {
  const socket = connections.get(host)?.socket;
  return socket?.readyState === WebSocket.OPEN ? socket : null;
}

/** The host's daemon sent its shell on this connection, so its threads can be asked about. */
function hasShell(host: string | null) {
  return host === null ? state.source === "daemon" : state.hosts[host]?.connected === true;
}

/** Asks for a thread's transcript: a replay after the cursor when we have one, else the latest turns. */
function subscribeToTranscript(threadId: string) {
  const host = getThreadHost(state, threadId);
  const socket = findOpenSocket(host);
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
}

const NO_PROVIDERS: ReadonlyArray<ProviderStatus> = [];

function createHostState(status: HostStatus): HostState {
  return {
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
  };
}

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
            "MassCode's daemon is a different version from this window. Quit MassCode and open it again.",
        }
      : updateHost(state, host, (current) => ({
          ...current,
          incompatible: `${host} runs a different version of MassCode. Restart it from Settings → Connections.`,
        })),
  );
}

/** Replaces one host's threads and projects with what its daemon sent; other hosts' stay. */
function onShell(connection: Connection, frame: Extract<ServerFrame, { _tag: "shell" }>) {
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
    Object.entries(state.threads).filter(([, info]) => !isOnHost(state, host, info.projectId)),
  );
  const threads = { ...others, ...incoming };

  // Keep transcripts of threads that still exist; they resume from their cursor.
  const transcripts: Record<string, Transcript> = {};
  for (const [threadId, transcript] of Object.entries(state.transcripts)) {
    if (others[threadId] || (sameData && incoming[threadId])) transcripts[threadId] = transcript;
    else if (sameData) removeTranscript(frame.dataId, threadId);
  }

  const terminals: Record<string, Array<string>> = {};
  for (const [threadId, terminalIds] of Object.entries(state.terminals)) {
    if (others[threadId]) terminals[threadId] = [...terminalIds];
  }

  const runs: Record<string, Array<RunningCommand>> = {};
  for (const [threadId, running] of Object.entries(state.runs)) {
    if (others[threadId]) runs[threadId] = [...running];
  }
  for (const { threadId, terminalId, command } of frame.terminals) {
    if (command !== undefined) (runs[threadId] ??= []).push({ terminalId, command });
  }

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
      ...state.projects.filter((project) => !isOnHost(state, host, project.id)),
      ...frame.projects,
    ],
    projectHosts,
    order: Object.values(threads)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((thread) => thread.id),
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
    if (getThreadHost(state, threadId) !== host) continue;
    if (transcripts[threadId] || !sameData) {
      subscribeToTranscript(threadId);
    } else {
      // Not in memory yet: read the cache first so the daemon only sends what's new.
      void loadCachedTranscript(threadId).then(
        () => wanted.has(threadId) && subscribeToTranscript(threadId),
      );
    }
  }
  for (const screen of ownScreens) openScreen(screen);

  if (host !== null) {
    syncSettings(host);
    scanProjects(host);
  } else {
    // Hosts that connected first had no projects folder to scan yet.
    for (const [alias, remote] of Object.entries(state.hosts))
      if (remote.connected) scanProjects(alias);
  }
}

/** Answers to requests carrying a `requestId`, by that id. */
const replies = new Map<string, (frame: ServerFrame) => void>();

function resolveReply(frame: Extract<ServerFrame, { requestId: string }>) {
  replies.get(frame.requestId)?.(frame);
  replies.delete(frame.requestId);
}

/** Sends a command answered by a frame of its own; null when the host is down or never answers. */
function sendRequest<Frame extends ServerFrame>(
  host: string | null,
  command: Extract<ClientCommand, { requestId: string }>,
  timeoutMs: number,
) {
  return new Promise<Frame | null>((resolve) => {
    const socket = findOpenSocket(host);
    if (!socket) return resolve(null);

    // SAFETY: a daemon answers each request with its own kind of frame, carrying the same id.
    replies.set(command.requestId, (frame) => resolve(frame as Frame));
    socket.send(JSON.stringify(command));
    setTimeout(() => {
      if (replies.delete(command.requestId)) resolve(null);
    }, timeoutMs);
  });
}

function onFrame(connection: Connection, frame: ServerFrame) {
  return ServerFrame.match(frame, {
    shell: (shell) => onShell(connection, shell),
    "thread.snapshot": (snapshot) => {
      const items = applyStreaming(applyStoredEvents([], snapshot.events, 0), snapshot.streaming);
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
        applyStoredEvents(base, replay.events, prev?.cursor ?? 0),
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
      const older = applyStoredEvents([], page.events, 0).filter((item) => !known.has(item.id));
      setState(
        setTranscript(state, page.threadId, {
          ...prev,
          items: [...older, ...prev.items],
          page: page.page,
          loadingOlder: false,
        }),
      );
    },
    "search.results": resolveReply,
    "folder.entries": resolveReply,
    "project.config": resolveReply,
    "project.configSaved": resolveReply,
    "image.signed": resolveReply,
    "project.cloned": resolveReply,
    "device.listed": resolveReply,
    "device.attached": resolveReply,
    "terminal.snapshot": ({ threadId, terminalId, data }) =>
      screens.get(getScreenKey(threadId, terminalId))?.reset(data),
    "terminal.output": ({ threadId, terminalId, data }) =>
      screens.get(getScreenKey(threadId, terminalId))?.write(data),
    "terminal.error": ({ threadId, terminalId, message }) =>
      screens.get(getScreenKey(threadId, terminalId))?.fail(message),
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
      const { sideChat } = state;
      if (sideChat && "threadId" in event && event.threadId === sideChat.id)
        return setState({
          ...state,
          sideChat: RuntimeEvent.guards["thread.status"](event)
            ? { ...sideChat, running: isTurnActive(event.status) }
            : { ...sideChat, items: reduceItems(sideChat.items, event, id) },
        });

      // A failed fork reports on the thread it was forked from.
      if (
        RuntimeEvent.guards.error(event) &&
        state.forking?.error === null &&
        event.threadId === state.forking.threadId
      )
        setState({ ...state, forking: { ...state.forking, error: event.message } });

      if (RuntimeEvent.guards["thread.device"](event))
        return showDevice(event.threadId, event.deviceId);
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
}

/** A remote daemon's own events land in its `HostState`; the rest are shared, keyed by thread or path. */
function reduceRemoteShell(state: State, host: string, event: RuntimeEvent): State {
  return Match.value(event).pipe(
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
}

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

function scheduleReconnect(connection: Connection) {
  const delays = connection.host === null ? RETRY_DELAYS_MS : REMOTE_RETRY_DELAYS_MS;
  connection.retry = setTimeout(
    () => {
      connection.retry = null;
      void connect(connection);
    },
    delays[Math.min(connection.attempt++, delays.length - 1)],
  );
}

async function connect(connection: Connection) {
  const { host } = connection;
  // Asked on every attempt: a daemon that restarts (or updates, on a remote host) comes back on a new port.
  const daemon =
    host === null
      ? ((await window.desktop?.daemon()) ?? null)
      : ((await window.desktop?.hostDaemon(host)) ?? null);
  if (connection.isRemoved) return;
  if (host !== null && !daemon) return scheduleReconnect(connection);

  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon?.port ?? DEFAULT_DAEMON_PORT}/?protocol=${PROTOCOL_VERSION}`,
    daemon ? [`masscode.${daemon.token}`] : undefined,
  );
  connection.socket = socket;
  socket.onopen = () => {
    if (window.desktop) socket.send(JSON.stringify(ClientCommand.cases["browser.host"].make({})));
    for (const command of connection.queued.splice(0)) socket.send(JSON.stringify(command));
  };
  socket.onmessage = (message) =>
    onFrame(connection, Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))(message.data));
  socket.onclose = (event) => {
    if (connection.socket !== socket) return;

    connection.socket = null;
    if (event.code === PROTOCOL_MISMATCH) markIncompatible(host);
    // Keep everything on screen; transcripts fall back to cached until the next connect catches them up.
    const transcripts = Object.fromEntries(
      Object.entries(state.transcripts).map(([id, transcript]) => [
        id,
        getThreadHost(state, id) !== host ||
        (transcript.status === "cached" && !transcript.loadingOlder)
          ? transcript
          : { ...transcript, status: "cached" as const, loadingOlder: false },
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
    if (!connection.isRemoved) scheduleReconnect(connection);
  };
}

function addConnection(host: string | null) {
  const connection: Connection = {
    host,
    socket: null,
    attempt: 0,
    retry: null,
    queued: [],
    isRemoved: false,
  };
  connections.set(host, connection);
  void connect(connection);
}

/** Drops a removed host's connection and everything it showed. */
function removeConnection(connection: Connection, host: string) {
  connection.isRemoved = true;
  if (connection.retry) clearTimeout(connection.retry);
  connection.socket?.close();
  connections.delete(host);

  const gone = new Set(
    Object.values(state.threads)
      .filter((info) => isOnHost(state, host, info.projectId))
      .map((info) => info.id),
  );

  function dropGoneThreads<A>(record: Readonly<Record<string, A>>) {
    return Object.fromEntries(Object.entries(record).filter(([threadId]) => !gone.has(threadId)));
  }

  const { [host]: _removed, ...hosts } = state.hosts;
  setState({
    ...state,
    hosts,
    projects: state.projects.filter((project) => !isOnHost(state, host, project.id)),
    projectHosts: Object.fromEntries(
      Object.entries(state.projectHosts).filter(([, projectHost]) => projectHost !== host),
    ),
    order: state.order.filter((id) => !gone.has(id)),
    threads: dropGoneThreads(state.threads),
    transcripts: dropGoneThreads(state.transcripts),
    terminals: dropGoneThreads(state.terminals),
    activeTerminals: dropGoneThreads(state.activeTerminals),
    runs: dropGoneThreads(state.runs),
  });
}

/** Follows the desktop app's list of remote hosts: connects new ones, drops removed ones. */
function syncHosts(list: ReadonlyArray<RemoteHost>) {
  const aliases = new Set(list.map((remote) => remote.alias));
  for (const connection of connections.values()) {
    if (connection.host !== null && !aliases.has(connection.host))
      removeConnection(connection, connection.host);
  }

  setState({
    ...state,
    hosts: Object.fromEntries(
      list.map(({ alias, status }) => [
        alias,
        { ...(state.hosts[alias] ?? createHostState(status)), status },
      ]),
    ),
  });

  for (const { alias, status } of list) {
    const connection = connections.get(alias);
    if (!connection) {
      addConnection(alias);
    } else if (HostStatus.guards.connected(status) && connection.retry) {
      // Back (say, restarted on the new version): don't wait out the backoff.
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
function openThread(threadId: string) {
  const count = wanted.get(threadId) ?? 0;
  wanted.set(threadId, count + 1);
  if (count > 0) return;

  clearTimeout(evictions.get(threadId));
  evictions.delete(threadId);
  if (state.transcripts[threadId]) subscribeToTranscript(threadId);
  else
    void loadCachedTranscript(threadId).then(
      () => wanted.has(threadId) && subscribeToTranscript(threadId),
    );
}

function closeThread(threadId: string) {
  const count = (wanted.get(threadId) ?? 1) - 1;
  if (count > 0) {
    wanted.set(threadId, count);
    return;
  }

  wanted.delete(threadId);
  findOpenSocket(getThreadHost(state, threadId))?.send(
    JSON.stringify(ClientCommand.cases["thread.unsubscribe"].make({ threadId })),
  );
  // Kept a few minutes for quick back-and-forth (t3code keeps 5); after that, reopening reads
  // the IndexedDB cache and replays only what it missed.
  evictions.set(
    threadId,
    setTimeout(() => {
      evictions.delete(threadId);
      const { [threadId]: _evicted, ...transcripts } = state.transcripts;
      setState({ ...state, transcripts });
    }, 5 * 60_000),
  );
}

let kept: ReadonlyArray<string> = [];

/**
 * Follows these threads' transcripts while their views are kept hidden, so switching back to
 * one shows it current, with no replay to wait for.
 */
export function keepFollowing(threadIds: ReadonlyArray<string>) {
  for (const threadId of threadIds) if (!kept.includes(threadId)) openThread(threadId);
  for (const threadId of kept) if (!threadIds.includes(threadId)) closeThread(threadId);
  kept = threadIds;
}

/** A thread's transcript, followed live while the calling component is mounted. */
export function useTranscript(threadId: string): Transcript | null {
  useEffect(() => {
    openThread(threadId);
    return () => closeThread(threadId);
  }, [threadId]);
  return useStore((state) => state.transcripts[threadId] ?? null);
}

/** Fetches the turns before what's loaded. */
export function loadOlder(threadId: string) {
  const transcript = state.transcripts[threadId];
  const socket = findOpenSocket(getThreadHost(state, threadId));
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
}

/** Folders added on a remote host whose project hasn't arrived yet, so commands for them go there. */
const pendingPaths = new Map<string, string>();

/** The host a folder is on: the project or thread folder it's in, longest match first. */
function findPathHost(state: State, path: string): string | null {
  function isInside(folder: string) {
    return path === folder || path.startsWith(`${folder}/`);
  }

  const project = state.projects
    .filter((candidate) => isInside(candidate.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (project) return state.projectHosts[project.id] ?? null;

  const thread = Object.values(state.threads)
    .filter((candidate) => isInside(candidate.cwd))
    .sort((left, right) => right.cwd.length - left.cwd.length)[0];
  if (thread) return getThreadHost(state, thread.id);

  return pendingPaths.get(path) ?? null;
}

/** The host a command is for: that of the thread, project or folder it names. */
function getCommandHost(command: ClientCommand): string | null {
  if ("threadId" in command) return getThreadHost(state, command.threadId);
  if ("projectId" in command) return state.projectHosts[command.projectId] ?? null;
  if ("path" in command) return findPathHost(state, command.path);
  return null;
}

/** Sends to the daemon the command is for, or to `host`'s; held while that one is down. */
export function send(command: ClientCommand, host = getCommandHost(command)) {
  const connection = connections.get(host);
  if (!connection) return;

  const socket = findOpenSocket(host);
  if (socket) socket.send(JSON.stringify(command));
  else connection.queued.push(command);
}

export function useThreadHost(threadId: string) {
  return useStore((state) => getThreadHost(state, threadId));
}

/** Why this thread can't rewind its files, or null when it can; only threads on its host share its folders. */
export function useFileRestoreBlocker(threadId: string) {
  return useStore((state) => {
    const thread = state.threads[threadId];
    if (!thread) return null;

    const host = getThreadHost(state, threadId);
    return fileRestoreBlocker(
      thread,
      Object.values(state.threads).filter((other) => isOnHost(state, host, other.projectId)),
    );
  });
}

export function usePathHost(path: string | null) {
  return useStore((state) => (path === null ? null : findPathHost(state, path)));
}

export function useProjectHost(projectId: string) {
  return useStore((state) => state.projectHosts[projectId] ?? null);
}

/** A host's harnesses; this Mac's for null. */
export function useProviders(host: string | null) {
  return useStore((state) =>
    host === null ? state.providers : (state.hosts[host]?.providers ?? NO_PROVIDERS),
  );
}

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
export function listFolders(host: string | null, path: string) {
  return sendRequest<Extract<ServerFrame, { _tag: "folder.entries" }>>(
    host,
    ClientCommand.cases["folder.list"].make({ path, requestId: crypto.randomUUID() }),
    10_000,
  );
}

/** This Mac's simulators and its device hub, setting the tools up first with `install`; null when the daemon doesn't answer. */
export function listDevices(install: boolean) {
  return sendRequest<Extract<ServerFrame, { _tag: "device.listed" }>>(
    null,
    ClientCommand.cases["device.list"].make({ install, requestId: crypto.randomUUID() }),
    // Setting up installs two npm packages.
    install ? 10 * 60_000 : 60_000,
  );
}

/** Boots a simulator if needed and shows it in the thread's panel; resolves to an error message, or null. */
export async function attachDevice(threadId: string, deviceId: string | null) {
  const attached = await sendRequest<Extract<ServerFrame, { _tag: "device.attached" }>>(
    null,
    ClientCommand.cases["device.attach"].make({
      threadId,
      deviceId,
      requestId: crypto.randomUUID(),
    }),
    3 * 60_000,
  );
  return attached ? attached.error : "MassCode didn't answer in time. Try again.";
}

/** Signed URLs by thread and source, renewed before the daemon's hour runs out. */
const signedImages = new Map<
  string,
  { readonly url: Promise<string | null>; readonly signedAtMs: number }
>();

/** A URL `<img>` can load for an image file on the thread's host; null when there's no such image. */
export function fetchImageUrl(threadId: string, src: string) {
  const key = `${threadId}\n${src}`;
  const cached = signedImages.get(key);
  if (cached && Date.now() - cached.signedAtMs < 50 * 60 * 1000) return cached.url;

  const thread = state.threads[threadId];
  const host = getThreadHost(state, threadId);
  const url = thread
    ? sendRequest<Extract<ServerFrame, { _tag: "image.signed" }>>(
        host,
        ClientCommand.cases["image.sign"].make({
          path: decodeURI(src.replace(/^file:\/\//, "")),
          cwd: thread.cwd,
          requestId: crypto.randomUUID(),
        }),
        10_000,
      ).then((signed) => {
        const socket = findOpenSocket(host);
        if (!signed?.url || !socket) {
          signedImages.delete(key);
          return null;
        }
        // Remote hosts are reached through a tunnel on this Mac, so the socket's address serves both.
        return new URL(signed.url, socket.url.replace(/^ws/, "http")).href;
      })
    : Promise.resolve(null);

  signedImages.set(key, { url, signedAtMs: Date.now() });
  return url;
}

/** Clones a repository into a new folder under `parent` on `host` and adds it as a project. */
export async function cloneProject(
  host: string | null,
  url: string,
  parent: string,
  folder?: string,
  name?: string,
) {
  const cloned = await sendRequest<Extract<ServerFrame, { _tag: "project.cloned" }>>(
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
    cloned ?? {
      path: null,
      error: "The host stopped answering. Check its connection, then retry.",
    }
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

export function getSettings() {
  return state.settings;
}

export function getHosts() {
  return state.hosts;
}

/** Threads asked about once per window: one that has nothing to read keeps having nothing. */
const usageRequested = new Set<string>();

export function readUsage(threadId: string) {
  if (usageRequested.has(threadId)) return;

  usageRequested.add(threadId);
  setState({ ...state, readingUsage: { ...state.readingUsage, [threadId]: true } });
  send(ClientCommand.cases["thread.readUsage"].make({ threadId }));
}

export function readLimits(provider: ProviderKind, host: string | null) {
  function markLoading(limits: State["limits"]) {
    return {
      ...limits,
      [provider]: { limits: limits[provider]?.limits ?? [], error: null, loading: true },
    };
  }

  setState(
    host === null
      ? { ...state, limits: markLoading(state.limits) }
      : updateHost(state, host, (current) => ({ ...current, limits: markLoading(current.limits) })),
  );
  send(ClientCommand.cases["provider.readLimits"].make({ provider }), host);
}

/** Applies settings locally right away (theme etc. shouldn't wait on the daemon), then persists them. */
export function updateSettings(settings: Settings) {
  setState({ ...state, settings });
  send(ClientCommand.cases["settings.update"].make({ settings }), null);
  for (const host of Object.keys(state.hosts)) syncSettings(host);
}

/** Changes some of one harness's Settings, keeping the rest. */
export function updateHarness(provider: ProviderKind, patch: Partial<ProviderSettings>) {
  updateSettings({
    ...state.settings,
    providers: {
      ...state.settings.providers,
      [provider]: { ...state.settings.providers[provider], ...patch },
    },
  });
}

/** Stars or unstars a `<harness>:<model>` choice. */
export function toggleFavoriteModel(choice: string) {
  const { provider, model } = decodeChoice(choice);
  const starred = state.settings.providers[provider].favoriteModels ?? [];
  updateHarness(provider, {
    favoriteModels: starred.includes(model)
      ? starred.filter((id) => id !== model)
      : [...starred, model],
  });
}

/**
 * Creates a thread from a draft by sending its first message. With `shouldOpen`, this window
 * switches to it once it exists.
 */
export function createThread(input: {
  path: string;
  provider: ProviderKind;
  model: string | null;
  text: string;
  options: TurnOptions;
  workspace: Workspace;
  shouldOpen?: boolean;
}) {
  const { shouldOpen = true, ...command } = input;
  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { shouldOpen, options: command.options });
  send(ClientCommand.cases["thread.create"].make({ requestId, ...command }));
}

export function switchToThread(threadId: string) {
  setState({ ...state, switchTo: { threadId } });
}

/** Starts a new thread with the conversation through a message's turn, and switches to it. */
export function forkThread(threadId: string, messageId: string) {
  if (state.forking?.error === null) return;

  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { shouldOpen: true });
  setState({ ...state, forking: { threadId, messageId, error: null } });
  send(ClientCommand.cases["thread.fork"].make({ threadId, messageId, requestId }));
}

/** Forgets a fork that failed, once its error has been seen. */
export function dismissForkError() {
  if (state.forking?.error) setState({ ...state, forking: null });
}

export function openSideChat(threadId: string, messageId: string) {
  if (state.sideChat) closeSideChat(state.sideChat.threadId);
  setState({
    ...state,
    sideChat: { id: crypto.randomUUID(), threadId, messageId, items: [], running: false },
  });
}

export function askSideChat(text: string) {
  const { sideChat } = state;
  if (!sideChat || sideChat.running) return;

  setState({ ...state, sideChat: { ...sideChat, running: true } });
  send(
    ClientCommand.cases["sideChat.ask"].make({
      threadId: sideChat.threadId,
      messageId: sideChat.messageId,
      sideChatId: sideChat.id,
      text,
    }),
  );
}

/** Ends `threadId`'s side chat for good, stopping its agent. */
export function closeSideChat(threadId: string) {
  const { sideChat } = state;
  if (sideChat?.threadId !== threadId) return;

  setState({ ...state, sideChat: null });
  send(
    ClientCommand.cases["sideChat.close"].make({
      threadId: sideChat.threadId,
      sideChatId: sideChat.id,
    }),
  );
}

/**
 * A message written while the agent works waits in the daemon (t3code's "queue"), then goes
 * out on its own after the agent's next tool call or when the turn ends.
 */
export function queueMessage(threadId: string, text: string, options: TurnOptions) {
  send(ClientCommand.cases["thread.send"].make({ threadId, text, options, queue: true }));
}

/** Sends a queued message right away, into the running turn. */
export function sendQueuedNow(threadId: string, messageId: string) {
  send(ClientCommand.cases["thread.sendQueued"].make({ threadId, messageId }));
}

/** Takes queued messages back out (all of them without `messageId`), for the composer. */
export function takeQueued(threadId: string, messageId?: string): ReadonlyArray<QueuedMessage> {
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
}

/** Full-text search over every thread's messages, newest first. */
export async function searchMessages(query: string): Promise<ReadonlyArray<SearchHit>> {
  const answers = await Promise.all(
    [...connections.keys()].map((host) =>
      sendRequest<Extract<ServerFrame, { _tag: "search.results" }>>(
        host,
        ClientCommand.cases.search.make({ query, requestId: crypto.randomUUID() }),
        // An answer that never comes (the connection dropped) shouldn't hold a caller forever.
        5000,
      ),
    ),
  );
  return answers.flatMap((answer) => answer?.hits ?? []);
}

export interface RunningCommand {
  readonly terminalId: string;
  readonly command: string;
}

interface TerminalScreen {
  readonly threadId: string;
  readonly terminalId: string;
  readonly size: () => { readonly columns: number; readonly rows: number };
  readonly reset: (data: string) => void;
  readonly write: (data: string) => void;
  readonly fail: (message: string) => void;
}

const screens = new Map<string, TerminalScreen>();

function getScreenKey(threadId: string, terminalId: string) {
  return `${threadId}:${terminalId}`;
}

/** What to type into a terminal's shell when the daemon starts it, by terminal id. */
const terminalInputs = new Map<string, string>();
/** The script each script's terminal runs, by terminal id; its tab is named after it. */
const terminalScripts = new Map<string, ProjectScript>();

export function findTerminalScript(terminalId: string) {
  return terminalScripts.get(terminalId);
}

function openScreen(screen: TerminalScreen) {
  const input = terminalInputs.get(screen.terminalId);
  sendIfConnected(
    ClientCommand.cases["terminal.open"].make({
      threadId: screen.threadId,
      terminalId: screen.terminalId,
      ...screen.size(),
      ...(input !== undefined && { input }),
    }),
  );
}

export function sendIfConnected(command: ClientCommand) {
  findOpenSocket(getCommandHost(command))?.send(JSON.stringify(command));
}

export function attachTerminal(screen: TerminalScreen) {
  const key = getScreenKey(screen.threadId, screen.terminalId);
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
  else createTerminal(threadId);
}

export function createTerminal(threadId: string, script?: ProjectScript) {
  const terminalId = crypto.randomUUID();
  if (script) {
    terminalInputs.set(terminalId, script.command);
    terminalScripts.set(terminalId, script);
  }

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

/** Runs a project script in a terminal of its own, or shows the one it's already running in. */
export function runScript(threadId: string, script: ProjectScript) {
  const running = state.terminals[threadId]?.find(
    (terminalId) => terminalScripts.get(terminalId)?.name === script.name,
  );
  if (running) showTerminal(threadId, running);
  else createTerminal(threadId, script);

  const preview = script.preview_url && normalizeUrl(script.preview_url);
  if (preview && window.desktop) openPreview(threadId, preview);
}

/** The project's `masscode.toml` on `host`; null when the host doesn't answer. */
export function readProjectConfig(host: string | null, path: string) {
  return sendRequest<Extract<ServerFrame, { _tag: "project.config" }>>(
    host,
    ClientCommand.cases["project.config"].make({ path, requestId: crypto.randomUUID() }),
    10_000,
  );
}

/**
 * Reads the project's `masscode.toml` on `host` afresh, so edits made elsewhere since aren't lost,
 * and saves what `change` makes of it; resolves to what kept it from saving, or null.
 */
export async function updateProjectConfig(
  host: string | null,
  path: string,
  change: (config: ProjectConfig) => ProjectConfig,
) {
  const current = await readProjectConfig(host, path);
  const saved =
    current &&
    (await sendRequest<Extract<ServerFrame, { _tag: "project.configSaved" }>>(
      host,
      ClientCommand.cases["project.saveConfig"].make({
        path,
        config: change(current.config),
        requestId: crypto.randomUUID(),
      }),
      10_000,
    ));
  return saved
    ? saved.error
    : "MassCode's daemon didn't answer, so nothing was saved. Check it's running and try again.";
}

/** Also stops a running command, without telling its agent. */
export function closeTerminal(threadId: string, terminalId: string) {
  terminalInputs.delete(terminalId);
  terminalScripts.delete(terminalId);
  send(ClientCommand.cases["terminal.close"].make({ threadId, terminalId }));
  setState(removeTerminal(state, threadId, terminalId));
}

/** Marks a thread's latest activity as seen, which clears its unread state. */
export function markSeen(threadId: string) {
  const info = state.threads[threadId];
  if (info && !isSeen(info))
    send(ClientCommand.cases["thread.seen"].make({ threadId, rev: info.updatedAt }));
}

/** Shelve/Unshelve from the thread menu; holds until the thread's next turn starts. */
export function setShelved(threadId: string, shelved: boolean) {
  send(ClientCommand.cases["thread.shelve"].make({ threadId, shelved }));
}

/** Nothing new (an error included) since you last opened the thread. */
export function isSeen(info: ThreadInfo) {
  return info.seenRev >= info.updatedAt;
}

/** Working threads, or ones waiting on you, can't be shelved by hand. */
export function canShelve(info: ThreadInfo) {
  return !isTurnActive(info.status);
}

export function respondApproval(
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
  reply?: { readonly permission?: PermissionLevel; readonly answers?: UserAnswers },
) {
  const transcript = state.transcripts[threadId];
  if (transcript) {
    const items = transcript.items.map((item) =>
      item.id === requestId && item.kind === "approval" ? { ...item, decision } : item,
    );
    setState(setTranscript(state, threadId, { ...transcript, items }));
  }

  send(ClientCommand.cases["approval.respond"].make({ threadId, requestId, decision, ...reply }));
}

export function useStore<A>(select: (state: State) => A): A {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}
