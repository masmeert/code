import { ServerFrame, type TerminalInfo } from "@masscode/contracts";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { accessSync, constants, existsSync } from "node:fs";
import { basename } from "node:path";
import { getErrorMessage } from "./errors.ts";

const IN_FLIGHT_CHARACTER_LIMIT = 128 * 1024;

/** How much of a run's output the agent gets: the end, where results and errors usually are. */
const RUN_OUTPUT_CHARACTER_LIMIT = 16 * 1024;

export interface TerminalViewer {
  send(frame: ServerFrame): void;
}

interface Attachment {
  inFlightCharacters: number;
  queued: Array<string>;
  queuedCharacters: number;
  isWaitingForSnapshot: boolean;
  isStale: boolean;
}

interface RunExit {
  readonly exitCode: number;
  readonly output: string;
  /** Closed by the user, the thread archiving or removal, rather than ending on its own. */
  readonly wasStopped: boolean;
}

interface TerminalSession extends TerminalInfo {
  readonly shell: Bun.Subprocess;
  /** Set on a run; left out, or once the daemon shuts down, its exit goes unreported. */
  onExit: ((exit: RunExit) => void) | null;
  isStopped: boolean;
  readonly screen: HeadlessTerminal;
  readonly serializer: SerializeAddon;
  readonly viewers: Map<TerminalViewer, Attachment>;
  readonly decoder: TextDecoder;
  pendingOutput: string;
  unparsedCharacters: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export type Terminals = ReturnType<typeof createTerminals>;

export function createTerminals(options: {
  findFolder(threadId: string): string | null;
  onOpened(terminal: TerminalInfo): void;
  onClosed(terminal: TerminalInfo): void;
}) {
  const sessions = new Map<string, TerminalSession>();

  // Every run's key, kept after it exits: a viewer attaching late must not start a shell in its place.
  const runs = new Set<string>();

  function getTerminalKey(threadId: string, terminalId: string) {
    return `${threadId}\u0000${terminalId}`;
  }

  function startShell(
    threadId: string,
    terminalId: string,
    columns: number,
    rows: number,
    run?: {
      readonly command: string;
      readonly onExit: (exit: RunExit) => void;
      readonly env?: Record<string, string>;
    },
  ): TerminalSession | Error {
    const folder = options.findFolder(threadId);
    if (folder === null) return new Error("This thread is gone.");
    if (!existsSync(folder)) return new Error(`The thread's folder is gone: ${folder}`);

    const shellPath =
      [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].find((candidate) => {
        if (!candidate) return false;
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }) ?? "/bin/sh";
    const shellName = basename(shellPath);

    const screen = new HeadlessTerminal({
      cols: columns,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    screen.loadAddon(new Unicode11Addon());
    screen.unicode.activeVersion = "11";

    try {
      const session: TerminalSession = {
        threadId,
        terminalId,
        ...(run && { command: run.command }),
        onExit: run?.onExit ?? null,
        isStopped: false,
        shell: Bun.spawn(
          [
            shellPath,
            ...(process.platform === "darwin" && (shellName === "zsh" || shellName === "bash")
              ? ["-l"]
              : []),
            // Interactive, so the rc files set up PATH, nvm and aliases as in the user's terminal.
            ...(run
              ? [...(shellName === "zsh" || shellName === "bash" ? ["-i"] : []), "-c", run.command]
              : shellName === "zsh"
                ? ["-o", "nopromptsp"]
                : []),
          ],
          {
            cwd: folder,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) =>
                    !/^(MASSCODE_|npm_|PNPM_|VSCODE_|ITERM_)|^(INIT_CWD|TMUX|TMUX_PANE|TERM_PROGRAM(_VERSION)?|TERM_SESSION_ID|COLUMNS|LINES)$/.test(
                      key,
                    ),
                ),
              ),
              LANG: process.env.LANG ?? "en_US.UTF-8",
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              TERM_PROGRAM: "MassCode",
              ...run?.env,
            },
            terminal: {
              cols: columns,
              rows,
              name: "xterm-256color",
              data: (_terminal, bytes) => bufferOutput(session, bytes),
            },
          },
        ),
        screen,
        serializer,
        viewers: new Map(),
        decoder: new TextDecoder(),
        pendingOutput: "",
        unparsedCharacters: 0,
        flushTimer: null,
      };

      sessions.set(getTerminalKey(threadId, terminalId), session);
      if (run) runs.add(getTerminalKey(threadId, terminalId));
      void session.shell.exited.then((exitCode) => handleShellExit(session, exitCode));
      options.onOpened({ threadId, terminalId, ...(run && { command: run.command }) });
      return session;
    } catch (error) {
      screen.dispose();
      return new Error(`Couldn't start ${shellPath}: ${getErrorMessage(error)}`);
    }
  }

  function bufferOutput(session: TerminalSession, bytes: Uint8Array) {
    session.pendingOutput += session.decoder.decode(bytes, { stream: true });
    session.flushTimer ??= setTimeout(() => flushOutput(session), 4);
  }

  function flushOutput(session: TerminalSession) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;

    const data = session.pendingOutput;
    if (!data) return;

    session.pendingOutput = "";
    if (session.unparsedCharacters < 16 * 1024 * 1024) {
      session.unparsedCharacters += data.length;
      session.screen.write(data, () => {
        session.unparsedCharacters -= data.length;
      });
    }

    for (const [viewer, attachment] of session.viewers)
      deliverOutput(session, viewer, attachment, data);
  }

  function deliverOutput(
    session: TerminalSession,
    viewer: TerminalViewer,
    attachment: Attachment,
    data: string,
  ) {
    if (attachment.isStale) return;

    if (
      !attachment.isWaitingForSnapshot &&
      attachment.queued.length === 0 &&
      attachment.inFlightCharacters < IN_FLIGHT_CHARACTER_LIMIT
    ) {
      attachment.inFlightCharacters += data.length;
      viewer.send(
        ServerFrame.cases["terminal.output"].make({
          threadId: session.threadId,
          terminalId: session.terminalId,
          data,
        }),
      );
      return;
    }

    attachment.queued.push(data);
    attachment.queuedCharacters += data.length;
    if (attachment.queuedCharacters > 1024 * 1024)
      Object.assign(attachment, { queued: [], queuedCharacters: 0, isStale: true });
  }

  function sendSnapshot(session: TerminalSession, viewer: TerminalViewer, attachment: Attachment) {
    Object.assign(attachment, {
      isWaitingForSnapshot: true,
      isStale: false,
      queued: [],
      queuedCharacters: 0,
    });

    session.screen.write("", () => {
      if (session.viewers.get(viewer) !== attachment) return;

      const data = session.serializer.serialize();
      Object.assign(attachment, { isWaitingForSnapshot: false, inFlightCharacters: data.length });
      viewer.send(
        ServerFrame.cases["terminal.snapshot"].make({
          threadId: session.threadId,
          terminalId: session.terminalId,
          data,
        }),
      );
    });
  }

  function resize(session: TerminalSession, columns: number, rows: number) {
    session.shell.terminal?.resize(columns, rows);
    session.screen.resize(columns, rows);
  }

  function handleShellExit(session: TerminalSession, exitCode: number) {
    flushOutput(session);
    session.shell.terminal?.close();
    // The screen parses writes asynchronously; an empty write's callback runs once it has caught up.
    session.screen.write("", () => {
      session.onExit?.({
        exitCode,
        output: getPrintedText(session.screen),
        wasStopped: session.isStopped,
      });
      session.screen.dispose();

      const key = getTerminalKey(session.threadId, session.terminalId);
      if (sessions.get(key) !== session) return;

      sessions.delete(key);
      options.onClosed({ threadId: session.threadId, terminalId: session.terminalId });
    });
  }

  function close(threadId: string, terminalId: string) {
    const session = sessions.get(getTerminalKey(threadId, terminalId));
    if (!session) return;

    session.isStopped = true;
    session.shell.kill("SIGHUP");
    setTimeout(() => {
      if (sessions.get(getTerminalKey(threadId, terminalId)) === session)
        session.shell.kill("SIGKILL");
    }, 1000);
  }

  return {
    list(): Array<TerminalInfo> {
      return [...sessions.values()].map(({ threadId, terminalId, command }) => ({
        threadId,
        terminalId,
        ...(command !== undefined && { command }),
      }));
    },
    /** Runs `command` in the thread's folder, with `env` on top of the daemon's; `onExit` gets how it ended. */
    run(
      threadId: string,
      terminalId: string,
      command: string,
      columns: number,
      rows: number,
      onExit: (exit: RunExit) => void,
      env?: Record<string, string>,
    ): Error | null {
      if (
        sessions.has(getTerminalKey(threadId, terminalId)) ||
        runs.has(getTerminalKey(threadId, terminalId))
      )
        return new Error("That command is already running.");

      const session = startShell(threadId, terminalId, columns, rows, {
        command,
        onExit,
        ...(env && { env }),
      });
      return session instanceof Error ? session : null;
    },
    attach(
      threadId: string,
      terminalId: string,
      columns: number,
      rows: number,
      viewer: TerminalViewer,
      input?: string,
    ) {
      const existing = sessions.get(getTerminalKey(threadId, terminalId));
      if (existing) resize(existing, columns, rows);

      const session =
        existing ??
        (runs.has(getTerminalKey(threadId, terminalId))
          ? new Error("This command already finished.")
          : startShell(threadId, terminalId, columns, rows));
      // The pty holds it until the shell reads its first line.
      if (!existing && input && !(session instanceof Error))
        session.shell.terminal?.write(`${input}\r`);

      if (session instanceof Error)
        return viewer.send(
          ServerFrame.cases["terminal.error"].make({
            threadId,
            terminalId,
            message: session.message,
          }),
        );

      flushOutput(session);
      const attachment: Attachment = {
        inFlightCharacters: 0,
        queued: [],
        queuedCharacters: 0,
        isWaitingForSnapshot: false,
        isStale: false,
      };
      session.viewers.set(viewer, attachment);
      sendSnapshot(session, viewer, attachment);
    },
    detach(threadId: string, terminalId: string, viewer: TerminalViewer) {
      sessions.get(getTerminalKey(threadId, terminalId))?.viewers.delete(viewer);
    },
    detachViewer(viewer: TerminalViewer) {
      for (const session of sessions.values()) session.viewers.delete(viewer);
    },
    acknowledge(threadId: string, terminalId: string, viewer: TerminalViewer, characters: number) {
      const session = sessions.get(getTerminalKey(threadId, terminalId));
      const attachment = session?.viewers.get(viewer);
      if (!session || !attachment) return;

      attachment.inFlightCharacters = Math.max(0, attachment.inFlightCharacters - characters);
      if (attachment.isStale) {
        if (attachment.inFlightCharacters === 0) sendSnapshot(session, viewer, attachment);
        return;
      }

      if (
        attachment.isWaitingForSnapshot ||
        attachment.queued.length === 0 ||
        attachment.inFlightCharacters >= IN_FLIGHT_CHARACTER_LIMIT
      )
        return;

      const data = attachment.queued.join("");
      Object.assign(attachment, {
        queued: [],
        queuedCharacters: 0,
        inFlightCharacters: attachment.inFlightCharacters + data.length,
      });
      viewer.send(ServerFrame.cases["terminal.output"].make({ threadId, terminalId, data }));
    },
    write(threadId: string, terminalId: string, data: string) {
      sessions.get(getTerminalKey(threadId, terminalId))?.shell.terminal?.write(data);
    },
    resize(threadId: string, terminalId: string, columns: number, rows: number) {
      const session = sessions.get(getTerminalKey(threadId, terminalId));
      if (session) resize(session, columns, rows);
    },
    close,
    closeThread(threadId: string) {
      for (const session of sessions.values())
        if (session.threadId === threadId) close(threadId, session.terminalId);
    },
    /** Closes the thread's shells sitting at a prompt with no one watching; runs and busy shells stay (as in t3code). */
    closeIdle(threadId: string) {
      for (const session of sessions.values()) {
        if (
          session.threadId !== threadId ||
          session.command !== undefined ||
          session.viewers.size > 0
        )
          continue;

        // A child process means the shell is running something: an editor, a dev server, a background job.
        // pgrep exits 1 only when it found none; anything else (or no pgrep at all) keeps the shell.
        try {
          if (Bun.spawnSync(["pgrep", "-P", String(session.shell.pid)]).exitCode !== 1) continue;
        } catch {
          continue;
        }

        close(threadId, session.terminalId);
      }
    },
    closeAll() {
      for (const session of sessions.values()) {
        session.onExit = null;
        session.shell.kill("SIGHUP");
      }
    },
  };
}

/** The screen as plain text, wrapped lines joined back up; cut to its end when long. */
function getPrintedText(screen: HeadlessTerminal) {
  const buffer = screen.buffer.active;
  const lines: Array<string> = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }

  const text = lines.join("\n").replace(/^\n+/, "").trimEnd();
  return text.length > RUN_OUTPUT_CHARACTER_LIMIT ? text.slice(-RUN_OUTPUT_CHARACTER_LIMIT) : text;
}
