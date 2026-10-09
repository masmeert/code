import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { SharedLayoutBg } from "@masscode/ui/motion/shared-layout-bg";
import { ScrollArea } from "@masscode/ui/components/scroll-area";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand } from "@masscode/contracts";
import { Bot, FolderGit2, GitCommitHorizontal, Palette, Server, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { send } from "../../lib/store.ts";
import { AppearancePage } from "./AppearancePage.tsx";
import { ConnectionsPage } from "./ConnectionsPage.tsx";
import { GeneralPage } from "./GeneralPage.tsx";
import { GitPage } from "./GitPage.tsx";
import { HarnessesPage } from "./HarnessesPage.tsx";
import { ProjectsPage } from "./ProjectsPage.tsx";

const PAGES = [
  { page: "general", title: "General", icon: Settings2, Content: GeneralPage },
  { page: "projects", title: "Projects", icon: FolderGit2, Content: ProjectsPage },
  { page: "appearance", title: "Appearance", icon: Palette, Content: AppearancePage },
  { page: "harnesses", title: "Harnesses", icon: Bot, Content: HarnessesPage },
  { page: "git", title: "Git", icon: GitCommitHorizontal, Content: GitPage },
  { page: "connections", title: "Connections", icon: Server, Content: ConnectionsPage },
] as const;

/** Settings, over the app; its pages are listed down the side. */
export function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <MorphingModal
      viewId={isOpen ? "settings" : null}
      onClose={onClose}
      placement="center"
      className="max-w-3xl"
    >
      {isOpen ? <SettingsView /> : null}
    </MorphingModal>
  );
}

function SettingsView() {
  const [page, setPage] = useState<(typeof PAGES)[number]>(PAGES[0]);

  // Hosts are reached over SSH by the desktop app.
  const pages = PAGES.filter((entry) => entry.page !== "connections" || window.desktop);

  // Sign-in state can change outside the app (e.g. `claude auth logout` in a terminal).
  useEffect(() => send(ClientCommand.cases["providers.refresh"].make({})), []);

  return (
    <div className="-m-5 flex h-[min(36rem,calc(100vh-4rem))]">
      <nav
        aria-label="Settings"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();

          const next =
            pages[
              (pages.indexOf(page) + (event.key === "ArrowDown" ? 1 : -1) + pages.length) %
                pages.length
            ];

          setPage(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-page="${next.page}"]`)?.focus();
        }}
        className="flex w-48 shrink-0 flex-col border-r border-border bg-sidebar p-3"
      >
        <h2 className="px-2 pt-1 pb-3 text-sm font-medium">Settings</h2>
        <SharedLayoutBg inset={0} pillClassName="rounded-lg bg-muted/50" className="gap-0.5">
          {pages.map((entry) => (
            <div key={entry.page}>
              <button
                type="button"
                aria-current={entry === page ? "page" : undefined}
                tabIndex={entry === page ? 0 : -1}
                data-page={entry.page}
                onClick={() => setPage(entry)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
                  entry === page && "bg-muted text-foreground",
                )}
              >
                <entry.icon className="size-4 shrink-0" />
                {entry.title}
              </button>
            </div>
          ))}
        </SharedLayoutBg>
      </nav>
      <ScrollArea className="min-w-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:py-7 [&>[data-slot=scroll-area-scrollbar]]:pr-0.5">
        <div className="p-5">
          <page.Content />
        </div>
      </ScrollArea>
    </div>
  );
}
