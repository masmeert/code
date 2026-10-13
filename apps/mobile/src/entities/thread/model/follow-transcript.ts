import type { TranscriptItem } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { send } from "@/shared/api";
import { getTranscript, setTranscript, transcriptKey } from "./thread-store.ts";

/** Latest turns loaded when a thread opens, and per "load earlier", as on the desktop. */
const TURN_LIMIT = 10;

const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];

/** Transcripts on screen, by `transcriptKey`, with how many screens show each. */
const wanted = new Map<string, number>();

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

/** Subscribes again to the host's transcripts on screen, from where each left off. */
export function resubscribeTranscripts(hostId: string) {
  for (const key of wanted.keys())
    if (key.startsWith(`${hostId}/`)) subscribeToTranscript(hostId, key.slice(hostId.length + 1));
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
