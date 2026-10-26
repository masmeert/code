import { formatTimeLeft } from "@masscode/client";
import { ChatApp } from "@masscode/ui/agents/chat-app";
import { Button } from "@masmeert/ui/button";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";
import { SidebarInset, useSidebar } from "@masmeert/ui/sidebar";
import { DEFAULT_KEEP_AWAKE_MANUAL_MINUTES } from "@masscode/contracts";
import {
  IconAppWindow,
  IconCoffee,
  IconDeviceMobile,
  IconEdit,
  IconBroadcast,
  IconFolderPlus,
  IconLayoutSidebar,
  IconSettings,
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { MotionConfig } from "motion/react";
import { Activity, type ComponentProps, useCallback, useEffect, useState } from "react";
import { toggleBrowser } from "@/entities/browser";
import { startKeepAwake, stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { useProjectStore } from "@/entities/project";
import { useSetting } from "@/entities/settings";
import { toggleTerminalPanel } from "@/entities/terminal";
import { keepFollowing, useThreadHost, useThreadStore } from "@/entities/thread";
import { formatKeybinding, useKeybinding } from "@/shared/lib/keybindings";
import "../model/notifications.ts";
import { toggleSimulator } from "@/entities/simulator";
import { focusComposer } from "@/widgets/composer";
import { useTheme } from "./use-theme.ts";
import { openWindow } from "./windows.ts";
import { AddProjectDialog, addProject } from "@/features/add-project";
import { ServicesModal } from "@/widgets/services";
import { SettingsModal } from "@/widgets/settings";
import { ErrorBoundary, Toaster } from "@/shared/ui";
import { closeSettings, openSettings, useSettingsRoute } from "@/shared/lib/settings-route";
import { BrowserHost } from "@/widgets/browser-host";
import { CommandPalette } from "@/widgets/command-palette";
import { DiffWorkers, ThreadPage } from "@/pages/thread";
import { Sidebar } from "@/widgets/sidebar";
import { DraftPage } from "@/pages/draft";
import { StatusBanners } from "./status-banners.tsx";

/**
 * What this window shows. Each window keeps its own. A draft with a null path is a new
 * thread whose project hasn't been picked yet.
 */
type View =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "draft"; readonly path: string | null };

/** Windows opened with New window carry their starting point in the URL. */
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
  const theme = useSetting((settings) => settings.theme);
  const switchTo = useThreadStore((state) => state.switchTo);
  const [chosen, setView] = useState<View | null>(readInitialView);
  // The page settings opens on; null while closed.
  const settingsPage = useSettingsRoute();
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

  // The thread last on screen, so its deletion can be told apart from a thread not loaded yet.
  const [shownThread, setShownThread] = useState<{
    readonly id: string;
    readonly projectId: string;
  } | null>(null);

  // The thread on screen was deleted (here, in another window, or by its agent): rather than
  // jump to some other thread, offer a new one in its project.
  if (shownThread && !threads[shownThread.id]) {
    setShownThread(null);

    if (chosen === null || (chosen.kind === "thread" && chosen.id === shownThread.id))
      setView({
        kind: "draft",
        path: projects.find((project) => project.id === shownThread.projectId)?.path ?? null,
      });
  }

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
  const activeInfo = activeThread ? threads[activeThread] : undefined;

  if (activeInfo && activeInfo.id !== shownThread?.id)
    setShownThread({ id: activeInfo.id, projectId: activeInfo.projectId });

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
  useKeybinding("thread.new", () => openDraft(currentPath));
  useKeybinding("settings.open", () => openSettings("general"));
  useKeybinding("window.new", () => openWindow(currentPath));

  return (
    <MotionConfig reducedMotion="user">
      <DiffWorkers>
        <ChatApp sidebarWidth="16rem" className="h-full rounded-none border-0">
          <Sidebar
            activeId={view.kind === "thread" ? view.id : null}
            currentPath={currentPath}
            onSelect={selectThread}
            onOpenSettings={() => openSettings("general")}
            onOpenKeepAwakeSettings={() => openSettings("keepAwake")}
            onOpenServices={() => setIsServicesOpen(true)}
            onDraft={openDraft}
          />
          <SidebarInset className="relative min-h-0 bg-background">
            <StatusBanners threadId={activeThread} />
            <ErrorBoundary
              resetKey={activeThread ?? "draft"}
              fallback={(error, retry) => (
                <div
                  role="alert"
                  className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
                >
                  <p className={cn(typeClass("body"), "font-medium text-foreground")}>
                    This view stopped working.
                  </p>
                  <p className={cn(typeClass("caption"), "max-w-md text-muted-foreground")}>
                    Your threads are safe. Start a new thread, or reload the window to try again.
                  </p>
                  <p
                    className={cn(
                      typeClass("caption"),
                      "max-w-md selectable font-mono break-words text-muted-foreground",
                    )}
                  >
                    {error.message}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => {
                        retry();
                        openDraft(currentPath);
                      }}
                    >
                      New thread
                    </Button>
                    <Button size="compact" variant="ghost" onClick={() => location.reload()}>
                      Reload
                    </Button>
                  </div>
                </div>
              )}
            >
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
            </ErrorBoundary>
          </SidebarInset>
          <SettingsModal
            isOpen={settingsPage !== null}
            page={settingsPage ?? undefined}
            onClose={() => closeSettings()}
          />
          <ServicesModal
            isOpen={isServicesOpen}
            onClose={() => setIsServicesOpen(false)}
            onSelectThread={selectThread}
          />
          <AddProjectDialog />
          <BrowserHost />
          <ShellCommandPalette
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
              {
                id: "project.add",
                label: "Add project",
                icon: <IconFolderPlus />,
                run: () => {
                  void addProject().then((path) => path && openDraft(path));
                },
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
                hint: formatKeybinding("window.new"),
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
                icon: <IconBroadcast />,
                run: () => setIsServicesOpen(true),
              },
              {
                id: "settings.open",
                label: "Settings",
                hint: formatKeybinding("settings.open"),
                icon: <IconSettings />,
                run: () => openSettings("general"),
              },
            ]}
          />
        </ChatApp>
      </DiffWorkers>
      <Toaster />
    </MotionConfig>
  );
}

/** The palette, with the actions that need the sidebar's context (only reachable inside the shell). */
function ShellCommandPalette(props: ComponentProps<typeof CommandPalette>) {
  const { toggleSidebar } = useSidebar();

  return (
    <CommandPalette
      {...props}
      actions={[
        ...props.actions,
        {
          id: "sidebar.toggle",
          label: "Toggle sidebar",
          hint: formatKeybinding("sidebar.toggle"),
          icon: <IconLayoutSidebar />,
          run: () => toggleSidebar(),
        },
      ]}
    />
  );
}
