import { ServerFrame, type TerminalInfo } from "@apcode/contracts";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { accessSync, constants, existsSync } from "node:fs";
import { basename } from "node:path";

const IN_FLIGHT_CHARACTER_LIMIT = 128 * 1024;

export interface TerminalViewer {
  send(frame: ServerFrame): void;
}

interface Attachment {
  inFlightCharacters: number;
  queued: Array<string>;
  queuedCharacters: number;
  waitingForSnapshot: boolean;
  stale: boolean;
}

interface TerminalSession extends TerminalInfo {
  readonly shell: Bun.Subprocess;
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
  folderOf(threadId: string): string | null;
  opened(terminal: TerminalInfo): void;
  closed(terminal: TerminalInfo): void;
}) {
  const sessions = new Map<string, TerminalSession>();

  function keyOf(threadId: string, terminalId: string) {
    return `${threadId}\u0000${terminalId}`;
  }

  function start(
    threadId: string,
    terminalId: string,
    columns: number,
    rows: number,
  ): TerminalSession | Error {
    const folder = options.folderOf(threadId);
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
        shell: Bun.spawn(
          [
            shellPath,
            ...(process.platform === "darwin" && (shellName === "zsh" || shellName === "bash")
              ? ["-l"]
              : []),
            ...(shellName === "zsh" ? ["-o", "nopromptsp"] : []),
          ],
          {
            cwd: folder,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) =>
                    !/^(APCODE_|npm_|PNPM_|VSCODE_|ITERM_)|^(INIT_CWD|TMUX|TMUX_PANE|TERM_PROGRAM(_VERSION)?|TERM_SESSION_ID|COLUMNS|LINES)$/.test(
                      key,
                    ),
                ),
              ),
              LANG: process.env.LANG ?? "en_US.UTF-8",
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              TERM_PROGRAM: "APCode",
            },
            terminal: {
              cols: columns,
              rows,
              name: "xterm-256color",
              data: (_terminal, bytes) => receive(session, bytes),
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
      sessions.set(keyOf(threadId, terminalId), session);
      void session.shell.exited.then(() => finish(session));
      options.opened({ threadId, terminalId });
      return session;
    } catch (error) {
      screen.dispose();
      return new Error(
        `Couldn't start ${shellPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function receive(session: TerminalSession, bytes: Uint8Array) {
    session.pendingOutput += session.decoder.decode(bytes, { stream: true });
    session.flushTimer ??= setTimeout(() => flush(session), 4);
  }

  function flush(session: TerminalSession) {
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
    for (const [viewer, attachment] of session.viewers) deliver(session, viewer, attachment, data);
  }

  function deliver(
    session: TerminalSession,
    viewer: TerminalViewer,
    attachment: Attachment,
    data: string,
  ) {
    if (attachment.stale) return;
    if (
      !attachment.waitingForSnapshot &&
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
      Object.assign(attachment, { queued: [], queuedCharacters: 0, stale: true });
  }

  function sendSnapshot(session: TerminalSession, viewer: TerminalViewer, attachment: Attachment) {
    Object.assign(attachment, {
      waitingForSnapshot: true,
      stale: false,
      queued: [],
      queuedCharacters: 0,
    });
    session.screen.write("", () => {
      if (session.viewers.get(viewer) !== attachment) return;
      const data = session.serializer.serialize();
      Object.assign(attachment, { waitingForSnapshot: false, inFlightCharacters: data.length });
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

  function finish(session: TerminalSession) {
    flush(session);
    session.shell.terminal?.close();
    session.screen.dispose();
    const key = keyOf(session.threadId, session.terminalId);
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    options.closed({ threadId: session.threadId, terminalId: session.terminalId });
  }

  function close(threadId: string, terminalId: string) {
    const session = sessions.get(keyOf(threadId, terminalId));
    if (!session) return;
    session.shell.kill("SIGHUP");
    setTimeout(() => {
      if (sessions.get(keyOf(threadId, terminalId)) === session) session.shell.kill("SIGKILL");
    }, 1000);
  }

  return {
    list(): Array<TerminalInfo> {
      return [...sessions.values()].map(({ threadId, terminalId }) => ({ threadId, terminalId }));
    },
    attach(
      threadId: string,
      terminalId: string,
      columns: number,
      rows: number,
      viewer: TerminalViewer,
    ) {
      const existing = sessions.get(keyOf(threadId, terminalId));
      if (existing) resize(existing, columns, rows);
      const session = existing ?? start(threadId, terminalId, columns, rows);
      if (session instanceof Error)
        return viewer.send(
          ServerFrame.cases["terminal.error"].make({
            threadId,
            terminalId,
            message: session.message,
          }),
        );
      flush(session);
      const attachment: Attachment = {
        inFlightCharacters: 0,
        queued: [],
        queuedCharacters: 0,
        waitingForSnapshot: false,
        stale: false,
      };
      session.viewers.set(viewer, attachment);
      sendSnapshot(session, viewer, attachment);
    },
    detach(threadId: string, terminalId: string, viewer: TerminalViewer) {
      sessions.get(keyOf(threadId, terminalId))?.viewers.delete(viewer);
    },
    detachViewer(viewer: TerminalViewer) {
      for (const session of sessions.values()) session.viewers.delete(viewer);
    },
    acknowledge(threadId: string, terminalId: string, viewer: TerminalViewer, characters: number) {
      const session = sessions.get(keyOf(threadId, terminalId));
      const attachment = session?.viewers.get(viewer);
      if (!session || !attachment) return;
      attachment.inFlightCharacters = Math.max(0, attachment.inFlightCharacters - characters);
      if (attachment.stale) {
        if (attachment.inFlightCharacters === 0) sendSnapshot(session, viewer, attachment);
        return;
      }
      if (
        attachment.waitingForSnapshot ||
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
      sessions.get(keyOf(threadId, terminalId))?.shell.terminal?.write(data);
    },
    resize(threadId: string, terminalId: string, columns: number, rows: number) {
      const session = sessions.get(keyOf(threadId, terminalId));
      if (session) resize(session, columns, rows);
    },
    close,
    closeThread(threadId: string) {
      for (const session of sessions.values())
        if (session.threadId === threadId) close(threadId, session.terminalId);
    },
    closeAll() {
      for (const session of sessions.values()) session.shell.kill("SIGHUP");
    },
  };
}
