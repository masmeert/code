import * as Schema from "effect/Schema";
import { Effort, ProviderKind } from "./providers.ts";

export const ThreadStatus = Schema.Literals([
  "idle",
  "running",
  "awaiting-approval",
  /** The agent asked the user questions and waits for the answers. */
  "awaiting-answer",
  "error",
  "closed",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

/** The agent is stopped on the user: for an approval, or for answers. */
export function isAwaitingUser(status: ThreadStatus) {
  return status === "awaiting-approval" || status === "awaiting-answer";
}

/** A turn is going, whether the agent is working or waiting on the user. */
export function isTurnActive(status: ThreadStatus) {
  return status === "running" || isAwaitingUser(status);
}

export const ApprovalDecision = Schema.Literals(["allow", "allow-session", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** A multiple-choice question from the agent, like Claude's AskUserQuestion. */
export const UserQuestion = Schema.Struct({
  id: Schema.String,
  /** A short label for it, like "Auth method". */
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      /** Markdown to show while the option is looked at: a mockup, a snippet. */
      preview: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.Boolean,
});
export type UserQuestion = typeof UserQuestion.Type;

/** Question id to the chosen option labels, plus any answer typed instead. */
export const UserAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type UserAnswers = typeof UserAnswers.Type;

/** How much the agent may do without asking. */
export const PermissionLevel = Schema.Literals(["plan", "ask", "auto-edit", "auto", "full-access"]);
export type PermissionLevel = typeof PermissionLevel.Type;

/** A file for the next message: a path on disk, or bytes pasted into the composer (base64). */
export const AttachmentInput = Schema.TaggedUnion({
  path: { path: Schema.String },
  data: {
    name: Schema.String,
    mediaType: Schema.String,
    data: Schema.String,
  },
});
export type AttachmentInput = typeof AttachmentInput.Type;

/** An attachment as sent; pasted data has been written to disk by then. */
export const Attachment = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  isImage: Schema.Boolean,
});
export type Attachment = typeof Attachment.Type;

/** How the agent works on a message, as chosen in the composer. */
const TurnSettings = Schema.Struct({
  /** Null uses the harness's default effort. */
  effort: Schema.NullOr(Effort),
  /** Faster output at a higher price, on models that offer it; absent leaves it as it was. */
  fast: Schema.optional(Schema.Boolean),
  permission: PermissionLevel,
});

/** Per-message settings chosen in the composer. */
export const TurnOptions = Schema.Struct({
  ...TurnSettings.fields,
  attachments: Schema.Array(AttachmentInput),
});
export type TurnOptions = typeof TurnOptions.Type;

/** Where a thread starts: the project folder, or a git worktree of its own on a new branch. */
export const Workspace = Schema.Literals(["local", "worktree"]);
export type Workspace = typeof Workspace.Type;

/** How full a thread's context window was after its last response. */
export const ContextUsage = Schema.Struct({
  usedTokens: Schema.Number,
  maxTokens: Schema.Number,
  /**
   * What fills the window, where the harness says (Claude). "free" is what's left, "buffer" is
   * held back for compaction, and "deferred" rows sit outside the window (tool schemas loaded on use).
   */
  categories: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      tokens: Schema.Number,
      kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
    }),
  ),
});
export type ContextUsage = typeof ContextUsage.Type;

export const ThreadUsage = Schema.Struct({
  context: Schema.NullOr(ContextUsage),
  /** What the thread's tokens would have cost at API list prices, subagents included; null when unknown. */
  costUsd: Schema.NullOr(Schema.Number),
});
export type ThreadUsage = typeof ThreadUsage.Type;

/** A turn the harness refused because the plan's usage limit is spent; the thread's queue waits until it's answered. */
export const LimitStop = Schema.Struct({
  provider: ProviderKind,
  /** Epoch ms; null when the harness didn't say. */
  resetsAt: Schema.NullOr(Schema.Number),
  /** What to continue with by itself once the limit resets; null when it won't. */
  resumeAtReset: Schema.NullOr(TurnOptions),
});
export type LimitStop = typeof LimitStop.Type;

/** The tool call a thread's agent has in flight. */
export const ThreadActivity = Schema.Struct({
  toolId: Schema.String,
  tool: Schema.String,
  summary: Schema.String,
});
export type ThreadActivity = typeof ThreadActivity.Type;

/** The permission or questions a thread is waiting on you for. */
export const PendingRequest = Schema.Struct({
  requestId: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  asksQuestions: Schema.Boolean,
});
export type PendingRequest = typeof PendingRequest.Type;

/** A message written while the agent worked, held by the daemon until the turn reaches a point it takes messages at. */
export const QueuedMessage = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  ...TurnSettings.fields,
});
export type QueuedMessage = typeof QueuedMessage.Type;

export const ThreadInfo = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  provider: ProviderKind,
  /** Null uses the harness's default model. */
  model: Schema.NullOr(Schema.String),
  /** Where the agent works: the thread's folder, or a worktree the agent switched into. */
  cwd: Schema.String,
  title: Schema.String,
  status: ThreadStatus,
  createdAt: Schema.Number,
  /** Last message sent or turn finished; drives sidebar order. */
  updatedAt: Schema.Number,
  /** Git branch checked out in `cwd`, null outside a repo. Read live, never stored. */
  branch: Schema.NullOr(Schema.String),
  /** When the thread was archived (hidden from the main list); null when it isn't. */
  archivedAt: Schema.NullOr(Schema.Number),
  /** `cwd` is a git worktree: one made for the thread, or one the agent switched into. */
  worktree: Schema.Boolean,
  /** Absent until the thread's first turn ends. */
  usage: Schema.optional(ThreadUsage),
  /** `updatedAt` as of the last time you looked at the thread; lower means unread. */
  seenRev: Schema.Number,
  /** Idle long enough, or shelved by hand; the daemon decides, so every window agrees. */
  shelved: Schema.Boolean,
  /** Live only, never stored: lets the thread list show progress without subscribing to transcripts. */
  activity: Schema.optional(ThreadActivity),
  /** Live only, never stored: lets the thread list answer approvals without opening the thread. */
  request: Schema.optional(PendingRequest),
  /** The thread whose agent started this one, through MassCode's orchestration tools. */
  startedBy: Schema.optional(Schema.String),
  /** Messages waiting for the running turn; absent when none are. */
  queue: Schema.optional(Schema.Array(QueuedMessage)),
  /** Absent unless the last turn hit a usage limit nobody has answered yet. */
  limitStop: Schema.optional(LimitStop),
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** One message matching a search. */
export const SearchHit = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  from: Schema.Literals(["user", "assistant"]),
  /** Text around the match; the match itself is wrapped in U+E000 / U+E001. */
  snippet: Schema.String,
});
export type SearchHit = typeof SearchHit.Type;

/**
 * Why rewinding a thread's files isn't allowed, or null when it is. Snapshots hold the whole
 * folder, so a restore is only safe in a worktree no other thread works in, around or inside.
 */
export function findFileRestoreBlocker(
  thread: ThreadInfo,
  others: Iterable<ThreadInfo>,
): string | null {
  if (!thread.worktree)
    return "Only threads in their own worktree can restore files. Start the thread in a new worktree to be able to.";
  const { cwd } = thread;
  for (const other of others) {
    if (other.id === thread.id) continue;
    if (cwd === other.cwd || cwd.startsWith(`${other.cwd}/`) || other.cwd.startsWith(`${cwd}/`))
      return `"${other.title}" also works in this folder, so restoring files could undo its work. Delete that thread to restore files here.`;
  }
  return null;
}
