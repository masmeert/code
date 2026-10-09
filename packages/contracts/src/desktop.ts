import * as Schema from "effect/Schema";
import type { BrowserAction, BrowserResult } from "./browser.ts";
import type { Theme } from "./settings.ts";
import type { AttachmentInput } from "./threads.ts";

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
  available: { version: Schema.String },
  downloading: { version: Schema.String, percent: Schema.Number },
  ready: { version: Schema.String },
  failed: { message: Schema.String },
});
export type UpdateStatus = typeof UpdateStatus.Type;

/** Where the app is with a remote host, an SSH alias like one from ~/.ssh/config. */
export const HostStatus = Schema.TaggedUnion({
  /** `step` says what's happening, e.g. "Uploading MassCode (40%)". */
  connecting: { step: Schema.String },
  connected: {},
  /** The host runs an older MassCode, which restarts on this version once its running turns end. */
  updating: {},
  failed: { message: Schema.String },
});
export type HostStatus = typeof HostStatus.Type;

export interface RemoteHost {
  readonly alias: string;
  readonly status: HostStatus;
}

/** Where a daemon listens on this machine, and the token it wants. */
export interface DaemonEndpoint {
  readonly port: number;
  readonly token: string;
}

export interface DesktopBridge {
  /** Null in dev, where the daemon runs on its own at DEFAULT_DAEMON_PORT without a token. */
  readonly daemon: () => Promise<DaemonEndpoint | null>;
  /** Hosts added in Settings → Connections, each with its own daemon over SSH. */
  readonly hosts: () => Promise<ReadonlyArray<RemoteHost>>;
  readonly onHosts: (listener: (hosts: ReadonlyArray<RemoteHost>) => void) => () => void;
  readonly addHost: (alias: string) => Promise<void>;
  /** Also stops MassCode on the host, and the agents it runs. */
  readonly removeHost: (alias: string) => Promise<void>;
  /** Connects if needed; null while the host can't be reached or is updating (see its status). */
  readonly hostDaemon: (alias: string) => Promise<DaemonEndpoint | null>;
  /** Restarts an updating host on this version now, stopping its running turns. */
  readonly restartHost: (alias: string) => Promise<void>;
  /** Host aliases from ~/.ssh/config, to pick from. */
  readonly sshAliases: () => Promise<ReadonlyArray<string>>;
  /** Files as data, for a remote host that can't read this machine's paths. */
  readonly readFiles: (
    paths: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<typeof AttachmentInput.cases.data.Type>>;
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
  readonly downloadUpdate: () => Promise<void>;
  readonly installUpdate: () => Promise<void>;
  /** A system notification about a thread, shown only while no MassCode window is focused. */
  readonly notify: (notification: {
    readonly threadId: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
  /** A notification about the thread was clicked in this window. */
  readonly onOpenThread: (listener: (threadId: string) => void) => () => void;
}
