import { AnimatedSidebar, AnimatedSidebarRail, AnimatedSidebarTrigger } from "@apcode/ui/motion/animated-sidebar";
import { Button } from "@apcode/ui/motion/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@apcode/ui/motion/context-menu";
import { Input } from "@apcode/ui/motion/input";
import { Tooltip } from "@apcode/ui/motion/tooltip";
import { MorphPopover, MorphPopoverContent, MorphPopoverMenu, MorphPopoverTrigger } from "@apcode/ui/motion/popover-morph";
import { EASE_OUT } from "@apcode/ui/lib/ease";
import { NumberTicker } from "@apcode/ui/motion/number-ticker";
import { SharedLayoutBg } from "@apcode/ui/motion/shared-layout-bg";
import { Separator } from "@apcode/ui/components/separator";
import { ProjectBadge } from "@/components/project-badge";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@apcode/ui/lib/utils";
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
import { AnimatePresence, motion, type Transition, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { canSettle, isSeen, isSettled, send, setSettled, useStore } from "../lib/store.ts";
import { addProject } from "../lib/projects.ts";
import { ago, useNow } from "../lib/time.ts";
import { usePersistedFlag } from "../lib/usePersistedFlag.ts";
import type { ModalView } from "./AppModal.tsx";

// Fold springs, borrowed from BouncyAccordion (@apcode/ui/motion/bouncy-accordion).
const FOLD_OPEN: Transition = { type: "spring", duration: 0.58, bounce: 0.32 };
// Closing is a plain ease: a bouncy spring overshoots past zero height, which clamps and stutters.
const FOLD_CLOSE: Transition = { duration: 0.24, ease: EASE_OUT, opacity: { duration: 0.12, ease: EASE_OUT } };
const FOLD_CHEVRON: Transition = { type: "spring", duration: 0.42, bounce: 0.28 };

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
  const reduce = useReducedMotion();

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

  // One hover pill glides between rows. Each row carries the hairline above it, centred in the gap
  // and hidden next to a filled (hovered or current) row.
  const renderCards = (infos: Array<ThreadInfo>) => (
    <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted/50" className="gap-1">
      {infos.map((info) => (
        <div
          key={info.id}
          className={cn(
            "before:pointer-events-none before:absolute before:inset-x-3 before:-top-[2.5px] before:h-px before:bg-border/60",
            "first:before:hidden hover:before:hidden has-[[aria-current=page]]:before:hidden",
            "[:hover+&]:before:hidden [:has([aria-current=page])+&]:before:hidden",
          )}
        >
          <ThreadCard
            info={info}
            project={projectOf(info)}
            active={info.id === props.activeId}
            unread={info.archivedAt === null && !isSeen(info, seen)}
            settled={info.archivedAt !== null || isSettled(info, seen, now, settleDelayMs)}
            now={now}
            onSelect={() => props.onSelect(info.id)}
          />
        </div>
      ))}
    </SharedLayoutBg>
  );

  const renderList = (label: string, infos: Array<ThreadInfo>) =>
    infos.length === 0 ? null : (
      <section className="flex flex-col">
        <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h3>
        {renderCards(infos)}
      </section>
    );

  // Foldable sections open themselves while searching, so matches are never hidden.
  // The header is a full-width row, sticky while open so it can be folded from anywhere in the list.
  const renderFolding = (label: string, icon: LucideIcon, infos: Array<ThreadInfo>, open: boolean, toggle: () => void) => {
    if (infos.length === 0) return null;
    const expanded = open || Boolean(query);
    const Icon = icon;
    return (
      <section className="flex flex-col gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className={cn(
            "group/fold flex h-9 w-full shrink-0 items-center gap-2 rounded-xl px-3 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
            expanded && "sticky top-0 z-20 bg-sidebar hover:bg-sidebar",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="font-medium">{label}</span>
          <NumberTicker
            value={infos.length}
            startOnView={false}
            duration={0.5}
            className="ml-auto rounded-full bg-muted px-1.5 py-px text-[11px] leading-4"
          />
          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={reduce ? { duration: 0 } : FOLD_CHEVRON}
            className="grid shrink-0 place-items-center"
          >
            <ChevronRight className="size-3.5" />
          </motion.span>
        </button>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="rows"
              // Clip only while moving, so focus rings aren't cut once open.
              initial={{ height: 0, opacity: 0, overflow: "hidden" }}
              animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
              exit={{ height: 0, opacity: 0, overflow: "hidden", transition: reduce ? { duration: 0 } : FOLD_CLOSE }}
              transition={reduce ? { duration: 0 } : FOLD_OPEN}
            >
              {renderCards(infos)}
            </motion.div>
          ) : null}
        </AnimatePresence>
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
              {settled.length + archived.length > 0 ? (
                <div className={cn("flex flex-col gap-0.5", active.length > 0 && "mt-2 border-t border-border/60 pt-2")}>
                  {renderFolding("Settled", CircleCheck, settled, showSettled, () => setShowSettled(!showSettled))}
                  {renderFolding("Archived", Archive, archived, showArchived, () => setShowArchived((open) => !open))}
                </div>
              ) : null}
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

/** Leading dot on the meta row: hue only when the thread needs you, solid while there's something new. */
const StatusDot = ({ info, unread, settled }: { info: ThreadInfo; unread: boolean; settled: boolean }) => {
  const [label, tone] =
    info.status === "awaiting-approval"
      ? ["Needs approval", "bg-warning"]
      : info.status === "error"
        ? ["Error", "bg-destructive"]
        : info.status === "running"
          ? ["Working", "bg-foreground animate-pulse"]
          : unread
            ? ["New activity", "bg-foreground"]
            : settled
              ? ["Settled", "bg-muted-foreground/25"]
              : ["Idle", "bg-muted-foreground/60"];
  return <span role="img" aria-label={label} className={cn("size-2 shrink-0 rounded-full", tone)} />;
};

/** Provider mark; spins while the agent works. */
const ProviderMark = ({ info }: { info: ThreadInfo }) => {
  const Logo = PROVIDER_LOGO[info.provider];
  const running = info.status === "running";
  return (
    <Logo
      className={cn(
        "size-3.5 shrink-0",
        running && "animate-spin [animation-duration:2.4s]",
        running && info.provider === "claude" ? "text-[#D97757]" : "text-muted-foreground",
      )}
    />
  );
};

/** Right end of the meta row: why the thread needs you, else its age. */
const TrailingLabel = ({ info, now }: { info: ThreadInfo; now: number }) => {
  if (info.status === "awaiting-approval") return <span className="font-medium text-warning">Needs approval</span>;
  if (info.status === "error") return <span className="font-medium text-destructive">Error</span>;
  return <span className="tabular-nums">{ago(info.updatedAt, now)}</span>;
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
            "group/card cursor-default rounded-xl px-3 py-2.5 outline-none transition-colors focus-visible:ring-4 focus-visible:ring-ring",
            props.active && "bg-muted",
          )}
        >
          <p className={cn("truncate text-sm text-foreground", props.unread ? "font-semibold" : "font-medium", props.settled && !props.active && "text-foreground/75")}>
            {info.title}
          </p>
          <div className="mt-1 flex h-5 items-center gap-2 text-xs text-muted-foreground">
            <StatusDot info={info} unread={props.unread} settled={props.settled} />
            <ProviderMark info={info} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0">{project.name}</span>
              {info.branch ? (
                <>
                  <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
                  <span className="min-w-0 truncate text-muted-foreground/70">{info.branch}</span>
                </>
              ) : null}
            </span>
            <span className={cn("shrink-0", menuOpen ? "hidden" : "group-hover/card:hidden")}>
              <TrailingLabel info={info} now={props.now} />
            </span>
            <span className={cn("-my-1 -mr-1 shrink-0 items-center gap-0.5", menuOpen ? "flex" : "hidden group-hover/card:flex")}>
              {info.archivedAt === null ? (
                <Tooltip content={props.settled ? "Unsettle" : "Settle"} side="bottom">
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={!canSettle(info)}
                    aria-label={props.settled ? "Unsettle" : "Settle"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSettled(info.id, !props.settled);
                    }}
                    className="grid size-6 place-items-center rounded-full hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
                  >
                    {props.settled ? <CircleDot className="size-3.5" /> : <CircleCheck className="size-3.5" />}
                  </button>
                </Tooltip>
              ) : null}
              <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
                <MorphPopoverTrigger>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Actions for ${info.title}`}
                    onClick={(e) => e.stopPropagation()}
                    className="grid size-6 place-items-center rounded-full hover:bg-foreground/5 hover:text-foreground"
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
            </span>
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
