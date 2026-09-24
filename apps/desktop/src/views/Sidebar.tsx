import { AnimatedSidebar, AnimatedSidebarRail, AnimatedSidebarTrigger } from "@/components/motion/animated-sidebar";
import { Button } from "@/components/motion/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/motion/context-menu";
import { Input } from "@/components/motion/input";
import { Tooltip } from "@/components/motion/tooltip";
import { MorphPopover, MorphPopoverContent, MorphPopoverMenu, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { Separator } from "@/components/ui/separator";
import { ProjectBadge } from "@/components/project-badge";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@/lib/utils";
import { DEFAULT_SETTLE_DELAY_MINUTES, type Project, type ThreadInfo } from "@apcode/contracts";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FolderPlus,
  ListFilter,
  type LucideIcon,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { canSettle, isSeen, isSettled, send, setSettled, useStore } from "../lib/store.ts";
import { addProject } from "../lib/projects.ts";
import { ago, useNow } from "../lib/time.ts";
import { usePersistedFlag } from "../lib/usePersistedFlag.ts";
import type { ModalView } from "./AppModal.tsx";

const IconButton = ({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) => (
  <Tooltip content={label} side="bottom">
    <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} className="size-7">
      {children}
    </Button>
  </Tooltip>
);

export const Sidebar = (props: {
  activeId: string | null;
  /** Folder of the thread or draft on screen; new threads start there. */
  currentPath: string | null;
  onSelect: (id: string) => void;
  onModal: (view: ModalView) => void;
  /** Opens a new-thread draft; null leaves the project to pick. */
  onDraft: (path: string | null) => void;
}) => {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const seen = useStore((s) => s.seen);
  const settleDelayMs = useStore((s) => s.settings.settleDelayMinutes ?? DEFAULT_SETTLE_DELAY_MINUTES) * 60_000;
  const [query, setQuery] = useState("");
  // Projects to show; empty means all.
  const [projectFilter, setProjectFilter] = useState<ReadonlySet<string>>(new Set());
  const now = useNow();

  // One flat list across projects: whatever still needs you on top, then settled threads; newest activity first in each.
  const [showArchived, setShowArchived] = useState(false);
  const [showSettled, setShowSettled] = usePersistedFlag("apcode.sidebar.settledOpen", true);
  const { active, settled, archived } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byId = new Map(projects.map((p) => [p.id, p]));
    const infos = Object.values(threads)
      .filter((info) => projectFilter.size === 0 || projectFilter.has(info.projectId))
      .filter(
        (info) =>
          !needle ||
          [info.title, byId.get(info.projectId)?.name, info.branch].some((s) => s?.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const current = infos.filter((info) => info.archivedAt === null);
    return {
      active: current.filter((info) => !isSettled(info, seen, now, settleDelayMs)),
      settled: current.filter((info) => isSettled(info, seen, now, settleDelayMs)),
      archived: infos.filter((info) => info.archivedAt !== null),
    };
  }, [projects, threads, seen, query, projectFilter, now, settleDelayMs]);

  const filtering = projectFilter.size > 0 || query.trim() !== "";

  const projectOf = (info: ThreadInfo) =>
    projects.find((p) => p.id === info.projectId) ?? { id: info.projectId, name: info.cwd.split("/").at(-1) ?? info.cwd, path: info.cwd, addedAt: 0 };

  const renderCards = (infos: Array<ThreadInfo>) =>
    infos.map((info) => (
          <ThreadCard
            key={info.id}
            info={info}
            project={projectOf(info)}
            active={info.id === props.activeId}
            unread={info.archivedAt === null && !isSeen(info, seen)}
            settled={info.archivedAt !== null || isSettled(info, seen, now, settleDelayMs)}
            now={now}
            onSelect={() => props.onSelect(info.id)}
          />
    ));

  const renderList = (label: string, infos: Array<ThreadInfo>) =>
    infos.length === 0 ? null : (
      <section className="flex flex-col gap-0.5">
        <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h3>
        {renderCards(infos)}
      </section>
    );

  // Foldable sections open themselves while searching, so matches are never hidden.
  const renderFolding = (label: string, infos: Array<ThreadInfo>, open: boolean, toggle: () => void) => {
    if (infos.length === 0) return null;
    const expanded = open || Boolean(query);
    return (
      <section className="flex flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex items-center gap-1 self-start px-3 pt-2 pb-1 text-left text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        >
          {label}
          <span className="tabular-nums text-muted-foreground/60">{infos.length}</span>
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        </button>
        {expanded ? renderCards(infos) : null}
      </section>
    );
  };

  const empty = active.length === 0 && settled.length === 0 && archived.length === 0;

  return (
    <AnimatedSidebar ariaLabel="Threads" collapsible="offcanvas" className="min-h-0" panelClassName="h-full bg-sidebar">
      {/* Title bar. The traffic lights (trafficLightPosition 16,20) are centred 18.5px down and end at 76px;
          the bottom padding centres this row on them, the left padding leaves them room. */}
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-1 pr-3 pb-[3px] pl-[86px]">
        <AnimatedSidebarTrigger className="size-7 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
        <span data-tauri-drag-region className="text-sm font-semibold text-foreground">
          APCode
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 px-3 pt-1">
        <Input
          value={query}
          onChange={setQuery}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Search"
          aria-label="Search threads"
          leftIcon={<Search />}
          className="min-w-0 flex-1"
          classNames={{
            field: "h-7 rounded-lg border-transparent ring-0 hover:bg-muted/60 data-[state=focused]:bg-muted",
            leftIcon: "left-1.5",
            input: "selectable pl-8 text-sm placeholder:text-muted-foreground",
          }}
        />
        <ProjectFilter projects={projects} selected={projectFilter} onChange={setProjectFilter} />
        <IconButton label="Add project" onClick={() => void addProject().then((path) => path && props.onDraft(path))}>
          <FolderPlus className="size-4" />
        </IconButton>
        <IconButton label="New thread" onClick={() => props.onDraft(props.currentPath)}>
          <SquarePen className="size-4" />
        </IconButton>
      </div>

      <Separator className="mx-5 mt-3 mb-1 w-auto!" />

      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto overscroll-contain px-2 pb-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {empty ? (
            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {filtering ? "No matching threads." : "No threads yet. Start one with the pen above."}
            </p>
          ) : (
            <>
              {renderList("Active", active)}
              {renderFolding("Settled", settled, showSettled, () => setShowSettled(!showSettled))}
              {renderFolding("Archived", archived, showArchived, () => setShowArchived((open) => !open))}
            </>
          )}
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sidebar to-transparent" />
      </div>

      <div className="flex shrink-0 items-center px-3 pt-1 pb-3">
        <Button
          variant="ghost"
          onClick={() => props.onModal("settings")}
          className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground hover:text-foreground"
        >
          <Settings className="size-4" />
          Settings
        </Button>
      </div>
      <AnimatedSidebarRail />
    </AnimatedSidebar>
  );
};

/** Header button that narrows the thread list to chosen projects. */
const ProjectFilter = (props: {
  projects: ReadonlyArray<Project>;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) => {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    const next = new Set(props.selected);
    if (!next.delete(id)) next.add(id);
    props.onChange(next);
  };
  const row =
    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-4 focus-visible:ring-ring";
  const active = props.selected.size > 0;

  return (
    // Keep the label out of the way while the menu is open.
    <Tooltip content="Filter" side="bottom" open={open ? false : undefined}>
      <MorphPopover open={open} onOpenChange={setOpen}>
        <MorphPopoverTrigger>
          <Button variant="ghost" size="icon" aria-label="Filter threads" className="relative size-7">
            <ListFilter className={cn("size-4", active && "text-foreground")} />
            {active ? <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" /> : null}
          </Button>
        </MorphPopoverTrigger>
        <MorphPopoverContent side="bottom" align="end" sideOffset={8} radius={12} className="w-52 p-1.5">
          <MorphPopoverMenu>
            <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">Projects</p>
            <button type="button" onClick={() => props.onChange(new Set())} className={row}>
              <Check aria-hidden="true" className={cn("size-3.5 shrink-0", active && "invisible")} />
              <span className="min-w-0 truncate">All projects</span>
            </button>
            {props.projects.map((project) => (
              <button key={project.id} type="button" aria-pressed={props.selected.has(project.id)} onClick={() => toggle(project.id)} className={row}>
                <Check aria-hidden="true" className={cn("size-3.5 shrink-0", !props.selected.has(project.id) && "invisible")} />
                <ProjectBadge project={project} />
                <span className="min-w-0 truncate">{project.name}</span>
              </button>
            ))}
          </MorphPopoverMenu>
        </MorphPopoverContent>
      </MorphPopover>
    </Tooltip>
  );
};

/** What a thread is doing, right of its title. */
const StatusMark = ({ info, unread }: { info: ThreadInfo; unread: boolean }) => {
  if (info.status === "running") {
    const Logo = PROVIDER_LOGO[info.provider];
    return (
      <Logo
        aria-label="Working"
        className={cn(
          "size-3.5 shrink-0 animate-spin [animation-duration:2.4s]",
          info.provider === "claude" ? "text-[#D97757]" : "text-foreground",
        )}
      />
    );
  }
  if (info.status === "awaiting-approval") return <span className="shrink-0 text-[11px] font-medium text-warning">Needs approval</span>;
  if (info.status === "error") return <span className="shrink-0 text-[11px] font-medium text-destructive">Error</span>;
  if (unread) return <span aria-label="New activity" className="size-2 shrink-0 rounded-full bg-foreground" />;
  return null;
};

interface CardAction {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** Keeps the menu open, e.g. to ask for confirmation. */
  readonly keepOpen?: boolean;
}

/** One action list, shared by the ⋯ menu and the right-click menu. */
const useThreadActions = (info: ThreadInfo, settled: boolean) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archived = info.archivedAt !== null;
  const actions: Array<CardAction> = [
    ...(archived
      ? [
          {
            key: "unarchive",
            label: "Unarchive",
            icon: ArchiveRestore,
            onSelect: () => send({ _tag: "thread.archive", threadId: info.id, archived: false }),
          },
        ]
      : [
          {
            key: "settle",
            label: settled ? "Unsettle" : "Settle",
            icon: settled ? CircleDot : CircleCheck,
            onSelect: () => setSettled(info.id, !settled),
            disabled: !canSettle(info),
          },
          {
            key: "archive",
            label: "Archive",
            icon: Archive,
            onSelect: () => send({ _tag: "thread.archive", threadId: info.id, archived: true }),
            disabled: !canSettle(info),
          },
        ]),
    confirmDelete
      ? {
          key: "delete",
          label: "Click again to delete",
          icon: Trash2,
          destructive: true,
          onSelect: () => send({ _tag: "thread.close", threadId: info.id }),
        }
      : { key: "delete", label: "Delete", icon: Trash2, destructive: true, keepOpen: true, onSelect: () => setConfirmDelete(true) },
  ];
  return { actions, resetConfirm: () => setConfirmDelete(false) };
};

const MenuRow = ({ action, onDone }: { action: CardAction; onDone: () => void }) => (
  <button
    type="button"
    disabled={action.disabled}
    onClick={() => {
      action.onSelect();
      if (!action.keepOpen) onDone();
    }}
    className={cn(
      "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
      action.destructive ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10" : "text-foreground hover:bg-muted focus-visible:bg-muted",
    )}
  >
    <action.icon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="min-w-0 truncate">{action.label}</span>
  </button>
);

const ThreadCard = (props: {
  info: ThreadInfo;
  project: Project;
  active: boolean;
  unread: boolean;
  settled: boolean;
  now: number;
  onSelect: () => void;
}) => {
  const { info, project } = props;
  const [menuOpen, setMenuOpenState] = useState(false);
  const { actions, resetConfirm } = useThreadActions(info, props.settled);
  const setMenuOpen = (open: boolean) => {
    setMenuOpenState(open);
    if (!open) resetConfirm();
  };

  return (
    <ContextMenu onOpenChange={(open) => !open && resetConfirm()}>
      <ContextMenuTrigger>
        <div
          role="button"
          tabIndex={0}
          aria-current={props.active ? "page" : undefined}
          onClick={props.onSelect}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            props.onSelect();
          }}
          className={cn(
            "group/card cursor-default rounded-xl px-3 py-2 outline-none transition-colors focus-visible:ring-4 focus-visible:ring-ring",
            props.active ? "bg-muted" : "hover:bg-muted/50",
          )}
        >
          <div className="flex h-5 items-center gap-2 text-xs text-muted-foreground">
            <ProjectBadge project={project} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="shrink-0">{project.name}</span>
              {info.branch ? <span className="min-w-0 truncate text-muted-foreground/60">{info.branch}</span> : null}
            </span>
            <span className={cn("shrink-0 tabular-nums", menuOpen ? "hidden" : "group-hover/card:hidden")}>{ago(info.updatedAt, props.now)}</span>
            <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
              <MorphPopoverTrigger>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Actions for ${info.title}`}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "-my-1 -mr-1.5 size-6 shrink-0 place-items-center rounded-md hover:bg-foreground/5",
                    menuOpen ? "grid" : "hidden group-hover/card:grid",
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </MorphPopoverTrigger>
              <MorphPopoverContent side="bottom" align="end" sideOffset={8} radius={12} className="w-48 p-1.5">
                <MorphPopoverMenu onClick={(e) => e.stopPropagation()}>
                  {actions.map((action) => (
                    <MenuRow key={action.key} action={action} onDone={() => setMenuOpen(false)} />
                  ))}
                </MorphPopoverMenu>
              </MorphPopoverContent>
            </MorphPopover>
          </div>
          <div className="mt-0.5 flex h-5 items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{info.title}</p>
            <StatusMark info={info} unread={props.unread} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent ariaLabel={`Actions for ${info.title}`} className="min-w-48">
        {actions.map((action) => (
          <ContextMenuItem
            key={action.key}
            onSelect={action.onSelect}
            disabled={action.disabled}
            closeOnSelect={!action.keepOpen}
            tone={action.destructive ? "destructive" : "default"}
            textValue={action.label}
          >
            <action.icon aria-hidden="true" className="size-3.5 shrink-0" />
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
};
