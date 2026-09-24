import { ChatApp } from "@/components/agents/chat-app";
import { AnimatedSidebarInset } from "@/components/motion/animated-sidebar";
import { useEffect, useState } from "react";
import { useStore } from "./lib/store.ts";
import { useShortcut } from "./lib/useShortcut.ts";
import { useTheme } from "./lib/useTheme.ts";
import { openWindow } from "./lib/windows.ts";
import { AppModal, type ModalView } from "./views/AppModal.tsx";
import { DiffWorkers } from "./views/DiffWorkers.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { DraftView, ThreadView } from "./views/ThreadView.tsx";

/** What this window shows. Each window keeps its own. */
/** A draft with a null path is a new thread whose project hasn't been picked yet. */
type View = { readonly kind: "thread"; readonly id: string } | { readonly kind: "draft"; readonly path: string | null };

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
  const theme = useStore((s) => s.settings.theme);
  const createdHere = useStore((s) => s.createdHere);
  const [chosen, setView] = useState<View | null>(initialView);
  const [modal, setModal] = useState<ModalView | null>(null);
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
  const currentPath = view.kind === "thread" ? (threads[view.id]?.info.cwd ?? null) : view.kind === "draft" ? view.path : null;

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
          {connected ? null : (
            <div className="absolute top-16 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-1 text-[11px] text-muted-foreground shadow-panel">
              Reconnecting to daemon…
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
      </ChatApp>
    </DiffWorkers>
  );
};
