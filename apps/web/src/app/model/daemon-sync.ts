import {
  ClientCommand,
  HostStatus,
  isTranscriptEvent,
  type RemoteHost,
  RuntimeEvent,
  ServerFrame,
} from "@masscode/contracts";
import { performBrowserAction } from "@/entities/browser";
import {
  getDataId,
  getHostState,
  markDisconnected,
  markIncompatible,
  receiveShell,
  setPhones,
  setRemoteHosts as setHosts,
} from "@/entities/host";
import { applyKeepAwakeEvent, receiveKeepAwake } from "@/entities/keep-awake";
import { applyServiceEvent, forgetServices, receiveServices } from "@/entities/service";
import {
  applyProjectEvent,
  forgetHostProjects,
  receiveProjects,
  scanProjects,
} from "@/entities/project";
import {
  applyProviderEvent,
  receiveProviders,
  setRemoteHosts as setProviderHosts,
} from "@/entities/provider";
import { applyRepoEvent, setRemoteHosts as setRepoHosts } from "@/entities/repo";
import {
  applySettingsEvent,
  getHostProjectsFolder,
  receiveSettings,
  setRemoteHosts as setSettingsHosts,
  syncSettings,
} from "@/entities/settings";
import { showDevice } from "@/entities/simulator";
import {
  applyTerminalEvent,
  forgetThreads,
  receiveShellTerminals,
  receiveTerminalFrame,
  reopenScreens,
} from "@/entities/terminal";
import {
  applyForkError,
  applyThreadEvent,
  applyTranscriptEvent,
  findCommandHost,
  forgetHostThreads,
  receiveShellThreads,
  receiveTranscriptFrame,
  resubscribeHost,
  showHostTranscriptsCached,
} from "@/entities/thread";
import { receiveSideChatEvent } from "@/features/side-chat";
import {
  connectTo,
  disconnectFrom,
  hasConnection,
  listDaemonHosts,
  onDisconnect,
  onFrame,
  onIncompatible,
  reconnectNow,
  routeCommandsWith,
  send,
} from "@/shared/api";

/** Adds the git repos in `host`'s projects folder, or its home, as projects there. */
function scanHostProjects(host: string) {
  // Until this Mac's shell or cache is in, its settings don't say where that folder is.
  if (getHostState().source !== "none") scanProjects(host, getHostProjectsFolder(host));
}

/**
 * Replaces one host's threads and projects with what its daemon sent; other hosts' stay. Each
 * part reads what the others held before this shell, so the thread list goes first and the host's
 * own state last: until then, a thread's change isn't taken for news. Settings go before the
 * thread list, so the notifications it triggers follow the host's latest settings.
 */
function receiveHostShell(host: string | null, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  const isSameData = shell.dataId === getDataId(host);
  receiveSettings(host, shell.settings);

  const { others, incoming } = receiveShellThreads(host, shell.threads, {
    dataId: shell.dataId,
    isSameData,
  });

  const reopened = receiveShellTerminals(others, incoming, shell.terminals);
  receiveProjects(host, shell.projects);
  receiveProviders(host, shell.providers);
  receiveKeepAwake(host, shell.keepAwake);
  receiveServices(host, shell.services);
  receiveShell(host, shell);

  resubscribeHost(host, isSameData);
  reopenScreens(reopened);

  if (host !== null) {
    syncSettings(host);
    scanHostProjects(host);
  } else {
    // Hosts that connected first had no projects folder to scan yet.
    for (const [alias, remote] of Object.entries(getHostState().hosts))
      if (remote.connected) scanHostProjects(alias);
  }
}

/** Everything but transcripts: the thread list, settings, projects, git state… */
function applyShellEvent(host: string | null, event: RuntimeEvent) {
  if (RuntimeEvent.guards["phones.updated"](event)) setPhones(event.phones);

  applySettingsEvent(host, event);
  applyKeepAwakeEvent(host, event);
  applyServiceEvent(host, event);
  applyProviderEvent(host, event);
  applyRepoEvent(host, event);
  applyProjectEvent(host, event);
  applyTerminalEvent(event);
  applyThreadEvent(event);
}

function receiveFrame(frame: ServerFrame, host: string | null) {
  ServerFrame.matchOrElse(
    frame,
    {
      shell: (shell) => receiveHostShell(host, shell),
      "thread.snapshot": receiveTranscriptFrame,
      "thread.replay": receiveTranscriptFrame,
      "thread.page": receiveTranscriptFrame,
      "terminal.snapshot": receiveTerminalFrame,
      "terminal.output": receiveTerminalFrame,
      "terminal.error": receiveTerminalFrame,
      "browser.request": ({ threadId, requestId, action }) =>
        void performBrowserAction(threadId, action).then(
          (result) =>
            send(
              ClientCommand.cases["browser.respond"].make({ requestId, result, error: null }),
              host,
            ),
          (error) =>
            send(
              ClientCommand.cases["browser.respond"].make({
                requestId,
                result: null,
                error: error instanceof Error ? error.message : String(error),
              }),
              host,
            ),
        ),
      event: ({ event, id }) => {
        if (receiveSideChatEvent(event, id)) return;

        applyForkError(event);

        if (RuntimeEvent.guards["thread.device"](event))
          return showDevice(event.threadId, event.deviceId);

        if (!isTranscriptEvent(event)) return applyShellEvent(host, event);

        applyTranscriptEvent(event, id);
      },
    },
    () => {},
  );
}

/** Drops a removed host's connection and everything it showed. */
function removeHost(host: string) {
  disconnectFrom(host);
  // Its threads are found through its projects, so they go first.
  forgetThreads(forgetHostThreads(host));
  forgetHostProjects(host);
}

/** Follows the desktop app's list of remote hosts: connects new ones, drops removed ones. */
function syncHosts(list: ReadonlyArray<RemoteHost>) {
  const aliases = list.map((remote) => remote.alias);

  for (const host of listDaemonHosts()) {
    if (host !== null && !aliases.includes(host)) removeHost(host);
  }

  setHosts(list);
  setSettingsHosts(aliases);
  setProviderHosts(aliases);
  setRepoHosts(aliases);

  for (const { alias, status } of list) {
    if (!hasConnection(alias)) connectTo(alias);
    // Back (say, restarted on the new version): don't wait out the backoff.
    else if (HostStatus.guards.connected(status)) reconnectNow(alias);
  }
}

routeCommandsWith(findCommandHost);

onFrame(receiveFrame);

onIncompatible(markIncompatible);

onDisconnect((host) => {
  showHostTranscriptsCached(host);
  markDisconnected(host);
  forgetServices(host);
});

connectTo(null);

if (window.desktop) {
  window.desktop.onHosts(syncHosts);
  void window.desktop.hosts().then(syncHosts);
}
