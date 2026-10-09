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
import { loadMacs, type PairedMac, saveMacs } from "./macs.ts";

/** How this phone's link to a Mac stands. */
export type MacConnection =
  | "connecting"
  | "connected"
  /** Unreachable for now: asleep, MassCode closed, or Tailscale off; it keeps retrying. */
  | "offline"
  /** The Mac unpaired this phone; only pairing again helps. */
  | "unpaired"
  /** The phone and the Mac run versions that don't understand each other. */
  | "outdated";

export interface MacState {
  readonly mac: PairedMac;
  readonly connection: MacConnection;
  /** The Mac's database the threads below come from. */
  readonly dataId: string | null;
  readonly settings: Settings | null;
  readonly projects: ReadonlyArray<Project>;
  readonly threads: Readonly<Record<string, ThreadInfo>>;
}

interface State {
  /** The paired Macs have been read from the keychain. */
  readonly isLoaded: boolean;
  readonly macs: Readonly<Record<string, MacState>>;
  /** By `transcriptKey`. */
  readonly transcripts: Readonly<Record<string, Transcript>>;
}

/** Latest turns loaded when a thread opens, and per "load earlier", as on the desktop. */
const TURN_LIMIT = 10;

const RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

/** The Mac closes an unpaired phone's sockets with this. */
const UNPAIRED = 4001;

const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame));

let state: State = { isLoaded: false, macs: {}, transcripts: {} };

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

export function transcriptKey(macId: string, threadId: string) {
  return `${macId}/${threadId}`;
}

function updateMac(macId: string, update: (mac: MacState) => MacState) {
  const current = state.macs[macId];

  if (current) setState({ ...state, macs: { ...state.macs, [macId]: update(current) } });
}

function updateThread(
  threads: MacState["threads"],
  threadId: string,
  update: (info: ThreadInfo) => ThreadInfo,
) {
  const info = threads[threadId];

  return info ? { ...threads, [threadId]: update(info) } : threads;
}

/** The thread list, settings and projects: everything but transcripts. */
function reduceMac(mac: MacState, event: RuntimeEvent): MacState {
  return RuntimeEvent.matchOrElse<MacState>(
    event,
    {
      "settings.updated": ({ settings }) => ({ ...mac, settings }),
      "project.added": ({ project }) => ({
        ...mac,
        projects: [...mac.projects.filter((existing) => existing.id !== project.id), project],
      }),
      "project.removed": ({ projectId }) => ({
        ...mac,
        projects: mac.projects.filter((project) => project.id !== projectId),
      }),
      "thread.created": ({ thread }) => ({
        ...mac,
        threads: { ...mac.threads, [thread.id]: thread },
      }),
      "thread.removed": ({ threadId }) => {
        const { [threadId]: _removed, ...threads } = mac.threads;

        return { ...mac, threads };
      },
      "thread.status": ({ threadId, status }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({ ...info, status })),
      }),
      "thread.model": ({ threadId, provider, model }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({ ...info, provider, model })),
      }),
      "thread.archived": ({ threadId, archivedAt }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({ ...info, archivedAt })),
      }),
      "thread.shelved": ({ threadId, shelved }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({ ...info, shelved })),
      }),
      "thread.seen": ({ threadId, seenRev }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({ ...info, seenRev })),
      }),
      "thread.activity": ({ threadId, activity }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({
          ...info,
          activity: activity ?? undefined,
        })),
      }),
      "thread.request": ({ threadId, request }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({
          ...info,
          request: request ?? undefined,
        })),
      }),
      "thread.queue": ({ threadId, queue }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({
          ...info,
          queue: queue.length > 0 ? queue : undefined,
        })),
      }),
      "thread.limitStop": ({ threadId, limitStop }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({
          ...info,
          limitStop: limitStop ?? undefined,
        })),
      }),
      "thread.meta": ({ threadId, title, updatedAt, branch, cwd, worktree }) => ({
        ...mac,
        threads: updateThread(mac.threads, threadId, (info) => ({
          ...info,
          title,
          updatedAt,
          branch,
          cwd,
          worktree,
        })),
      }),
    },
    () => mac,
  );
}

function setTranscript(macId: string, threadId: string, transcript: Transcript) {
  setState({
    ...state,
    transcripts: { ...state.transcripts, [transcriptKey(macId, threadId)]: transcript },
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

function subscribeToTranscript(macId: string, threadId: string) {
  sendOn(
    connections.get(macId),
    ClientCommand.cases["thread.subscribe"].make({
      threadId,
      after: state.transcripts[transcriptKey(macId, threadId)]?.cursor ?? null,
      turnLimit: TURN_LIMIT,
    }),
  );
}

function onShell(macId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  const current = state.macs[macId];

  if (!current) return;

  if (shell.protocol !== PROTOCOL_VERSION) {
    updateMac(macId, (mac) => ({ ...mac, connection: "outdated" }));
    connections.get(macId)?.socket?.close();

    return;
  }

  // Another database means other threads; what was kept from the old one doesn't apply.
  const transcripts =
    current.dataId === null || current.dataId === shell.dataId
      ? state.transcripts
      : Object.fromEntries(
          Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${macId}/`)),
        );

  setState({
    ...state,
    transcripts,
    macs: {
      ...state.macs,
      [macId]: {
        ...current,
        connection: "connected",
        dataId: shell.dataId,
        settings: shell.settings,
        projects: shell.projects,
        threads: Object.fromEntries(shell.threads.map((thread) => [thread.id, thread])),
      },
    },
  });

  const connection = connections.get(macId);

  if (connection) connection.attempt = 0;

  for (const key of wanted.keys())
    if (key.startsWith(`${macId}/`)) subscribeToTranscript(macId, key.slice(macId.length + 1));
}

function onFrame(macId: string, frame: ServerFrame) {
  ServerFrame.match(frame, {
    shell: (shell) => onShell(macId, shell),
    "thread.snapshot": ({ threadId, events, streaming, cursor, page }) =>
      setTranscript(macId, threadId, {
        items: applyStreaming(applyStoredEvents([], events, 0), streaming),
        cursor,
        page,
        status: "live",
        loadingOlder: false,
      }),
    "thread.replay": ({ threadId, events, streaming, cursor }) => {
      const previous = state.transcripts[transcriptKey(macId, threadId)];

      setTranscript(macId, threadId, {
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
      const previous = state.transcripts[transcriptKey(macId, threadId)];

      if (!previous) return;

      const known = new Set(previous.items.map((item) => item.id));

      setTranscript(macId, threadId, {
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
      if (!isTranscriptEvent(event)) return updateMac(macId, (mac) => reduceMac(mac, event));

      const transcript = state.transcripts[transcriptKey(macId, event.threadId)];

      if (!transcript || (id !== null && id <= transcript.cursor)) return;

      setTranscript(macId, event.threadId, {
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

function scheduleReconnect(macId: string, connection: Connection) {
  connection.retry = setTimeout(
    () => {
      connection.retry = null;
      connect(macId, connection);
    },
    RETRY_DELAYS_MS[Math.min(connection.attempt++, RETRY_DELAYS_MS.length - 1)],
  );
}

function connect(macId: string, connection: Connection) {
  const mac = state.macs[macId];

  if (!mac || connection.removed) return;

  if (mac.connection !== "connected")
    updateMac(macId, (current) => ({ ...current, connection: "connecting" }));

  // The MagicDNS name survives the Mac's address changing; the address works without MagicDNS on
  // this phone. Retries take turns between them.
  const address = mac.mac.dnsName && connection.attempt % 2 === 0 ? mac.mac.dnsName : mac.mac.host;

  const socket = new WebSocket(`ws://${address}:${mac.mac.port}/?protocol=${PROTOCOL_VERSION}`, [
    `masscode.${mac.mac.token}`,
  ]);

  connection.socket = socket;

  socket.onmessage = (message) => {
    try {
      onFrame(macId, decodeFrame(String(message.data)));
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
          key.startsWith(`${macId}/`) ? { ...transcript, status: "cached" as const } : transcript,
        ]),
      ),
    });

    const connectionState: MacConnection =
      event.code === UNPAIRED
        ? "unpaired"
        : event.code === PROTOCOL_MISMATCH
          ? "outdated"
          : "offline";

    updateMac(macId, (current) => ({
      ...current,
      connection: current.connection === "outdated" ? "outdated" : connectionState,
    }));

    if (connectionState === "offline" && state.macs[macId]?.connection === "offline")
      scheduleReconnect(macId, connection);
  };
}

function startConnection(macId: string) {
  const connection: Connection = { socket: null, attempt: 0, retry: null, removed: false };
  connections.set(macId, connection);
  connect(macId, connection);
}

/** Tries every Mac it isn't connected to now, without waiting out the backoff. */
export function reconnectAll() {
  for (const [macId, connection] of connections) {
    if (connection.socket || state.macs[macId]?.connection === "outdated") continue;

    if (connection.retry) clearTimeout(connection.retry);

    connection.retry = null;
    connection.attempt = 0;
    connect(macId, connection);
  }
}

export async function addMac(mac: PairedMac) {
  const others = Object.values(state.macs)
    .map((existing) => existing.mac)
    .filter((existing) => existing.host !== mac.host);

  await saveMacs([...others, mac]);

  for (const existing of Object.values(state.macs))
    if (existing.mac.host === mac.host) forgetConnection(existing.mac.id);

  setState({
    ...state,
    macs: {
      ...Object.fromEntries(
        Object.entries(state.macs).filter(([, existing]) => existing.mac.host !== mac.host),
      ),
      [mac.id]: {
        mac,
        connection: "connecting",
        dataId: null,
        settings: null,
        projects: [],
        threads: {},
      },
    },
  });
  startConnection(mac.id);
}

function forgetConnection(macId: string) {
  const connection = connections.get(macId);

  if (!connection) return;

  connection.removed = true;

  if (connection.retry) clearTimeout(connection.retry);

  connection.socket?.close();
  connections.delete(macId);
}

/** Forgets the Mac on this phone; the Mac still lists the phone until it's unpaired there. */
export async function removeMac(macId: string) {
  forgetConnection(macId);

  const { [macId]: _removed, ...macs } = state.macs;
  await saveMacs(Object.values(macs).map((mac) => mac.mac));

  setState({
    ...state,
    macs,
    transcripts: Object.fromEntries(
      Object.entries(state.transcripts).filter(([key]) => !key.startsWith(`${macId}/`)),
    ),
  });
}

export function send(macId: string, command: ClientCommand) {
  sendOn(connections.get(macId), command);
}

/** Follows the thread's transcript while a screen shows it; call what it returns to stop. */
export function openThread(macId: string, threadId: string) {
  const key = transcriptKey(macId, threadId);
  wanted.set(key, (wanted.get(key) ?? 0) + 1);

  if (!state.transcripts[key])
    setTranscript(macId, threadId, {
      items: NO_ITEMS,
      cursor: 0,
      page: null,
      status: "loading",
      loadingOlder: false,
    });

  subscribeToTranscript(macId, threadId);

  return () => {
    const count = (wanted.get(key) ?? 1) - 1;

    if (count > 0) return void wanted.set(key, count);

    wanted.delete(key);
    send(macId, ClientCommand.cases["thread.unsubscribe"].make({ threadId }));
  };
}

export function loadOlder(macId: string, threadId: string) {
  const transcript = state.transcripts[transcriptKey(macId, threadId)];

  if (!transcript?.page?.hasMore || transcript.loadingOlder) return;

  setTranscript(macId, threadId, { ...transcript, loadingOlder: true });
  send(
    macId,
    ClientCommand.cases["thread.loadOlder"].make({
      threadId,
      before: transcript.page.before,
      turnLimit: TURN_LIMIT,
    }),
  );
}

void loadMacs().then((macs) => {
  setState({
    ...state,
    isLoaded: true,
    macs: Object.fromEntries(
      macs.map((mac) => [
        mac.id,
        { mac, connection: "connecting", dataId: null, settings: null, projects: [], threads: {} },
      ]),
    ),
  });

  for (const mac of macs) startConnection(mac.id);
});

// iOS suspends the app in the background and its sockets die; coming back reconnects at once.
AppState.addEventListener("change", (status) => {
  if (status === "active") reconnectAll();
});
