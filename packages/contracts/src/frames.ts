import * as Schema from "effect/Schema";
import { BrowserAction } from "./browser.ts";
import { Device, DeviceHub } from "./devices.ts";
import { RuntimeEvent, StoredEvent } from "./events.ts";
import { Project, ProjectConfig } from "./projects.ts";
import { ProviderStatus } from "./providers.ts";
import { Settings } from "./settings.ts";
import { TerminalInfo } from "./terminals.ts";
import { SearchHit, ThreadInfo } from "./threads.ts";

/** Where a windowed transcript starts: `before` is the first loaded event id, `hasMore` if older ones exist. */
export const PageInfo = Schema.Struct({
  before: Schema.Number,
  hasMore: Schema.Boolean,
});
export type PageInfo = typeof PageInfo.Type;

/** What the daemon sends a client. */
export const ServerFrame = Schema.TaggedUnion({
  /**
   * Sent on connect: everything but transcripts, which load per thread. `dataId`
   * identifies the daemon's database, so a client never resumes against another one.
   */
  shell: {
    dataId: Schema.String,
    settings: Settings,
    projects: Schema.Array(Project),
    providers: Schema.Array(ProviderStatus),
    threads: Schema.Array(ThreadInfo),
    terminals: Schema.Array(TerminalInfo),
    /** The daemon runs as root, so Full access lets agents change anything on its machine. */
    root: Schema.Boolean,
    /** Its `PROTOCOL_VERSION`; missing from daemons older than the check. */
    protocol: Schema.optional(Schema.Number),
  },
  /** A transcript from scratch: the latest turns, plus the text of any message still streaming. */
  "thread.snapshot": {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    streaming: Schema.Array(RuntimeEvent),
    /** Id of the newest stored event (the resume cursor); 0 if none. */
    cursor: Schema.Number,
    page: Schema.NullOr(PageInfo),
  },
  /** What a subscriber missed since its cursor. */
  "thread.replay": {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    streaming: Schema.Array(RuntimeEvent),
    cursor: Schema.Number,
  },
  /** Older turns for "load earlier". */
  "thread.page": {
    threadId: Schema.String,
    events: Schema.Array(StoredEvent),
    page: PageInfo,
  },
  /** Answers a `search` command from this connection. */
  "search.results": {
    requestId: Schema.String,
    hits: Schema.Array(SearchHit),
  },
  /** Answers `project.config`: empty when there's no file, with `error` saying what's wrong when it's invalid. */
  "project.config": {
    requestId: Schema.String,
    config: ProjectConfig,
    /** The file as written; null when there's none. */
    text: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
  },
  /** Answers `project.saveConfig`: what kept it from saving, or null once it's saved. */
  "project.configSaved": {
    requestId: Schema.String,
    error: Schema.NullOr(Schema.String),
  },
  /** Answers `folder.list`: `path` made absolute, and the folders in it. */
  "folder.entries": {
    requestId: Schema.String,
    path: Schema.String,
    folders: Schema.Array(Schema.String),
    error: Schema.NullOr(Schema.String),
  },
  /** Answers `image.sign`: a URL path on the daemon serving the image for an hour; null when it isn't an image file. */
  "image.signed": {
    requestId: Schema.String,
    url: Schema.NullOr(Schema.String),
  },
  "project.cloned": {
    requestId: Schema.String,
    path: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
  },
  /** A live event; `id` is set on stored (transcript) events and advances the thread's cursor. */
  event: {
    id: Schema.NullOr(Schema.Number),
    event: RuntimeEvent,
  },
  "terminal.snapshot": {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  },
  "terminal.output": {
    threadId: Schema.String,
    terminalId: Schema.String,
    data: Schema.String,
  },
  "terminal.error": {
    threadId: Schema.String,
    terminalId: Schema.String,
    message: Schema.String,
  },
  "browser.request": {
    requestId: Schema.String,
    threadId: Schema.String,
    action: BrowserAction,
  },
  /** Answers `device.list`; `installed` is false until the simulator tools are set up, and `hub` null until then. */
  "device.listed": {
    requestId: Schema.String,
    installed: Schema.Boolean,
    hub: Schema.NullOr(DeviceHub),
    devices: Schema.Array(Device),
    error: Schema.NullOr(Schema.String),
  },
  "device.attached": {
    requestId: Schema.String,
    error: Schema.NullOr(Schema.String),
  },
});
export type ServerFrame = typeof ServerFrame.Type;
