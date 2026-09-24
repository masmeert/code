import * as Schema from "effect/Schema";

export const DEFAULT_DAEMON_PORT = 47821;

export const ProviderKind = Schema.Literals(["claude", "codex"]);
export type ProviderKind = typeof ProviderKind.Type;

export const ThreadStatus = Schema.Literals(["idle", "running", "awaiting-approval", "error", "closed"]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ApprovalDecision = Schema.Literals(["allow", "allow-session", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;

/** Reasoning effort. Each harness takes a subset: Claude low…max, Codex minimal…xhigh. */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/** How much the agent may do without asking. */
export const PermissionLevel = Schema.Literals(["ask", "auto-edit", "full-access"]);
export type PermissionLevel = typeof PermissionLevel.Type;

/** A file for the next message: a path on disk, or bytes pasted into the composer (base64). */
export const AttachmentInput = Schema.Union([
  Schema.TaggedStruct("path", { path: Schema.String }),
  Schema.TaggedStruct("data", { name: Schema.String, mediaType: Schema.String, data: Schema.String }),
]);
export type AttachmentInput = typeof AttachmentInput.Type;

/** An attachment as sent; pasted data has been written to disk by then. */
export const Attachment = Schema.Struct({ name: Schema.String, path: Schema.String, isImage: Schema.Boolean });
export type Attachment = typeof Attachment.Type;

/** Per-message settings chosen in the composer. */
export const TurnOptions = Schema.Struct({
  /** Null uses the harness's default effort. */
  effort: Schema.NullOr(Effort),
  permission: PermissionLevel,
  attachments: Schema.Array(AttachmentInput),
});
export type TurnOptions = typeof TurnOptions.Type;

export const ProviderSettings = Schema.Struct({
  /** Model for new threads; null uses the harness's own default. */
  defaultModel: Schema.NullOr(Schema.String),
});
export type ProviderSettings = typeof ProviderSettings.Type;

export const Settings = Schema.Struct({
  theme: Theme,
  /** Harness preselected in new chats; follows the last one used. */
  lastProvider: ProviderKind,
  providers: Schema.Struct({ claude: ProviderSettings, codex: ProviderSettings }),
  /** Minutes a finished, seen thread stays in Active before it settles. Optional so older settings files still load. */
  settleDelayMinutes: Schema.optional(Schema.Number),
});
export type Settings = typeof Settings.Type;
export const DEFAULT_SETTLE_DELAY_MINUTES = 5;
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  lastProvider: "claude",
  providers: { claude: { defaultModel: null }, codex: { defaultModel: null } },
};

export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The harness's own default pick, marked with a star in pickers. */
  recommended: Schema.optional(Schema.Boolean),
  /** Effort the harness uses for this model when none is picked; absent if it takes none or didn't say. */
  defaultEffort: Schema.optional(Effort),
});
export type ModelOption = typeof ModelOption.Type;

/** What the daemon knows about one harness CLI on this machine. */
export const ProviderStatus = Schema.Struct({
  kind: ProviderKind,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  linked: Schema.Boolean,
  /** Signed-in identity, usually an email. */
  account: Schema.NullOr(Schema.String),
  /** Subscription tier as the CLI reports it, e.g. "max", "plus". */
  plan: Schema.NullOr(Schema.String),
  models: Schema.Array(ModelOption),
  error: Schema.NullOr(Schema.String),
});
export type ProviderStatus = typeof ProviderStatus.Type;

/** Progress of an interactive sign-in started from Settings. */
export const AuthFlow = Schema.Struct({
  provider: ProviderKind,
  stage: Schema.Literals(["starting", "browser", "awaiting-code", "done", "failed"]),
  url: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type AuthFlow = typeof AuthFlow.Type;

export const Project = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  addedAt: Schema.Number,
});
export type Project = typeof Project.Type;

export const ThreadInfo = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  provider: ProviderKind,
  /** Null uses the harness's default model. */
  model: Schema.NullOr(Schema.String),
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
});
export type ThreadInfo = typeof ThreadInfo.Type;

// ---------------------------------------------------------------------------
// Runtime events: every provider adapter normalizes into this shape.
// ---------------------------------------------------------------------------

export const RuntimeEvent = Schema.Union([
  /** `requestId` echoes the creating command, so only that window selects the new thread. */
  Schema.TaggedStruct("thread.created", { thread: ThreadInfo, requestId: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("thread.model", { threadId: Schema.String, model: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("thread.archived", { threadId: Schema.String, archivedAt: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct("thread.status", { threadId: Schema.String, status: ThreadStatus }),
  /** Title, activity time or branch changed. */
  Schema.TaggedStruct("thread.meta", {
    threadId: Schema.String,
    title: Schema.String,
    updatedAt: Schema.Number,
    branch: Schema.NullOr(Schema.String),
  }),
  /** The user closed the thread; it is deleted (distinct from its agent process ending). */
  Schema.TaggedStruct("thread.removed", { threadId: Schema.String }),
  Schema.TaggedStruct("user.message", {
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
    /** Missing on messages stored before attachments existed. */
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
  }),
  Schema.TaggedStruct("assistant.delta", { threadId: Schema.String, messageId: Schema.String, delta: Schema.String }),
  Schema.TaggedStruct("assistant.completed", { threadId: Schema.String, messageId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("tool.started", {
    threadId: Schema.String,
    toolId: Schema.String,
    name: Schema.String,
    summary: Schema.String,
  }),
  Schema.TaggedStruct("tool.completed", {
    threadId: Schema.String,
    toolId: Schema.String,
    output: Schema.String,
    isError: Schema.Boolean,
  }),
  Schema.TaggedStruct("approval.requested", {
    threadId: Schema.String,
    requestId: Schema.String,
    title: Schema.String,
    detail: Schema.String,
  }),
  Schema.TaggedStruct("approval.resolved", { threadId: Schema.String, requestId: Schema.String }),
  Schema.TaggedStruct("turn.completed", { threadId: Schema.String, durationMs: Schema.NullOr(Schema.Number) }),
  Schema.TaggedStruct("error", { threadId: Schema.NullOr(Schema.String), message: Schema.String }),
  Schema.TaggedStruct("settings.updated", { settings: Settings }),
  Schema.TaggedStruct("project.added", { project: Project }),
  Schema.TaggedStruct("project.removed", { projectId: Schema.String }),
  Schema.TaggedStruct("providers.updated", { providers: Schema.Array(ProviderStatus) }),
  /** Local branches of the repo at `path`; `error` is set when a checkout failed. */
  Schema.TaggedStruct("git.branches", {
    path: Schema.String,
    current: Schema.NullOr(Schema.String),
    branches: Schema.Array(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
  /** Uncommitted changes (vs HEAD, untracked files included) in the repo at `path`, as one unified patch. */
  Schema.TaggedStruct("git.diff", {
    path: Schema.String,
    patch: Schema.String,
    /** Some files were left out to keep the patch small. */
    truncated: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("auth.flow", { flow: AuthFlow }),
]);
export type RuntimeEvent = typeof RuntimeEvent.Type;

/** Distributive Omit over the event union (drops `threadId` so adapters stay thread-agnostic). */
export type ProviderEvent = RuntimeEvent extends infer E ? (E extends { threadId: unknown } ? Omit<E, "threadId"> : never) : never;

// ---------------------------------------------------------------------------
// Client -> daemon commands
// ---------------------------------------------------------------------------

export const ClientCommand = Schema.Union([
  /** Creates a thread and sends its first message (drafts only exist client-side until then). */
  Schema.TaggedStruct("thread.create", {
    /** Project folder; registered as a project if it isn't one yet. */
    path: Schema.String,
    provider: ProviderKind,
    model: Schema.NullOr(Schema.String),
    text: Schema.String,
    options: TurnOptions,
    requestId: Schema.String,
  }),
  Schema.TaggedStruct("thread.setModel", { threadId: Schema.String, model: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("project.add", { path: Schema.String }),
  Schema.TaggedStruct("thread.send", { threadId: Schema.String, text: Schema.String, options: TurnOptions }),
  /** Answered with a `git.branches` event. */
  Schema.TaggedStruct("git.listBranches", { path: Schema.String }),
  /** Answered with a `git.diff` event. */
  Schema.TaggedStruct("git.diff", { path: Schema.String }),
  Schema.TaggedStruct("git.checkout", { path: Schema.String, branch: Schema.String }),
  /** Creates a branch from HEAD and switches to it. */
  Schema.TaggedStruct("git.createBranch", { path: Schema.String, branch: Schema.String }),
  Schema.TaggedStruct("thread.interrupt", { threadId: Schema.String }),
  Schema.TaggedStruct("thread.close", { threadId: Schema.String }),
  /** Archiving also stops the thread's agent process; it resumes on the next message. */
  Schema.TaggedStruct("thread.archive", { threadId: Schema.String, archived: Schema.Boolean }),
  Schema.TaggedStruct("approval.respond", {
    threadId: Schema.String,
    requestId: Schema.String,
    decision: ApprovalDecision,
  }),
  Schema.TaggedStruct("settings.update", { settings: Settings }),
  Schema.TaggedStruct("project.remove", { projectId: Schema.String }),
  Schema.TaggedStruct("providers.refresh", {}),
  Schema.TaggedStruct("provider.link", { provider: ProviderKind }),
  /** Claude's sign-in ends on a page showing a code to paste back. */
  Schema.TaggedStruct("provider.linkCode", { provider: ProviderKind, code: Schema.String }),
  Schema.TaggedStruct("provider.linkCancel", { provider: ProviderKind }),
  Schema.TaggedStruct("provider.unlink", { provider: ProviderKind }),
]);
export type ClientCommand = typeof ClientCommand.Type;

// ---------------------------------------------------------------------------
// Daemon -> client frames
// ---------------------------------------------------------------------------

export const ServerFrame = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    settings: Settings,
    projects: Schema.Array(Project),
    providers: Schema.Array(ProviderStatus),
    threads: Schema.Array(ThreadInfo),
    events: Schema.Array(RuntimeEvent),
  }),
  Schema.TaggedStruct("event", { seq: Schema.Number, event: RuntimeEvent }),
]);
export type ServerFrame = typeof ServerFrame.Type;
