import {
  ClientCommand,
  type ProjectScript,
  RuntimeEvent,
  ServerFrame,
  type ThreadInfo,
  type TurnOptions,
} from "@masscode/contracts";
import { send, sendIfConnected } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

export interface RunningCommand {
  readonly terminalId: string;
  readonly command: string;
}

interface TerminalsState {
  readonly terminals: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly activeTerminals: Readonly<Record<string, string>>;
  /** Commands from agents' replies still running, per thread; shown in the transcript, not the terminal panel. */
  readonly runs: Readonly<Record<string, ReadonlyArray<RunningCommand>>>;
  /** Plain shells running a program in the foreground, per thread. */
  readonly busy: Readonly<Record<string, ReadonlyArray<string>>>;
}

interface TerminalScreen {
  readonly threadId: string;
  readonly terminalId: string;
  readonly size: () => { readonly columns: number; readonly rows: number };
  readonly reset: (data: string) => void;
  readonly write: (data: string) => void;
  readonly fail: (message: string) => void;
}

const store = createStore<TerminalsState>({
  terminals: {},
  activeTerminals: {},
  runs: {},
  busy: {},
});

export const useTerminalStore = store.useStore;

const screens = new Map<string, TerminalScreen>();

function getScreenKey(threadId: string, terminalId: string) {
  return `${threadId}:${terminalId}`;
}

/** What to type into a terminal's shell when the daemon starts it, by terminal id. */
const terminalInputs = new Map<string, string>();

/** The script each script's terminal runs, by terminal id; its tab is named after it. */
const terminalScripts = new Map<string, ProjectScript>();

export function findTerminalScript(terminalId: string) {
  return terminalScripts.get(terminalId);
}

/** The thread's terminal already running the script named `scriptName`, if any. */
export function findScriptTerminal(threadId: string, scriptName: string) {
  return store
    .getState()
    .terminals[threadId]?.find(
      (terminalId) => terminalScripts.get(terminalId)?.name === scriptName,
    );
}

function removeTerminal(
  state: TerminalsState,
  threadId: string,
  terminalId: string,
): TerminalsState {
  const terminalIds = state.terminals[threadId] ?? [];
  const remaining = terminalIds.filter((id) => id !== terminalId);
  const { [threadId]: active, ...activeTerminals } = state.activeTerminals;

  const nextActive =
    active === terminalId
      ? (remaining[terminalIds.indexOf(terminalId)] ?? remaining.at(-1))
      : active;

  return {
    terminals: { ...state.terminals, [threadId]: remaining },
    activeTerminals: nextActive ? { ...activeTerminals, [threadId]: nextActive } : activeTerminals,
    runs: {
      ...state.runs,
      [threadId]: (state.runs[threadId] ?? []).filter((run) => run.terminalId !== terminalId),
    },
    busy: {
      ...state.busy,
      [threadId]: (state.busy[threadId] ?? []).filter((id) => id !== terminalId),
    },
  };
}

function openScreen(screen: TerminalScreen) {
  const input = terminalInputs.get(screen.terminalId);
  const script = terminalScripts.get(screen.terminalId)?.name;
  sendIfConnected(
    ClientCommand.cases["terminal.open"].make({
      threadId: screen.threadId,
      terminalId: screen.terminalId,
      ...screen.size(),
      ...(input !== undefined && { input }),
      ...(script !== undefined && { script }),
    }),
  );
}

export function attachTerminal(screen: TerminalScreen) {
  const key = getScreenKey(screen.threadId, screen.terminalId);
  screens.set(key, screen);
  openScreen(screen);

  return () => {
    if (screens.get(key) !== screen) return;
    screens.delete(key);
    sendIfConnected(
      ClientCommand.cases["terminal.detach"].make({
        threadId: screen.threadId,
        terminalId: screen.terminalId,
      }),
    );
  };
}

export function showTerminal(threadId: string, terminalId: string) {
  const state = store.getState();
  store.setState({
    ...state,
    activeTerminals: { ...state.activeTerminals, [threadId]: terminalId },
  });
}

export function createTerminal(threadId: string, script?: ProjectScript) {
  const terminalId = crypto.randomUUID();

  if (script) {
    terminalInputs.set(terminalId, script.command);
    terminalScripts.set(terminalId, script);
  }

  const state = store.getState();
  store.setState({
    ...state,
    terminals: {
      ...state.terminals,
      [threadId]: [...(state.terminals[threadId] ?? []), terminalId],
    },
    activeTerminals: { ...state.activeTerminals, [threadId]: terminalId },
  });
}

export function toggleTerminalPanel(threadId: string) {
  const state = store.getState();

  if (state.activeTerminals[threadId]) {
    const { [threadId]: _hidden, ...activeTerminals } = state.activeTerminals;

    return store.setState({ ...state, activeTerminals });
  }

  const latest = state.terminals[threadId]?.at(-1);

  if (latest) showTerminal(threadId, latest);
  else createTerminal(threadId);
}

/**
 * Runs a command from an agent's reply in a terminal of its own, shown under the transcript once
 * the daemon has started it; when it exits, its output goes to the agent as the next message.
 */
export function runCommand(threadId: string, command: string, options: TurnOptions) {
  send(
    ClientCommand.cases["terminal.run"].make({
      threadId,
      terminalId: crypto.randomUUID(),
      command,
      columns: 100,
      rows: 12,
      options,
    }),
  );
}

/** Also stops a running command, without telling its agent. */
export function closeTerminal(threadId: string, terminalId: string) {
  terminalInputs.delete(terminalId);
  terminalScripts.delete(terminalId);
  send(ClientCommand.cases["terminal.close"].make({ threadId, terminalId }));
  store.setState(removeTerminal(store.getState(), threadId, terminalId));
}

export function receiveTerminalFrame(
  frame: Extract<ServerFrame, { _tag: "terminal.snapshot" | "terminal.output" | "terminal.error" }>,
) {
  const screen = screens.get(getScreenKey(frame.threadId, frame.terminalId));

  ServerFrame.matchOrElse(
    frame,
    {
      "terminal.snapshot": ({ data }) => screen?.reset(data),
      "terminal.output": ({ data }) => screen?.write(data),
      "terminal.error": ({ message }) => screen?.fail(message),
    },
    () => {},
  );
}

export function applyTerminalEvent(event: RuntimeEvent) {
  const state = store.getState();

  RuntimeEvent.matchOrElse(
    event,
    {
      "terminal.opened": ({ threadId, terminalId, command }) => {
        if (command !== undefined) {
          const running = state.runs[threadId] ?? [];

          if (running.some((run) => run.terminalId === terminalId)) return;

          return store.setState({
            ...state,
            runs: { ...state.runs, [threadId]: [...running, { terminalId, command }] },
          });
        }

        const terminalIds = state.terminals[threadId] ?? [];

        if (terminalIds.includes(terminalId)) return;

        store.setState({
          ...state,
          terminals: { ...state.terminals, [threadId]: [...terminalIds, terminalId] },
        });
      },
      "terminal.closed": ({ threadId, terminalId }) =>
        store.setState(removeTerminal(state, threadId, terminalId)),
      "terminal.busy": ({ threadId, terminalId, busy }) => {
        const others = (state.busy[threadId] ?? []).filter((id) => id !== terminalId);

        store.setState({
          ...state,
          busy: { ...state.busy, [threadId]: busy ? [...others, terminalId] : others },
        });
      },
      "thread.removed": ({ threadId }) => forgetThreads(new Set([threadId])),
    },
    () => {},
  );
}

/**
 * Keeps other hosts' terminals and takes the incoming threads' from the host's shell, along with
 * the ones this window has open on them. Returns those, to reopen once the shell is in.
 */
export function receiveShellTerminals(
  others: Readonly<Record<string, ThreadInfo>>,
  incoming: Readonly<Record<string, ThreadInfo>>,
  shellTerminals: ReadonlyArray<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly command?: string;
    readonly busy?: boolean;
  }>,
) {
  const state = store.getState();
  const terminals: Record<string, Array<string>> = {};

  for (const [threadId, terminalIds] of Object.entries(state.terminals)) {
    if (others[threadId]) terminals[threadId] = [...terminalIds];
  }

  const runs: Record<string, Array<RunningCommand>> = {};

  for (const [threadId, running] of Object.entries(state.runs)) {
    if (others[threadId]) runs[threadId] = [...running];
  }

  for (const { threadId, terminalId, command } of shellTerminals) {
    if (command !== undefined) (runs[threadId] ??= []).push({ terminalId, command });
  }

  // A run that ended while disconnected is simply gone; its window must not come back as a tab.
  const ownScreens = [...screens.values()].filter(
    (screen) =>
      incoming[screen.threadId] &&
      !state.runs[screen.threadId]?.some((run) => run.terminalId === screen.terminalId),
  );

  for (const { threadId, terminalId } of [
    ...shellTerminals.filter((terminal) => terminal.command === undefined),
    ...ownScreens,
  ]) {
    if (!terminals[threadId]?.includes(terminalId)) (terminals[threadId] ??= []).push(terminalId);
  }

  const busy: Record<string, Array<string>> = {};

  for (const [threadId, terminalIds] of Object.entries(state.busy)) {
    if (others[threadId]) busy[threadId] = [...terminalIds];
  }

  for (const { threadId, terminalId, busy: isBusy } of shellTerminals)
    if (isBusy) (busy[threadId] ??= []).push(terminalId);

  store.setState({
    terminals,
    runs,
    busy,
    activeTerminals: Object.fromEntries(
      Object.entries(state.activeTerminals).flatMap(([threadId, terminalId]) => {
        const active = terminals[threadId]?.includes(terminalId)
          ? terminalId
          : terminals[threadId]?.at(-1);

        return active ? [[threadId, active]] : [];
      }),
    ),
  });

  return ownScreens;
}

export function reopenScreens(reopened: ReadonlyArray<TerminalScreen>) {
  for (const screen of reopened) openScreen(screen);
}

/** Drops these threads' terminals and runs. */
export function forgetThreads(threadIds: ReadonlySet<string>) {
  function dropThreads<A>(record: Readonly<Record<string, A>>) {
    return Object.fromEntries(
      Object.entries(record).filter(([threadId]) => !threadIds.has(threadId)),
    );
  }

  const state = store.getState();
  store.setState({
    terminals: dropThreads(state.terminals),
    activeTerminals: dropThreads(state.activeTerminals),
    runs: dropThreads(state.runs),
    busy: dropThreads(state.busy),
  });
}
