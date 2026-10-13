import {
  prependPage,
  reduceItems,
  reduceThreads,
  replayTranscript,
  snapshotTranscript,
  type Transcript,
} from "@masscode/client";
import {
  RuntimeEvent,
  type ServerFrame,
  type SlashCommand,
  type ThreadInfo,
} from "@masscode/contracts";
import { create } from "zustand";

type Threads = Readonly<Record<string, ThreadInfo>>;

interface State {
  /** Each host's threads, by host id. */
  readonly threads: Readonly<Record<string, Threads>>;
  /** Slash commands per thread, by host id, fetched when a `/` command starts. */
  readonly commands: Readonly<
    Record<string, Readonly<Record<string, ReadonlyArray<SlashCommand>>>>
  >;
  /** By `transcriptKey`. */
  readonly transcripts: Readonly<Record<string, Transcript>>;
}

const NO_THREADS: Threads = {};

export const useThreadStore = create<State>()(() => ({
  threads: {},
  commands: {},
  transcripts: {},
}));

export function transcriptKey(hostId: string, threadId: string) {
  return `${hostId}/${threadId}`;
}

export function setTranscript(hostId: string, threadId: string, transcript: Transcript) {
  useThreadStore.setState((state) => ({
    transcripts: { ...state.transcripts, [transcriptKey(hostId, threadId)]: transcript },
  }));
}

export function getTranscript(hostId: string, threadId: string) {
  return useThreadStore.getState().transcripts[transcriptKey(hostId, threadId)];
}

function dropHostTranscripts(transcripts: State["transcripts"], hostId: string) {
  return Object.fromEntries(
    Object.entries(transcripts).filter(([key]) => !key.startsWith(`${hostId}/`)),
  );
}

/** The host's threads from its shell; `keepsTranscripts` is false when they belong to another database. */
export function applyThreadShell(
  hostId: string,
  shell: Extract<ServerFrame, { _tag: "shell" }>,
  keepsTranscripts: boolean,
) {
  useThreadStore.setState((state) => ({
    transcripts: keepsTranscripts
      ? state.transcripts
      : dropHostTranscripts(state.transcripts, hostId),
    threads: {
      ...state.threads,
      [hostId]: Object.fromEntries(shell.threads.map((thread) => [thread.id, thread])),
    },
  }));
}

/** Everything about threads but transcripts, which arrive per thread. */
export function applyThreadEvent(hostId: string, event: RuntimeEvent) {
  useThreadStore.setState((state) => {
    const threads = state.threads[hostId] ?? NO_THREADS;

    return RuntimeEvent.matchOrElse<Partial<State>>(
      event,
      {
        "thread.created": ({ thread }) => ({
          threads: { ...state.threads, [hostId]: { ...threads, [thread.id]: thread } },
        }),
        "thread.commands": ({ threadId, commands }) => ({
          commands: {
            ...state.commands,
            [hostId]: { ...state.commands[hostId], [threadId]: commands },
          },
        }),
        "thread.removed": ({ threadId }) => {
          const { [threadId]: _removed, ...rest } = threads;

          return { threads: { ...state.threads, [hostId]: rest } };
        },
      },
      () => {
        const reduced = reduceThreads(threads, event);

        return reduced === threads ? state : { threads: { ...state.threads, [hostId]: reduced } };
      },
    );
  });
}

export function applyTranscriptEvent(
  hostId: string,
  id: number | null,
  event: RuntimeEvent & { readonly threadId: string },
) {
  const transcript = getTranscript(hostId, event.threadId);

  if (!transcript || (id !== null && id <= transcript.cursor)) return;

  setTranscript(hostId, event.threadId, {
    ...transcript,
    items: reduceItems(transcript.items, event, id),
    cursor: id ?? transcript.cursor,
  });
}

export function applyTranscriptSnapshot(
  hostId: string,
  snapshot: Extract<ServerFrame, { _tag: "thread.snapshot" }>,
) {
  setTranscript(hostId, snapshot.threadId, snapshotTranscript(snapshot));
}

export function applyTranscriptReplay(
  hostId: string,
  replay: Extract<ServerFrame, { _tag: "thread.replay" }>,
) {
  setTranscript(
    hostId,
    replay.threadId,
    replayTranscript(getTranscript(hostId, replay.threadId), replay),
  );
}

export function applyTranscriptPage(
  hostId: string,
  page: Extract<ServerFrame, { _tag: "thread.page" }>,
) {
  const previous = getTranscript(hostId, page.threadId);

  if (previous) setTranscript(hostId, page.threadId, prependPage(previous, page));
}

/** Kept on screen, marked cached until the next connection catches them up. */
export function markTranscriptsCached(hostId: string) {
  useThreadStore.setState((state) => ({
    transcripts: Object.fromEntries(
      Object.entries(state.transcripts).map(([key, transcript]) => [
        key,
        key.startsWith(`${hostId}/`) ? { ...transcript, status: "cached" as const } : transcript,
      ]),
    ),
  }));
}

/** Drops the host's threads, their commands and transcripts. */
export function forgetHostThreads(hostId: string) {
  useThreadStore.setState((state) => {
    const { [hostId]: _threads, ...threads } = state.threads;
    const { [hostId]: _commands, ...commands } = state.commands;

    return { threads, commands, transcripts: dropHostTranscripts(state.transcripts, hostId) };
  });
}
