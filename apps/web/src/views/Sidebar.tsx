import {
  AnimatedSidebar,
  AnimatedSidebarRail,
  AnimatedSidebarTrigger,
} from "@masscode/ui/motion/animated-sidebar";
import { Button } from "@masscode/ui/motion/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@masscode/ui/motion/context-menu";
import { Input } from "@masscode/ui/motion/input";
import { Tooltip } from "@masscode/ui/motion/tooltip";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverMenu,
  MorphPopoverTrigger,
} from "@masscode/ui/motion/popover-morph";
import { SPRING_LAYOUT, SPRING_SWAP } from "@masscode/ui/lib/ease";
import { NumberTicker } from "@masscode/ui/motion/number-ticker";
import { SharedLayoutBg } from "@masscode/ui/motion/shared-layout-bg";
import { ProjectBadge, projectLabel } from "@/components/project-badge";
import { harnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@masscode/ui/lib/utils";
import { formatBinding, isMac } from "@masscode/ui/lib/keys";
import {
  ClientCommand,
  isAwaitingUser,
  type Project,
  type ThreadActivity,
  type ThreadInfo,
  UpdateStatus,
} from "@masscode/contracts";
import * as Match from "effect/Match";
import { categoryOf, livePhrase } from "@masscode/ui/agents/tool-group";
import { TextShimmer } from "@masscode/ui/motion/text-shimmer";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Check,
  ChevronRight,
  type LucideIcon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  canShelve,
  isSeen,
  respondApproval,
  send,
  setShelved,
  useProjectHost,
  useStore,
} from "../lib/store.ts";
import { describe } from "../lib/keybindings.ts";
import { projectKey } from "../lib/projects.ts";
import { useThreadListView } from "../lib/threadListView.ts";
import { ago, useNow } from "../lib/time.ts";
import { useUpdateStatus } from "../lib/updates.ts";
import { usePersistedFlag } from "../lib/usePersistedFlag.ts";
import type { ModalView } from "./AppModal.tsx";
import { ThreadListMenu } from "./ThreadListMenu.tsx";

/** Waiting on you: an approval, an answer, or a look at what went wrong. */
function waitsOnYou(info: ThreadInfo) {
  return isAwaitingUser(info.status) || info.status === "error";
}

/** Only the macOS desktop window draws traffic lights over the top-left corner. */
export const hasTrafficLights = Boolean(window.desktop) && isMac;

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} side="bottom">
      <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} className="size-7">
        {children}
      </Button>
    </Tooltip>
  );
}

export function Sidebar(props: {
  activeId: string | null;
  /** Folder of the thread or draft on screen; new threads start there. */
  currentPath: string | null;
  onSelect: (id: string) => void;
  onModal: (view: ModalView) => void;
  /** Opens a new-thread draft; null leaves the project to pick. */
  onDraft: (path: string | null) => void;
}) {
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const [query, setQuery] = useState("");
  const [view, setView] = useThreadListView();
  const now = useNow();
  const reduceMotion = useReducedMotion();
  const updateStatus = useUpdateStatus();

  // Grouped by state: whatever still needs you on top, then shelved threads, then archived ones.
  const [showArchived, setShowArchived] = useState(false);
  const [showShelved, setShowShelved] = usePersistedFlag("masscode.sidebar.shelvedOpen", true);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlyArray<string>>([]);
  // Sections render a page of rows at a time: recent history is the common lookup, the deep tail shouldn't dominate the list.
  const [shownCounts, setShownCounts] = useState<Readonly<Record<string, number>>>({});
  const { infos, needsYou, active, shelved, archived, projectGroups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    function keyOf(projectId: string) {
      const project = projectsById.get(projectId);
      return project ? projectKey(project) : projectId;
    }

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
          [info.title, projectsById.get(info.projectId)?.name, info.branch].some((field) =>
            field?.toLowerCase().includes(needle),
          ),
      )
      .sort((first, second) =>
        view.sortBy === "created"
          ? second.createdAt - first.createdAt
          : second.updatedAt - first.updatedAt,
      );
    const current = infos.filter((info) => info.archivedAt === null);

    return {
      infos,
      needsYou: current.filter((info) => !info.shelved && waitsOnYou(info)),
      active: current.filter((info) => !info.shelved && !waitsOnYou(info)),
      shelved: current.filter((info) => info.shelved),
      archived: infos.filter((info) => info.archivedAt !== null),
      // One group per repo, whichever machines its threads run on.
      projectGroups: [...new Set(infos.map((info) => keyOf(info.projectId)))].map((key) =>
        infos.filter((info) => keyOf(info.projectId) === key),
      ),
    };
  }, [projects, threads, query, view, now]);

  function projectOf(info: ThreadInfo) {
    return (
      projects.find((project) => project.id === info.projectId) ?? {
        id: info.projectId,
        name: info.cwd.split("/").at(-1) ?? info.cwd,
        path: info.cwd,
        addedAt: 0,
      }
    );
  }

  function shownOf(key: string, infos: Array<ThreadInfo>) {
    return query ? infos : infos.slice(0, shownCounts[key] ?? 10);
  }

  // ⌘1–9 open the first nine threads in the order they're drawn; holding ⌘ shows each one's shortcut.
  let drawnInOrder: Array<ThreadInfo>;
  if (view.groupBy === "none") drawnInOrder = infos;
  else if (view.groupBy === "project")
    drawnInOrder = projectGroups.flatMap((group) => {
      const key = projectKey(projectOf(group[0]));
      return collapsedProjects.includes(key) && !query ? [] : shownOf(key, group);
    });
  else if (view.status === "archived") drawnInOrder = archived;
  else
    drawnInOrder = [
      ...needsYou,
      ...active,
      ...(showShelved || query ? shownOf("shelved", shelved) : []),
      ...(showArchived || query ? shownOf("archived", archived) : []),
    ];
  const jumpIds = drawnInOrder.slice(0, 9).map((info) => info.id);

  const [showDigits, setShowDigits] = useState(false);
  const latestJump = useRef({ ids: jumpIds, onSelect: props.onSelect });
  latestJump.current = { ids: jumpIds, onSelect: props.onSelect };

  useEffect(() => {
    const modifier = isMac ? "Meta" : "Control";
    let hintTimer: ReturnType<typeof setTimeout> | undefined;

    function hideDigits() {
      clearTimeout(hintTimer);
      setShowDigits(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === modifier) {
        // A delay, so the hints don't flash for every other ⌘ shortcut.
        hintTimer = setTimeout(() => setShowDigits(true), 200);
        return;
      }

      hideDigits();
      const held = isMac ? event.metaKey : event.ctrlKey;
      if (event.defaultPrevented || !held || event.shiftKey || event.altKey) return;
      const id = /^[1-9]$/.test(event.key) ? latestJump.current.ids[Number(event.key) - 1] : null;
      if (!id) return;
      event.preventDefault();
      latestJump.current.onSelect(id);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === modifier) hideDigits();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hideDigits);
    return () => {
      hideDigits();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideDigits);
    };
  }, []);

  // One hover pill glides between rows; rows glide too, so one leaving closes its gap smoothly.
  // Each row carries the hairline above it, centred in the gap and hidden next to a filled
  // (hovered or current) row.
  function renderCards(infos: Array<ThreadInfo>) {
    return (
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted/50" className="gap-1">
        {infos.map((info) => (
          <motion.div
            key={info.id}
            layout="position"
            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
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
              unread={info.archivedAt === null && !isSeen(info)}
              shelved={info.archivedAt !== null || info.shelved}
              now={now}
              digit={showDigits && jumpIds.includes(info.id) ? jumpIds.indexOf(info.id) + 1 : null}
              onSelect={props.onSelect}
            />
          </motion.div>
        ))}
      </SharedLayoutBg>
    );
  }

  function renderList(label: ReactNode, infos: Array<ThreadInfo>) {
    if (infos.length === 0) return null;

    return (
      <section className="flex flex-col">
        <h3 className="flex items-center gap-2 px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
          {label}
        </h3>
        {renderCards(infos)}
      </section>
    );
  }

  // Foldable sections open themselves while searching, so matches are never hidden.
  // The header is a full-width row, sticky while open so it can be folded from anywhere in the list.
  // No height animation: rows fade while sections glide to their new positions, so a shelf
  // pinned to the bottom rises as one block. popLayout lifts closing rows out of flow at once;
  // positioned in their section, they ride its glide as they fade.
  function renderFolding(
    key: string,
    label: string,
    icon: ReactNode,
    infos: Array<ThreadInfo>,
    open: boolean,
    toggle: () => void,
  ) {
    if (infos.length === 0) return null;

    const expanded = open || Boolean(query);
    const snap = reduceMotion || Boolean(query);
    const shown = shownOf(key, infos);

    return (
      <motion.section
        key={key}
        layout="position"
        transition={snap ? { duration: 0 } : SPRING_LAYOUT}
        className="relative flex flex-col gap-1"
      >
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
        <AnimatePresence initial={false} mode="popLayout">
          {expanded ? (
            <motion.div
              key="rows"
              initial={snap ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={snap ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
              className="w-full"
            >
              {renderCards(shown)}
              {infos.length > shown.length ? (
                <button
                  type="button"
                  onClick={() =>
                    setShownCounts((counts) => ({ ...counts, [key]: shown.length + 25 }))
                  }
                  className="mt-1 flex h-8 w-full items-center rounded-xl px-3 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
                >
                  Show {Math.min(25, infos.length - shown.length)} more
                </button>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.section>
    );
  }

  function renderThreads() {
    if (infos.length === 0)
      return (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          {Object.keys(threads).length > 0
            ? "No matching threads."
            : `No threads yet. Press ${describe("thread.new")} to start one.`}
        </p>
      );

    if (view.groupBy === "none") return renderCards(infos);

    if (view.groupBy === "project")
      return (
        <div className="flex flex-col gap-0.5">
          {projectGroups.map((group) => {
            const project = projectOf(group[0]);
            const key = projectKey(project);
            return renderFolding(
              key,
              project.name,
              <ProjectBadge project={project} />,
              group,
              !collapsedProjects.includes(key),
              () =>
                setCollapsedProjects((current) =>
                  current.includes(key) ? current.filter((id) => id !== key) : [...current, key],
                ),
            );
          })}
        </div>
      );

    if (view.status === "archived") return renderList("Archived", archived);

    return (
      <>
        {renderList(
          <>
            <span className="size-1.5 rounded-full bg-warning" />
            <span className="text-foreground">Needs you</span>
            <span className="tabular-nums">{needsYou.length}</span>
          </>,
          needsYou,
        )}
        {renderList("Active", active)}
        {shelved.length + archived.length > 0 ? (
          <motion.div
            // Pinned to the bottom while folded, like t3code's shelf; unfolding rises into the free space.
            layout="position"
            transition={reduceMotion || query ? { duration: 0 } : SPRING_LAYOUT}
            className={cn(
              "mt-auto flex flex-col gap-0.5",
              needsYou.length + active.length > 0 && "border-t border-border/60 pt-2",
            )}
          >
            {renderFolding("shelved", "Shelved", <Check />, shelved, showShelved, () =>
              setShowShelved(!showShelved),
            )}
            {renderFolding("archived", "Archived", <Archive />, archived, showArchived, () =>
              setShowArchived((open) => !open),
            )}
          </motion.div>
        ) : null}
      </>
    );
  }

  return (
    <AnimatedSidebar
      ariaLabel="Threads"
      collapsible="offcanvas"
      className="min-h-0"
      panelClassName="h-full bg-sidebar"
    >
      {/* Title bar. The traffic lights (trafficLightPosition 16,11) are centred 18.5px down and end at 76px;
          the bottom padding centres this row on them, the left padding leaves them room. */}
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 pr-3 pb-[3px] [-webkit-app-region:drag]",
          hasTrafficLights ? "pl-[86px]" : "pl-3",
        )}
      >
        <AnimatedSidebarTrigger className="size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-muted/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
        <div className="ml-auto [-webkit-app-region:no-drag]">
          <IconButton
            label={`New thread ${describe("thread.new")}`}
            onClick={() => props.onDraft(props.currentPath)}
          >
            <SquarePen className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="shrink-0 px-3 pt-1">
        <Input
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => event.key === "Escape" && setQuery("")}
          placeholder="Search"
          aria-label="Search threads"
          leftIcon={<Search />}
          rightIcon={<ThreadListMenu view={view} projects={projects} onChange={setView} />}
          classNames={{
            field:
              "h-7 rounded-lg border-transparent ring-0 hover:bg-muted/60 data-[state=focused]:bg-muted",
            leftIcon: "left-1.5",
            rightIcon: "right-0 [&_button]:size-7",
            input: "selectable pr-8 pl-8 text-sm placeholder:text-muted-foreground",
          }}
        />
      </div>

      <div className="relative mt-2 min-h-0 flex-1">
        <motion.div
          layoutScroll
          className="flex h-full [scrollbar-width:none] flex-col overflow-y-auto overscroll-contain px-2 pb-2 [&::-webkit-scrollbar]:hidden"
        >
          {renderThreads()}
        </motion.div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-sidebar to-transparent"
        />
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-3 pt-1 pb-3">
        {updateStatus &&
        UpdateStatus.isAnyOf(["available", "downloading", "ready"])(updateStatus) ? (
          <Button
            variant="ghost"
            disabled={UpdateStatus.guards.downloading(updateStatus)}
            onClick={() =>
              UpdateStatus.guards.ready(updateStatus)
                ? window.desktop?.installUpdate()
                : window.desktop?.downloadUpdate()
            }
            className="h-8 w-full justify-start gap-2 rounded-lg bg-brand/10 px-2 text-sm font-normal text-brand hover:bg-brand/15 hover:text-brand disabled:opacity-100"
          >
            <ArrowDownToLine className="size-4" />
            {Match.value(updateStatus).pipe(
              Match.tag("available", () => "Download update"),
              Match.tag("downloading", ({ percent }) => `Downloading ${Math.round(percent)}%`),
              Match.tag("ready", () => "Restart to update"),
              Match.exhaustive,
            )}
            <span className="ml-auto text-xs tabular-nums opacity-70">v{updateStatus.version}</span>
          </Button>
        ) : null}
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
}

/** Leading dot on the meta row: hue only when the thread needs you, solid while there's something new. */
function StatusDot({
  info,
  unread,
  shelved,
}: {
  info: ThreadInfo;
  unread: boolean;
  shelved: boolean;
}) {
  const { label, tone } = statusDotStyle(info, unread, shelved);

  return (
    <span role="img" aria-label={label} className={cn("size-2 shrink-0 rounded-full", tone)} />
  );
}

function statusDotStyle(info: ThreadInfo, unread: boolean, shelved: boolean) {
  if (info.status === "awaiting-approval") return { label: "Needs approval", tone: "bg-warning" };
  if (info.status === "awaiting-answer") return { label: "Needs an answer", tone: "bg-warning" };
  if (info.status === "error") return { label: "Error", tone: "bg-destructive" };
  if (info.status === "running") return { label: "Working", tone: "bg-success animate-pulse" };
  if (unread) return { label: "New activity", tone: "bg-brand" };
  if (shelved) return { label: "Shelved", tone: "bg-muted-foreground/25" };
  return { label: "Idle", tone: "bg-brand" };
}

/** What a running thread is doing: the command it runs, else the tool call in words. */
function activityLabel(activity: ThreadActivity | undefined) {
  if (!activity) return "Thinking…";
  if (categoryOf(activity.tool) === "run") return activity.summary;
  return livePhrase({
    id: activity.toolId,
    name: activity.tool,
    summary: activity.summary,
    output: null,
    isError: false,
  });
}

/** Provider mark; spins while the agent works. */
function ProviderMark({ info }: { info: ThreadInfo }) {
  const Logo = PROVIDER_LOGO[info.provider];
  const settings = useStore((state) => state.settings);
  const running = info.status === "running";

  return (
    <Logo
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground",
        running && "animate-spin [animation-duration:2.4s]",
        running && harnessTint(settings, info.provider).active,
      )}
    />
  );
}

/** Right end of the meta row: why the thread needs you, else its age. */
function TrailingLabel({ info, now }: { info: ThreadInfo; now: number }) {
  if (info.status === "awaiting-approval")
    return <span className="font-medium text-warning">Needs approval</span>;
  if (info.status === "awaiting-answer")
    return <span className="font-medium text-warning">Needs an answer</span>;
  if (info.status === "error") return <span className="font-medium text-destructive">Error</span>;
  return <span className="tabular-nums">{ago(info.updatedAt, now)}</span>;
}

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
function useThreadActions(info: ThreadInfo, shelved: boolean, onRename: () => void) {
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const confirmArchive = useStore((state) => state.settings.confirmArchive === true);
  const confirmDelete = useStore((state) => state.settings.confirmDelete !== false);

  const archived = info.archivedAt !== null;
  const actions: Array<CardAction> = [
    { key: "rename", label: "Rename", icon: Pencil, onSelect: onRename },
    ...(archived
      ? [
          {
            key: "unarchive",
            label: "Unarchive",
            icon: ArchiveRestore,
            onSelect: () =>
              send(
                ClientCommand.cases["thread.archive"].make({
                  threadId: info.id,
                  archived: false,
                }),
              ),
          },
        ]
      : [
          {
            key: "shelve",
            label: shelved ? "Unshelve" : "Shelve",
            icon: shelved ? X : Check,
            onSelect: () => setShelved(info.id, !shelved),
            disabled: !canShelve(info),
          },
          confirmArchive && confirming !== "archive"
            ? {
                key: "archive",
                label: "Archive",
                icon: Archive,
                keepOpen: true,
                onSelect: () => setConfirming("archive"),
                disabled: !canShelve(info),
              }
            : {
                key: "archive",
                label: confirmArchive ? "Click again to archive" : "Archive",
                icon: Archive,
                onSelect: () =>
                  send(
                    ClientCommand.cases["thread.archive"].make({
                      threadId: info.id,
                      archived: true,
                    }),
                  ),
                disabled: !canShelve(info),
              },
        ]),
    confirmDelete && confirming !== "delete"
      ? {
          key: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          keepOpen: true,
          onSelect: () => setConfirming("delete"),
        }
      : {
          key: "delete",
          label: confirmDelete ? "Click again to delete" : "Delete",
          icon: Trash2,
          destructive: true,
          onSelect: () => send(ClientCommand.cases["thread.close"].make({ threadId: info.id })),
        },
  ];

  return { actions, resetConfirm: () => setConfirming(null) };
}

function MenuRow({ action, onDone }: { action: CardAction; onDone: () => void }) {
  return (
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
}

// Memoized: any thread's status or activity replaces `threads`, and only that thread's row should redraw.
const ThreadCard = memo(function ThreadCard(props: {
  info: ThreadInfo;
  project: Project;
  active: boolean;
  unread: boolean;
  shelved: boolean;
  now: number;
  /** The ⌘-number that opens it, shown while ⌘ is held; null otherwise. */
  digit: number | null;
  /** Must be stable, or every row redraws on each sidebar render. */
  onSelect: (id: string) => void;
}) {
  const { info, project } = props;
  const host = useProjectHost(project.id);
  const reduceMotion = useReducedMotion();
  const [menuOpen, setMenuOpenState] = useState(false);
  const [responding, setResponding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { actions, resetConfirm } = useThreadActions(info, props.shelved, () => setRenaming(true));
  // Two-finger swipe left shelves (or unshelves): the row follows the fingers, and past the
  // threshold letting go commits; short of it, it springs back.
  const swipeX = useMotionValue(0);
  const swipeEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const swipeReveal = useTransform(swipeX, [-64, -16], [1, 0]);

  const urgent = !props.shelved && waitsOnYou(info);
  const request = info.request;

  function setMenuOpen(open: boolean) {
    setMenuOpenState(open);
    if (!open) resetConfirm();
  }

  useEffect(() => () => clearTimeout(swipeEnd.current), []);
  useEffect(() => setResponding(false), [request?.requestId]);

  const title = renaming ? (
    <input
      autoFocus
      aria-label="Thread title"
      defaultValue={info.title}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.currentTarget.value = info.title;
        }
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
      onBlur={(event) => {
        setRenaming(false);
        const next = event.currentTarget.value.trim();
        if (next && next !== info.title)
          send(ClientCommand.cases["thread.rename"].make({ threadId: info.id, title: next }));
      }}
      className="w-full bg-transparent outline-none"
    />
  ) : (
    info.title
  );

  const trailing = (
    <>
      <span className={cn("shrink-0 text-xs", menuOpen ? "hidden" : "group-hover/card:hidden")}>
        <TrailingLabel info={info} now={props.now} />
      </span>
      <span
        className={cn(
          "-my-1 -mr-1 shrink-0 items-center gap-0.5 text-muted-foreground",
          menuOpen ? "flex" : "hidden group-hover/card:flex",
        )}
      >
        {info.archivedAt === null ? (
          <Tooltip content={props.shelved ? "Unshelve" : "Shelve"} side="bottom">
            <button
              type="button"
              tabIndex={-1}
              disabled={!canShelve(info)}
              aria-label={props.shelved ? "Unshelve" : "Shelve"}
              onClick={(event) => {
                event.stopPropagation();
                setShelved(info.id, !props.shelved);
              }}
              className="grid size-6 place-items-center rounded-full hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
            >
              {props.shelved ? <X className="size-3.5" /> : <Check className="size-3.5" />}
            </button>
          </Tooltip>
        ) : null}
        <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
          <MorphPopoverTrigger>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Actions for ${info.title}`}
              onClick={(event) => event.stopPropagation()}
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
            <MorphPopoverMenu onClick={(event) => event.stopPropagation()}>
              {actions.map((action) => (
                <MenuRow key={action.key} action={action} onDone={() => setMenuOpen(false)} />
              ))}
            </MorphPopoverMenu>
          </MorphPopoverContent>
        </MorphPopover>
      </span>
    </>
  );

  return (
    <ContextMenu onOpenChange={(open) => !open && resetConfirm()}>
      <ContextMenuTrigger>
        <div className="relative">
          <motion.span
            aria-hidden="true"
            style={{ opacity: swipeReveal }}
            className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-muted-foreground"
          >
            {props.shelved ? <X className="size-4" /> : <Check className="size-4" />}
          </motion.span>
          <motion.div
            role="button"
            tabIndex={0}
            aria-current={props.active ? "page" : undefined}
            style={{ x: swipeX }}
            onClick={() => props.onSelect(info.id)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && event.key === "F2") setRenaming(true);
              if (
                event.target !== event.currentTarget ||
                (event.key !== "Enter" && event.key !== " ")
              )
                return;
              event.preventDefault();
              props.onSelect(info.id);
            }}
            onWheel={(event) => {
              if (info.archivedAt !== null || !canShelve(info)) return;
              if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
              swipeX.set(Math.max(-96, Math.min(0, swipeX.get() - event.deltaX)));
              clearTimeout(swipeEnd.current);
              swipeEnd.current = setTimeout(() => {
                if (swipeX.get() <= -64) setShelved(info.id, !props.shelved);
                animate(swipeX, 0, reduceMotion ? { duration: 0 } : SPRING_SWAP);
              }, 120);
            }}
            className={cn(
              "group/card rounded-xl px-3 transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring",
              props.shelved ? "py-1.5" : "py-2.5",
              props.active && "bg-muted",
            )}
          >
            {props.shelved ? (
              <div className="flex h-5 min-w-0 items-center gap-2 text-muted-foreground">
                <p
                  onDoubleClick={() => setRenaming(true)}
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    props.active ? "text-foreground" : "text-foreground/60",
                  )}
                >
                  {title}
                </p>
                {trailing}
              </div>
            ) : (
              <div className="min-w-0">
                <p
                  onDoubleClick={() => setRenaming(true)}
                  className={cn(
                    "truncate text-sm text-foreground",
                    props.unread || urgent ? "font-semibold" : "font-medium",
                  )}
                >
                  {title}
                </p>
                <div className="mt-1 flex h-5 items-center gap-2 text-xs text-muted-foreground">
                  <StatusDot info={info} unread={props.unread} shelved={props.shelved} />
                  <ProviderMark info={info} />
                  {info.status === "running" ? (
                    <TextShimmer
                      className={cn(
                        "block min-w-0 flex-1 truncate",
                        info.activity && categoryOf(info.activity.tool) === "run" && "font-mono",
                      )}
                    >
                      {activityLabel(info.activity)}
                    </TextShimmer>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="max-w-full shrink-0 truncate">
                        {projectLabel(project.name, host)}
                      </span>
                      {info.branch ? (
                        <>
                          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
                          <span className="min-w-0 truncate text-muted-foreground/70">
                            {info.branch}
                          </span>
                        </>
                      ) : null}
                    </span>
                  )}
                  {trailing}
                </div>
                {urgent && request && !request.asksQuestions && request.title !== "ExitPlanMode" ? (
                  <>
                    <p className="mt-2 truncate rounded-lg bg-muted/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                      <span className="text-foreground">{request.title}</span> {request.detail}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        size="sm"
                        disabled={responding}
                        onClick={(event) => {
                          event.stopPropagation();
                          setResponding(true);
                          respondApproval(info.id, request.requestId, "allow");
                        }}
                        className="h-7 rounded-lg px-2.5"
                      >
                        Allow
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={responding}
                        onClick={(event) => {
                          event.stopPropagation();
                          setResponding(true);
                          respondApproval(info.id, request.requestId, "deny");
                        }}
                        className="h-7 rounded-lg px-2.5"
                      >
                        Deny
                      </Button>
                    </div>
                  </>
                ) : urgent && request ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onSelect(info.id);
                    }}
                    className="mt-2 h-7 rounded-lg px-2.5"
                  >
                    {request.asksQuestions ? "Answer" : "Review plan"}
                  </Button>
                ) : null}
              </div>
            )}
          </motion.div>
          {props.digit === null ? null : (
            // Overlaid, like t3code's: it never displaces the time or status, nor catches clicks.
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-1.5 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
            >
              {formatBinding(`mod+${props.digit}`)}
            </kbd>
          )}
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
});
