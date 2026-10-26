import { ClientCommand, isTurnActive, type TurnOptions } from "@masscode/contracts";
import { getHostState, watchHosts } from "@/entities/host";
import { getThreadHost, getThreadState, queueMessage } from "@/entities/thread";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

/** A message written while the thread's daemon was unreachable; it goes out once it's back. */
export interface HeldMessage {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly options: TurnOptions;
  /** Queue it behind the running turn rather than steering it. */
  readonly queue: boolean;
}

const NO_MESSAGES: ReadonlyArray<HeldMessage> = [];

const store = createStore<ReadonlyArray<HeldMessage>>(NO_MESSAGES);

export function isThreadHostConnected(threadId: string) {
  const host = getThreadHost(threadId);
  const state = getHostState();

  return host === null ? state.connected : state.hosts[host]?.connected === true;
}

export function useHeldMessages(threadId: string) {
  const held = store.useStore((messages) => messages);

  return held.some((message) => message.threadId === threadId)
    ? held.filter((message) => message.threadId === threadId)
    : NO_MESSAGES;
}

export function holdMessage(message: Omit<HeldMessage, "id">) {
  store.setState([...store.getState(), { ...message, id: crypto.randomUUID() }]);
}

/** Takes a held message back out, so it never sends. */
export function takeHeldMessage(id: string) {
  const message = store.getState().find((candidate) => candidate.id === id);
  store.setState(store.getState().filter((candidate) => candidate.id !== id));

  return message;
}

function sendHeldMessage({ threadId, text, options, queue }: HeldMessage) {
  const status = getThreadState().threads[threadId]?.status;

  if (queue && status !== undefined && isTurnActive(status)) queueMessage(threadId, text, options);
  else send(ClientCommand.cases["thread.send"].make({ threadId, text, options }));
}

watchHosts(() => {
  const held = store.getState();

  if (!held.length) return;

  const ready = held.filter((message) => isThreadHostConnected(message.threadId));

  if (!ready.length) return;

  store.setState(held.filter((message) => !ready.includes(message)));

  for (const message of ready) sendHeldMessage(message);
});
