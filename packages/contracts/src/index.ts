import * as Schema from "effect/Schema";

export const DEFAULT_DAEMON_PORT = 47821;

export const ProviderKind = Schema.Literals(["claude", "codex"]);
export type ProviderKind = typeof ProviderKind.Type;

export const ThreadStatus = Schema.Literals([
  "idle",
  "running",
  "awaiting-approval",
  "error",
  "closed",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ApprovalDecision = Schema.Literals(["allow", "allow-session", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;

export const BROWSER_PARTITION = "persist:apcode-browser";

export const BrowserAction = Schema.Union([
  Schema.TaggedStruct("navigate", { url: Schema.String }),
  Schema.TaggedStruct("status", {}),
  Schema.TaggedStruct("snapshot", {}),
  Schema.TaggedStruct("click", { target: Schema.String }),
  Schema.TaggedStruct("type", {
    target: Schema.String,
    text: Schema.String,
    submit: Schema.Boolean,
  }),
  Schema.TaggedStruct("press", { key: Schema.String }),
  Schema.TaggedStruct("evaluate", { expression: Schema.String }),
  Schema.TaggedStruct("console", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type BrowserAction = typeof BrowserAction.Type;

export const BrowserResult = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  text: Schema.String,
  screenshot: Schema.NullOr(Schema.String),
});
export type BrowserResult = typeof BrowserResult.Type;

export const DesktopBrowserEvent = Schema.TaggedUnion({
  "open-tab": { webContentsId: Schema.Number, url: Schema.String },
  "new-tab": { webContentsId: Schema.Number },
  "close-tab": { webContentsId: Schema.Number },
  "focus-address": { webContentsId: Schema.Number },
});
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const UpdateStatus = Schema.TaggedUnion({
  idle: {},
  checking: {},
  "up-to-date": {},
  downloading: { version: Schema.String, percent: Schema.Number },
  ready: { version: Schema.String },
  failed: { message: Schema.String },
});
export type UpdateStatus = typeof UpdateStatus.Type;

export interface DesktopBridge {
  /** Null in dev, where the daemon runs on its own at DEFAULT_DAEMON_PORT without a token. */
  readonly daemon: () => Promise<{ readonly port: number; readonly token: string } | null>;
  readonly pickFolder: (title: string, defaultPath?: string) => Promise<string | null>;
  readonly pickFiles: (title: string) => Promise<ReadonlyArray<string>>;
  readonly setTheme: (theme: Theme) => Promise<void>;
  readonly onFileDrop: (listener: (paths: ReadonlyArray<string>) => void) => () => void;
  readonly onBrowserEvent: (listener: (event: DesktopBrowserEvent) => void) => () => void;
  readonly automateBrowser: (
    webContentsId: number,
    action: BrowserAction,
  ) => Promise<BrowserResult>;
  readonly appVersion: () => Promise<string>;
  readonly updateStatus: () => Promise<UpdateStatus>;
  readonly onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
  readonly checkForUpdates: () => Promise<void>;
  readonly installUpdate: () => Promise<void>;
  /** A system notification about a thread, shown only while no APCode window is focused. */
  readonly notify: (notification: {
    readonly threadId: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
  /** The number on the dock icon; 0 clears it. */
  readonly setBadgeCount: (count: number) => Promise<void>;
  /** A notification about the thread was clicked in this window. */
  readonly onOpenThread: (listener: (threadId: string) => void) => () => void;
}

/** Reasoning effort. Each harness takes a subset: Claude low…max, Codex minimal…xhigh. */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/** How much the agent may do without asking. */
export const PermissionLevel = Schema.Literals(["plan", "ask", "auto-edit", "auto", "full-access"]);
export type PermissionLevel = typeof PermissionLevel.Type;

/** A file for the next message: a path on disk, or bytes pasted into the composer (base64). */
export const AttachmentInput = Schema.Union([
  Schema.TaggedStruct("path", { path: Schema.String }),
  Schema.TaggedStruct("data", {
    name: Schema.String,
    mediaType: Schema.String,
    data: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type AttachmentInput = typeof AttachmentInput.Type;

/** An attachment as sent; pasted data has been written to disk by then. */
export const Attachment = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  isImage: Schema.Boolean,
});
export type Attachment = typeof Attachment.Type;

/** Per-message settings chosen in the composer. */
export const TurnOptions = Schema.Struct({
  /** Null uses the harness's default effort. */
  effort: Schema.NullOr(Effort),
  permission: PermissionLevel,
  attachments: Schema.Array(AttachmentInput),
});
export type TurnOptions = typeof TurnOptions.Type;

/** Tint a harness wears in the app; "brand" keeps its own colours. */
export const HarnessColor = Schema.Literals([
  "brand",
  "orange",
  "amber",
  "emerald",
  "sky",
  "violet",
  "pink",
]);
export type HarnessColor = typeof HarnessColor.Type;

export const MergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeMethod = typeof MergeMethod.Type;

/** How commit messages and pull requests get written: like the repo's history, as Conventional Commits, or by the user's own rules. */
export const WritingStyle = Schema.Literals(["repo_conventions", "conventional_commits", "custom"]);
export type WritingStyle = typeof WritingStyle.Type;

export const ProviderSettings = Schema.Struct({
  /** Model for new threads; null uses the harness's own default. */
  defaultModel: Schema.NullOr(Schema.String),
  /** Shown in place of the harness's own name. The fields below are optional so older settings files still load. */
  displayName: Schema.optional(Schema.String),
  color: Schema.optional(HarnessColor),
  /** CLI to run instead of the one found on PATH. */
  binaryPath: Schema.optional(Schema.String),
  /** CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex. */
  configDir: Schema.optional(Schema.String),
  launchArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Model ids in picker order; models missing from it follow in the harness's own order. */
  modelOrder: Schema.optional(Schema.Array(Schema.String)),
  hiddenModels: Schema.optional(Schema.Array(Schema.String)),
  favoriteModels: Schema.optional(Schema.Array(Schema.String)),
});
export type ProviderSettings = typeof ProviderSettings.Type;

export const Settings = Schema.Struct({
  theme: Theme,
  /** Harness preselected in new chats; follows the last one used. */
  lastProvider: ProviderKind,
  providers: Schema.Struct({ claude: ProviderSettings, codex: ProviderSettings }),
  /** Minutes a finished, seen thread stays in Active before it settles. Optional so older settings files still load. */
  settleDelayMinutes: Schema.optional(Schema.Number),
  /** A message sent while the agent works: held until the turn ends ("queue"), or sent into it right away ("steer"). */
  followUp: Schema.optional(Schema.Literals(["queue", "steer"])),
  /** Model new threads start with, as `provider:model`; null/absent follows the last harness used. */
  newThreadModel: Schema.optional(Schema.NullOr(Schema.String)),
  /** Effort new threads start with; null/absent uses the model's own. */
  newThreadEffort: Schema.optional(Schema.NullOr(Effort)),
  newThreadPermission: Schema.optional(PermissionLevel),
  /** Where new threads start: the project folder, or a git worktree of their own. */
  workspace: Schema.optional(Schema.Literals(["local", "worktree"])),
  /** Settles threads with no activity for `autoSettleDays`, read or not. */
  autoSettle: Schema.optional(Schema.Boolean),
  autoSettleDays: Schema.optional(Schema.Number),
  diffLayout: Schema.optional(Schema.Literals(["unified", "split"])),
  /** New worktrees branch from origin's copy of the current branch (fetched first) instead of the local one. */
  worktreeFromOrigin: Schema.optional(Schema.Boolean),
  /** Folder the Add Project picker opens in; absent opens the home folder. */
  addProjectFolder: Schema.optional(Schema.String),
  confirmArchive: Schema.optional(Schema.Boolean),
  confirmDelete: Schema.optional(Schema.Boolean),
  /** Writes commit messages left empty and pull request text, as `provider:model`; null/absent uses the last harness's default model. */
  commitModel: Schema.optional(Schema.NullOr(Schema.String)),
  /** Fast-forwards a checkout on its default branch when it has no changes or commits of its own. */
  autoPull: Schema.optional(Schema.Boolean),
  /** Method pull requests merge with first; null/absent reuses the last one picked on this device. */
  mergeMethod: Schema.optional(Schema.NullOr(MergeMethod)),
  writingStyle: Schema.optional(WritingStyle),
  /** Used when `writingStyle` is "custom". */
  writingInstructions: Schema.optional(Schema.String),
  /** Pull request bodies follow the repo's template when it has one. Absent counts as on. */
  followTemplates: Schema.optional(Schema.Boolean),
  /** System notifications when a thread finishes or needs you, while APCode is in the background. Absent counts as on. */
  notifications: Schema.optional(Schema.Boolean),
});
export type Settings = typeof Settings.Type;
export const DEFAULT_SETTLE_DELAY_MINUTES = 15;
export const DEFAULT_AUTO_SETTLE_DAYS = 7;
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
  /** Not checked yet, so nothing above is known: the first check after launch is still running. */
  checking: Schema.optional(Schema.Boolean),
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

/** One window of a subscription's rate limit, e.g. the 5-hour one. */
export const UsageLimit = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  /** Epoch ms; null when the window hasn't started. */
  resetsAt: Schema.NullOr(Schema.Number),
});
export type UsageLimit = typeof UsageLimit.Type;

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
  /** `cwd` is a git worktree made for this thread (removed with it when it has no changes). */
  worktree: Schema.Boolean,
  /** Absent until the thread's first turn ends. */
  usage: Schema.optional(ThreadUsage),
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** A slash command the thread's harness offers. */
export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
});
export type SlashCommand = typeof SlashCommand.Type;

/** One message matching a search. */
export const SearchHit = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  from: Schema.Literals(["user", "assistant"]),
  /** Text around the match; the match itself is wrapped in U+E000 / U+E001. */
  snippet: Schema.String,
});
export type SearchHit = typeof SearchHit.Type;

export const TerminalInfo = Schema.Struct({ threadId: Schema.String, terminalId: Schema.String });
export type TerminalInfo = typeof TerminalInfo.Type;

const TerminalColumns = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const TerminalRows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

// ---------------------------------------------------------------------------
// Runtime events: every provider adapter normalizes into this shape.
// ---------------------------------------------------------------------------

export const GitAction = Schema.Literals([
  "commit",
  "commit-push",
  "push",
  "pull-request",
  "merge",
]);
export type GitAction = typeof GitAction.Type;

/** Hosts we can open pull requests on, through their CLIs (gh, glab). */
export const SourceControlKind = Schema.Literals(["github", "gitlab"]);
export type SourceControlKind = typeof SourceControlKind.Type;

/** What the daemon knows about one host's CLI on this machine. */
export const SourceControlStatus = Schema.Struct({
  kind: SourceControlKind,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** Null when sign-in couldn't be checked. */
  authenticated: Schema.NullOr(Schema.Boolean),
  account: Schema.NullOr(Schema.String),
  /** Why it can't be used yet, and how to fix it. */
  detail: Schema.NullOr(Schema.String),
});
export type SourceControlStatus = typeof SourceControlStatus.Type;

/** The pull request (merge request on GitLab) for a branch. */
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  base: Schema.String,
});
export type PullRequest = typeof PullRequest.Type;

export const RepoStatus = Schema.Struct({
  /** Changed files, untracked included. */
  changes: Schema.Number,
  /** Null when detached. */
  branch: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
  /** Commits on the branch that the default branch doesn't have. */
  aheadOfDefault: Schema.Number,
  /** Host of the main remote, when it's one pull requests can be opened on. */
  sourceControl: Schema.NullOr(SourceControlKind),
  /** The branch's open pull request, else its latest one. */
  pullRequest: Schema.NullOr(PullRequest),
  upstream: Schema.NullOr(Schema.String),
  /** Commits not on the upstream yet; with no upstream, every commit on the branch. */
  ahead: Schema.Number,
  behind: Schema.Number,
  hasRemote: Schema.Boolean,
  detached: Schema.Boolean,
});
export type RepoStatus = typeof RepoStatus.Type;

export const RuntimeEvent = Schema.Union([
  /** `requestId` echoes the creating command, so only that window selects the new thread. */
  Schema.TaggedStruct("thread.created", {
    thread: ThreadInfo,
    requestId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("thread.model", {
    threadId: Schema.String,
    model: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("thread.archived", {
    threadId: Schema.String,
    archivedAt: Schema.NullOr(Schema.Number),
  }),
  Schema.TaggedStruct("thread.status", { threadId: Schema.String, status: ThreadStatus }),
  /** Null answers a `thread.readUsage` that found nothing: the thread never finished a turn, or its log couldn't be read. */
  Schema.TaggedStruct("thread.usage", {
    threadId: Schema.String,
    usage: Schema.NullOr(ThreadUsage),
  }),
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
    /** Sent into a running turn rather than starting one; can't be rewound to. */
    steer: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("assistant.delta", {
    threadId: Schema.String,
    messageId: Schema.String,
    delta: Schema.String,
  }),
  Schema.TaggedStruct("assistant.completed", {
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
  }),
  Schema.TaggedStruct("tool.started", {
    threadId: Schema.String,
    toolId: Schema.String,
    name: Schema.String,
    summary: Schema.String,
    /** The subagent call (Task/Agent) this one was made inside of. */
    parentToolId: Schema.optional(Schema.String),
  }),
  /** How the subagent started by `toolId` is getting on. Live only: never stored. */
  Schema.TaggedStruct("tool.progress", {
    threadId: Schema.String,
    toolId: Schema.String,
    /** A one-line, present-tense summary of what it's doing now. */
    summary: Schema.optional(Schema.String),
    tokens: Schema.optional(Schema.Number),
    /** Absent where the harness doesn't say (Codex). */
    durationMs: Schema.optional(Schema.Number),
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
    /** The subagent asking, when it isn't the main agent. */
    agent: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("approval.resolved", { threadId: Schema.String, requestId: Schema.String }),
  Schema.TaggedStruct("turn.completed", {
    threadId: Schema.String,
    durationMs: Schema.NullOr(Schema.Number),
  }),
  /** What the turn started by `messageId` changed on disk, from the snapshots taken before and after it. */
  Schema.TaggedStruct("turn.checkpoint", {
    threadId: Schema.String,
    messageId: Schema.String,
    files: Schema.Number,
    additions: Schema.Number,
    deletions: Schema.Number,
  }),
  /** The conversation was rewound to before `messageId`: it and everything after it are gone. */
  Schema.TaggedStruct("thread.rewound", { threadId: Schema.String, messageId: Schema.String }),
  /** Slash commands the thread's harness offers; answers `thread.listCommands`. */
  Schema.TaggedStruct("thread.commands", {
    threadId: Schema.String,
    commands: Schema.Array(SlashCommand),
  }),
  /** The changes of one turn (see `turn.checkpoint`); answers `checkpoint.diff`. */
  Schema.TaggedStruct("checkpoint.diff", {
    threadId: Schema.String,
    messageId: Schema.String,
    patch: Schema.String,
    truncated: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  }),
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
  /** Files in the repo at `path`, relative to it, for `@` mentions. */
  Schema.TaggedStruct("git.files", { path: Schema.String, files: Schema.Array(Schema.String) }),
  /** Uncommitted changes (vs HEAD, untracked files included) in the repo at `path`, as one unified patch. */
  Schema.TaggedStruct("git.diff", {
    path: Schema.String,
    patch: Schema.String,
    /** Some files were left out to keep the patch small. */
    truncated: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  }),
  /** Working-tree and upstream state of the repo at `path`; `action` names the commit/push this answers, if any. */
  Schema.TaggedStruct("git.status", {
    path: Schema.String,
    status: Schema.NullOr(RepoStatus),
    action: Schema.NullOr(GitAction),
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("auth.flow", { flow: AuthFlow }),
  /** A subscription's rate limits; answers `provider.readLimits`. Empty with no error when the login has none (API keys). */
  Schema.TaggedStruct("provider.limits", {
    provider: ProviderKind,
    limits: Schema.Array(UsageLimit),
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("sourceControl.updated", { statuses: Schema.Array(SourceControlStatus) }),
  Schema.TaggedStruct("terminal.opened", { threadId: Schema.String, terminalId: Schema.String }),
  Schema.TaggedStruct("terminal.closed", { threadId: Schema.String, terminalId: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type RuntimeEvent = typeof RuntimeEvent.Type;

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
    /** "worktree" starts the thread in a new git worktree on its own branch. */
    workspace: Schema.Literals(["local", "worktree"]),
  }),
  Schema.TaggedStruct("thread.setModel", {
    threadId: Schema.String,
    model: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("project.add", { path: Schema.String }),
  /** Starts a turn; while one is running, the message goes into it instead (steering). */
  Schema.TaggedStruct("thread.send", {
    threadId: Schema.String,
    text: Schema.String,
    options: TurnOptions,
  }),
  /**
   * Rewinds the conversation to before user message `messageId`. With `restoreFiles`, the
   * thread's folder also goes back to how it was when that message was sent.
   */
  Schema.TaggedStruct("thread.rewind", {
    threadId: Schema.String,
    messageId: Schema.String,
    restoreFiles: Schema.Boolean,
  }),
  /** Summarizes the conversation so far to free up context. */
  Schema.TaggedStruct("thread.compact", { threadId: Schema.String }),
  /** Answered with a `thread.commands` event. */
  Schema.TaggedStruct("thread.listCommands", { threadId: Schema.String }),
  /** Reads the usage of a thread that ran before usage was recorded; answered with a `thread.usage` event. */
  Schema.TaggedStruct("thread.readUsage", { threadId: Schema.String }),
  /** Answered with a `checkpoint.diff` event. */
  Schema.TaggedStruct("checkpoint.diff", { threadId: Schema.String, messageId: Schema.String }),
  /** Full-text search over messages; answered with a `search.results` frame. */
  Schema.TaggedStruct("search", { query: Schema.String, requestId: Schema.String }),
  /** Answered with a `git.branches` event. */
  Schema.TaggedStruct("git.listBranches", { path: Schema.String }),
  /** Answered with a `git.files` event. */
  Schema.TaggedStruct("git.listFiles", { path: Schema.String }),
  /** Answered with a `git.diff` event. */
  Schema.TaggedStruct("git.diff", { path: Schema.String }),
  Schema.TaggedStruct("git.checkout", { path: Schema.String, branch: Schema.String }),
  /** Creates a branch from HEAD and switches to it. */
  Schema.TaggedStruct("git.createBranch", { path: Schema.String, branch: Schema.String }),
  /** Answered with a `git.status` event. */
  Schema.TaggedStruct("git.status", { path: Schema.String }),
  /** Stages everything and commits it, then pushes if `push`; answered with a `git.status` event. An empty `message` is written by the commit model. */
  Schema.TaggedStruct("git.commit", {
    path: Schema.String,
    message: Schema.String,
    push: Schema.Boolean,
  }),
  /** Answered with a `git.status` event. */
  Schema.TaggedStruct("git.push", { path: Schema.String }),
  /** Pushes if needed, writes the title and body with the commit model, and opens it; answered with a `git.status` event. */
  Schema.TaggedStruct("git.createPullRequest", { path: Schema.String }),
  /** Merges the branch's open pull request on its host; answered with a `git.status` event. */
  Schema.TaggedStruct("git.mergePullRequest", { path: Schema.String, method: MergeMethod }),
  /** Answered with a `sourceControl.updated` event. */
  Schema.TaggedStruct("sourceControl.refresh", {}),
  Schema.TaggedStruct("thread.interrupt", { threadId: Schema.String }),
  /** Stops one subagent, the one started by tool call `toolId`; the turn carries on without it. */
  Schema.TaggedStruct("thread.stopAgent", { threadId: Schema.String, toolId: Schema.String }),
  Schema.TaggedStruct("thread.close", { threadId: Schema.String }),
  /** Archiving also stops the thread's agent process; it resumes on the next message. */
  Schema.TaggedStruct("thread.archive", { threadId: Schema.String, archived: Schema.Boolean }),
  Schema.TaggedStruct("approval.respond", {
    threadId: Schema.String,
    requestId: Schema.String,
    decision: ApprovalDecision,
    /** Approving a plan: the level to build it with; auto-edit when left out. */
    permission: Schema.optional(PermissionLevel),
  }),
  Schema.TaggedStruct("settings.update", { settings: Settings }),
  Schema.TaggedStruct("project.remove", { projectId: Schema.String }),
  Schema.TaggedStruct("providers.refresh", {}),
  Schema.TaggedStruct("provider.link", { provider: ProviderKind }),
  /** Claude's sign-in ends on a page showing a code to paste back. */
  Schema.TaggedStruct("provider.linkCode", { provider: ProviderKind, code: Schema.String }),
  Schema.TaggedStruct("provider.linkCancel", { provider: ProviderKind }),
  Schema.TaggedStruct("provider.unlink", { provider: ProviderKind }),
  /** Answered with a `provider.limits` event. */
  Schema.TaggedStruct("provider.readLimits", { provider: ProviderKind }),
  /**
   * Start receiving a thread's transcript. With `after` (the last event id this client
   * has), only what it missed is replayed; otherwise the latest `turnLimit` turns arrive
   * as a `thread.snapshot`. Answered with `thread.snapshot` or `thread.replay`.
   */
  Schema.TaggedStruct("thread.subscribe", {
    threadId: Schema.String,
    after: Schema.NullOr(Schema.Number),
    turnLimit: Schema.Number,
  }),
  Schema.TaggedStruct("thread.unsubscribe", { threadId: Schema.String }),
  /** Older turns, before event id `before`. Answered with `thread.page`. */
  Schema.TaggedStruct("thread.loadOlder", {
    threadId: Schema.String,
    before: Schema.Number,
    turnLimit: Schema.Number,
  }),
  Schema.TaggedStruct("terminal.open", {
    threadId: Schema.String,
    terminalId: Schema.String,
    columns: TerminalColumns,
    rows: TerminalRows,
  }),
  Schema.TaggedStruct("terminal.detach", { threadId: Schema.String, terminalId: Schema.String }),
  Schema.TaggedStruct("terminal.write", {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  }),
  Schema.TaggedStruct("terminal.resize", {
    threadId: Schema.String,
    terminalId: Schema.String,
    columns: TerminalColumns,
    rows: TerminalRows,
  }),
  Schema.TaggedStruct("terminal.acknowledge", {
    threadId: Schema.String,
    terminalId: Schema.String,
    characters: Schema.Number,
  }),
  Schema.TaggedStruct("terminal.close", { threadId: Schema.String, terminalId: Schema.String }),
  Schema.TaggedStruct("browser.host", {}),
  Schema.TaggedStruct("browser.respond", {
    requestId: Schema.String,
    result: Schema.NullOr(BrowserResult),
    error: Schema.NullOr(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type ClientCommand = typeof ClientCommand.Type;

// ---------------------------------------------------------------------------
// Daemon -> client frames
// ---------------------------------------------------------------------------

/** A stored event with its id: ids only grow, so they work as a resume cursor across restarts. */
export const StoredEvent = Schema.Struct({ id: Schema.Number, event: RuntimeEvent });
export type StoredEvent = typeof StoredEvent.Type;

/** Where a windowed transcript starts: `before` is the first loaded event id, `hasMore` if older ones exist. */
export const PageInfo = Schema.Struct({ before: Schema.Number, hasMore: Schema.Boolean });
export type PageInfo = typeof PageInfo.Type;

/**
 * Transcript events: they only reach clients subscribed to that thread. Everything else
 * (thread list, status, settings, projects…) goes to every client.
 */
export function isTranscriptEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { threadId: string }> {
  return (
    RuntimeEvent.isAnyOf([
      "user.message",
      "assistant.delta",
      "assistant.completed",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "approval.requested",
      "approval.resolved",
      "turn.completed",
      "turn.checkpoint",
      "thread.rewound",
    ])(event) ||
    (RuntimeEvent.guards.error(event) && event.threadId !== null)
  );
}

export const ServerFrame = Schema.Union([
  /**
   * Sent on connect: everything but transcripts, which load per thread. `dataId`
   * identifies the daemon's database, so a client never resumes against another one.
   */
  Schema.TaggedStruct("shell", {
    dataId: Schema.String,
    settings: Settings,
    projects: Schema.Array(Project),
    providers: Schema.Array(ProviderStatus),
    threads: Schema.Array(ThreadInfo),
    terminals: Schema.Array(TerminalInfo),
  }),
  /** A transcript from scratch: the latest turns, plus the text of any message still streaming. */
  Schema.TaggedStruct("thread.snapshot", {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    streaming: Schema.Array(RuntimeEvent),
    /** Id of the newest stored event (the resume cursor); 0 if none. */
    cursor: Schema.Number,
    page: Schema.NullOr(PageInfo),
  }),
  /** What a subscriber missed since its cursor. */
  Schema.TaggedStruct("thread.replay", {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    streaming: Schema.Array(RuntimeEvent),
    cursor: Schema.Number,
  }),
  /** Older turns for "load earlier". */
  Schema.TaggedStruct("thread.page", {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    page: PageInfo,
  }),
  /** Answers a `search` command from this connection. */
  Schema.TaggedStruct("search.results", {
    requestId: Schema.String,
    hits: Schema.Array(SearchHit),
  }),
  /** A live event; `id` is set on stored (transcript) events and advances the thread's cursor. */
  Schema.TaggedStruct("event", { id: Schema.NullOr(Schema.Number), event: RuntimeEvent }),
  Schema.TaggedStruct("terminal.snapshot", {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  }),
  Schema.TaggedStruct("terminal.output", {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  }),
  Schema.TaggedStruct("terminal.error", {
    threadId: Schema.String,
    terminalId: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct("browser.request", {
    requestId: Schema.String,
    threadId: Schema.String,
    action: BrowserAction,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type ServerFrame = typeof ServerFrame.Type;
