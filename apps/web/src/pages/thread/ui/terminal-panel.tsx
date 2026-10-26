import { ClientCommand } from "@masscode/contracts";
import { ResizeHandle } from "@masmeert/ui/resize-handle";
import { cn } from "@masscode/ui/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { IconChevronDown, IconPlus, IconTerminal2, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import symbolsFontUrl from "./symbols-nerd-font-mono.woff2";
import { IconButton } from "@/shared/ui";
import { formatKeybinding } from "@/shared/lib/keybindings";
import { isLocalUrl, openTab } from "@/entities/browser";
import { focusComposer } from "@/widgets/composer";
import {
  attachTerminal,
  closeTerminal,
  createTerminal,
  findTerminalScript,
  showTerminal,
  toggleTerminalPanel,
  useTerminalStore,
} from "@/entities/terminal";
import { sendIfConnected } from "@/shared/api";
import { useResizableSize } from "@masmeert/ui/hooks/use-resizable";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { closeOnEscape } from "../lib/close-on-escape.ts";

const symbolsFont = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);

document.fonts.add(symbolsFont);

/**
 * The app's colours for the surface and the hues it shares with the terminal palette (red, green,
 * yellow); the rest of the ANSI palette has no app colour to follow. xterm only reads opaque colours
 * from CSS, so the translucent selection and scrollbar stay as they are.
 */
function getTerminalTheme(): ITheme {
  const tokens = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("dark");

  function readToken(name: string) {
    return tokens.getPropertyValue(name).trim();
  }

  const background = readToken("--background");
  const brand = readToken("--brand");

  return {
    background,
    foreground: readToken("--foreground"),
    cursor: brand,
    cursorAccent: background,
    red: readToken("--destructive"),
    green: readToken("--success"),
    yellow: brand,
    ...(isDark
      ? {
          selectionBackground: "rgba(255, 255, 255, 0.15)",
          scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
          scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.2)",
          scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.28)",
          black: "#484f58",
          blue: "#58a6ff",
          magenta: "#bc8cff",
          cyan: "#39c5cf",
          white: "#b1bac4",
          brightBlack: "#6e7681",
          brightRed: "#ffa198",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd",
          brightWhite: "#ffffff",
        }
      : {
          selectionBackground: "rgba(182, 96, 40, 0.2)",
          scrollbarSliderBackground: "rgba(0, 0, 0, 0.12)",
          scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.2)",
          scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.28)",
          black: "#24292f",
          blue: "#0969da",
          magenta: "#8250df",
          cyan: "#1b7c83",
          white: "#6e7781",
          brightBlack: "#57606a",
          brightRed: "#a40e26",
          brightGreen: "#1a7f37",
          brightYellow: "#633c01",
          brightBlue: "#218bff",
          brightMagenta: "#a475f9",
          brightCyan: "#3192aa",
          brightWhite: "#8c959f",
        }),
  };
}

export function TerminalPanel({
  threadId,
  activeTerminal,
}: {
  threadId: string;
  activeTerminal: string;
}) {
  const terminalIds = useTerminalStore((state) => state.terminals[threadId]) ?? [];
  const busyTerminalIds = useTerminalStore((state) => state.busy[threadId]) ?? [];
  const section = useRef<HTMLElement>(null);
  // Closing a terminal that runs something, like a script's dev server, takes a second click.
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmingClose) return;

    const timer = window.setTimeout(() => setConfirmingClose(null), 4000);

    return () => window.clearTimeout(timer);
  }, [confirmingClose]);

  const panel = useResizableSize({
    key: "masscode.terminalHeight",
    initial: 288,
    side: "start",
    axis: "y",
    clamp: (height) =>
      Math.max(
        120,
        Math.min(
          height,
          (section.current?.parentElement?.clientHeight ?? window.innerHeight) - 200,
        ),
      ),
  });

  return (
    <section
      ref={section}
      aria-label="Terminal"
      style={{ height: panel.size }}
      onKeyDown={closeOnEscape(() => toggleTerminalPanel(threadId))}
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
    >
      <ResizeHandle
        side="start"
        axis="y"
        label="Resize terminal"
        value={panel.size}
        dragging={panel.dragging}
        {...panel.handleProps}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <div
          role="tablist"
          aria-label="Terminals"
          className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {terminalIds.map((terminalId, index) => {
            const script = findTerminalScript(terminalId);
            const name = script?.name ?? `Terminal ${index + 1}`;
            const isConfirming = confirmingClose === terminalId;
            const isRunning = script !== undefined || busyTerminalIds.includes(terminalId);

            return (
              <div
                key={terminalId}
                className={cn(
                  typeClass("caption"),
                  "group/tab flex h-7 shrink-0 items-center rounded-lg pr-0.5 transition-colors",
                  terminalId === activeTerminal
                    ? "bg-selected text-foreground"
                    : "text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={terminalId === activeTerminal}
                  onClick={() => showTerminal(threadId, terminalId)}
                  className="flex h-full items-center gap-1.5 rounded-lg pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <IconTerminal2 className="size-3.5" />
                  {name}
                </button>
                <button
                  type="button"
                  title={
                    script
                      ? `Stop ${name} and close its terminal`
                      : isRunning
                        ? "Stop the running program and close the terminal"
                        : "Close terminal"
                  }
                  aria-label={isConfirming ? `Click again to stop ${name}` : `Close ${name}`}
                  onClick={() => {
                    if (isRunning && !isConfirming) return setConfirmingClose(terminalId);
                    setConfirmingClose(null);
                    closeTerminal(threadId, terminalId);
                  }}
                  onBlur={() => isConfirming && setConfirmingClose(null)}
                  className={cn(
                    "grid h-6 min-w-6 place-items-center rounded-md transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                    isConfirming
                      ? "px-1.5 text-destructive opacity-100 hover:text-destructive"
                      : terminalId === activeTerminal
                        ? "opacity-100"
                        : "opacity-0 group-hover/tab:opacity-100",
                  )}
                >
                  {isConfirming ? `Click again to stop ${name}` : <IconX className="size-3" />}
                </button>
              </div>
            );
          })}
        </div>
        <IconButton label="New terminal" onClick={() => createTerminal(threadId)}>
          <IconPlus className="size-4" />
        </IconButton>
        <IconButton
          label={`Hide terminal (${formatKeybinding("terminal.toggle")})`}
          className="ml-auto"
          onClick={() => {
            toggleTerminalPanel(threadId);
            focusComposer();
          }}
        >
          <IconChevronDown className="size-4" />
        </IconButton>
      </div>
      <TerminalView key={activeTerminal} threadId={threadId} terminalId={activeTerminal} />
    </section>
  );
}

export function TerminalView({
  threadId,
  terminalId,
  autoFocus = true,
  className,
}: {
  threadId: string;
  terminalId: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isCancelled = false;
    let dispose = () => {};

    void symbolsFont
      .load()
      .catch(() => symbolsFont)
      .then(() => {
        if (isCancelled || !host.current) return;

        const terminal = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          fontFamily: '"SF Mono", Menlo, Monaco, "Symbols Nerd Font Mono", monospace',
          fontSize: 12,
          lineHeight: 1.2,
          scrollback: 5000,
          macOptionClickForcesSelection: true,
          minimumContrastRatio: 4.5,
          theme: getTerminalTheme(),
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = "11";
        terminal.loadAddon(
          new WebLinksAddon((event, uri) => {
            if (!event.metaKey && !event.ctrlKey) return;

            if (window.desktop && isLocalUrl(uri)) openTab(threadId, uri);
            else window.open(uri, "_blank");
          }),
        );
        terminal.open(host.current);

        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminal.loadAddon(webgl);
        } catch {}

        fitAddon.fit();

        let isReplaying = false;

        function acknowledge(characters: number) {
          sendIfConnected(
            ClientCommand.cases["terminal.acknowledge"].make({ threadId, terminalId, characters }),
          );
        }

        const detach = attachTerminal({
          threadId,
          terminalId,
          size: () => ({ columns: terminal.cols, rows: terminal.rows }),
          reset: (data) => {
            isReplaying = true;
            terminal.reset();
            terminal.write(data, () => {
              isReplaying = false;
              acknowledge(data.length);
            });
          },
          write: (data) => terminal.write(data, () => acknowledge(data.length)),
          fail: (message) => terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`),
        });

        terminal.onData((data) => {
          if (!isReplaying) {
            sendIfConnected(
              ClientCommand.cases["terminal.write"].make({ threadId, terminalId, data }),
            );
          }
        });
        terminal.onResize(({ cols, rows }) =>
          sendIfConnected(
            ClientCommand.cases["terminal.resize"].make({
              threadId,
              terminalId,
              columns: cols,
              rows,
            }),
          ),
        );

        let frame = 0;

        const sizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => fitAddon.fit());
        });

        sizeObserver.observe(host.current);

        const themeObserver = new MutationObserver(() => {
          terminal.options.theme = getTerminalTheme();
        });

        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        if (autoFocus) terminal.focus();

        dispose = () => {
          cancelAnimationFrame(frame);
          sizeObserver.disconnect();
          themeObserver.disconnect();
          detach();
          terminal.dispose();
        };
      });

    return () => {
      isCancelled = true;
      dispose();
    };
  }, [threadId, terminalId, autoFocus]);

  return (
    <div className={cn("min-h-0 flex-1 pb-1 pl-3", className)}>
      <div ref={host} className="size-full" />
    </div>
  );
}
