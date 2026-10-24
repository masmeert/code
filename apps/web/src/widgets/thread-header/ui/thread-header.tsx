import { formatProjectLabel } from "@masscode/client";
import { ProjectBadge, useProjectConfig, useProjectHost } from "@/entities/project";
import { type Project } from "@masscode/contracts";
import { SidebarTrigger, useSidebar } from "@masmeert/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@masmeert/ui/dropdown-menu";
import {
  IconDeviceMobile,
  IconDotsVertical,
  IconLayoutSidebar,
  IconPencil,
  IconPlayerPlay,
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { toggleBrowser, useBrowser } from "@/entities/browser";
import { formatKeybinding } from "@/shared/lib/keybindings";
import { toggleSimulator, useSimulator } from "@/entities/simulator";
import { toggleTerminalPanel, useTerminalStore } from "@/entities/terminal";
import { runScript } from "../model/run-script.ts";
import { ScriptsEditor } from "./scripts-editor.tsx";
import { hasTrafficLights } from "@/shared/config";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";

/** Top bar: project / title breadcrumb. Leaves room for the traffic lights when the sidebar is folded away. */
export function ThreadHeader({
  project,
  title,
  badge,
  actions,
}: {
  project?: Pick<Project, "id" | "name" | "remote" | "folder"> | undefined;
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  const { open: isSidebarOpen } = useSidebar();
  const host = useProjectHost(project?.id ?? "");

  return (
    // Same row geometry as the sidebar's title bar, so both line up with the traffic lights.
    <header
      className={`@container flex h-10 shrink-0 items-center gap-2 pr-4 pb-[3px] [-webkit-app-region:drag] ${isSidebarOpen ? "pl-5" : hasTrafficLights ? "pl-[86px]" : "pl-3"}`}
    >
      {isSidebarOpen ? null : (
        <SidebarTrigger className="mr-1 size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-hover hover:text-foreground">
          <IconLayoutSidebar className="size-4" />
        </SidebarTrigger>
      )}
      {project ? (
        <>
          <ProjectBadge project={project} className="translate-y-px" />
          <span className={cn(typeClass("body"), "shrink-0 text-muted-foreground @max-lg:hidden")}>
            {formatProjectLabel(project.name, host)}
          </span>
          <span className={cn(typeClass("body"), "shrink-0 text-muted-foreground @max-lg:hidden")}>
            /
          </span>
        </>
      ) : null}
      <span className={cn(typeClass("body"), "min-w-0 truncate font-medium text-foreground")}>
        {title}
      </span>
      {badge}
      {actions ? (
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 [-webkit-app-region:no-drag]">
          {actions}
        </span>
      ) : null}
    </header>
  );
}

/** The project's `masscode.toml` scripts, to run in the thread, and the way to edit them. */
export function ScriptsMenu({
  threadId,
  host,
  path,
}: {
  threadId: string;
  host: string | null;
  path: string;
}) {
  // Read again each time the menu opens, so edits to the file show without a reload.
  const [scriptsRead, setScriptsRead] = useState(0);
  const [isEditingScripts, setIsEditingScripts] = useState(false);

  const projectConfig = useProjectConfig(host, path, scriptsRead);
  const scripts = projectConfig?.config.scripts ?? [];

  return (
    <>
      <ScriptsEditor
        isOpen={isEditingScripts}
        host={host}
        path={path}
        onClose={() => setIsEditingScripts(false)}
        onSaved={() => {
          setIsEditingScripts(false);
          setScriptsRead((read) => read + 1);
        }}
      />
      <DropdownMenu onOpenChange={(isOpen) => isOpen && setScriptsRead((read) => read + 1)}>
        <DropdownMenuTrigger
          title="Scripts"
          aria-label="Scripts"
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/60 data-popup-open:text-foreground"
        >
          <IconPlayerPlay className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} className="max-w-80">
          {projectConfig?.error ? (
            <p className={cn(typeClass("caption"), "selectable px-2 py-1.5 text-destructive")}>
              {projectConfig.error}
            </p>
          ) : null}
          {scripts.map((script) => (
            <DropdownMenuItem
              key={script.name}
              title={script.command}
              onClick={() => runScript(threadId, script)}
            >
              <IconPlayerPlay />
              <span className="min-w-0 flex-1 truncate">{script.name}</span>
              {script.preview_url && window.desktop ? (
                <IconWorld className="text-muted-foreground" />
              ) : null}
            </DropdownMenuItem>
          ))}
          {scripts.length > 0 || projectConfig?.error ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => setIsEditingScripts(true)}>
            <IconPencil />
            {scripts.length > 0 ? "Edit scripts…" : "Add a script…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Toggles for the thread's terminal, browser and simulator panels. */
export function PanelsMenu({
  threadId,
  isSimulatorAvailable,
}: {
  threadId: string;
  isSimulatorAvailable: boolean;
}) {
  const activeTerminal = useTerminalStore((state) => state.activeTerminals[threadId]);
  const isBrowserOpen = useBrowser((state) => state.threads[threadId]?.open ?? false);
  const isSimulatorOpen = useSimulator(threadId).open;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="More panels"
        aria-label="More panels"
        className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/60 data-popup-open:text-foreground"
      >
        <IconDotsVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8}>
        <DropdownMenuCheckboxItem
          checked={activeTerminal !== undefined}
          onCheckedChange={() => toggleTerminalPanel(threadId)}
          closeOnClick
        >
          <IconTerminal2 />
          Terminal
          <DropdownMenuShortcut>{formatKeybinding("terminal.toggle")}</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        {window.desktop ? (
          <DropdownMenuCheckboxItem
            checked={isBrowserOpen}
            onCheckedChange={() => toggleBrowser(threadId)}
            closeOnClick
          >
            <IconWorld />
            Browser
            <DropdownMenuShortcut>{formatKeybinding("browser.toggle")}</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ) : null}
        {isSimulatorAvailable ? (
          <DropdownMenuCheckboxItem
            checked={isSimulatorOpen}
            onCheckedChange={() => toggleSimulator(threadId)}
            closeOnClick
          >
            <IconDeviceMobile />
            Simulator
            <DropdownMenuShortcut>{formatKeybinding("simulator.toggle")}</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
