import { isTranscriptEvent, PROTOCOL_VERSION, ServerFrame } from "@masscode/contracts";
import {
  applyConnectionLoss,
  applyHostEvent,
  applyHostShell,
  markHostOutdated,
  useHostStore,
} from "@/entities/host";
import { applyProjectEvent, applyProjectShell } from "@/entities/project";
import { applyProviderEvent, applyProviderShell } from "@/entities/provider";
import {
  applyThreadEvent,
  applyThreadShell,
  applyTranscriptEvent,
  applyTranscriptPage,
  applyTranscriptReplay,
  applyTranscriptSnapshot,
  markTranscriptsCached,
  resubscribeTranscripts,
} from "@/entities/thread";
import { closeConnection, routeConnectionLossTo, routeFramesTo } from "@/shared/api";

function applyShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  const current = useHostStore.getState().hosts[hostId];

  if (!current) return;

  if (shell.protocol !== PROTOCOL_VERSION) {
    markHostOutdated(hostId);
    closeConnection(hostId);

    return;
  }

  // Another database means other threads; what was kept from the old one doesn't apply.
  applyThreadShell(hostId, shell, current.dataId === null || current.dataId === shell.dataId);
  applyProjectShell(hostId, shell);
  applyProviderShell(hostId, shell);
  applyHostShell(hostId, shell);
  resubscribeTranscripts(hostId);
}

routeFramesTo((hostId, frame) =>
  ServerFrame.match(frame, {
    shell: (shell) => applyShell(hostId, shell),
    "thread.snapshot": (snapshot) => applyTranscriptSnapshot(hostId, snapshot),
    "thread.replay": (replay) => applyTranscriptReplay(hostId, replay),
    "thread.page": (page) => applyTranscriptPage(hostId, page),
    event: ({ id, event }) => {
      if (isTranscriptEvent(event)) return applyTranscriptEvent(hostId, id, event);

      if (!useHostStore.getState().hosts[hostId]) return;

      applyHostEvent(hostId, event);
      applyProjectEvent(hostId, event);
      applyProviderEvent(hostId, event);
      applyThreadEvent(hostId, event);
    },
    "search.results": () => {},
    "project.config": () => {},
    "project.configSaved": () => {},
    "folder.entries": () => {},
    // Answers to this phone's requests, which the connection hands to whoever asked.
    "image.signed": () => {},
    "asset.data": () => {},
    "thread.createFailed": () => {},
    "project.cloned": () => {},
    "pairing.started": () => {},
    "terminal.snapshot": () => {},
    "terminal.output": () => {},
    "terminal.error": () => {},
    "browser.request": () => {},
    "device.listed": () => {},
    "device.attached": () => {},
    "keepAwake.apps": () => {},
    "service.killed": () => {},
  }),
);

routeConnectionLossTo((hostId, loss) => {
  markTranscriptsCached(hostId);
  applyConnectionLoss(hostId, loss);
});
