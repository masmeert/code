import { ClientCommand, isTurnActive, RuntimeEvent } from "@masscode/contracts";
import { reduceItems, type TranscriptItem } from "@masscode/client";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

/** The side chat (BTW) open in this window: read-only questions about one reply, gone once closed. */
interface SideChat {
  readonly id: string;
  readonly threadId: string;
  /** The reply it's about. */
  readonly messageId: string;
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly running: boolean;
}

const store = createStore<{ readonly sideChat: SideChat | null }>({ sideChat: null });

/** The side chat open on `threadId`, if any. */
export function useSideChat(threadId: string) {
  return store.useStore((state) => (state.sideChat?.threadId === threadId ? state.sideChat : null));
}

/** Ends `threadId`'s side chat for good, stopping its agent. */
export function closeSideChat(threadId: string) {
  const { sideChat } = store.getState();

  if (sideChat?.threadId !== threadId) return;

  store.setState({ sideChat: null });
  send(
    ClientCommand.cases["sideChat.close"].make({
      threadId: sideChat.threadId,
      sideChatId: sideChat.id,
    }),
  );
}

export function openSideChat(threadId: string, messageId: string) {
  const { sideChat } = store.getState();

  if (sideChat) closeSideChat(sideChat.threadId);
  store.setState({
    sideChat: { id: crypto.randomUUID(), threadId, messageId, items: [], running: false },
  });
}

export function askSideChat(text: string) {
  const { sideChat } = store.getState();

  if (!sideChat || sideChat.running) return;

  store.setState({ sideChat: { ...sideChat, running: true } });
  send(
    ClientCommand.cases["sideChat.ask"].make({
      threadId: sideChat.threadId,
      messageId: sideChat.messageId,
      sideChatId: sideChat.id,
      text,
    }),
  );
}

/** Takes the open side chat's events, which come keyed by its id; false for any other event. */
export function receiveSideChatEvent(event: RuntimeEvent, id: number | null) {
  const { sideChat } = store.getState();

  if (!sideChat || !("threadId" in event) || event.threadId !== sideChat.id) return false;

  store.setState({
    sideChat: RuntimeEvent.guards["thread.status"](event)
      ? { ...sideChat, running: isTurnActive(event.status) }
      : { ...sideChat, items: reduceItems(sideChat.items, event, id) },
  });

  return true;
}
