import { formatTimeLeft } from "@masscode/client";
import { ChatApp } from "@masscode/ui/agents/chat-app";
import { SidebarInset } from "@masmeert/ui/sidebar";
import { DEFAULT_KEEP_AWAKE_MANUAL_MINUTES } from "@masscode/contracts";
import {
  IconAppWindow,
  IconCoffee,
  IconDeviceMobile,
  IconEdit,
  IconNetwork,
  IconSettings,
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { MotionConfig } from "motion/react";
import { Activity, useCallback, useEffect, useState } from "react";
import { toggleBrowser } from "@/entities/browser";
import { useHostStore } from "@/entities/host";
import { startKeepAwake, stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { useProjectStore } from "@/entities/project";
import { useSetting } from "@/entities/settings";
import { toggleTerminalPanel } from "@/entities/terminal";
import { keepFollowing, useThreadHost, useThreadStore } from "@/entities/thread";
import { formatKeybinding, useKeybinding, useShortcut } from "@/shared/lib/keybindings";
import "../model/notifications.ts";
import { toggleSimulator } from "@/entities/simulator";
import { focusComposer } from "@/widgets/composer";
import { useTheme } from "./use-theme.ts";
import { openWindow } from "./windows.ts";
import { AddProjectDialog } from "@/features/add-project";
import { ServicesModal } from "@/widgets/services";
import { SettingsModal } from "@/widgets/settings";
import { BrowserHost } from "@/widgets/browser-host";
import { CommandPalette } from "@/widgets/command-palette";
import { DiffWorkers, ThreadPage } from "@/pages/thread";
import { Sidebar } from "@/widgets/sidebar";
import { DraftPage } from "@/pages/draft";

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
  const order = useThreadStore((state) => state.order);
  const threads = useThreadStore((state) => state.threads);
  const projects = useProjectStore((state) => state.projects);
  const isConnected = useHostStore((state) => state.connected);

  const incompatible = useHostStore(
    (state) =>
      state.incompatible ??
      Object.values(state.hosts).find((host) => host.incompatible)?.incompatible,
  );

  const source = useHostStore((state) => state.source);
  // A cold start takes a moment and the cached threads are already on screen, so
  // only speak up if it's slow. Losing a live daemon is worth saying right away.
  const [isSlowStart, setIsSlowStart] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIsSlowStart(true), 2500);

    return () => clearTimeout(timer);
  }, []);

  const theme = useSetting((settings) => settings.theme);
  const switchTo = useThreadStore((state) => state.switchTo);
  const [chosen, setView] = useState<View | null>(readInitialView);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isServicesOpen, setIsServicesOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  useKeybinding("palette.open", () => setIsPaletteOpen((isOpen) => !isOpen));
  const keepAwakeStatus = useKeepAwake();
  const keepAwakeSettings = useSetting((settings) => settings.keepAwake);
  const keepAwakeMinutes = keepAwakeSettings?.manualMinutes ?? DEFAULT_KEEP_AWAKE_MANUAL_MINUTES;
  const canKeepAwake = keepAwakeStatus?.available === true && keepAwakeSettings?.enabled === true;

  function toggleKeepAwake() {
    if (keepAwakeStatus?.session) stopKeepAwake();
    else startKeepAwake(keepAwakeMinutes);
  }

  useKeybinding(canKeepAwake ? "keepAwake.toggle" : undefined, toggleKeepAwake);
  useKeybinding("services.open", () => setIsServicesOpen((isOpen) => !isOpen));
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
  useShortcut(",", () => setIsSettingsOpen(true));
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
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenServices={() => setIsServicesOpen(true)}
            onDraft={openDraft}
          />
          <SidebarInset className="relative min-h-0 bg-background">
            {incompatible ? (
              <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-destructive shadow-surface-3">
                {incompatible}
              </div>
            ) : isConnected || (source !== "daemon" && !isSlowStart) ? null : (
              <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-muted-foreground shadow-surface-3">
                {source === "daemon" ? "Reconnecting to daemon…" : "Starting daemon…"}
              </div>
            )}
            {recent
              .filter((id) => threads[id])
              // In a fixed order: moving a view in the DOM would lose its scroll position.
              .toSorted()
              .map((id) => (
                <Activity key={id} mode={id === activeThread ? "visible" : "hidden"}>
                  <ThreadPage threadId={id} />
                </Activity>
              ))}
            {view.kind === "draft" ? (
              // One key for every draft, so text typed before picking a project survives the pick.
              <DraftPage key="draft" path={view.path} onPickProject={openDraft} />
            ) : null}
          </SidebarInset>
          <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
          <ServicesModal
            isOpen={isServicesOpen}
            onClose={() => setIsServicesOpen(false)}
            onSelectThread={selectThread}
          />
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
                icon: <IconEdit />,
                run: () => openDraft(currentPath),
              },
              ...(view.kind === "thread"
                ? [
                    {
                      id: "terminal.toggle",
                      label: "Toggle terminal",
                      hint: formatKeybinding("terminal.toggle"),
                      icon: <IconTerminal2 />,
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
                      icon: <IconWorld />,
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
                      icon: <IconDeviceMobile />,
                      run: () => toggleSimulator(view.id),
                    },
                  ]
                : []),
              {
                id: "window.new",
                label: "New window",
                icon: <IconAppWindow />,
                run: () => openWindow(currentPath),
              },
              ...(canKeepAwake
                ? [
                    {
                      id: "keepAwake.toggle",
                      label: keepAwakeStatus?.session
                        ? "Stop keeping this Mac awake"
                        : `Keep this Mac awake for ${formatTimeLeft(keepAwakeMinutes * 60_000)}`,
                      hint: formatKeybinding("keepAwake.toggle"),
                      icon: <IconCoffee />,
                      run: toggleKeepAwake,
                    },
                  ]
                : []),
              {
                id: "services.open",
                label: "Services",
                hint: formatKeybinding("services.open"),
                icon: <IconNetwork />,
                run: () => setIsServicesOpen(true),
              },
              {
                id: "settings.open",
                label: "Settings",
                hint: formatKeybinding("settings.open"),
                icon: <IconSettings />,
                run: () => setIsSettingsOpen(true),
              },
            ]}
          />
        </ChatApp>
      </DiffWorkers>
    </MotionConfig>
  );
}
