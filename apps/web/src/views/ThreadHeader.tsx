import { ProjectBadge, formatProjectLabel } from "@/components/project-badge";
import { type Project } from "@masscode/contracts";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "@masscode/ui/motion/animated-sidebar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@masscode/ui/components/dropdown-menu";
import {
  EllipsisVertical,
  Globe,
  PanelLeft,
  Pencil,
  Play,
  Smartphone,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toggleBrowser, useBrowser } from "../lib/browser.ts";
import { formatKeybinding } from "../lib/keybindings.ts";
import { useProjectConfig } from "../lib/projectConfig.ts";
import { toggleSimulator, useSimulator } from "../lib/simulator.ts";
import { runScript, toggleTerminalPanel, useProjectHost, useStore } from "../lib/store.ts";
import { ScriptsEditor } from "./ScriptsEditor.tsx";
import { hasTrafficLights } from "./Sidebar.tsx";

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
  const { open: isSidebarOpen } = useAnimatedSidebar();
  const host = useProjectHost(project?.id ?? "");

  return (
    // Same row geometry as the sidebar's title bar, so both line up with the traffic lights.
    <header
      className={`@container flex h-10 shrink-0 items-center gap-2 pr-4 pb-[3px] [-webkit-app-region:drag] ${isSidebarOpen ? "pl-5" : hasTrafficLights ? "pl-[86px]" : "pl-3"}`}
    >
      {isSidebarOpen ? null : (
        <AnimatedSidebarTrigger className="mr-1 size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-muted/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
      )}
      {project ? (
        <>
          <ProjectBadge project={project} className="translate-y-px" />
          <span className="shrink-0 text-sm text-muted-foreground @max-lg:hidden">
            {formatProjectLabel(project.name, host)}
          </span>
          <span className="shrink-0 text-sm text-muted-foreground/50 @max-lg:hidden">/</span>
        </>
      ) : null}
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
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
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
        >
          <Play className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} className="max-w-80">
          {projectConfig?.error ? (
            <p className="selectable px-2 py-1.5 text-xs text-destructive">{projectConfig.error}</p>
          ) : null}
          {scripts.map((script) => (
            <DropdownMenuItem
              key={script.name}
              title={script.command}
              onSelect={() => runScript(threadId, script)}
            >
              <Play />
              <span className="min-w-0 flex-1 truncate">{script.name}</span>
              {script.preview_url && window.desktop ? (
                <Globe className="text-muted-foreground" />
              ) : null}
            </DropdownMenuItem>
          ))}
          {scripts.length > 0 || projectConfig?.error ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => setIsEditingScripts(true)}>
            <Pencil />
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
  const activeTerminal = useStore((state) => state.activeTerminals[threadId]);
  const isBrowserOpen = useBrowser((state) => state.threads[threadId]?.open ?? false);
  const isSimulatorOpen = useSimulator(threadId).open;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="More panels"
        aria-label="More panels"
        className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
      >
        <EllipsisVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8}>
        <DropdownMenuCheckboxItem
          checked={activeTerminal !== undefined}
          onCheckedChange={() => toggleTerminalPanel(threadId)}
        >
          <SquareTerminal />
          Terminal
          <DropdownMenuShortcut>{formatKeybinding("terminal.toggle")}</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        {window.desktop ? (
          <DropdownMenuCheckboxItem
            checked={isBrowserOpen}
            onCheckedChange={() => toggleBrowser(threadId)}
          >
            <Globe />
            Browser
            <DropdownMenuShortcut>{formatKeybinding("browser.toggle")}</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ) : null}
        {isSimulatorAvailable ? (
          <DropdownMenuCheckboxItem
            checked={isSimulatorOpen}
            onCheckedChange={() => toggleSimulator(threadId)}
          >
            <Smartphone />
            Simulator
            <DropdownMenuShortcut>{formatKeybinding("simulator.toggle")}</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
