import {
  prependPage,
  reduceItems,
  reduceThreads,
  replayTranscript,
  snapshotTranscript,
  type Transcript,
  type TranscriptItem,
} from "@masscode/client";
import {
  ClientCommand,
  isTranscriptEvent,
  type Project,
  type ProviderStatus,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  RuntimeEvent,
  ServerFrame,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import ReconnectingWebSocket from "partysocket/ws";
import { AppState } from "react-native";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PairedHost } from "./hosts.ts";

/** How this phone's link to a host stands. */
export type HostConnection =
  | "connecting"
  | "connected"
  /** Unreachable for now: asleep, MassCode closed, or Tailscale off; it keeps retrying. */
  | "offline"
  /** The host unpaired this phone; only pairing again helps. */
  | "unpaired"
  /** The phone and the host run versions that don't understand each other. */
  | "outdated";

export interface HostState {
  /** How to reach it, from pairing. */
  readonly paired: PairedHost;
  readonly connection: HostConnection;
  /** The host's database the threads below come from. */
  readonly dataId: string | null;
  readonly settings: Settings | null;
  readonly projects: ReadonlyArray<Project>;
  /** The host's harnesses and their models, for the composer's model label. */
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly threads: Readonly<Record<string, ThreadInfo>>;
}

interface State {
  /** The paired hosts have been read from the keychain. */
  readonly isLoaded: boolean;
  readonly hosts: Readonly<Record<string, HostState>>;
  /** By `transcriptKey`. */
  readonly transcripts: Readonly<Record<string, Transcript>>;
}

/** Latest turns loaded when a thread opens, and per "load earlier", as on the desktop. */
const TURN_LIMIT = 10;

/** The host closes an unpaired phone's sockets with this. */
const UNPAIRED = 4001;

const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame));

const decodeKept = Schema.decodeUnknownSync(Schema.Struct({ paired: Schema.Array(PairedHost) }));

function createHost(paired: PairedHost): HostState {
  return {
    paired,
    connection: "connecting",
    dataId: null,
    settings: null,
    projects: [],
    providers: [],
    threads: {},
  };
}

// Only the pairings are kept, in the keychain since anyone with a token can steer that host's
// agents; the rest comes from each host when it connects.
export const useStore = create<State>()(
  persist<State, [], [], { paired: ReadonlyArray<PairedHost> }>(
    () => ({ isLoaded: false, hosts: {}, transcripts: {} }),
    {
      name: "paired-hosts",
      storage: createJSONStorage(() => ({
        getItem: (key) => SecureStore.getItemAsync(key),
        setItem: (key, value) => SecureStore.setItemAsync(key, value),
        removeItem: (key) => SecureStore.deleteItemAsync(key),
      })),
      partialize: (state) => ({ paired: Object.values(state.hosts).map((host) => host.paired) }),
      merge: (kept, current) => {
        const paired = (() => {
          try {
            return decodeKept(kept).paired;
          } catch {
            return [];
          }
        })();

        return {
          ...current,
          hosts: Object.fromEntries(paired.map((host) => [host.id, createHost(host)])),
        };
      },
      onRehydrateStorage: () => () => {
        useStore.setState({ isLoaded: true });

        for (const host of Object.values(useStore.getState().hosts)) connect(host.paired);
      },
    },
  ),
);

export function transcriptKey(hostId: string, threadId: string) {
  return `${hostId}/${threadId}`;
}

function updateHost(hostId: string, update: (host: HostState) => HostState) {
  useStore.setState((state) => {
    const host = state.hosts[hostId];

    return host ? { hosts: { ...state.hosts, [hostId]: update(host) } } : state;
  });
}

function setTranscript(hostId: string, threadId: string, transcript: Transcript) {
  useStore.setState((state) => ({
    transcripts: { ...state.transcripts, [transcriptKey(hostId, threadId)]: transcript },
  }));
}

function getTranscript(hostId: string, threadId: string) {
  return useStore.getState().transcripts[transcriptKey(hostId, threadId)];
}

/** Everything but transcripts, which arrive per thread. */
function reduceHost(host: HostState, event: RuntimeEvent): HostState {
  return RuntimeEvent.matchOrElse<HostState>(
    event,
    {
      "settings.updated": ({ settings }) => ({ ...host, settings }),
      "providers.updated": ({ providers }) => ({ ...host, providers }),
      "project.added": ({ project }) => ({
        ...host,
        projects: [...host.projects.filter((existing) => existing.id !== project.id), project],
      }),
      "project.removed": ({ projectId }) => ({
        ...host,
        projects: host.projects.filter((project) => project.id !== projectId),
      }),
      "thread.created": ({ thread }) => ({
        ...host,
        threads: { ...host.threads, [thread.id]: thread },
      }),
      "thread.removed": ({ threadId }) => {
        const { [threadId]: _removed, ...threads } = host.threads;

        return { ...host, threads };
      },
    },
    () => ({ ...host, threads: reduceThreads(host.threads, event) }),
  );
}

const sockets = new Map<string, ReconnectingWebSocket>();

/** Transcripts on screen, by `transcriptKey`, with how many screens show each. */
const wanted = new Map<string, number>();

export function send(hostId: string, command: ClientCommand) {
  const socket = sockets.get(hostId);

  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(command));
}

function subscribeToTranscript(hostId: string, threadId: string) {
  send(
    hostId,
    ClientCommand.cases["thread.subscribe"].make({
      threadId,
      after: getTranscript(hostId, threadId)?.cursor ?? null,
      turnLimit: TURN_LIMIT,
    }),
  );
}

function onShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  const current = useStore.getState().hosts[hostId];

  if (!current) return;

  if (shell.protocol !== PROTOCOL_VERSION) {
    updateHost(hostId, (host) => ({ ...host, connection: "outdated" }));
    sockets.get(hostId)?.close();

    return;
  }

  useStore.setState((state) => ({
    // Another database means other threads; what was kept from the old one doesn't apply.
    transcripts:
      current.dataId === null || current.dataId === shell.dataId
        ? state.transcripts
        : Object.fromEntries(
            Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${hostId}/`)),
          ),
    hosts: {
      ...state.hosts,
      [hostId]: {
        ...current,
        connection: "connected",
        dataId: shell.dataId,
        settings: shell.settings,
        projects: shell.projects,
        providers: shell.providers,
        threads: Object.fromEntries(shell.threads.map((thread) => [thread.id, thread])),
      },
    },
  }));

  for (const key of wanted.keys())
    if (key.startsWith(`${hostId}/`)) subscribeToTranscript(hostId, key.slice(hostId.length + 1));
}

function onFrame(hostId: string, frame: ServerFrame) {
  ServerFrame.match(frame, {
    shell: (shell) => onShell(hostId, shell),
    "thread.snapshot": (snapshot) =>
      setTranscript(hostId, snapshot.threadId, snapshotTranscript(snapshot)),
    "thread.replay": (replay) =>
      setTranscript(
        hostId,
        replay.threadId,
        replayTranscript(getTranscript(hostId, replay.threadId), replay),
      ),
    "thread.page": (page) => {
      const previous = getTranscript(hostId, page.threadId);

      if (previous) setTranscript(hostId, page.threadId, prependPage(previous, page));
    },
    event: ({ id, event }) => {
      if (!isTranscriptEvent(event)) return updateHost(hostId, (host) => reduceHost(host, event));

      const transcript = getTranscript(hostId, event.threadId);

      if (!transcript || (id !== null && id <= transcript.cursor)) return;

      setTranscript(hostId, event.threadId, {
        ...transcript,
        items: reduceItems(transcript.items, event, id),
        cursor: id ?? transcript.cursor,
      });
    },
    "search.results": () => {},
    "project.config": () => {},
    "project.configSaved": () => {},
    "folder.entries": () => {},
    "image.signed": () => {},
    "project.cloned": () => {},
    "pairing.started": () => {},
    "terminal.snapshot": () => {},
    "terminal.output": () => {},
    "terminal.error": () => {},
    "browser.request": () => {},
    "device.listed": () => {},
    "device.attached": () => {},
  });
}

function connect(paired: PairedHost) {
  let attempt = 0;

  const socket = new ReconnectingWebSocket(
    // The MagicDNS name survives the host's address changing; the address works without MagicDNS
    // on this phone. Retries take turns between them.
    () =>
      `ws://${paired.dnsName && attempt++ % 2 === 0 ? paired.dnsName : paired.address}:${paired.port}/?protocol=${PROTOCOL_VERSION}`,
    [`masscode.${paired.token}`],
    { minReconnectionDelay: 500, maxReconnectionDelay: 30_000 },
  );

  socket.addEventListener("message", (message) => {
    try {
      onFrame(paired.id, decodeFrame(String(message.data)));
    } catch {
      // A frame this version can't read; the next shell says whether the versions match.
    }
  });

  socket.addEventListener("close", (event) => {
    const connection: HostConnection =
      event.code === UNPAIRED
        ? "unpaired"
        : event.code === PROTOCOL_MISMATCH
          ? "outdated"
          : "offline";

    useStore.setState((state) => ({
      // Kept on screen, marked cached until the next connection catches them up.
      transcripts: Object.fromEntries(
        Object.entries(state.transcripts).map(([key, transcript]) => [
          key,
          key.startsWith(`${paired.id}/`)
            ? { ...transcript, status: "cached" as const }
            : transcript,
        ]),
      ),
    }));
    updateHost(paired.id, (host) => ({
      ...host,
      connection: host.connection === "outdated" ? "outdated" : connection,
    }));

    // Retrying can't fix these; only pairing again or updating can.
    if (connection !== "offline") socket.close();
  });

  sockets.set(paired.id, socket);
}

/** Tries every host it isn't connected to now, without waiting out the backoff. */
export function reconnectAll() {
  for (const [hostId, socket] of sockets)
    if (useStore.getState().hosts[hostId]?.connection === "offline") socket.reconnect();
}

/** Pairing with a host again replaces what this phone had for it. */
export function addHost(paired: PairedHost) {
  for (const host of Object.values(useStore.getState().hosts))
    if (host.paired.address === paired.address) removeHost(host.paired.id);

  useStore.setState((state) => ({
    hosts: { ...state.hosts, [paired.id]: createHost(paired) },
  }));
  connect(paired);
}

/** Forgets the host on this phone; the host still lists the phone until it's unpaired there. */
export function removeHost(hostId: string) {
  sockets.get(hostId)?.close();
  sockets.delete(hostId);
  useStore.setState((state) => {
    const { [hostId]: _removed, ...hosts } = state.hosts;

    return {
      hosts,
      transcripts: Object.fromEntries(
        Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${hostId}/`)),
      ),
    };
  });
}

/** Follows the thread's transcript while a screen shows it; call what it returns to stop. */
export function openThread(hostId: string, threadId: string) {
  const key = transcriptKey(hostId, threadId);
  wanted.set(key, (wanted.get(key) ?? 0) + 1);

  if (!getTranscript(hostId, threadId))
    setTranscript(hostId, threadId, {
      items: NO_ITEMS,
      cursor: 0,
      page: null,
      status: "loading",
      loadingOlder: false,
    });

  subscribeToTranscript(hostId, threadId);

  return () => {
    const count = (wanted.get(key) ?? 1) - 1;

    if (count > 0) return void wanted.set(key, count);

    wanted.delete(key);
    send(hostId, ClientCommand.cases["thread.unsubscribe"].make({ threadId }));
  };
}

export function loadOlder(hostId: string, threadId: string) {
  const transcript = getTranscript(hostId, threadId);

  if (!transcript?.page?.hasMore || transcript.loadingOlder) return;

  setTranscript(hostId, threadId, { ...transcript, loadingOlder: true });
  send(
    hostId,
    ClientCommand.cases["thread.loadOlder"].make({
      threadId,
      before: transcript.page.before,
      turnLimit: TURN_LIMIT,
    }),
  );
}

// iOS suspends the app in the background and its sockets die; coming back reconnects at once.
AppState.addEventListener("change", (status) => {
  if (status === "active") reconnectAll();
});
