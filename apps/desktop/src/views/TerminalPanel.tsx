import { ResizeHandle } from "@apcode/ui/components/resize-handle";
import { cn } from "@apcode/ui/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Plus, SquareTerminal, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import symbolsFontUrl from "../assets/fonts/symbols-nerd-font-mono.woff2";
import { focusComposer } from "../lib/drafts.ts";
import { attachTerminal, closeTerminal, newTerminal, sendIfConnected, showTerminal, toggleTerminalPanel, useStore } from "../lib/store.ts";
import { useResizableSize } from "@apcode/ui/hooks/use-resizable";

const symbolsFont = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
document.fonts.add(symbolsFont);

function terminalTheme(dark: boolean): ITheme {
  return dark
    ? {
        background: "#151515",
        foreground: "#f2f2f2",
        cursor: "#f2f2f2",
        cursorAccent: "#151515",
        selectionBackground: "#f2f2f2",
        selectionForeground: "#151515",
        scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
        scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.2)",
        scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.28)",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
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
        background: "#fcfcfc",
        foreground: "#0b0b0b",
        cursor: "#0b0b0b",
        cursorAccent: "#fcfcfc",
        selectionBackground: "#0b0b0b",
        selectionForeground: "#fcfcfc",
        scrollbarSliderBackground: "rgba(0, 0, 0, 0.12)",
        scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.2)",
        scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.28)",
        black: "#24292f",
        red: "#cf222e",
        green: "#116329",
        yellow: "#4d2d00",
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
      };
}

export function TerminalPanel({ threadId, activeTerminal }: { threadId: string; activeTerminal: string }) {
  const terminalIds = useStore((state) => state.terminals[threadId]) ?? [];
  const section = useRef<HTMLElement>(null);
  const panel = useResizableSize({
    key: "apcode.terminalHeight",
    initial: 288,
    side: "start",
    axis: "y",
    clamp: (height) => Math.max(120, Math.min(height, (section.current?.parentElement?.clientHeight ?? window.innerHeight) - 200)),
  });
  return (
    <section
      ref={section}
      aria-label="Terminal"
      style={{ height: panel.size }}
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
    >
      <ResizeHandle side="start" axis="y" label="Resize terminal" value={panel.size} dragging={panel.dragging} {...panel.handleProps} />
      <div className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-3">
        <div role="tablist" aria-label="Terminals" className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {terminalIds.map((terminalId, index) => (
            <div
              key={terminalId}
              className={cn(
                "group/tab flex h-7 shrink-0 items-center rounded-lg pr-0.5 text-xs transition-colors",
                terminalId === activeTerminal ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={terminalId === activeTerminal}
                onClick={() => showTerminal(threadId, terminalId)}
                className="flex h-full items-center gap-1.5 rounded-lg pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SquareTerminal className="size-3.5" />
                Terminal {index + 1}
              </button>
              <button
                type="button"
                title="Close terminal"
                aria-label={`Close terminal ${index + 1}`}
                onClick={() => closeTerminal(threadId, terminalId)}
                className={cn(
                  "grid size-6 place-items-center rounded-md outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                  terminalId === activeTerminal ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <IconButton label="New terminal" onClick={() => newTerminal(threadId)}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton
          label="Hide terminal"
          className="ml-auto"
          onClick={() => {
            toggleTerminalPanel(threadId);
            focusComposer();
          }}
        >
          <ChevronDown className="size-3.5" />
        </IconButton>
      </div>
      <TerminalView key={activeTerminal} threadId={threadId} terminalId={activeTerminal} />
    </section>
  );
}

function IconButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </button>
  );
}

function TerminalView({ threadId, terminalId }: { threadId: string; terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let dispose = () => {};
    void symbolsFont
      .load()
      .catch(() => symbolsFont)
      .then(() => {
        if (cancelled || !host.current) return;
        const terminal = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          fontFamily: '"SF Mono", Menlo, Monaco, "Symbols Nerd Font Mono", monospace',
          fontSize: 12,
          lineHeight: 1.2,
          scrollback: 5000,
          macOptionClickForcesSelection: true,
          minimumContrastRatio: 4.5,
          theme: terminalTheme(document.documentElement.classList.contains("dark")),
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = "11";
        terminal.loadAddon(
          new WebLinksAddon((event, uri) => {
            if (event.metaKey || event.ctrlKey) window.open(uri, "_blank");
          }),
        );
        terminal.open(host.current);
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminal.loadAddon(webgl);
        } catch {}
        fit.fit();

        let replaying = false;
        function acknowledge(characters: number) {
          sendIfConnected({ _tag: "terminal.acknowledge", threadId, terminalId, characters });
        }
        const detach = attachTerminal({
          threadId,
          terminalId,
          size: () => ({ columns: terminal.cols, rows: terminal.rows }),
          reset: (data) => {
            replaying = true;
            terminal.reset();
            terminal.write(data, () => {
              replaying = false;
              acknowledge(data.length);
            });
          },
          write: (data) => terminal.write(data, () => acknowledge(data.length)),
          fail: (message) => terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`),
        });
        terminal.onData((data) => {
          if (!replaying) sendIfConnected({ _tag: "terminal.write", threadId, terminalId, data });
        });
        terminal.onResize(({ cols, rows }) => sendIfConnected({ _tag: "terminal.resize", threadId, terminalId, columns: cols, rows }));

        let frame = 0;
        const sizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => fit.fit());
        });
        sizeObserver.observe(host.current);
        const themeObserver = new MutationObserver(() => {
          terminal.options.theme = terminalTheme(document.documentElement.classList.contains("dark"));
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
        terminal.focus();

        dispose = () => {
          cancelAnimationFrame(frame);
          sizeObserver.disconnect();
          themeObserver.disconnect();
          detach();
          terminal.dispose();
        };
      });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [threadId, terminalId]);
  return (
    <div className="min-h-0 flex-1 pb-1 pl-3">
      <div ref={host} className="size-full" />
    </div>
  );
}
