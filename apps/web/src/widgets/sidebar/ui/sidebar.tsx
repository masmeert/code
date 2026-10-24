import { Sidebar as AnimatedSidebar, SidebarRail, SidebarTrigger } from "@masmeert/ui/sidebar";
import { Button } from "@masmeert/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@masmeert/ui/context-menu";
import { Input } from "@masmeert/ui/input";
import { Tooltip } from "@masmeert/ui/tooltip";
import {
  MorphingPopover,
  MorphingPopoverContent,
  MorphingPopoverMenu,
  MorphingPopoverTrigger,
} from "@masmeert/ui/morphing-popover";
import { spring } from "@masmeert/ui/lib/springs";
import { NumberTicker } from "@masmeert/ui/number-ticker";
import { SharedLayoutBg } from "@masmeert/ui/shared-layout-bg";
import { formatProjectLabel, getProjectKey } from "@masscode/client";
import {
  buildFallbackProject,
  ProjectBadge,
  useProjectHost,
  useProjectStore,
} from "@/entities/project";
import { getHarnessTint, PROVIDER_LOGO } from "@/entities/provider";
import { cn } from "@masscode/ui/lib/utils";
import { formatBinding, isMac } from "@masmeert/ui/lib/keys";
import {
  ClientCommand,
  isAwaitingUser,
  type Project,
  type ThreadInfo,
  UpdateStatus,
} from "@masscode/contracts";
import { categoryOf, describeActivity } from "@masscode/client";
import { TextShimmer } from "@masmeert/ui/text-shimmer";
import {
  IconArchive,
  IconArrowBarToDown,
  IconCheck,
  IconChevronRight,
  IconDots,
  IconEdit,
  IconLayoutSidebar,
  IconPencil,
  IconRestore,
  IconRotateClockwise,
  IconSearch,
  IconSettings,
  IconTrash,
  IconX,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { memo, type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useSetting, useSettings } from "@/entities/settings";
import { canShelve, isSeen, respondApproval, setShelved, useThreadStore } from "@/entities/thread";
import { send } from "@/shared/api";
import { formatKeybinding } from "@/shared/lib/keybindings";
import { useThreadListView } from "../model/thread-list-view.ts";
import { formatAge } from "@masscode/client";
import { useNow } from "@masscode/client";
import { getUpdateAction, useUpdateStatus } from "@/features/update-app";
import { getStatusDotStyle, NEEDS_YOU, PLAN_APPROVAL_TITLE } from "@masscode/client";
import { usePersistedFlag } from "@/shared/lib/storage";
import { hasTrafficLights } from "@/shared/config";
import { IconButton } from "@/shared/ui";
import { KeepAwakeIndicator } from "./keep-awake-indicator.tsx";
import { ServicesIndicator } from "./services-indicator.tsx";
import { ThreadListMenu } from "./thread-list-menu.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

/** Waiting on you: an approval, an answer, or a look at what went wrong. */
function isWaitingOnYou(info: ThreadInfo) {
  return isAwaitingUser(info.status) || info.status === "error";
}

export function Sidebar(props: {
  activeId: string | null;
  /** Folder of the thread or draft on screen; new threads start there. */
  currentPath: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onOpenServices: () => void;
  /** Opens a new-thread draft; null leaves the project to pick. */
  onDraft: (path: string | null) => void;
}) {
  const projects = useProjectStore((state) => state.projects);
  const threads = useThreadStore((state) => state.threads);
  const [query, setQuery] = useState("");
  const [view, setView] = useThreadListView();
  const now = useNow();
  const shouldReduceMotion = useReducedMotion();
  const updateStatus = useUpdateStatus();
  const updateAction = updateStatus ? getUpdateAction(updateStatus) : null;

  // Grouped by state: whatever still needs you on top, then shelved threads, then archived ones.
  const [isArchivedShown, setIsArchivedShown] = useState(false);

  const [isShelvedShown, setIsShelvedShown] = usePersistedFlag(
    "masscode.sidebar.shelvedOpen",
    true,
  );

  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlyArray<string>>([]);
  // Sections render a page of rows at a time: recent history is the common lookup, the deep tail shouldn't dominate the list.
  const [shownCounts, setShownCounts] = useState<Readonly<Record<string, number>>>({});

  const { infos, needsYou, active, shelved, archived, projectGroups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    function getProjectGroupKey(projectId: string) {
      const project = projectsById.get(projectId);

      return project ? getProjectKey(project) : projectId;
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
      needsYou: current.filter((info) => !info.shelved && isWaitingOnYou(info)),
      active: current.filter((info) => !info.shelved && !isWaitingOnYou(info)),
      shelved: current.filter((info) => info.shelved),
      archived: infos.filter((info) => info.archivedAt !== null),
      // One group per repo, whichever machines its threads run on.
      projectGroups: [...new Set(infos.map((info) => getProjectGroupKey(info.projectId)))].map(
        (key) => infos.filter((info) => getProjectGroupKey(info.projectId) === key),
      ),
    };
  }, [projects, threads, query, view, now]);

  function getThreadProject(info: ThreadInfo) {
    return (
      projects.find((project) => project.id === info.projectId) ??
      buildFallbackProject(info.projectId, info.cwd)
    );
  }

  function getShownThreads(key: string, infos: Array<ThreadInfo>) {
    return query ? infos : infos.slice(0, shownCounts[key] ?? 10);
  }

  // ⌘1–9 open the first nine threads in the order they're drawn; holding ⌘ shows each one's shortcut.
  let drawnInOrder: Array<ThreadInfo>;

  if (view.groupBy === "none") drawnInOrder = infos;
  else if (view.groupBy === "project")
    drawnInOrder = projectGroups.flatMap((group) => {
      const key = getProjectKey(getThreadProject(group[0]));

      return collapsedProjects.includes(key) && !query ? [] : getShownThreads(key, group);
    });
  else if (view.status === "archived") drawnInOrder = archived;
  else
    drawnInOrder = [
      ...needsYou,
      ...active,
      ...(isShelvedShown || query ? getShownThreads("shelved", shelved) : []),
      ...(isArchivedShown || query ? getShownThreads("archived", archived) : []),
    ];
  const jumpIds = drawnInOrder.slice(0, 9).map((info) => info.id);

  const [isDigitHintShown, setIsDigitHintShown] = useState(false);

  // Reads the threads in the order drawn when the key is pressed.
  const jumpToThread = useEffectEvent((event: KeyboardEvent) => {
    const id = /^[1-9]$/.test(event.key) ? jumpIds[Number(event.key) - 1] : null;

    if (!id) return;
    event.preventDefault();
    props.onSelect(id);
  });

  useEffect(() => {
    const modifier = isMac ? "Meta" : "Control";
    let hintTimer: ReturnType<typeof setTimeout> | undefined;

    function hideDigitHints() {
      clearTimeout(hintTimer);
      setIsDigitHintShown(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === modifier) {
        // A delay, so the hints don't flash for every other ⌘ shortcut.
        hintTimer = setTimeout(() => setIsDigitHintShown(true), 200);

        return;
      }

      hideDigitHints();
      const isModifierHeld = isMac ? event.metaKey : event.ctrlKey;

      if (event.defaultPrevented || !isModifierHeld || event.shiftKey || event.altKey) return;
      jumpToThread(event);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === modifier) hideDigitHints();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hideDigitHints);

    return () => {
      hideDigitHints();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideDigitHints);
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
            transition={shouldReduceMotion ? { duration: 0 } : spring.moderate}
            className={cn(
              "before:pointer-events-none before:absolute before:inset-x-3 before:-top-[2.5px] before:h-px before:bg-border/60",
              "first:before:hidden hover:before:hidden has-[[aria-current=page]]:before:hidden",
              "[:has([aria-current=page])+&]:before:hidden [:hover+&]:before:hidden",
            )}
          >
            <ThreadCard
              info={info}
              project={getThreadProject(info)}
              isActive={info.id === props.activeId}
              isUnread={info.archivedAt === null && !isSeen(info)}
              isShelved={info.archivedAt !== null || info.shelved}
              now={now}
              digit={
                isDigitHintShown && jumpIds.includes(info.id) ? jumpIds.indexOf(info.id) + 1 : null
              }
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
    isOpen: boolean,
    toggle: () => void,
  ) {
    if (infos.length === 0) return null;

    const isExpanded = isOpen || Boolean(query);
    const shouldSnap = shouldReduceMotion || Boolean(query);
    const shown = getShownThreads(key, infos);

    return (
      <motion.section
        key={key}
        layout="position"
        transition={shouldSnap ? { duration: 0 } : spring.moderate}
        className="relative flex flex-col gap-1"
      >
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={toggle}
          className={cn(
            typeClass("caption"),
            "group/fold flex h-9 w-full shrink-0 items-center gap-2 rounded-xl px-3 text-left text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
            isExpanded && "sticky top-0 z-20 bg-sidebar hover:bg-sidebar",
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
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={shouldSnap ? { duration: 0 } : spring.fast}
            className="grid shrink-0 place-items-center"
          >
            <IconChevronRight className="size-3.5" />
          </motion.span>
        </button>
        <AnimatePresence initial={false} mode="popLayout">
          {isExpanded ? (
            <motion.div
              key="rows"
              initial={shouldSnap ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={shouldSnap ? { duration: 0 } : spring.fast}
              className="w-full"
            >
              {renderCards(shown)}
              {infos.length > shown.length ? (
                <button
                  type="button"
                  onClick={() =>
                    setShownCounts((counts) => ({ ...counts, [key]: shown.length + 25 }))
                  }
                  className={cn(
                    typeClass("caption"),
                    "mt-1 flex h-8 w-full items-center rounded-xl px-3 text-left text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
                  )}
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
        <p className={cn(typeClass("caption"), "px-3 pt-2 text-muted-foreground")}>
          {Object.keys(threads).length > 0
            ? "No matching threads."
            : `No threads yet. Press ${formatKeybinding("thread.new")} to start one.`}
        </p>
      );

    if (view.groupBy === "none") return renderCards(infos);

    if (view.groupBy === "project")
      return (
        <div className="flex flex-col gap-0.5">
          {projectGroups.map((group) => {
            const project = getThreadProject(group[0]);
            const key = getProjectKey(project);

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
            transition={shouldReduceMotion || query ? { duration: 0 } : spring.moderate}
            className={cn(
              "mt-auto flex flex-col gap-0.5",
              needsYou.length + active.length > 0 && "border-t border-border/60 pt-2",
            )}
          >
            {renderFolding("shelved", "Shelved", <IconCheck />, shelved, isShelvedShown, () =>
              setIsShelvedShown(!isShelvedShown),
            )}
            {renderFolding("archived", "Archived", <IconArchive />, archived, isArchivedShown, () =>
              setIsArchivedShown((isShown) => !isShown),
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
        <SidebarTrigger className="size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-hover hover:text-foreground">
          <IconLayoutSidebar className="size-4" />
        </SidebarTrigger>
        <div className="ml-auto [-webkit-app-region:no-drag]">
          <Tooltip content={`New thread ${formatKeybinding("thread.new")}`} side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`New thread ${formatKeybinding("thread.new")}`}
              onClick={() => props.onDraft(props.currentPath)}
              className="size-7"
            >
              <IconEdit className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="shrink-0 px-3 pt-1">
        <Input
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => event.key === "Escape" && setQuery("")}
          placeholder="Search"
          aria-label="Search threads"
          leftIcon={<IconSearch />}
          rightIcon={<ThreadListMenu view={view} projects={projects} onChange={setView} />}
          classNames={{
            field:
              "h-7 rounded-lg border-transparent ring-0 hover:bg-hover data-[state=focused]:bg-muted",
            leftIcon: "left-1.5",
            rightIcon: "right-0 [&_button]:size-7",
            input: cn(typeClass("body"), "selectable pr-8 pl-8 placeholder:text-muted-foreground"),
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

      <div className="flex shrink-0 items-center gap-0.5 px-3 pt-1 pb-3">
        <IconButton label="Settings" onClick={props.onOpenSettings}>
          <IconSettings className="size-4" />
        </IconButton>
        <ServicesIndicator onOpen={props.onOpenServices} />
        <KeepAwakeIndicator />
        {updateStatus &&
        updateAction &&
        UpdateStatus.isAnyOf(["available", "downloading", "ready"])(updateStatus) ? (
          <IconButton
            label={`${updateAction.label} (v${updateStatus.version})`}
            disabled={updateAction.isBusy}
            onClick={updateAction.run}
            className="ml-auto w-auto min-w-7 rounded-full bg-brand/10 px-1.5 text-brand hover:bg-brand/15 hover:text-brand disabled:opacity-100"
          >
            {UpdateStatus.guards.downloading(updateStatus) ? (
              <span className="text-[10px] tabular-nums">{Math.round(updateStatus.percent)}%</span>
            ) : UpdateStatus.guards.ready(updateStatus) ? (
              <IconRotateClockwise className="size-4" />
            ) : (
              <IconArrowBarToDown className="size-4" />
            )}
          </IconButton>
        ) : null}
      </div>
      <SidebarRail />
    </AnimatedSidebar>
  );
}

/** Leading dot on the meta row: hue only when the thread needs you, solid while there's something new. */
function StatusDot({
  info,
  isUnread,
  isShelved,
}: {
  info: ThreadInfo;
  isUnread: boolean;
  isShelved: boolean;
}) {
  const { label, tone } = getStatusDotStyle(info, isUnread, isShelved);

  return (
    <span role="img" aria-label={label} className={cn("size-2 shrink-0 rounded-full", tone)} />
  );
}

/** Provider mark; spins while the agent works. */
function ProviderMark({ info }: { info: ThreadInfo }) {
  const Logo = PROVIDER_LOGO[info.provider];
  const settings = useSettings();
  const isRunning = info.status === "running";

  return (
    <Logo
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground",
        isRunning && "animate-spin [animation-duration:2.4s]",
        isRunning && getHarnessTint(settings, info.provider).active,
      )}
    />
  );
}

/** Right end of the meta row: why the thread needs you, else its age. */
function TrailingLabel({ info, now }: { info: ThreadInfo; now: number }) {
  const needsYou = NEEDS_YOU[info.status];

  if (needsYou)
    return <span className={cn("font-medium", needsYou.labelTone)}>{needsYou.label}</span>;

  return <span className="tabular-nums">{formatAge(info.updatedAt, now)}</span>;
}

interface CardAction {
  readonly key: string;
  readonly label: string;
  readonly icon: TablerIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** Keeps the menu open, e.g. to ask for confirmation. */
  readonly keepOpen?: boolean;
}

/** One action list, shared by the ⋯ menu and the right-click menu. */
function useThreadActions(info: ThreadInfo, isShelved: boolean, onRename: () => void) {
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const shouldConfirmArchive = useSetting((settings) => settings.confirmArchive === true);
  const shouldConfirmDelete = useSetting((settings) => settings.confirmDelete !== false);

  const isArchived = info.archivedAt !== null;

  const actions: Array<CardAction> = [
    { key: "rename", label: "Rename", icon: IconPencil, onSelect: onRename },
    ...(isArchived
      ? [
          {
            key: "unarchive",
            label: "Unarchive",
            icon: IconRestore,
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
            label: isShelved ? "Unshelve" : "Shelve",
            icon: isShelved ? IconX : IconCheck,
            onSelect: () => setShelved(info.id, !isShelved),
            disabled: !canShelve(info),
          },
          shouldConfirmArchive && confirming !== "archive"
            ? {
                key: "archive",
                label: "Archive",
                icon: IconArchive,
                keepOpen: true,
                onSelect: () => setConfirming("archive"),
                disabled: !canShelve(info),
              }
            : {
                key: "archive",
                label: shouldConfirmArchive ? "Click again to archive" : "Archive",
                icon: IconArchive,
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
    shouldConfirmDelete && confirming !== "delete"
      ? {
          key: "delete",
          label: "Delete",
          icon: IconTrash,
          destructive: true,
          keepOpen: true,
          onSelect: () => setConfirming("delete"),
        }
      : {
          key: "delete",
          label: shouldConfirmDelete ? "Click again to delete" : "Delete",
          icon: IconTrash,
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
        typeClass("caption"),
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        action.destructive
          ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
          : "text-foreground",
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
  isActive: boolean;
  isUnread: boolean;
  isShelved: boolean;
  now: number;
  /** The ⌘-number that opens it, shown while ⌘ is held; null otherwise. */
  digit: number | null;
  /** Must be stable, or every row redraws on each sidebar render. */
  onSelect: (id: string) => void;
}) {
  const { info, project } = props;
  const host = useProjectHost(project.id);
  const shouldReduceMotion = useReducedMotion();
  const [isMenuOpen, setIsMenuOpenState] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);

  const { actions, resetConfirm } = useThreadActions(info, props.isShelved, () =>
    setIsRenaming(true),
  );

  // Two-finger swipe left shelves (or unshelves): the row follows the fingers, and past the
  // threshold letting go commits; short of it, it springs back.
  const swipeX = useMotionValue(0);
  const swipeEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const swipeReveal = useTransform(swipeX, [-64, -16], [1, 0]);

  const isUrgent = !props.isShelved && isWaitingOnYou(info);
  const request = info.request;

  function setIsMenuOpen(isOpen: boolean) {
    setIsMenuOpenState(isOpen);

    if (!isOpen) resetConfirm();
  }

  useEffect(() => () => clearTimeout(swipeEnd.current), []);
  useEffect(() => setIsResponding(false), [request?.requestId]);

  const title = isRenaming ? (
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
        setIsRenaming(false);
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
      <span
        className={cn(
          typeClass("caption"),
          "shrink-0",
          isMenuOpen ? "hidden" : "group-hover/card:hidden",
        )}
      >
        <TrailingLabel info={info} now={props.now} />
      </span>
      <span
        className={cn(
          "-my-1 -mr-1 shrink-0 items-center gap-0.5 text-muted-foreground",
          isMenuOpen ? "flex" : "hidden group-hover/card:flex",
        )}
      >
        {info.archivedAt === null ? (
          <Tooltip content={props.isShelved ? "Unshelve" : "Shelve"} side="bottom">
            <button
              type="button"
              tabIndex={-1}
              disabled={!canShelve(info)}
              aria-label={props.isShelved ? "Unshelve" : "Shelve"}
              onClick={(event) => {
                event.stopPropagation();
                setShelved(info.id, !props.isShelved);
              }}
              className="grid size-6 place-items-center rounded-full hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
            >
              {props.isShelved ? (
                <IconX className="size-3.5" />
              ) : (
                <IconCheck className="size-3.5" />
              )}
            </button>
          </Tooltip>
        ) : null}
        <MorphingPopover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <MorphingPopoverTrigger>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Actions for ${info.title}`}
              onClick={(event) => event.stopPropagation()}
              className="grid size-6 place-items-center rounded-full hover:bg-foreground/5 hover:text-foreground"
            >
              <IconDots className="size-4" />
            </button>
          </MorphingPopoverTrigger>
          <MorphingPopoverContent
            side="bottom"
            align="end"
            sideOffset={8}
            radius={12}
            className="w-48 p-1.5"
          >
            <MorphingPopoverMenu onClick={(event) => event.stopPropagation()}>
              {actions.map((action) => (
                <MenuRow key={action.key} action={action} onDone={() => setIsMenuOpen(false)} />
              ))}
            </MorphingPopoverMenu>
          </MorphingPopoverContent>
        </MorphingPopover>
      </span>
    </>
  );

  return (
    <ContextMenu onOpenChange={(isOpen) => !isOpen && resetConfirm()}>
      <ContextMenuTrigger>
        <div className="relative">
          <motion.span
            aria-hidden="true"
            style={{ opacity: swipeReveal }}
            className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-muted-foreground"
          >
            {props.isShelved ? <IconX className="size-4" /> : <IconCheck className="size-4" />}
          </motion.span>
          <motion.div
            role="button"
            tabIndex={0}
            aria-current={props.isActive ? "page" : undefined}
            style={{ x: swipeX }}
            onClick={() => props.onSelect(info.id)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && event.key === "F2") setIsRenaming(true);

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
                if (swipeX.get() <= -64) setShelved(info.id, !props.isShelved);
                animate(swipeX, 0, shouldReduceMotion ? { duration: 0 } : spring.fast);
              }, 120);
            }}
            className={cn(
              "group/card rounded-xl px-3 transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring",
              props.isShelved ? "py-1.5" : "py-2.5",
              props.isActive && "bg-muted",
            )}
          >
            {props.isShelved ? (
              <div className="flex h-5 min-w-0 items-center gap-2 text-muted-foreground">
                <p
                  onDoubleClick={() => setIsRenaming(true)}
                  className={cn(
                    typeClass("body"),
                    "min-w-0 flex-1 truncate",
                    props.isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {title}
                </p>
                {trailing}
              </div>
            ) : (
              <div className="min-w-0">
                <p
                  onDoubleClick={() => setIsRenaming(true)}
                  className={cn(
                    typeClass("body"),
                    "truncate text-foreground",
                    props.isUnread || isUrgent ? "font-semibold" : "font-medium",
                  )}
                >
                  {title}
                </p>
                <div
                  className={cn(
                    typeClass("caption"),
                    "mt-1 flex h-5 items-center gap-2 text-muted-foreground",
                  )}
                >
                  <StatusDot info={info} isUnread={props.isUnread} isShelved={props.isShelved} />
                  <ProviderMark info={info} />
                  {info.status === "running" ? (
                    <TextShimmer
                      className={cn(
                        "block min-w-0 flex-1 truncate",
                        info.activity && categoryOf(info.activity.tool) === "run" && "font-mono",
                      )}
                    >
                      {describeActivity(info.activity)}
                    </TextShimmer>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="max-w-full shrink-0 truncate">
                        {formatProjectLabel(project.name, host)}
                      </span>
                      {info.branch ? (
                        <>
                          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
                          <span className="min-w-0 truncate text-muted-foreground">
                            {info.branch}
                          </span>
                        </>
                      ) : null}
                    </span>
                  )}
                  {trailing}
                </div>
                {isUrgent &&
                request &&
                !request.asksQuestions &&
                request.title !== PLAN_APPROVAL_TITLE ? (
                  <>
                    <p className="mt-2 truncate rounded-lg bg-muted/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                      <span className="text-foreground">{request.title}</span> {request.detail}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        size="compact"
                        disabled={isResponding}
                        onClick={(event) => {
                          event.stopPropagation();
                          setIsResponding(true);
                          respondApproval(info.id, request.requestId, "allow");
                        }}
                        className="h-7 rounded-lg px-2.5"
                      >
                        Allow
                      </Button>
                      <Button
                        size="compact"
                        variant="ghost"
                        disabled={isResponding}
                        onClick={(event) => {
                          event.stopPropagation();
                          setIsResponding(true);
                          respondApproval(info.id, request.requestId, "deny");
                        }}
                        className="h-7 rounded-lg px-2.5"
                      >
                        Deny
                      </Button>
                    </div>
                  </>
                ) : isUrgent && request ? (
                  <Button
                    size="compact"
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
              className="pointer-events-none absolute top-1/2 right-1.5 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium text-foreground shadow-sm"
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
