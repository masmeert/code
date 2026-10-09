import { ChatApp } from "@masscode/ui/agents/chat-app";
import { AnimatedSidebarInset } from "@masscode/ui/motion/animated-sidebar";
import {
  AppWindow,
  Globe,
  Settings as SettingsIcon,
  Smartphone,
  SquarePen,
  SquareTerminal,
} from "lucide-react";
import { MotionConfig } from "motion/react";
import { Activity, useCallback, useEffect, useState } from "react";
import { toggleBrowser } from "./lib/browser.ts";
import { formatKeybinding, useKeybinding } from "./lib/keybindings.ts";
import "./lib/notifications.ts";
import { toggleSimulator } from "./lib/simulator.ts";
import { focusComposer } from "./lib/drafts.ts";
import { keepFollowing, toggleTerminalPanel, useStore, useThreadHost } from "./lib/store.ts";
import { useShortcut } from "./lib/useShortcut.ts";
import { useTheme } from "./lib/useTheme.ts";
import { openWindow } from "./lib/windows.ts";
import { AddProjectDialog } from "./views/AddProjectDialog.tsx";
import { AppModal, type ModalView } from "./views/AppModal.tsx";
import { BrowserHost } from "./views/BrowserHost.tsx";
import { CommandPalette } from "./views/CommandPalette.tsx";
import { DiffWorkers } from "./views/DiffWorkers.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { DraftView, ThreadView } from "./views/ThreadView.tsx";

/**
 * What this window shows. Each window keeps its own. A draft with a null path is a new
 * thread whose project hasn't been picked yet.
 */
type View =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "draft"; readonly path: string | null };

/** Windows opened with Ctrl+N carry their starting point in the URL. */
function readInitialView(): View | null {
  const params = new URLSearchParams(location.search);
  const path = params.get("path");
  if (path) return { kind: "draft", path };
  if (params.has("home")) return { kind: "draft", path: null };
  return null;
}

export function App() {
  const order = useStore((state) => state.order);
  const threads = useStore((state) => state.threads);
  const projects = useStore((state) => state.projects);
  const isConnected = useStore((state) => state.connected);
  const incompatible = useStore(
    (state) =>
      state.incompatible ??
      Object.values(state.hosts).find((host) => host.incompatible)?.incompatible,
  );
  const source = useStore((state) => state.source);
  // A cold start takes a moment and the cached threads are already on screen, so
  // only speak up if it's slow. Losing a live daemon is worth saying right away.
  const [isSlowStart, setIsSlowStart] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIsSlowStart(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  const theme = useStore((state) => state.settings.theme);
  const switchTo = useStore((state) => state.switchTo);
  const [chosen, setView] = useState<View | null>(readInitialView);
  const [modal, setModal] = useState<ModalView | null>(null);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  useKeybinding("palette.open", () => setIsPaletteOpen((isOpen) => !isOpen));
  useTheme(theme);

  // Stable, so sidebar rows (memoized) don't all redraw on every render.
  const selectThread = useCallback((id: string) => setView({ kind: "thread", id }), []);
  useEffect(() => window.desktop?.onOpenThread(selectThread), [selectThread]);

  // Main window with nothing chosen yet: show the latest thread, else a new one.
  const view: View =
    chosen && (chosen.kind !== "thread" || threads[chosen.id])
      ? chosen
      : order[0]
        ? { kind: "thread", id: order[0] }
        : { kind: "draft", path: null };

  useEffect(() => {
    if (switchTo) setView({ kind: "thread", id: switchTo.threadId });
  }, [switchTo]);

  const activeThread = view.kind === "thread" ? view.id : null;
  // The last few threads' views stay mounted, hidden, and followed live: switching back to one
  // is instant and shows it current. Most recent first; four bounds what they hold in memory.
  const [recent, setRecent] = useState<ReadonlyArray<string>>([]);
  if (activeThread && recent[0] !== activeThread)
    setRecent([activeThread, ...recent.filter((id) => id !== activeThread)].slice(0, 4));
  useEffect(() => keepFollowing(recent), [recent]);

  // A kept view isn't remounted, so its composer's autoFocus doesn't fire again.
  useEffect(() => {
    if (activeThread) focusComposer();
  }, [activeThread]);

  // Simulators run on this Mac only; a remote thread's agent couldn't reach them.
  const isSimulatorAvailable =
    useThreadHost(view.kind === "thread" ? view.id : "") === null &&
    window.desktop !== undefined &&
    navigator.userAgent.includes("Mac");

  function openDraft(path: string | null) {
    setView({ kind: "draft", path });
  }

  function findProjectPath(threadId: string | undefined) {
    return (
      projects.find((project) => project.id === threads[threadId ?? ""]?.projectId)?.path ?? null
    );
  }

  // Where a new thread starts: the project on screen, else the latest thread's. A worktree
  // thread's cwd is its worktree, so this goes by the thread's project instead.
  const currentPath =
    (view.kind === "thread" ? findProjectPath(view.id) : view.path) ?? findProjectPath(order[0]);

  // Like Claude Code: a new thread starts in the project on screen, if any.
  useShortcut("n", () => openDraft(currentPath));
  useShortcut(",", () => setModal("settings"));
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey && !event.metaKey && event.key === "n") {
        event.preventDefault();
        openWindow(currentPath);
      }
    }

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
            onSelect={selectThread}
            onModal={setModal}
            onDraft={openDraft}
          />
          <AnimatedSidebarInset className="relative min-h-0 bg-background">
            {incompatible ? (
              <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-destructive shadow-panel">
                {incompatible}
              </div>
            ) : isConnected || (source !== "daemon" && !isSlowStart) ? null : (
              <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-muted-foreground shadow-panel">
                {source === "daemon" ? "Reconnecting to daemon…" : "Starting daemon…"}
              </div>
            )}
            {recent
              .filter((id) => threads[id])
              // In a fixed order: moving a view in the DOM would lose its scroll position.
              .toSorted()
              .map((id) => (
                <Activity key={id} mode={id === activeThread ? "visible" : "hidden"}>
                  <ThreadView threadId={id} />
                </Activity>
              ))}
            {view.kind === "draft" ? (
              // One key for every draft, so text typed before picking a project survives the pick.
              <DraftView key="draft" path={view.path} onPickProject={openDraft} />
            ) : null}
          </AnimatedSidebarInset>
          <AppModal view={modal} onView={setModal} />
          <AddProjectDialog />
          <BrowserHost />
          <CommandPalette
            isOpen={isPaletteOpen}
            onClose={() => setIsPaletteOpen(false)}
            onOpenThread={(id) => setView({ kind: "thread", id })}
            onNewThreadIn={(path) => openDraft(path)}
            actions={[
              {
                id: "thread.new",
                label: "New thread",
                hint: formatKeybinding("thread.new"),
                icon: <SquarePen />,
                run: () => openDraft(currentPath),
              },
              ...(view.kind === "thread"
                ? [
                    {
                      id: "terminal.toggle",
                      label: "Toggle terminal",
                      hint: formatKeybinding("terminal.toggle"),
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
                      hint: formatKeybinding("browser.toggle"),
                      icon: <Globe />,
                      run: () => toggleBrowser(view.id),
                    },
                  ]
                : []),
              ...(view.kind === "thread" && isSimulatorAvailable
                ? [
                    {
                      id: "simulator.toggle",
                      label: "Toggle simulator",
                      hint: formatKeybinding("simulator.toggle"),
                      icon: <Smartphone />,
                      run: () => toggleSimulator(view.id),
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
                hint: formatKeybinding("settings.open"),
                icon: <SettingsIcon />,
                run: () => setModal("settings"),
              },
            ]}
          />
        </ChatApp>
      </DiffWorkers>
    </MotionConfig>
  );
}
