import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { SharedLayoutBg } from "@masmeert/ui/shared-layout-bg";
import { ScrollArea } from "@masmeert/ui/scroll-area";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand } from "@masscode/contracts";
import {
  IconAdjustmentsHorizontal,
  IconCoffee,
  IconDeviceMobile,
  IconFolderCode,
  IconGitCommit,
  IconPalette,
  IconRobot,
  IconServer,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useKeepAwake } from "@/entities/keep-awake";
import { send } from "@/shared/api";
import { AppearancePage } from "./appearance-page.tsx";
import { ConnectionsPage } from "./connections-page.tsx";
import { GeneralPage } from "./general-page.tsx";
import { GitPage } from "./git-page.tsx";
import { KeepAwakePage } from "./keep-awake-page.tsx";
import { HarnessesPage } from "./harnesses-page.tsx";
import { PhonesPage } from "./phones-page.tsx";
import { ProjectsPage } from "./projects-page.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

const PAGES = [
  { page: "general", title: "General", icon: IconAdjustmentsHorizontal, Content: GeneralPage },
  { page: "projects", title: "Projects", icon: IconFolderCode, Content: ProjectsPage },
  { page: "appearance", title: "Appearance", icon: IconPalette, Content: AppearancePage },
  { page: "harnesses", title: "Harnesses", icon: IconRobot, Content: HarnessesPage },
  { page: "git", title: "Git", icon: IconGitCommit, Content: GitPage },
  { page: "keepAwake", title: "Keep awake", icon: IconCoffee, Content: KeepAwakePage },
  { page: "connections", title: "Connections", icon: IconServer, Content: ConnectionsPage },
  { page: "phone", title: "Phone", icon: IconDeviceMobile, Content: PhonesPage },
] as const;

export type SettingsPage = (typeof PAGES)[number]["page"];

/** Settings, over the app; its pages are listed down the side. Opens on `page`, else the first. */
export function SettingsModal({
  isOpen,
  page,
  onClose,
}: {
  isOpen: boolean;
  page?: SettingsPage;
  onClose: () => void;
}) {
  return (
    <MorphingModal
      viewId={isOpen ? "settings" : null}
      onClose={onClose}
      placement="center"
      className="max-w-3xl"
    >
      {isOpen ? <SettingsView initialPage={page} /> : null}
    </MorphingModal>
  );
}

function SettingsView({ initialPage }: { initialPage?: SettingsPage }) {
  const [page, setPage] = useState<(typeof PAGES)[number]>(
    () => PAGES.find((entry) => entry.page === initialPage) ?? PAGES[0],
  );

  const isKeepAwakeAvailable = useKeepAwake()?.available === true;

  // Hosts are reached over SSH by the desktop app.
  const pages = PAGES.filter(
    (entry) =>
      (entry.page !== "connections" || window.desktop) &&
      (entry.page !== "keepAwake" || isKeepAwakeAvailable),
  );

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
        <h2 className={cn(typeClass("body"), "px-2 pt-1 pb-3 font-medium")}>Settings</h2>
        <SharedLayoutBg inset={0} pillClassName="rounded-lg" className="gap-0.5">
          {pages.map((entry) => (
            <div key={entry.page}>
              <button
                type="button"
                aria-current={entry === page ? "page" : undefined}
                tabIndex={entry === page ? 0 : -1}
                data-page={entry.page}
                onClick={() => setPage(entry)}
                className={cn(
                  typeClass("body"),
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
                  entry === page && "bg-selected text-foreground",
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
