import {
  type ApprovalDecision,
  ClientCommand,
  type PermissionLevel,
  type RuntimeEvent,
  ServerFrame,
  type UserAnswers,
} from "@masscode/contracts";
import {
  prependPage,
  reduceItems,
  replayTranscript,
  snapshotTranscript,
  type Transcript,
} from "@masscode/client";
import { useEffect } from "react";
import { getDataId as getHostDataId, isHostReady } from "@/entities/host/@x/thread";
import { isConnectionOpen, send, sendIfConnected } from "@/shared/api";
import { loadTranscript, removeTranscript, saveTranscript } from "@/shared/cache";
import { createStore } from "@/shared/lib/store";
import { getThreadHost, getThreadState, watchThreads } from "./thread-store.ts";

const store = createStore<{ readonly transcripts: Readonly<Record<string, Transcript>> }>({
  transcripts: {},
});

/** Latest turns loaded when a thread opens, and per "load earlier" (t3code uses the same window). */
const TURN_LIMIT = 10;

/** The database a thread's cached transcript belongs to: its host's. */
export function getDataId(threadId: string) {
  return getHostDataId(getThreadHost(threadId));
}

export function getTranscripts() {
  return store.getState().transcripts;
}

export function setTranscripts(transcripts: Readonly<Record<string, Transcript>>) {
  store.setState({ transcripts });
}

function setTranscript(threadId: string, transcript: Transcript) {
  store.setState({ transcripts: { ...store.getState().transcripts, [threadId]: transcript } });
}

/** Brand new: nothing to fetch, it's live from its first event. */
export function startLiveTranscript(threadId: string) {
  setTranscript(threadId, {
    items: [],
    cursor: 0,
    page: null,
    status: "live",
    loadingOlder: false,
  });
}

export function dropTranscript(threadId: string) {
  const { [threadId]: _transcript, ...transcripts } = store.getState().transcripts;
  const dataId = getDataId(threadId);

  if (dataId) removeTranscript(dataId, threadId);

  store.setState({ transcripts });
}

/** Threads with an open view, counted (a thread can be open in several places). */
const wanted = new Map<string, number>();

/** Threads whose cached transcript is still being read; subscribing waits for it, to know the cursor. */
const readingCache = new Set<string>();

/** Closed threads' pending drops from memory, cancelled if a view opens them again. */
const evictions = new Map<string, ReturnType<typeof setTimeout>>();

/** Puts a thread's cached transcript in memory, if it isn't there yet. */
export async function loadCachedTranscript(threadId: string) {
  const dataId = getDataId(threadId);

  if (!dataId || store.getState().transcripts[threadId] || readingCache.has(threadId)) return;

  readingCache.add(threadId);
  const cached = await loadTranscript(dataId, threadId);
  readingCache.delete(threadId);

  // The daemon may have answered meanwhile, or a new shell may be from another database.
  if (!cached || getDataId(threadId) !== dataId || store.getState().transcripts[threadId]) return;

  const { items, cursor, page } = cached;
  setTranscript(threadId, { items, cursor, page, status: "cached", loadingOlder: false });
}

/** Asks for a thread's transcript: a replay after the cursor when we have one, else the latest turns. */
function subscribeToTranscript(threadId: string) {
  const host = getThreadHost(threadId);

  if (!isConnectionOpen(host) || !isHostReady(host) || readingCache.has(threadId)) return;

  const transcript = store.getState().transcripts[threadId];

  if (transcript) {
    if (transcript.status === "cached")
      setTranscript(threadId, { ...transcript, status: "loading" });
  } else {
    setTranscript(threadId, {
      items: [],
      cursor: 0,
      page: null,
      status: "loading",
      loadingOlder: false,
    });
  }

  const after = transcript && transcript.items.length > 0 ? transcript.cursor : null;
  send(
    ClientCommand.cases["thread.subscribe"].make({ threadId, after, turnLimit: TURN_LIMIT }),
    host,
  );
}

/**
 * Asks again for the transcripts open on `host` once its shell is in: kept ones replay what they
 * missed, the rest come from the cache first when it's the same database, so the daemon only
 * sends what's new.
 */
export function resubscribeHost(host: string | null, isSameData: boolean) {
  for (const threadId of wanted.keys()) {
    if (getThreadHost(threadId) !== host) continue;

    if (store.getState().transcripts[threadId] || !isSameData) {
      subscribeToTranscript(threadId);
    } else {
      void loadCachedTranscript(threadId).then(
        () => wanted.has(threadId) && subscribeToTranscript(threadId),
      );
    }
  }
}

/** Follows a thread's transcript while a view shows it. */
function openThread(threadId: string) {
  const count = wanted.get(threadId) ?? 0;
  wanted.set(threadId, count + 1);

  if (count > 0) return;

  clearTimeout(evictions.get(threadId));
  evictions.delete(threadId);

  if (store.getState().transcripts[threadId]) subscribeToTranscript(threadId);
  else
    void loadCachedTranscript(threadId).then(
      () => wanted.has(threadId) && subscribeToTranscript(threadId),
    );
}

function closeThread(threadId: string) {
  const count = (wanted.get(threadId) ?? 1) - 1;

  if (count > 0) {
    wanted.set(threadId, count);

    return;
  }

  wanted.delete(threadId);
  sendIfConnected(ClientCommand.cases["thread.unsubscribe"].make({ threadId }));
  // Kept a few minutes for quick back-and-forth (t3code keeps 5); after that, reopening reads
  // the IndexedDB cache and replays only what it missed.
  evictions.set(
    threadId,
    setTimeout(() => {
      evictions.delete(threadId);
      const { [threadId]: _evicted, ...transcripts } = store.getState().transcripts;
      store.setState({ transcripts });
    }, 5 * 60_000),
  );
}

let kept: ReadonlyArray<string> = [];

/**
 * Follows these threads' transcripts while their views are kept hidden, so switching back to
 * one shows it current, with no replay to wait for.
 */
export function keepFollowing(threadIds: ReadonlyArray<string>) {
  for (const threadId of threadIds) if (!kept.includes(threadId)) openThread(threadId);

  for (const threadId of kept) if (!threadIds.includes(threadId)) closeThread(threadId);
  kept = threadIds;
}

/** A thread's transcript, followed live while the calling component is mounted. */
export function useTranscript(threadId: string): Transcript | null {
  useEffect(() => {
    openThread(threadId);

    return () => closeThread(threadId);
  }, [threadId]);

  return store.useStore((state) => state.transcripts[threadId] ?? null);
}

/** Fetches the turns before what's loaded. */
export function loadOlder(threadId: string) {
  const transcript = store.getState().transcripts[threadId];

  if (
    !transcript?.page?.hasMore ||
    transcript.loadingOlder ||
    !isConnectionOpen(getThreadHost(threadId))
  )
    return;

  setTranscript(threadId, { ...transcript, loadingOlder: true });
  sendIfConnected(
    ClientCommand.cases["thread.loadOlder"].make({
      threadId,
      before: transcript.page.before,
      turnLimit: TURN_LIMIT,
    }),
  );
}

/** Keep everything on screen; `host`'s transcripts fall back to cached until the next connect catches them up. */
export function showHostTranscriptsCached(host: string | null) {
  store.setState({
    transcripts: Object.fromEntries(
      Object.entries(store.getState().transcripts).map(([id, transcript]) => [
        id,
        getThreadHost(id) !== host || (transcript.status === "cached" && !transcript.loadingOlder)
          ? transcript
          : { ...transcript, status: "cached" as const, loadingOlder: false },
      ]),
    ),
  });
}

export function receiveTranscriptFrame(
  frame: Extract<ServerFrame, { _tag: "thread.snapshot" | "thread.replay" | "thread.page" }>,
) {
  const { transcripts } = store.getState();

  ServerFrame.matchOrElse(
    frame,
    {
      "thread.snapshot": (snapshot) =>
        setTranscript(snapshot.threadId, snapshotTranscript(snapshot)),
      "thread.replay": (replay) =>
        setTranscript(replay.threadId, replayTranscript(transcripts[replay.threadId], replay)),
      "thread.page": (page) => {
        const previous = transcripts[page.threadId];

        if (previous) setTranscript(page.threadId, prependPage(previous, page));
      },
    },
    () => {},
  );
}

export function applyTranscriptEvent(
  event: RuntimeEvent & { readonly threadId: string },
  id: number | null,
) {
  const transcript = store.getState().transcripts[event.threadId];

  // Not following this thread, or already have it (a replay can overlap live events).
  if (!transcript || (id !== null && id <= transcript.cursor)) return;

  setTranscript(event.threadId, {
    ...transcript,
    items: reduceItems(transcript.items, event, id),
    cursor: id ?? transcript.cursor,
  });
}

export function respondApproval(
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
  reply?: { readonly permission?: PermissionLevel; readonly answers?: UserAnswers },
) {
  const transcript = store.getState().transcripts[threadId];

  if (transcript) {
    const items = transcript.items.map((item) =>
      item.id === requestId && item.kind === "approval" ? { ...item, decision } : item,
    );

    setTranscript(threadId, { ...transcript, items });
  }

  send(ClientCommand.cases["approval.respond"].make({ threadId, requestId, decision, ...reply }));
}

let lastTranscripts = store.getState().transcripts;

let lastThreads = getThreadState().threads;

/**
 * Persists live transcripts once a turn settles, not on every delta: encoding the whole transcript
 * mid-stream is wasted work (t3code does the same). Saved when the turn ends.
 */
function saveSettledTranscripts() {
  const prevTranscripts = lastTranscripts;
  const prevThreads = lastThreads;
  const { transcripts } = store.getState();
  const { threads } = getThreadState();
  lastTranscripts = transcripts;
  lastThreads = threads;

  if (prevTranscripts === transcripts && prevThreads === threads) return;

  for (const [threadId, transcript] of Object.entries(transcripts)) {
    if (transcript.status !== "live") continue;

    if (threads[threadId]?.status === "running") continue;

    if (transcript === prevTranscripts[threadId] && prevThreads[threadId]?.status !== "running")
      continue;

    const dataId = getDataId(threadId);

    if (!dataId) continue;

    const { items, cursor, page } = transcript;
    saveTranscript(dataId, threadId, { items, cursor, page });
  }
}

store.watch(saveSettledTranscripts);

watchThreads(saveSettledTranscripts);
