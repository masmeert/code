import { RuntimeEvent, type ThreadInfo } from "@masscode/contracts";
import type { Transcript } from "@masscode/client";
import { removeTranscript } from "@/shared/cache";
import {
  addCreatedThread,
  applyThreadInfoEvent,
  getThreadState,
  isThreadOnHost,
  removeThreadInfo,
  setThreadState,
} from "./thread-store.ts";
import {
  dropTranscript,
  getTranscripts,
  setTranscripts,
  startLiveTranscript,
} from "./transcript-store.ts";

export function applyThreadEvent(event: RuntimeEvent) {
  RuntimeEvent.matchOrElse(
    event,
    {
      "thread.created": ({ thread, requestId, hasTranscript }) => {
        addCreatedThread(thread, requestId);

        // A fork's transcript loads like any other's once it's opened.
        if (!hasTranscript) startLiveTranscript(thread.id);
      },
      "thread.removed": ({ threadId }) => {
        // Its cache is found through its host, so it goes before the thread does.
        dropTranscript(threadId);
        removeThreadInfo(threadId);
      },
    },
    () => applyThreadInfoEvent(event),
  );
}

/**
 * Replaces one host's threads with what its daemon sent; other hosts' stay. Transcripts of threads
 * that still exist are kept, to resume from their cursor. Returns the threads on other hosts and
 * the incoming ones, by id.
 */
export function receiveShellThreads(
  host: string | null,
  incomingThreads: ReadonlyArray<ThreadInfo>,
  shell: { readonly dataId: string; readonly isSameData: boolean },
) {
  const state = getThreadState();
  const incoming = Object.fromEntries(incomingThreads.map((info) => [info.id, info]));

  const others = Object.fromEntries(
    Object.entries(state.threads).filter(([, info]) => !isThreadOnHost(host, info)),
  );

  const threads = { ...others, ...incoming };
  const transcripts: Record<string, Transcript> = {};

  for (const [threadId, transcript] of Object.entries(getTranscripts())) {
    if (others[threadId] || (shell.isSameData && incoming[threadId]))
      transcripts[threadId] = transcript;
    else if (shell.isSameData) removeTranscript(shell.dataId, threadId);
  }

  setThreadState({
    ...state,
    order: Object.values(threads)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((thread) => thread.id),
    threads,
  });
  setTranscripts(transcripts);

  return { others, incoming };
}

/** Drops a removed host's threads and their transcripts; returns their ids. */
export function forgetHostThreads(host: string) {
  const state = getThreadState();

  const gone = new Set(
    Object.values(state.threads)
      .filter((info) => isThreadOnHost(host, info))
      .map((info) => info.id),
  );

  function dropGoneThreads<A>(record: Readonly<Record<string, A>>) {
    return Object.fromEntries(Object.entries(record).filter(([threadId]) => !gone.has(threadId)));
  }

  // Transcripts first: a settled one whose thread is already gone would be saved under the wrong host.
  setTranscripts(dropGoneThreads(getTranscripts()));
  setThreadState({
    ...state,
    order: state.order.filter((id) => !gone.has(id)),
    threads: dropGoneThreads(state.threads),
  });

  return gone;
}

/** Shows the last run's thread list until the daemon answers. */
export function showCachedThreads(
  order: ReadonlyArray<string>,
  threads: Readonly<Record<string, ThreadInfo>>,
) {
  setThreadState({ ...getThreadState(), order, threads });
}
