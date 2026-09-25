import { ChatApp } from "@apcode/ui/agents/chat-app";
import { AnimatedSidebarInset } from "@apcode/ui/motion/animated-sidebar";
import {
  AppWindow,
  Globe,
  Settings as SettingsIcon,
  SquarePen,
  SquareTerminal,
} from "lucide-react";
import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";
import { toggleBrowser } from "./lib/browser.ts";
import { describe, useKeybinding } from "./lib/keybindings.ts";
import { toggleTerminalPanel, useStore } from "./lib/store.ts";
import { useShortcut } from "./lib/useShortcut.ts";
import { useTheme } from "./lib/useTheme.ts";
import { openWindow } from "./lib/windows.ts";
import { AppModal, type ModalView } from "./views/AppModal.tsx";
import { BrowserHost } from "./views/BrowserHost.tsx";
import { CommandPalette } from "./views/CommandPalette.tsx";
import { DiffWorkers } from "./views/DiffWorkers.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { DraftView, ThreadView } from "./views/ThreadView.tsx";

/** What this window shows. Each window keeps its own. */
/** A draft with a null path is a new thread whose project hasn't been picked yet. */
type View =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "draft"; readonly path: string | null };

/** Windows opened with Ctrl+N carry their starting point in the URL. */
const initialView = (): View | null => {
  const params = new URLSearchParams(location.search);
  const path = params.get("path");
  if (path) return { kind: "draft", path };
  if (params.has("home")) return { kind: "draft", path: null };
  return null;
};

export const App = () => {
  const order = useStore((s) => s.order);
  const threads = useStore((s) => s.threads);
  const connected = useStore((s) => s.connected);
  const source = useStore((s) => s.source);
  // A cold start takes a moment and the cached threads are already on screen, so
  // only speak up if it's slow. Losing a live daemon is worth saying right away.
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlowStart(true), 2500);
    return () => clearTimeout(timer);
  }, []);
  const theme = useStore((s) => s.settings.theme);
  const createdHere = useStore((s) => s.createdHere);
  const [chosen, setView] = useState<View | null>(initialView);
  const [modal, setModal] = useState<ModalView | null>(null);
  const [palette, setPalette] = useState(false);
  useKeybinding("palette.open", () => setPalette((open) => !open));
  useTheme(theme);

  // Main window with nothing chosen yet: show the latest thread, else a new one.
  const view: View =
    chosen && (chosen.kind !== "thread" || threads[chosen.id])
      ? chosen
      : order[0]
        ? { kind: "thread", id: order[0] }
        : { kind: "draft", path: null };

  // A draft sent from this window became a thread: open it.
  useEffect(() => {
    if (createdHere) setView({ kind: "thread", id: createdHere.threadId });
  }, [createdHere]);

  const draft = (path: string | null) => setView({ kind: "draft", path });
  const currentPath =
    view.kind === "thread"
      ? (threads[view.id]?.cwd ?? null)
      : view.kind === "draft"
        ? view.path
        : null;

  // Like Claude Code: a new thread starts in the project on screen, if any.
  useShortcut("n", () => draft(currentPath));
  useShortcut(",", () => setModal("settings"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key === "n") {
        e.preventDefault();
        openWindow(currentPath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentPath]);

  return (
    <MotionConfig reducedMotion="user">
      <DiffWorkers>
        <ChatApp sidebarWidth="16rem" className="h-full rounded-none border-0">
          <Sidebar
            activeId={view.kind === "thread" ? view.id : null}
            currentPath={currentPath}
            onSelect={(id) => setView({ kind: "thread", id })}
            onModal={setModal}
            onDraft={draft}
          />
          <AnimatedSidebarInset className="relative min-h-0 bg-background">
            {connected || (source !== "daemon" && !slowStart) ? null : (
              <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-muted-foreground shadow-panel">
                {source === "daemon" ? "Reconnecting to daemon…" : "Starting daemon…"}
              </div>
            )}
            {view.kind === "thread" ? (
              <ThreadView key={view.id} threadId={view.id} />
            ) : (
              // One key for every draft, so text typed before picking a project survives the pick.
              <DraftView key="draft" path={view.path} onPickProject={draft} />
            )}
          </AnimatedSidebarInset>
          <AppModal view={modal} onView={setModal} />
          <BrowserHost />
          <CommandPalette
            open={palette}
            onClose={() => setPalette(false)}
            onOpenThread={(id) => setView({ kind: "thread", id })}
            onNewThreadIn={(path) => draft(path)}
            actions={[
              {
                id: "thread.new",
                label: "New thread",
                hint: describe("thread.new"),
                icon: <SquarePen />,
                run: () => draft(currentPath),
              },
              ...(view.kind === "thread"
                ? [
                    {
                      id: "terminal.toggle",
                      label: "Toggle terminal",
                      hint: describe("terminal.toggle"),
                      icon: <SquareTerminal />,
                      run: () => toggleTerminalPanel(view.id),
                    },
                  ]
                : []),
              ...(view.kind === "thread" && window.desktop
                ? [
                    {
                      id: "browser.toggle",
                      label: "Toggle browser",
                      hint: describe("browser.toggle"),
                      icon: <Globe />,
                      run: () => toggleBrowser(view.id),
                    },
                  ]
                : []),
              {
                id: "window.new",
                label: "New window",
                icon: <AppWindow />,
                run: () => openWindow(currentPath),
              },
              {
                id: "settings.open",
                label: "Settings",
                hint: describe("settings.open"),
                icon: <SettingsIcon />,
                run: () => setModal("settings"),
              },
            ]}
          />
        </ChatApp>
      </DiffWorkers>
    </MotionConfig>
  );
};
