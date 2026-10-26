import {
  ClientCommand,
  findFileRestoreBlocker,
  isTurnActive,
  type ProviderKind,
  type QueuedMessage,
  RuntimeEvent,
  type SlashCommand,
  type ThreadInfo,
  type TurnOptions,
  type Workspace,
} from "@masscode/contracts";
import { reduceThreads } from "@masscode/client";
import {
  findPendingPathHost,
  findProjectHostForPath,
  getProjectHost,
  isProjectOnHost,
  useProjectStore,
} from "@/entities/project/@x/thread";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

interface ThreadsState {
  readonly order: ReadonlyArray<string>;
  /** The thread list. Transcripts live apart, so streaming text doesn't re-render the sidebar. */
  readonly threads: Readonly<Record<string, ThreadInfo>>;
  /** A thread for this window to switch to: one it created or forked, or a link followed. */
  readonly switchTo: { readonly threadId: string } | null;
  /** The message this window asked to fork from, until the fork appears; `error` says why it didn't. */
  readonly forking: {
    readonly threadId: string;
    readonly messageId: string;
    readonly error: string | null;
  } | null;
  /** Slash commands per thread, fetched when the command menu opens. */
  readonly commands: Readonly<Record<string, ReadonlyArray<SlashCommand>>>;
  /** Threads whose usage is being read from their harness's log. */
  readonly readingUsage: Readonly<Record<string, boolean>>;
}

const store = createStore<ThreadsState>({
  order: [],
  threads: {},
  switchTo: null,
  forking: null,
  commands: {},
  readingUsage: {},
});

export const useThreadStore = store.useStore;

export const getThreadState = store.getState;

export const setThreadState = store.setState;

export const watchThreads = store.watch;

/**
 * `thread.create` and `thread.fork` commands sent from this window, by request id. A fork has
 * no options of its own to start its composer from.
 */
const ownRequests = new Map<
  string,
  { readonly shouldOpen: boolean; readonly options?: TurnOptions }
>();

/** What threads created here sent their first message with, so their composer starts from the draft's picks. */
const firstOptions = new Map<string, TurnOptions>();

export function findFirstTurnOptions(threadId: string) {
  return firstOptions.get(threadId);
}

/** The remote host a thread runs on; null for this Mac. */
export function getThreadHost(threadId: string): string | null {
  const projectId = store.getState().threads[threadId]?.projectId;

  return projectId ? getProjectHost(projectId) : null;
}

/** Whether a thread is on `host` (null: this Mac). */
export function isThreadOnHost(host: string | null, info: ThreadInfo) {
  return isProjectOnHost(host, info.projectId);
}

export function useThreadHost(threadId: string) {
  const projectId = store.useStore((state) => state.threads[threadId]?.projectId);

  return useProjectStore((state) => (projectId && state.projectHosts[projectId]) || null);
}

/** The host a folder is on: the project or thread folder it's in, longest match first. */
export function findPathHost(path: string): string | null {
  const projectHost = findProjectHostForPath(path);

  if (projectHost !== undefined) return projectHost;

  const thread = Object.values(store.getState().threads)
    .filter((candidate) => path === candidate.cwd || path.startsWith(`${candidate.cwd}/`))
    .sort((left, right) => right.cwd.length - left.cwd.length)[0];

  if (thread) return getThreadHost(thread.id);

  return findPendingPathHost(path);
}

export function usePathHost(path: string | null) {
  function find() {
    return path === null ? null : findPathHost(path);
  }

  // Both lists decide the answer, so it's worked out again when either changes.
  useProjectStore(find);

  return store.useStore(find);
}

/** Why this thread can't rewind its files, or null when it can; only threads on its host share its folders. */
export function useFileRestoreBlocker(threadId: string) {
  const projectHosts = useProjectStore((state) => state.projectHosts);

  return store.useStore((state) => {
    const thread = state.threads[threadId];

    if (!thread) return null;

    const host = (thread.projectId && projectHosts[thread.projectId]) || null;

    return findFileRestoreBlocker(
      thread,
      Object.values(state.threads).filter(
        (other) => (projectHosts[other.projectId] ?? null) === host,
      ),
    );
  });
}

/** The host a command is for: that of the thread, project or folder it names. */
export function findCommandHost(command: ClientCommand): string | null {
  if ("threadId" in command) return getThreadHost(command.threadId);

  if ("projectId" in command) return getProjectHost(command.projectId);

  if ("path" in command) return findPathHost(command.path);

  return null;
}

function updateThreadInfo(
  state: ThreadsState,
  threadId: string,
  update: (info: ThreadInfo) => ThreadInfo,
): ThreadsState {
  const info = state.threads[threadId];

  if (!info) return state;

  return { ...state, threads: { ...state.threads, [threadId]: update(info) } };
}

/** Adds a thread the daemon created, switching to it when this window asked for it; true if it did. */
export function addCreatedThread(thread: ThreadInfo, requestId: string | null) {
  const state = store.getState();
  const request = requestId === null ? undefined : ownRequests.get(requestId);

  if (requestId !== null) ownRequests.delete(requestId);

  if (request?.options) firstOptions.set(thread.id, request.options);

  store.setState({
    ...state,
    forking: request ? null : state.forking,
    switchTo: request?.shouldOpen ? { threadId: thread.id } : state.switchTo,
    order: [thread.id, ...state.order.filter((id) => id !== thread.id)],
    threads: { ...state.threads, [thread.id]: thread },
  });
}

export function removeThreadInfo(threadId: string) {
  const state = store.getState();
  const { [threadId]: _thread, ...threads } = state.threads;

  store.setState({ ...state, order: state.order.filter((id) => id !== threadId), threads });
}

/** Thread-list events: everything about a thread but its transcript. */
export function applyThreadInfoEvent(event: RuntimeEvent) {
  const state = store.getState();

  RuntimeEvent.matchOrElse(
    event,
    {
      "thread.commands": ({ threadId, commands }) =>
        store.setState({ ...state, commands: { ...state.commands, [threadId]: commands } }),
      "thread.usage": ({ threadId, usage }) => {
        const { [threadId]: _reading, ...readingUsage } = state.readingUsage;
        const next = { ...state, readingUsage };

        store.setState(
          usage ? updateThreadInfo(next, threadId, (info) => ({ ...info, usage })) : next,
        );
      },
    },
    () => {
      const threads = reduceThreads(state.threads, event);

      if (threads !== state.threads) store.setState({ ...state, threads });
    },
  );
}

/** A failed fork reports on the thread it was forked from. */
export function applyForkError(event: RuntimeEvent) {
  const { forking } = store.getState();

  if (
    RuntimeEvent.guards.error(event) &&
    forking?.error === null &&
    event.threadId === forking.threadId
  )
    store.setState({ ...store.getState(), forking: { ...forking, error: event.message } });
}

/**
 * Creates a thread from a draft by sending its first message. With `shouldOpen`, this window
 * switches to it once it exists.
 */
export function createThread(input: {
  path: string;
  provider: ProviderKind;
  model: string | null;
  text: string;
  options: TurnOptions;
  workspace: Workspace;
  /** New worktrees only: the local branch to start from. */
  baseBranch?: string;
  shouldOpen?: boolean;
}) {
  const { shouldOpen = true, ...command } = input;
  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { shouldOpen, options: command.options });
  send(ClientCommand.cases["thread.create"].make({ requestId, ...command }));
}

export function switchToThread(threadId: string) {
  store.setState({ ...store.getState(), switchTo: { threadId } });
}

/** Starts a new thread with the conversation through a message's turn, and switches to it. */
export function forkThread(threadId: string, messageId: string) {
  if (store.getState().forking?.error === null) return;

  const requestId = crypto.randomUUID();
  ownRequests.set(requestId, { shouldOpen: true });
  store.setState({ ...store.getState(), forking: { threadId, messageId, error: null } });
  send(ClientCommand.cases["thread.fork"].make({ threadId, messageId, requestId }));
}

/** Forgets a fork that failed, once its error has been seen. */
export function dismissForkError() {
  if (store.getState().forking?.error) store.setState({ ...store.getState(), forking: null });
}

/**
 * A message written while the agent works waits in the daemon (t3code's "queue"), then goes
 * out on its own after the agent's next tool call or when the turn ends.
 */
export function queueMessage(threadId: string, text: string, options: TurnOptions) {
  send(ClientCommand.cases["thread.send"].make({ threadId, text, options, queue: true }));
}

/** Sends a queued message right away, into the running turn. */
export function sendQueuedNow(threadId: string, messageId: string) {
  send(ClientCommand.cases["thread.sendQueued"].make({ threadId, messageId }));
}

/** Takes queued messages back out (all of them without `messageId`), for the composer. */
export function takeQueued(threadId: string, messageId?: string): ReadonlyArray<QueuedMessage> {
  const queue = store.getState().threads[threadId]?.queue ?? [];
  const taken = messageId ? queue.filter((message) => message.id === messageId) : queue;

  if (taken.length)
    send(
      ClientCommand.cases["thread.unqueue"].make({
        threadId,
        messageIds: taken.map((message) => message.id),
      }),
    );

  return taken;
}

/** Threads asked about once per window: one that has nothing to read keeps having nothing. */
const usageRequested = new Set<string>();

export function readUsage(threadId: string) {
  if (usageRequested.has(threadId)) return;

  usageRequested.add(threadId);
  const state = store.getState();
  store.setState({ ...state, readingUsage: { ...state.readingUsage, [threadId]: true } });
  send(ClientCommand.cases["thread.readUsage"].make({ threadId }));
}

/** Nothing new (an error included) since you last opened the thread. */
export function isSeen(info: ThreadInfo) {
  return info.seenRev >= info.updatedAt;
}

/** Marks a thread's latest activity as seen, which clears its unread state. */
export function markSeen(threadId: string) {
  const info = store.getState().threads[threadId];

  if (info && !isSeen(info))
    send(ClientCommand.cases["thread.seen"].make({ threadId, rev: info.updatedAt }));
}

/** Shelve/Unshelve from the thread menu; holds until the thread's next turn starts. */
export function setShelved(threadId: string, shelved: boolean) {
  send(ClientCommand.cases["thread.shelve"].make({ threadId, shelved }));
}

/** Working threads, or ones waiting on you, can't be shelved by hand. */
export function canShelve(info: ThreadInfo) {
  return !isTurnActive(info.status);
}
