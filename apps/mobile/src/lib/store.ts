import {
  applyStoredEvents,
  applyStreaming,
  reduceItems,
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
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { loadHosts, type PairedHost, saveHosts } from "./hosts.ts";

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

const RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

/** The host closes an unpaired phone's sockets with this. */
const UNPAIRED = 4001;

const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame));

let state: State = { isLoaded: false, hosts: {}, transcripts: {} };

const listeners = new Set<() => void>();

function setState(next: State) {
  state = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useStore<Selected>(select: (current: State) => Selected) {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function transcriptKey(hostId: string, threadId: string) {
  return `${hostId}/${threadId}`;
}

function updateHost(hostId: string, update: (host: HostState) => HostState) {
  const current = state.hosts[hostId];

  if (current) setState({ ...state, hosts: { ...state.hosts, [hostId]: update(current) } });
}

function updateThread(
  threads: HostState["threads"],
  threadId: string,
  update: (info: ThreadInfo) => ThreadInfo,
) {
  const info = threads[threadId];

  return info ? { ...threads, [threadId]: update(info) } : threads;
}

/** The thread list, settings and projects: everything but transcripts. */
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
      "thread.status": ({ threadId, status }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({ ...info, status })),
      }),
      "thread.model": ({ threadId, provider, model }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({ ...info, provider, model })),
      }),
      "thread.archived": ({ threadId, archivedAt }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({ ...info, archivedAt })),
      }),
      "thread.shelved": ({ threadId, shelved }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({ ...info, shelved })),
      }),
      "thread.seen": ({ threadId, seenRev }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({ ...info, seenRev })),
      }),
      "thread.activity": ({ threadId, activity }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({
          ...info,
          activity: activity ?? undefined,
        })),
      }),
      "thread.request": ({ threadId, request }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({
          ...info,
          request: request ?? undefined,
        })),
      }),
      "thread.queue": ({ threadId, queue }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({
          ...info,
          queue: queue.length > 0 ? queue : undefined,
        })),
      }),
      "thread.limitStop": ({ threadId, limitStop }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({
          ...info,
          limitStop: limitStop ?? undefined,
        })),
      }),
      "thread.meta": ({ threadId, title, updatedAt, branch, cwd, worktree }) => ({
        ...host,
        threads: updateThread(host.threads, threadId, (info) => ({
          ...info,
          title,
          updatedAt,
          branch,
          cwd,
          worktree,
        })),
      }),
    },
    () => host,
  );
}

function setTranscript(hostId: string, threadId: string, transcript: Transcript) {
  setState({
    ...state,
    transcripts: { ...state.transcripts, [transcriptKey(hostId, threadId)]: transcript },
  });
}

interface Connection {
  socket: WebSocket | null;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  removed: boolean;
}

const connections = new Map<string, Connection>();

/** Transcripts on screen, by `transcriptKey`, with how many screens show each. */
const wanted = new Map<string, number>();

function sendOn(connection: Connection | undefined, command: ClientCommand) {
  if (connection?.socket?.readyState === WebSocket.OPEN)
    connection.socket.send(JSON.stringify(command));
}

function subscribeToTranscript(hostId: string, threadId: string) {
  sendOn(
    connections.get(hostId),
    ClientCommand.cases["thread.subscribe"].make({
      threadId,
      after: state.transcripts[transcriptKey(hostId, threadId)]?.cursor ?? null,
      turnLimit: TURN_LIMIT,
    }),
  );
}

function onShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  const current = state.hosts[hostId];

  if (!current) return;

  if (shell.protocol !== PROTOCOL_VERSION) {
    updateHost(hostId, (host) => ({ ...host, connection: "outdated" }));
    connections.get(hostId)?.socket?.close();

    return;
  }

  // Another database means other threads; what was kept from the old one doesn't apply.
  const transcripts =
    current.dataId === null || current.dataId === shell.dataId
      ? state.transcripts
      : Object.fromEntries(
          Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${hostId}/`)),
        );

  setState({
    ...state,
    transcripts,
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
  });

  const connection = connections.get(hostId);

  if (connection) connection.attempt = 0;

  for (const key of wanted.keys())
    if (key.startsWith(`${hostId}/`)) subscribeToTranscript(hostId, key.slice(hostId.length + 1));
}

function onFrame(hostId: string, frame: ServerFrame) {
  ServerFrame.match(frame, {
    shell: (shell) => onShell(hostId, shell),
    "thread.snapshot": ({ threadId, events, streaming, cursor, page }) =>
      setTranscript(hostId, threadId, {
        items: applyStreaming(applyStoredEvents([], events, 0), streaming),
        cursor,
        page,
        status: "live",
        loadingOlder: false,
      }),
    "thread.replay": ({ threadId, events, streaming, cursor }) => {
      const previous = state.transcripts[transcriptKey(hostId, threadId)];

      setTranscript(hostId, threadId, {
        items: applyStreaming(
          applyStoredEvents(previous?.items ?? NO_ITEMS, events, previous?.cursor ?? 0),
          streaming,
        ),
        cursor: Math.max(previous?.cursor ?? 0, cursor),
        page: previous?.page ?? null,
        status: "live",
        loadingOlder: false,
      });
    },
    "thread.page": ({ threadId, events, page }) => {
      const previous = state.transcripts[transcriptKey(hostId, threadId)];

      if (!previous) return;

      const known = new Set(previous.items.map((item) => item.id));

      setTranscript(hostId, threadId, {
        ...previous,
        items: [
          ...applyStoredEvents([], events, 0).filter((item) => !known.has(item.id)),
          ...previous.items,
        ],
        page,
        loadingOlder: false,
      });
    },
    event: ({ id, event }) => {
      if (!isTranscriptEvent(event)) return updateHost(hostId, (host) => reduceHost(host, event));

      const transcript = state.transcripts[transcriptKey(hostId, event.threadId)];

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

function scheduleReconnect(hostId: string, connection: Connection) {
  connection.retry = setTimeout(
    () => {
      connection.retry = null;
      connect(hostId, connection);
    },
    RETRY_DELAYS_MS[Math.min(connection.attempt++, RETRY_DELAYS_MS.length - 1)],
  );
}

function connect(hostId: string, connection: Connection) {
  const host = state.hosts[hostId];

  if (!host || connection.removed) return;

  if (host.connection !== "connected")
    updateHost(hostId, (current) => ({ ...current, connection: "connecting" }));

  // The MagicDNS name survives the host's address changing; the address works without MagicDNS on
  // this phone. Retries take turns between them.
  const address =
    host.paired.dnsName && connection.attempt % 2 === 0 ? host.paired.dnsName : host.paired.address;

  const socket = new WebSocket(
    `ws://${address}:${host.paired.port}/?protocol=${PROTOCOL_VERSION}`,
    [`masscode.${host.paired.token}`],
  );

  connection.socket = socket;

  socket.onmessage = (message) => {
    try {
      onFrame(hostId, decodeFrame(String(message.data)));
    } catch {
      // A frame this version can't read; the next shell says whether the versions match.
    }
  };

  socket.onclose = (event) => {
    if (connection.socket !== socket) return;

    connection.socket = null;

    // Kept on screen, marked cached until the next connection catches them up.
    setState({
      ...state,
      transcripts: Object.fromEntries(
        Object.entries(state.transcripts).map(([key, transcript]) => [
          key,
          key.startsWith(`${hostId}/`) ? { ...transcript, status: "cached" as const } : transcript,
        ]),
      ),
    });

    const connectionState: HostConnection =
      event.code === UNPAIRED
        ? "unpaired"
        : event.code === PROTOCOL_MISMATCH
          ? "outdated"
          : "offline";

    updateHost(hostId, (current) => ({
      ...current,
      connection: current.connection === "outdated" ? "outdated" : connectionState,
    }));

    if (connectionState === "offline" && state.hosts[hostId]?.connection === "offline")
      scheduleReconnect(hostId, connection);
  };
}

function startConnection(hostId: string) {
  const connection: Connection = { socket: null, attempt: 0, retry: null, removed: false };
  connections.set(hostId, connection);
  connect(hostId, connection);
}

/** Tries every host it isn't connected to now, without waiting out the backoff. */
export function reconnectAll() {
  for (const [hostId, connection] of connections) {
    if (connection.socket || state.hosts[hostId]?.connection === "outdated") continue;

    if (connection.retry) clearTimeout(connection.retry);

    connection.retry = null;
    connection.attempt = 0;
    connect(hostId, connection);
  }
}

export async function addHost(host: PairedHost) {
  const others = Object.values(state.hosts)
    .map((existing) => existing.paired)
    .filter((existing) => existing.address !== host.address);

  await saveHosts([...others, host]);

  for (const existing of Object.values(state.hosts))
    if (existing.paired.address === host.address) forgetConnection(existing.paired.id);

  setState({
    ...state,
    hosts: {
      ...Object.fromEntries(
        Object.entries(state.hosts).filter(
          ([, existing]) => existing.paired.address !== host.address,
        ),
      ),
      [host.id]: {
        paired: host,
        connection: "connecting",
        dataId: null,
        settings: null,
        projects: [],
        providers: [],
        threads: {},
      },
    },
  });
  startConnection(host.id);
}

function forgetConnection(hostId: string) {
  const connection = connections.get(hostId);

  if (!connection) return;

  connection.removed = true;

  if (connection.retry) clearTimeout(connection.retry);

  connection.socket?.close();
  connections.delete(hostId);
}

/** Forgets the host on this phone; the host still lists the phone until it's unpaired there. */
export async function removeHost(hostId: string) {
  forgetConnection(hostId);

  const { [hostId]: _removed, ...hosts } = state.hosts;
  await saveHosts(Object.values(hosts).map((host) => host.paired));

  setState({
    ...state,
    hosts,
    transcripts: Object.fromEntries(
      Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${hostId}/`)),
    ),
  });
}

export function send(hostId: string, command: ClientCommand) {
  sendOn(connections.get(hostId), command);
}

/** Follows the thread's transcript while a screen shows it; call what it returns to stop. */
export function openThread(hostId: string, threadId: string) {
  const key = transcriptKey(hostId, threadId);
  wanted.set(key, (wanted.get(key) ?? 0) + 1);

  if (!state.transcripts[key])
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
  const transcript = state.transcripts[transcriptKey(hostId, threadId)];

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

void loadHosts().then((hosts) => {
  setState({
    ...state,
    isLoaded: true,
    hosts: Object.fromEntries(
      hosts.map((host) => [
        host.id,
        {
          paired: host,
          connection: "connecting",
          dataId: null,
          settings: null,
          projects: [],
          providers: [],
          threads: {},
        },
      ]),
    ),
  });

  for (const host of hosts) startConnection(host.id);
});

// iOS suspends the app in the background and its sockets die; coming back reconnects at once.
AppState.addEventListener("change", (status) => {
  if (status === "active") reconnectAll();
});
