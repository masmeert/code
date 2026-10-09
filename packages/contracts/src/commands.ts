import * as Schema from "effect/Schema";
import { BrowserResult } from "./browser.ts";
import { MergeMethod } from "./git.ts";
import { ProjectConfig } from "./projects.ts";
import { ProviderKind } from "./providers.ts";
import { Settings } from "./settings.ts";
import {
  ApprovalDecision,
  PermissionLevel,
  TurnOptions,
  UserAnswers,
  Workspace,
} from "./threads.ts";

const TerminalColumns = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));

const TerminalRows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

/** What a client asks the daemon to do. */
export const ClientCommand = Schema.TaggedUnion({
  /** Creates a thread and sends its first message (drafts only exist client-side until then). */
  "thread.create": {
    /** Project folder; registered as a project if it isn't one yet. */
    path: Schema.String,
    provider: ProviderKind,
    model: Schema.NullOr(Schema.String),
    text: Schema.String,
    options: TurnOptions,
    requestId: Schema.String,
    workspace: Workspace,
  },
  /** A model of another harness switches the thread to it, when no turn is running. */
  "thread.setModel": {
    threadId: Schema.String,
    provider: Schema.optional(ProviderKind),
    model: Schema.NullOr(Schema.String),
  },
  "project.add": { path: Schema.String },
  /** Adds every git repo directly inside `path` as a project. */
  "project.scan": { path: Schema.String },
  /** Answered with a `folder.entries` frame. `~` is the daemon's home. */
  "folder.list": {
    path: Schema.String,
    requestId: Schema.String,
  },
  /** Reads the `masscode.toml` in the project folder `path`; answered with `project.config`. */
  "project.config": {
    path: Schema.String,
    requestId: Schema.String,
  },
  /** Writes `config` as the `masscode.toml` in the project folder `path`; answered with `project.configSaved`. */
  "project.saveConfig": {
    path: Schema.String,
    config: ProjectConfig,
    requestId: Schema.String,
  },
  /** Answered with an `image.signed` frame. `path` is relative to `cwd`; `~` is the daemon's home. */
  "image.sign": {
    path: Schema.String,
    cwd: Schema.String,
    requestId: Schema.String,
  },
  /** Clones into a new folder under `parent` and adds it as a project; answered with a `project.cloned` frame. */
  "project.clone": {
    url: Schema.String,
    parent: Schema.String,
    /** The folder inside the repo to add as the project, like "apps/web"; the top when left out. */
    folder: Schema.optional(Schema.String),
    /** What to call the clone's folder; the repo's name when left out. */
    name: Schema.optional(Schema.String),
    requestId: Schema.String,
  },
  /** Starts a turn; while one is running, the message goes into it instead (steering), or waits with `queue`. */
  "thread.send": {
    threadId: Schema.String,
    text: Schema.String,
    options: TurnOptions,
    /** While a turn runs, hold the message until the agent's next tool call ends or the turn does. */
    queue: Schema.optional(Schema.Boolean),
    /** Our id for the message: sending it again is a no-op, so retries are safe. */
    messageId: Schema.optional(Schema.String),
  },
  /** Sends a queued message right away: into the running turn, or as a new one. */
  "thread.sendQueued": {
    threadId: Schema.String,
    messageId: Schema.String,
  },
  /** Takes queued messages back out, e.g. to edit them in the composer. */
  "thread.unqueue": {
    threadId: Schema.String,
    messageIds: Schema.Array(Schema.String),
  },
  /** Summarizes the conversation so far to free up context. */
  "thread.compact": { threadId: Schema.String },
  /** Answered with a `thread.commands` event. */
  "thread.listCommands": { threadId: Schema.String },
  /** Answered with a `skills.listed` event. */
  "skills.list": {
    provider: ProviderKind,
    path: Schema.String,
  },
  /** Reads the usage of a thread that ran before usage was recorded; answered with a `thread.usage` event. */
  "thread.readUsage": { threadId: Schema.String },
  /** Answered with a `checkpoint.diff` event. */
  "checkpoint.diff": {
    threadId: Schema.String,
    messageId: Schema.String,
  },
  /** Full-text search over messages; answered with a `search.results` frame. */
  search: {
    query: Schema.String,
    requestId: Schema.String,
  },
  /** Answered with a `git.branches` event. */
  "git.listBranches": { path: Schema.String },
  /** Answered with a `git.files` event. */
  "git.listFiles": { path: Schema.String },
  /** Answered with a `git.diff` event. */
  "git.diff": { path: Schema.String },
  "git.checkout": {
    path: Schema.String,
    branch: Schema.String,
  },
  /** Creates a branch from HEAD and switches to it. */
  "git.createBranch": {
    path: Schema.String,
    branch: Schema.String,
  },
  /** Answered with a `git.status` event. */
  "git.status": { path: Schema.String },
  /** Stages everything and commits it, then pushes if `push`; answered with a `git.status` event. An empty `message` is written by the commit model. */
  "git.commit": {
    path: Schema.String,
    message: Schema.String,
    push: Schema.Boolean,
  },
  /** Answered with a `git.status` event. */
  "git.push": { path: Schema.String },
  /** Pushes if needed, writes the title and body with the commit model, and opens it; answered with a `git.status` event. */
  "git.createPullRequest": { path: Schema.String },
  /** Merges the branch's open pull request on its host; answered with a `git.status` event. */
  "git.mergePullRequest": {
    path: Schema.String,
    method: MergeMethod,
  },
  /** Merges a worktree's branch into its base branch locally; answered with a `git.status` event. */
  "git.mergeIntoBase": { path: Schema.String },
  /** Answered with a `sourceControl.updated` event. */
  "sourceControl.refresh": {},
  /**
   * Continues a thread a usage limit stopped, on `provider` when given (switching the thread to
   * it): its next queued message goes out, else one asking the agent to carry on.
   */
  "thread.resumeAfterLimit": {
    threadId: Schema.String,
    options: TurnOptions,
    provider: Schema.optional(ProviderKind),
  },
  /** Does the same by itself once the limit resets; null options call that off. */
  "thread.resumeAtReset": {
    threadId: Schema.String,
    options: Schema.NullOr(TurnOptions),
  },
  /** Puts a usage-limit stop away without continuing. */
  "thread.dismissLimitStop": { threadId: Schema.String },
  /**
   * Rewinds the conversation to before user message `messageId`. With `restoreFiles`, the
   * thread's folder also goes back to how it was when that message was sent.
   */
  "thread.rewind": {
    threadId: Schema.String,
    messageId: Schema.String,
    restoreFiles: Schema.Boolean,
  },
  /**
   * Starts a new thread with the conversation through the turn of message `messageId`;
   * the original stays as it is. Both work in the same folder.
   */
  "thread.fork": {
    threadId: Schema.String,
    messageId: Schema.String,
    requestId: Schema.String,
  },
  /**
   * Asks a read-only side question (BTW) in side chat `sideChatId`; the first one starts it on a
   * copy of the conversation through the turn of message `messageId`. Its events carry
   * `sideChatId` as their `threadId`, reach only the connection that asked, and are never stored:
   * closing it, or that connection going away, ends it for good.
   */
  "sideChat.ask": {
    threadId: Schema.String,
    messageId: Schema.String,
    sideChatId: Schema.String,
    text: Schema.String,
  },
  "sideChat.close": {
    threadId: Schema.String,
    sideChatId: Schema.String,
  },
  "browser.host": {},
  "browser.respond": {
    requestId: Schema.String,
    result: Schema.NullOr(BrowserResult),
    error: Schema.NullOr(Schema.String),
  },
  /** Answered with a `device.listed` frame. `install` first sets up the simulator tools when they're missing. */
  "device.list": {
    requestId: Schema.String,
    install: Schema.Boolean,
  },
  /** Boots the simulator if needed and shows it in the thread's panel; null shows none. Answered with `device.attached`. */
  "device.attach": {
    requestId: Schema.String,
    threadId: Schema.String,
    deviceId: Schema.NullOr(Schema.String),
  },
  "thread.interrupt": { threadId: Schema.String },
  /** Stops one subagent, the one started by tool call `toolId`; the turn carries on without it. */
  "thread.stopAgent": {
    threadId: Schema.String,
    toolId: Schema.String,
  },
  "thread.close": { threadId: Schema.String },
  /** Archiving also stops the thread's agent process; it resumes on the next message. */
  "thread.archive": {
    threadId: Schema.String,
    archived: Schema.Boolean,
  },
  /** You looked at the thread as of its `updatedAt` `rev`. */
  "thread.seen": {
    threadId: Schema.String,
    rev: Schema.Number,
  },
  /** Answered with a `thread.meta` event; a blank title is ignored. */
  "thread.rename": {
    threadId: Schema.String,
    title: Schema.String,
  },
  /** Shelve/Unshelve from the thread menu; holds until the thread's next turn starts. */
  "thread.shelve": {
    threadId: Schema.String,
    shelved: Schema.Boolean,
  },
  /** Questions are answered with "allow" and `answers`, and skipped with "deny". */
  "approval.respond": {
    threadId: Schema.String,
    requestId: Schema.String,
    decision: ApprovalDecision,
    /** Approving a plan: the level to build it with; auto-edit when left out. */
    permission: Schema.optional(PermissionLevel),
    answers: Schema.optional(UserAnswers),
  },
  "settings.update": { settings: Settings },
  "project.remove": { projectId: Schema.String },
  "providers.refresh": {},
  "provider.link": { provider: ProviderKind },
  /** Claude's sign-in ends on a page showing a code to paste back. */
  "provider.linkCode": {
    provider: ProviderKind,
    code: Schema.String,
  },
  "provider.linkCancel": { provider: ProviderKind },
  "provider.unlink": { provider: ProviderKind },
  /** Answered with a `provider.limits` event. */
  "provider.readLimits": { provider: ProviderKind },
  /**
   * Start receiving a thread's transcript. With `after` (the last event id this client
   * has), only what it missed is replayed; otherwise the latest `turnLimit` turns arrive
   * as a `thread.snapshot`. Answered with `thread.snapshot` or `thread.replay`.
   */
  "thread.subscribe": {
    threadId: Schema.String,
    after: Schema.NullOr(Schema.Number),
    turnLimit: Schema.Number,
  },
  "thread.unsubscribe": { threadId: Schema.String },
  /** Older turns, before event id `before`. Answered with `thread.page`. */
  "thread.loadOlder": {
    threadId: Schema.String,
    before: Schema.Number,
    turnLimit: Schema.Number,
  },
  "terminal.open": {
    threadId: Schema.String,
    terminalId: Schema.String,
    columns: TerminalColumns,
    rows: TerminalRows,
    /** Typed into the shell when this starts one, like a script's command; ignored when the shell is already running. */
    input: Schema.optionalKey(Schema.String),
  },
  /**
   * Runs one command in the thread's folder, in a terminal of its own. When it exits, what it
   * printed goes to the agent as the next message; closing the terminal first cancels that.
   */
  "terminal.run": {
    threadId: Schema.String,
    terminalId: Schema.String,
    command: Schema.String,
    columns: TerminalColumns,
    rows: TerminalRows,
    options: TurnOptions,
  },
  "terminal.detach": {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
  "terminal.write": {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  },
  "terminal.resize": {
    threadId: Schema.String,
    terminalId: Schema.String,
    columns: TerminalColumns,
    rows: TerminalRows,
  },
  "terminal.acknowledge": {
    threadId: Schema.String,
    terminalId: Schema.String,
    characters: Schema.Number,
  },
  "terminal.close": {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
});

export type ClientCommand = typeof ClientCommand.Type;
