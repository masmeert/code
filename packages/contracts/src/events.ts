import * as Schema from "effect/Schema";
import { GitAction, RepoStatus, SourceControlStatus } from "./git.ts";
import { Project } from "./projects.ts";
import {
  AuthFlow,
  ProviderKind,
  ProviderStatus,
  Skill,
  SlashCommand,
  UsageLimit,
} from "./providers.ts";
import { Settings } from "./settings.ts";
import { CommandRun, TerminalInfo } from "./terminals.ts";
import {
  Attachment,
  LimitStop,
  PendingRequest,
  QueuedMessage,
  ThreadActivity,
  ThreadInfo,
  ThreadStatus,
  ThreadUsage,
  UserAnswers,
  UserQuestion,
} from "./threads.ts";

/** What a harness taking over a thread is told: the `messages` it missed while `from` had it. */
const Handoff = Schema.Struct({
  from: ProviderKind,
  messages: Schema.Number,
  text: Schema.String,
});

/** What happens in the daemon and its threads; every provider adapter normalizes into this shape. */
export const RuntimeEvent = Schema.TaggedUnion({
  /** `requestId` echoes the creating command, so only that window selects the new thread. */
  "thread.created": {
    thread: ThreadInfo,
    requestId: Schema.NullOr(Schema.String),
    /** It starts with a transcript (a fork), for clients to fetch rather than start empty. */
    hasTranscript: Schema.optional(Schema.Boolean),
  },
  "thread.model": {
    threadId: Schema.String,
    provider: ProviderKind,
    model: Schema.NullOr(Schema.String),
  },
  "thread.archived": {
    threadId: Schema.String,
    archivedAt: Schema.NullOr(Schema.Number),
  },
  "thread.status": {
    threadId: Schema.String,
    status: ThreadStatus,
  },
  "thread.shelved": {
    threadId: Schema.String,
    shelved: Schema.Boolean,
  },
  "thread.seen": {
    threadId: Schema.String,
    seenRev: Schema.Number,
  },
  "thread.activity": {
    threadId: Schema.String,
    activity: Schema.NullOr(ThreadActivity),
  },
  "thread.request": {
    threadId: Schema.String,
    request: Schema.NullOr(PendingRequest),
  },
  "thread.queue": {
    threadId: Schema.String,
    queue: Schema.Array(QueuedMessage),
  },
  /** Null once the stop is answered, or a new turn starts. */
  "thread.limitStop": {
    threadId: Schema.String,
    limitStop: Schema.NullOr(LimitStop),
  },
  /** Null answers a `thread.readUsage` that found nothing: the thread never finished a turn, or its log couldn't be read. */
  "thread.usage": {
    threadId: Schema.String,
    usage: Schema.NullOr(ThreadUsage),
  },
  /** Title, activity time, branch or folder changed. */
  "thread.meta": {
    threadId: Schema.String,
    title: Schema.String,
    updatedAt: Schema.Number,
    branch: Schema.NullOr(Schema.String),
    cwd: Schema.String,
    worktree: Schema.Boolean,
  },
  /** The user closed the thread; it is deleted (distinct from its agent process ending). */
  "thread.removed": { threadId: Schema.String },
  "user.message": {
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
    /** Missing on messages stored before attachments existed. */
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
    /** Sent into a running turn rather than starting one; can't be rewound to. */
    steer: Schema.optionalKey(Schema.Boolean),
    /** Sent by a finished command run rather than typed; `text` is what the agent reads. */
    run: Schema.optionalKey(CommandRun),
    /** The harness it went to; missing on messages from before threads could switch harness. */
    provider: Schema.optionalKey(ProviderKind),
    /** What the harness was told ahead of it. */
    handoff: Schema.optionalKey(Handoff),
  },
  "assistant.delta": {
    threadId: Schema.String,
    messageId: Schema.String,
    delta: Schema.String,
  },
  "assistant.completed": {
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
  },
  /** The agent's thinking before or between its replies, as its harness summarizes it. */
  "reasoning.delta": {
    threadId: Schema.String,
    messageId: Schema.String,
    delta: Schema.String,
  },
  "reasoning.completed": {
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
  },
  "tool.started": {
    threadId: Schema.String,
    toolId: Schema.String,
    name: Schema.String,
    summary: Schema.String,
    /** The subagent call (Task/Agent) this one was made inside of. */
    parentToolId: Schema.optional(Schema.String),
  },
  /** How the subagent started by `toolId` is getting on. Live only: never stored. */
  "tool.progress": {
    threadId: Schema.String,
    toolId: Schema.String,
    /** A one-line, present-tense summary of what it's doing now. */
    summary: Schema.optional(Schema.String),
    tokens: Schema.optional(Schema.Number),
    /** Absent where the harness doesn't say (Codex). */
    durationMs: Schema.optional(Schema.Number),
  },
  "tool.completed": {
    threadId: Schema.String,
    toolId: Schema.String,
    output: Schema.String,
    isError: Schema.Boolean,
  },
  "approval.requested": {
    threadId: Schema.String,
    requestId: Schema.String,
    title: Schema.String,
    detail: Schema.String,
    /** The subagent asking, when it isn't the main agent. */
    agent: Schema.optional(Schema.String),
    /** Set when the agent asks questions rather than for permission. */
    questions: Schema.optional(Schema.Array(UserQuestion)),
  },
  "approval.resolved": {
    threadId: Schema.String,
    requestId: Schema.String,
    /** What was answered, for questions; absent when they were skipped. */
    answers: Schema.optional(UserAnswers),
  },
  "turn.completed": {
    threadId: Schema.String,
    durationMs: Schema.NullOr(Schema.Number),
  },
  /** What the turn started by `messageId` changed on disk, from the snapshots taken before and after it. */
  "turn.checkpoint": {
    threadId: Schema.String,
    messageId: Schema.String,
    files: Schema.Number,
    additions: Schema.Number,
    deletions: Schema.Number,
  },
  /** The conversation was rewound to before `messageId`: it and everything after it are gone. */
  "thread.rewound": {
    threadId: Schema.String,
    messageId: Schema.String,
  },
  /** Ends the transcript a fork starts with: where it was forked from. */
  "thread.forked": {
    threadId: Schema.String,
    fromThreadId: Schema.String,
    /** The original's title then, for when it's gone. */
    fromTitle: Schema.String,
  },
  /** Starts the transcript of a thread another thread's agent started. */
  "thread.startedBy": {
    threadId: Schema.String,
    byThreadId: Schema.String,
    /** That thread's title then, for when it's gone. */
    byTitle: Schema.String,
  },
  /** How a new worktree's setup command ended; `stopped` when the user skipped it. */
  "worktree.setup": {
    threadId: Schema.String,
    run: CommandRun,
    stopped: Schema.Boolean,
  },
  /** Slash commands the thread's harness offers; answers `thread.listCommands`. */
  "thread.commands": {
    threadId: Schema.String,
    commands: Schema.Array(SlashCommand),
  },
  /** Skills `provider` loads in the folder at `path`; answers `skills.list`, again when a refresh finds changes. */
  "skills.listed": {
    provider: ProviderKind,
    path: Schema.String,
    skills: Schema.Array(Skill),
    error: Schema.NullOr(Schema.String),
  },
  /** The changes of one turn (see `turn.checkpoint`); answers `checkpoint.diff`. */
  "checkpoint.diff": {
    threadId: Schema.String,
    messageId: Schema.String,
    patch: Schema.String,
    truncated: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  },
  error: {
    threadId: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
  "settings.updated": { settings: Settings },
  "project.added": { project: Project },
  "project.removed": { projectId: Schema.String },
  "providers.updated": { providers: Schema.Array(ProviderStatus) },
  /** Local branches of the repo at `path`; `error` is set when a checkout failed. */
  "git.branches": {
    path: Schema.String,
    current: Schema.NullOr(Schema.String),
    branches: Schema.Array(Schema.String),
    error: Schema.NullOr(Schema.String),
  },
  /** Files in the repo at `path`, relative to it, for `@` mentions. */
  "git.files": {
    path: Schema.String,
    files: Schema.Array(Schema.String),
  },
  /** Uncommitted changes (vs HEAD, untracked files included) in the repo at `path`, as one unified patch. */
  "git.diff": {
    path: Schema.String,
    patch: Schema.String,
    /** Some files were left out to keep the patch small. */
    truncated: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  },
  /** Working-tree and upstream state of the repo at `path`; `action` names the commit/push this answers, if any. */
  "git.status": {
    path: Schema.String,
    status: Schema.NullOr(RepoStatus),
    action: Schema.NullOr(GitAction),
    error: Schema.NullOr(Schema.String),
  },
  "auth.flow": { flow: AuthFlow },
  /** A subscription's rate limits; answers `provider.readLimits`. Empty with no error when the login has none (API keys). */
  "provider.limits": {
    provider: ProviderKind,
    limits: Schema.Array(UsageLimit),
    error: Schema.NullOr(Schema.String),
  },
  "sourceControl.updated": { statuses: Schema.Array(SourceControlStatus) },
  "terminal.opened": TerminalInfo.fields,
  "terminal.closed": {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
  /** The simulator the thread's Simulator panel shows; null when it shows none. */
  "thread.device": {
    threadId: Schema.String,
    deviceId: Schema.NullOr(Schema.String),
  },
});

export type RuntimeEvent = typeof RuntimeEvent.Type;

/** A stored event with its id: ids only grow, so they work as a resume cursor across restarts. */
export const StoredEvent = Schema.Struct({
  id: Schema.Number,
  event: RuntimeEvent,
});

export type StoredEvent = typeof StoredEvent.Type;

const TRANSCRIPT_TAGS = [
  "user.message",
  "assistant.delta",
  "assistant.completed",
  "reasoning.delta",
  "reasoning.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "turn.completed",
  "turn.checkpoint",
  "thread.rewound",
  "thread.forked",
  "thread.startedBy",
  "worktree.setup",
] as const;

/**
 * Transcript events, and errors of a thread: they only reach clients subscribed to that thread.
 * Everything else (thread list, status, settings, projects…) goes to every client.
 */
export function isTranscriptEvent(
  event: RuntimeEvent,
): event is
  | Extract<RuntimeEvent, { _tag: (typeof TRANSCRIPT_TAGS)[number] }>
  | (typeof RuntimeEvent.cases.error.Type & { readonly threadId: string }) {
  return (
    RuntimeEvent.isAnyOf(TRANSCRIPT_TAGS)(event) ||
    (RuntimeEvent.guards.error(event) && event.threadId !== null)
  );
}
