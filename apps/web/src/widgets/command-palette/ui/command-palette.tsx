import { formatProjectLabel } from "@masscode/client";
import { ProjectBadge, useProjectStore } from "@/entities/project";
import { searchCommands } from "@masmeert/ui/lib/command-search";
import { formatBinding, isMac } from "@masmeert/ui/lib/keys";
import { useRowCursor } from "@masmeert/ui/hooks/use-row-cursor";
import { cn } from "@masscode/ui/lib/utils";
import type { SearchHit } from "@masscode/contracts";
import { IconMessage, IconSearch } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useHostStore } from "@/entities/host";
import { searchMessages, useThreadStore } from "@/entities/thread";
import { typeClass } from "@masmeert/ui/lib/type-scale";

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

interface PaletteProps {
  readonly actions: ReadonlyArray<PaletteAction>;
  readonly onOpenThread: (threadId: string) => void;
  readonly onNewThreadIn: (path: string) => void;
  readonly onClose: () => void;
}

interface Row {
  readonly id: string;
  readonly section: string;
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly hint?: string;
  readonly run: () => void;
}

const MAX_THREADS = 8;

const SEARCH_DELAY_MS = 150;

const NO_HITS: ReadonlyArray<SearchHit> = [];

/** The daemon wraps each matched word in these. */
const MATCH_START = "\uE000";

const MATCH_END = "\uE001";

/** At most this much text before the first match, so a narrow row still shows it. */
const LEAD_CHARS = 24;

/** The snippet as plain text, starting just before its first match. */
function focusSnippet(text: string) {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+|\*\*|__|~~/g, "")
    .replace(/(^|\n)\s*(#{1,6}|>|[-*+]|\d+\.)\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  const matchAt = plain.indexOf(MATCH_START);

  if (matchAt <= LEAD_CHARS) return plain;

  // From a word boundary, so the lead doesn't open on half a word.
  const wordAt = plain.indexOf(" ", matchAt - LEAD_CHARS);

  return `…${plain.slice(wordAt === -1 || wordAt >= matchAt ? matchAt : wordAt + 1)}`;
}

/** A search snippet with the matched words highlighted. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {focusSnippet(text)
        .split(MATCH_START)
        .map((part, index) => {
          if (index === 0) return <Fragment key={index}>{part}</Fragment>;
          const [match, rest] = part.split(MATCH_END);

          return (
            <Fragment key={index}>
              <mark className="rounded-sm bg-brand/15 font-medium text-foreground">{match}</mark>
              {rest}
            </Fragment>
          );
        })}
    </>
  );
}

/** A row's action: close, then act with the latest props, so rows needn't be rebuilt when the parent re-renders. */
function createRowAction(latest: RefObject<PaletteProps>, act: (props: PaletteProps) => void) {
  return () => {
    latest.current.onClose();
    act(latest.current);
  };
}

/**
 * ⌘K: jump to a thread or project, run an action, or find a message across every
 * thread. Start with ">" for actions only.
 */
export function CommandPalette({ isOpen, ...props }: PaletteProps & { readonly isOpen: boolean }) {
  // Portaled, so no ancestor's transform or stacking context can trap the overlay.
  return isOpen ? createPortal(<Palette {...props} />, document.body) : null;
}

/** Mounted only while open, so a closed palette subscribes to nothing and searches nothing. */
function Palette(props: PaletteProps) {
  const threads = useThreadStore((state) => state.threads);
  const projects = useProjectStore((state) => state.projects);
  const projectHosts = useProjectStore((state) => state.projectHosts);
  const [query, setQuery] = useState("");
  // The query the hits answer, so a search still under way doesn't read as finding nothing.
  const [search, setSearch] = useState({ query: "", hits: NO_HITS });

  const isAnyHostConnected = useHostStore(
    (state) => state.connected || Object.values(state.hosts).some((host) => host.connected),
  );

  const idPrefix = useId();
  const shouldReduceMotion = useReducedMotion() ?? false;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(props);

  useLayoutEffect(() => {
    latest.current = props;
  });

  const isActionsOnly = query.startsWith(">");
  const needle = (isActionsOnly ? query.slice(1) : query).trim();
  const messageQuery = !isActionsOnly && needle.length >= 2 ? needle.toLowerCase() : "";

  // Message search goes to the daemon once there's something to look for.
  useEffect(() => {
    if (!messageQuery) return;

    let isCancelled = false;

    const timer = setTimeout(
      () =>
        void searchMessages(messageQuery).then(
          (hits) => !isCancelled && setSearch({ query: messageQuery, hits }),
        ),
      SEARCH_DELAY_MS,
    );

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [messageQuery]);

  // Rebuilt when the store changes, not per keystroke: the search caches each entry's normalized
  // text by identity. Newest first, which equal scores keep; archived threads after the rest.
  const threadEntries = useMemo(
    () =>
      Object.values(threads)
        .sort(
          (left, right) =>
            Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
            right.updatedAt - left.updatedAt,
        )
        .map((thread) => ({ label: thread.title, thread })),
    [threads],
  );

  const projectEntries = useMemo(
    () =>
      projects.map((project) => ({
        label: formatProjectLabel(project.name, projectHosts[project.id]),
        project,
      })),
    [projects, projectHosts],
  );

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // One memo per section, so a message search landing rebuilds only the message rows.
  const threadRows = useMemo(
    (): ReadonlyArray<Row> =>
      isActionsOnly
        ? []
        : searchCommands(threadEntries, needle)
            // Stable, so matches keep their ranking within each group.
            .toSorted(
              (left, right) =>
                Number(left.thread.archivedAt !== null) - Number(right.thread.archivedAt !== null),
            )
            .slice(0, MAX_THREADS)
            .map(({ thread }) => {
              const project = projectById.get(thread.projectId);

              return {
                id: `thread:${thread.id}`,
                section:
                  thread.archivedAt !== null
                    ? "Archived threads"
                    : needle
                      ? "Threads"
                      : "Recent threads",
                icon: project ? <ProjectBadge project={project} /> : <IconMessage />,
                label: thread.title,
                detail: project
                  ? formatProjectLabel(project.name, projectHosts[project.id])
                  : thread.cwd.split("/").at(-1),
                run: createRowAction(latest, (latestProps) => latestProps.onOpenThread(thread.id)),
              };
            }),
    [isActionsOnly, needle, threadEntries, projectById, projectHosts],
  );

  const actionRows = useMemo(
    (): ReadonlyArray<Row> =>
      searchCommands(props.actions, needle).map((action) => ({
        id: `action:${action.id}`,
        section: "Actions",
        icon: action.icon,
        label: action.label,
        hint: action.hint,
        run: createRowAction(latest, () => action.run()),
      })),
    [props.actions, needle],
  );

  const projectRows = useMemo(
    (): ReadonlyArray<Row> =>
      isActionsOnly || !needle
        ? []
        : searchCommands(projectEntries, needle).map(({ project }) => ({
            id: `project:${project.id}`,
            section: "New thread in",
            icon: <ProjectBadge project={project} />,
            label: formatProjectLabel(project.name, projectHosts[project.id]),
            detail: project.path,
            run: createRowAction(latest, (latestProps) => latestProps.onNewThreadIn(project.path)),
          })),
    [isActionsOnly, needle, projectEntries, projectHosts],
  );

  // Hits from an older query stay up until the new ones land, but not once there's no search at all.
  const shownHits = messageQuery ? search.hits : NO_HITS;

  const messageSearchStatus = !messageQuery
    ? null
    : !isAnyHostConnected
      ? "Can't search messages while MassCode is disconnected"
      : search.query !== messageQuery
        ? "Searching messages…"
        : null;

  const messageRows = useMemo(
    (): ReadonlyArray<Row> =>
      shownHits.map((hit) => ({
        id: `message:${hit.threadId}:${hit.messageId}`,
        section: "Messages",
        icon: <IconSearch />,
        label: <Snippet text={hit.snippet} />,
        detail: `${hit.from === "user" ? "You" : "Agent"} in ${threads[hit.threadId]?.title ?? ""}`,
        run: createRowAction(latest, (latestProps) => latestProps.onOpenThread(hit.threadId)),
      })),
    [shownHits, threads],
  );

  // Empty sections drop out: with no query that leaves recent threads, then actions.
  const rows = useMemo(
    () => [...threadRows, ...actionRows, ...projectRows, ...messageRows],
    [threadRows, actionRows, projectRows, messageRows],
  );

  const {
    activeIndex,
    pointed: isPointed,
    moveTo,
    moveActive,
  } = useRowCursor(rows, query, { loop: true });

  // The highlight glides after the pointer. Arrow keys and a new list jump it: the keyboard wants each
  // step at once, and gliding from wherever the old row ended up reads as the list scrolling.
  const shouldGlide = isPointed && !shouldReduceMotion;

  const activeId = rows[activeIndex]?.id;

  useEffect(() => {
    const container = list.current;

    if (!container) return;

    // The first row brings its section header into view too.
    if (activeIndex === 0) container.scrollTop = 0;
    else
      container
        .querySelector(`[data-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, activeId]);

  // Rows with a shortcut of their own keep it; the others are numbered ⌘1–9, in order.
  const quickPicks = rows.filter((row) => !row.hint).slice(0, 9);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      rows[activeIndex]?.run();
    } else if (event.key === "Escape") {
      // One layer per Escape: the settings modal may be open underneath.
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "Tab") {
      // Focus stays in the field; the arrows move through the rows.
      event.preventDefault();
    } else if ((isMac ? event.metaKey : event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      quickPicks[Number(event.key) - 1]?.run();
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={props.onClose}
        className="fixed inset-0 z-[100] bg-black/30 [backdrop-filter:blur(24px)_saturate(140%)] [-webkit-backdrop-filter:blur(24px)_saturate(140%)]"
      />
      <div className="pointer-events-none fixed inset-x-4 top-[14vh] bottom-4 z-[100] flex items-start justify-center">
        <div
          role="dialog"
          aria-modal
          aria-label="Command palette"
          onKeyDown={onKeyDown}
          // Clicks anywhere but the field leave focus in it.
          onMouseDown={(event) => event.target !== input.current && event.preventDefault()}
          className="pointer-events-auto flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-surface-3"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search threads, projects and messages… (> for actions)"
              role="combobox"
              aria-expanded
              aria-controls={`${idPrefix}-list`}
              aria-activedescendant={rows.length ? `${idPrefix}-option-${activeIndex}` : undefined}
              aria-autocomplete="list"
              className={cn(
                typeClass("body"),
                "h-11 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
              )}
            />
          </div>
          {/*
            layoutScroll: the highlight's glide accounts for how far the list is scrolled.
            isolate: one stacking context for every row, so the gliding highlight passes under
            the rows it crosses instead of over the ones before its own.
          */}
          <motion.div
            ref={list}
            id={`${idPrefix}-list`}
            role="listbox"
            aria-label="Results"
            layoutScroll
            className="isolate min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
          >
            {rows.length === 0 ? (
              <div
                role="status"
                className={cn(typeClass("body"), "px-2 py-6 text-center text-muted-foreground")}
              >
                {messageSearchStatus ?? "Nothing matches"}
              </div>
            ) : null}
            {rows.map((row, index) => (
              <Fragment key={row.id}>
                {row.section !== rows[index - 1]?.section ? (
                  <div
                    aria-hidden
                    className={cn(
                      typeClass("caption", "compact"),
                      "px-2 pb-1 text-muted-foreground",
                      index > 0 ? "pt-2.5" : "pt-1",
                    )}
                  >
                    {row.section}
                  </div>
                ) : null}
                <PaletteRow
                  row={row}
                  index={index}
                  quickPick={row.hint ? undefined : quickPicks.indexOf(row) + 1 || undefined}
                  isActive={index === activeIndex}
                  shouldGlide={index === activeIndex && shouldGlide}
                  idPrefix={idPrefix}
                  onPoint={moveTo}
                />
              </Fragment>
            ))}
            {rows.length > 0 && messageSearchStatus ? (
              <div
                role="status"
                className={cn(
                  typeClass("caption", "compact"),
                  "px-2 pt-2.5 pb-1 text-muted-foreground",
                )}
              >
                {messageSearchStatus}
              </div>
            ) : null}
          </motion.div>
        </div>
      </div>
    </>
  );
}

/** Memoized, so moving the highlight re-renders only the two rows it moves between. */
const PaletteRow = memo(function PaletteRow(props: {
  row: Row;
  index: number;
  /** Its ⌘1–9 number, for rows without a shortcut of their own. */
  quickPick: number | undefined;
  isActive: boolean;
  idPrefix: string;
  /** Whether the highlight glides in from the previous row, rather than appearing here. */
  shouldGlide: boolean;
  onPoint: (id: string) => void;
}) {
  const { row, index, isActive } = props;

  return (
    <button
      type="button"
      role="option"
      tabIndex={-1}
      id={`${props.idPrefix}-option-${index}`}
      data-index={index}
      aria-selected={isActive}
      // Not mouseenter: rows scrolling under a resting pointer would take the highlight from the keyboard.
      onMouseMove={isActive ? undefined : () => props.onPoint(row.id)}
      onClick={row.run}
      className={cn(
        typeClass("body", "compact"),
        "relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none",
        isActive ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {isActive ? (
        <motion.span
          layoutId={`${props.idPrefix}-highlight`}
          transition={
            props.shouldGlide ? { type: "spring", stiffness: 480, damping: 38 } : { duration: 0 }
          }
          className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-hover"
        />
      ) : null}
      <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-3.5">{row.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{row.label}</span>
        {row.detail ? (
          <span
            className={cn(typeClass("caption", "compact"), "block truncate text-muted-foreground")}
          >
            {row.detail}
          </span>
        ) : null}
      </span>
      {row.hint || props.quickPick ? (
        <kbd
          className={cn(
            typeClass("caption", "compact"),
            "shrink-0 font-sans text-muted-foreground",
          )}
        >
          {row.hint || formatBinding(`mod+${props.quickPick}`)}
        </kbd>
      ) : null}
    </button>
  );
});
