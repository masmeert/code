import {
  AnimatedSidebar,
  AnimatedSidebarRail,
  AnimatedSidebarTrigger,
} from "@apcode/ui/motion/animated-sidebar";
import { Button } from "@apcode/ui/motion/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@apcode/ui/motion/context-menu";
import { Input } from "@apcode/ui/motion/input";
import { Tooltip } from "@apcode/ui/motion/tooltip";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverMenu,
  MorphPopoverTrigger,
} from "@apcode/ui/motion/popover-morph";
import { EASE_OUT, SPRING_SWAP } from "@apcode/ui/lib/ease";
import { NumberTicker } from "@apcode/ui/motion/number-ticker";
import { SharedLayoutBg } from "@apcode/ui/motion/shared-layout-bg";
import { Separator } from "@apcode/ui/components/separator";
import { ProjectBadge } from "@/components/project-badge";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@apcode/ui/lib/utils";
import {
  ClientCommand,
  DEFAULT_SETTLE_DELAY_MINUTES,
  type Project,
  type ThreadInfo,
} from "@apcode/contracts";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FolderPlus,
  type LucideIcon,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion, type Transition, useReducedMotion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { canSettle, isSeen, isSettled, send, setSettled, useStore } from "../lib/store.ts";
import { addProject } from "../lib/projects.ts";
import { useThreadListView } from "../lib/threadListView.ts";
import { ago, useNow } from "../lib/time.ts";
import { usePersistedFlag } from "../lib/usePersistedFlag.ts";
import type { ModalView } from "./AppModal.tsx";
import { ThreadListMenu } from "./ThreadListMenu.tsx";

// A plain ease: a bouncy spring overshoots past zero height, which clamps and stutters.
const FOLD: Transition = {
  duration: 0.24,
  ease: EASE_OUT,
  opacity: { duration: 0.12, ease: EASE_OUT },
};

const IconButton = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
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
  const settleDelayMs =
    useStore((s) => s.settings.settleDelayMinutes ?? DEFAULT_SETTLE_DELAY_MINUTES) * 60_000;
  const [query, setQuery] = useState("");
  const [view, setView] = useThreadListView();
  const now = useNow();
  const reduce = useReducedMotion();

  // Grouped by state: whatever still needs you on top, then settled threads, then archived ones.
  const [showArchived, setShowArchived] = useState(false);
  const [showSettled, setShowSettled] = usePersistedFlag("apcode.sidebar.settledOpen", true);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlyArray<string>>([]);
  const { infos, active, settled, archived, projectGroups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byId = new Map(projects.map((p) => [p.id, p]));
    const infos = Object.values(threads)
      .filter(
        (info) =>
          view.status === "all" || (info.archivedAt !== null) === (view.status === "archived"),
      )
      .filter((info) => view.projects.length === 0 || view.projects.includes(info.projectId))
      .filter((info) => view.provider === "all" || info.provider === view.provider)
      .filter(
        (info) =>
          view.activity === "any" ||
          now - info.updatedAt <= { day: 1, week: 7, month: 30 }[view.activity] * 86_400_000,
      )
      .filter(
        (info) =>
          !needle ||
          [info.title, byId.get(info.projectId)?.name, info.branch].some((s) =>
            s?.toLowerCase().includes(needle),
          ),
      )
      .sort((a, b) =>
        view.sortBy === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt,
      );
    const current = infos.filter((info) => info.archivedAt === null);
    return {
      infos,
      active: current.filter((info) => !isSettled(info, seen, now, settleDelayMs)),
      settled: current.filter((info) => isSettled(info, seen, now, settleDelayMs)),
      archived: infos.filter((info) => info.archivedAt !== null),
      projectGroups: [...new Set(infos.map((info) => info.projectId))].map((projectId) =>
        infos.filter((info) => info.projectId === projectId),
      ),
    };
  }, [projects, threads, seen, query, view, now, settleDelayMs]);

  const projectOf = (info: ThreadInfo) =>
    projects.find((p) => p.id === info.projectId) ?? {
      id: info.projectId,
      name: info.cwd.split("/").at(-1) ?? info.cwd,
      path: info.cwd,
      addedAt: 0,
    };

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
            "[:has([aria-current=page])+&]:before:hidden [:hover+&]:before:hidden",
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
  const renderFolding = (
    key: string,
    label: string,
    icon: ReactNode,
    infos: Array<ThreadInfo>,
    open: boolean,
    toggle: () => void,
  ) => {
    if (infos.length === 0) return null;
    const expanded = open || Boolean(query);
    const snap = reduce || Boolean(query);
    return (
      <section key={key} className="flex flex-col gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className={cn(
            "group/fold flex h-9 w-full shrink-0 items-center gap-2 rounded-xl px-3 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
            expanded && "sticky top-0 z-20 bg-sidebar hover:bg-sidebar",
          )}
        >
          <span aria-hidden="true" className="grid shrink-0 place-items-center [&>svg]:size-3.5">
            {icon}
          </span>
          <span className="min-w-0 truncate font-medium">{label}</span>
          <NumberTicker
            value={infos.length}
            startOnView={false}
            duration={0.2}
            className="ml-auto rounded-full bg-muted px-1.5 py-px text-[11px] leading-4"
          />
          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={snap ? { duration: 0 } : SPRING_SWAP}
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
              initial={snap ? false : { height: 0, opacity: 0, overflow: "hidden" }}
              animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
              exit={{
                height: 0,
                opacity: 0,
                overflow: "hidden",
                transition: snap ? { duration: 0 } : FOLD,
              }}
              transition={FOLD}
            >
              {renderCards(infos)}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>
    );
  };

  return (
    <AnimatedSidebar
      ariaLabel="Threads"
      collapsible="offcanvas"
      className="min-h-0"
      panelClassName="h-full bg-sidebar"
    >
      {/* Title bar. The traffic lights (trafficLightPosition 16,11) are centred 18.5px down and end at 76px;
          the bottom padding centres this row on them, the left padding leaves them room. */}
      <div className="flex h-10 shrink-0 items-center gap-1 pr-3 pb-[3px] pl-[86px] [-webkit-app-region:drag]">
        <AnimatedSidebarTrigger className="size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-muted/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
        <span className="text-sm font-semibold text-foreground">APCode</span>
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
            field:
              "h-7 rounded-lg border-transparent ring-0 hover:bg-muted/60 data-[state=focused]:bg-muted",
            leftIcon: "left-1.5",
            input: "selectable pl-8 text-sm placeholder:text-muted-foreground",
          }}
        />
        <ThreadListMenu view={view} projects={projects} onChange={setView} />
        <IconButton
          label="Add project"
          onClick={() => void addProject().then((path) => path && props.onDraft(path))}
        >
          <FolderPlus className="size-4" />
        </IconButton>
        <IconButton label="New thread" onClick={() => props.onDraft(props.currentPath)}>
          <SquarePen className="size-4" />
        </IconButton>
      </div>

      <Separator className="mx-5 mt-3 mb-1 w-auto!" />

      <div className="relative min-h-0 flex-1">
        <div className="h-full [scrollbar-width:none] overflow-y-auto overscroll-contain px-2 pb-8 [&::-webkit-scrollbar]:hidden">
          {infos.length === 0 ? (
            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {Object.keys(threads).length > 0
                ? "No matching threads."
                : "No threads yet. Start one with the pen above."}
            </p>
          ) : view.groupBy === "none" ? (
            renderCards(infos)
          ) : view.groupBy === "project" ? (
            <div className="flex flex-col gap-0.5">
              {projectGroups.map((group) => {
                const project = projectOf(group[0]);
                return renderFolding(
                  project.id,
                  project.name,
                  <ProjectBadge project={project} />,
                  group,
                  !collapsedProjects.includes(project.id),
                  () =>
                    setCollapsedProjects((current) =>
                      current.includes(project.id)
                        ? current.filter((id) => id !== project.id)
                        : [...current, project.id],
                    ),
                );
              })}
            </div>
          ) : (
            <>
              {renderList("Active", active)}
              {settled.length + archived.length > 0 ? (
                <div
                  className={cn(
                    "flex flex-col gap-0.5",
                    active.length > 0 && "mt-2 border-t border-border/60 pt-2",
                  )}
                >
                  {renderFolding("settled", "Settled", <CircleCheck />, settled, showSettled, () =>
                    setShowSettled(!showSettled),
                  )}
                  {view.status === "archived"
                    ? renderList("Archived", archived)
                    : renderFolding(
                        "archived",
                        "Archived",
                        <Archive />,
                        archived,
                        showArchived,
                        () => setShowArchived((open) => !open),
                      )}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sidebar to-transparent"
        />
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

/** Leading dot on the meta row: hue only when the thread needs you, solid while there's something new. */
const StatusDot = ({
  info,
  unread,
  settled,
}: {
  info: ThreadInfo;
  unread: boolean;
  settled: boolean;
}) => {
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
  return (
    <span role="img" aria-label={label} className={cn("size-2 shrink-0 rounded-full", tone)} />
  );
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
  if (info.status === "awaiting-approval")
    return <span className="font-medium text-warning">Needs approval</span>;
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
            onSelect: () =>
              send(
                ClientCommand.cases["thread.archive"].make({ threadId: info.id, archived: false }),
              ),
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
            onSelect: () =>
              send(
                ClientCommand.cases["thread.archive"].make({ threadId: info.id, archived: true }),
              ),
            disabled: !canSettle(info),
          },
        ]),
    confirmDelete
      ? {
          key: "delete",
          label: "Click again to delete",
          icon: Trash2,
          destructive: true,
          onSelect: () => send(ClientCommand.cases["thread.close"].make({ threadId: info.id })),
        }
      : {
          key: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          keepOpen: true,
          onSelect: () => setConfirmDelete(true),
        },
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
      "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
      action.destructive
        ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
        : "text-foreground hover:bg-muted focus-visible:bg-muted",
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
            "group/card cursor-default rounded-xl px-3 py-2.5 transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring",
            props.active && "bg-muted",
          )}
        >
          <p
            className={cn(
              "truncate text-sm text-foreground",
              props.unread ? "font-semibold" : "font-medium",
              props.settled && !props.active && "text-foreground/75",
            )}
          >
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
            <span
              className={cn(
                "-my-1 -mr-1 shrink-0 items-center gap-0.5",
                menuOpen ? "flex" : "hidden group-hover/card:flex",
              )}
            >
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
                    {props.settled ? (
                      <CircleDot className="size-3.5" />
                    ) : (
                      <CircleCheck className="size-3.5" />
                    )}
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
                <MorphPopoverContent
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  radius={12}
                  className="w-48 p-1.5"
                >
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
