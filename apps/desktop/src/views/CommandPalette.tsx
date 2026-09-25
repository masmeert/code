import { ProjectBadge } from "@/components/project-badge";
import { searchCommands } from "@/lib/command-search";
import { EASE_OUT } from "@/lib/ease";
import { useOnOpen } from "@/lib/hooks/use-on-open";
import { useRowCursor } from "@/lib/hooks/use-row-cursor";
import { cn } from "@/lib/utils";
import type { SearchHit } from "@apcode/contracts";
import { MessageSquare, Search } from "lucide-react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { Fragment, memo, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { searchMessages, useStore } from "../lib/store.ts";

export interface PaletteAction {
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

// Opened by shortcut many times a day, so the entrance has to read as instant.
// Only transform and opacity animate: the browser runs those off the main
// thread, so they stay smooth while a streaming reply keeps it busy.
const PANEL_SPRING = { type: "spring", stiffness: 560, damping: 40, mass: 0.5 } as const;
const PANEL_REDUCED = { duration: 0.1 } as const;
const PANEL_EXIT = { duration: 0.12, ease: EASE_OUT } as const;
const PANEL_SHOWN = { opacity: 1, transform: "translateY(0px) scale(1)" };
const PANEL_HIDDEN = { opacity: 0, transform: "translateY(-8px) scale(0.97)" };
const PANEL_HIDDEN_REDUCED = { opacity: 0, transform: "translateY(0px) scale(1)" };
const SCRIM_FADE = { duration: 0.18, ease: EASE_OUT } as const;
// Tighter than the panel's, so it keeps up with a held arrow key.
const HIGHLIGHT_SPRING = { type: "spring", stiffness: 480, damping: 38 } as const;
const INSTANT = { duration: 0 } as const;

/** A search snippet with the matched words highlighted (the daemon wraps them in U+E000 / U+E001). */
const Snippet = ({ text }: { text: string }) => (
  <>
    {text.split("").map((part, index) => {
      if (index === 0) return <Fragment key={index}>{part}</Fragment>;
      const [match, rest] = part.split("");
      return (
        <Fragment key={index}>
          <mark className="rounded-sm bg-primary/15 text-foreground">{match}</mark>
          {rest}
        </Fragment>
      );
    })}
  </>
);

/** A row's action: close, then act with the latest props, so rows needn't be rebuilt when the parent re-renders. */
const choose = (latest: RefObject<PaletteProps>, act: (props: PaletteProps) => void) => () => {
  latest.current.onClose();
  act(latest.current);
};

/**
 * ⌘K: jump to a thread or project, run an action, or find a message across every
 * thread. Start with ">" for actions only.
 */
export const CommandPalette = ({ open, ...props }: PaletteProps & { readonly open: boolean }) =>
  // Portaled, so no ancestor's transform or stacking context can trap the overlay.
  createPortal(<AnimatePresence initial={false}>{open ? <Palette key="palette" {...props} /> : null}</AnimatePresence>, document.body);

/** Mounted only while open or closing, so a closed palette subscribes to nothing and searches nothing. */
const Palette = (props: PaletteProps) => {
  const threads = useStore((s) => s.threads);
  const projects = useStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(NO_HITS);
  const uid = useId();
  const reduce = useReducedMotion() ?? false;
  // False from the moment the palette starts closing: it stops taking input while the exit plays.
  const isPresent = useIsPresent();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const actionsOnly = query.startsWith(">");
  const needle = (actionsOnly ? query.slice(1) : query).trim();
  const messageQuery = !actionsOnly && needle.length >= 2 ? needle.toLowerCase() : "";

  // Message search goes to the daemon once there's something to look for.
  useEffect(() => {
    if (!messageQuery) return setHits(NO_HITS);
    let cancelled = false;
    const timer = setTimeout(() => void searchMessages(messageQuery).then((found) => !cancelled && setHits(found)), SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [messageQuery]);

  // Rebuilt when the store changes, not per keystroke: the search caches each entry's normalized
  // text by identity. Newest first, which equal scores keep.
  const threadEntries = useMemo(
    () =>
      Object.values(threads)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((thread) => ({ label: thread.title, thread })),
    [threads],
  );
  const projectEntries = useMemo(() => projects.map((project) => ({ label: project.name, project })), [projects]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  // One memo per section, so a message search landing rebuilds only the message rows.
  const threadRows = useMemo(
    (): ReadonlyArray<Row> =>
      actionsOnly
        ? []
        : searchCommands(threadEntries, needle)
            .slice(0, MAX_THREADS)
            .map(({ thread }) => {
              const project = projectById.get(thread.projectId);
              return {
                id: `thread:${thread.id}`,
                section: needle ? "Threads" : "Recent threads",
                icon: project ? <ProjectBadge project={project} /> : <MessageSquare />,
                label: thread.title,
                detail: `${project?.name ?? thread.cwd.split("/").at(-1)}${thread.archivedAt ? " · archived" : ""}`,
                run: choose(latest, (p) => p.onOpenThread(thread.id)),
              };
            }),
    [actionsOnly, needle, threadEntries, projectById],
  );
  const actionRows = useMemo(
    (): ReadonlyArray<Row> =>
      searchCommands(props.actions, needle).map((action) => ({
        id: `action:${action.id}`,
        section: "Actions",
        icon: action.icon,
        label: action.label,
        ...(action.hint ? { hint: action.hint } : {}),
        run: choose(latest, () => action.run()),
      })),
    [props.actions, needle],
  );
  const projectRows = useMemo(
    (): ReadonlyArray<Row> =>
      actionsOnly || !needle
        ? []
        : searchCommands(projectEntries, needle).map(({ project }) => ({
            id: `project:${project.id}`,
            section: "New thread in",
            icon: <ProjectBadge project={project} />,
            label: project.name,
            detail: project.path,
            run: choose(latest, (p) => p.onNewThreadIn(project.path)),
          })),
    [actionsOnly, needle, projectEntries],
  );
  // Hits from an older query stay up until the new ones land, but not once there's no search at all.
  const shownHits = messageQuery ? hits : NO_HITS;
  const messageRows = useMemo(
    (): ReadonlyArray<Row> =>
      shownHits.map((hit) => ({
        id: `message:${hit.threadId}:${hit.messageId}`,
        section: "Messages",
        icon: <Search />,
        label: <Snippet text={hit.snippet} />,
        detail: `${hit.from === "user" ? "You" : "Agent"} · ${threads[hit.threadId]?.title ?? ""}`,
        run: choose(latest, (p) => p.onOpenThread(hit.threadId)),
      })),
    [shownHits, threads],
  );
  // Empty sections drop out: with no query that leaves recent threads, then actions.
  const rows = useMemo(
    () => [...threadRows, ...actionRows, ...projectRows, ...messageRows],
    [threadRows, actionRows, projectRows, messageRows],
  );

  const { activeIndex: active, continuous, moveTo, moveActive } = useRowCursor(rows, query, { loop: true });
  // The highlight glides for hover and single steps. A new list or a wrap-around jumps it instead:
  // gliding from wherever the old row ended up reads as the list scrolling.
  const glide = continuous && !reduce;
  // Reopened while still closing, it's the same palette coming back: start it over.
  useOnOpen(isPresent, () => {
    setQuery("");
    moveTo(null);
  });
  useLayoutEffect(() => {
    if (isPresent) input.current?.focus();
  }, [isPresent]);

  const activeId = rows[active]?.id;
  useEffect(() => {
    const container = list.current;
    if (!container) return;
    // The first row brings its section header into view too.
    if (active === 0) container.scrollTop = 0;
    else container.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, activeId]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      rows[active]?.run();
    } else if (event.key === "Escape") {
      // One layer per Escape: the settings modal may be open underneath.
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "Tab") {
      // Focus stays in the field; the arrows move through the rows.
      event.preventDefault();
    } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      rows[Number(event.key) - 1]?.run();
    }
  };

  const hidden = reduce ? PANEL_HIDDEN_REDUCED : PANEL_HIDDEN;
  const pointerEvents = isPresent ? "auto" : "none";
  return (
    <>
      <motion.button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: PANEL_EXIT }}
        transition={SCRIM_FADE}
        inert={!isPresent}
        style={{ pointerEvents }}
        onClick={props.onClose}
        className="fixed inset-0 z-[100] bg-black/20"
      />
      <div inert={!isPresent} className="pointer-events-none fixed inset-x-4 top-[14vh] bottom-4 z-[100] flex items-start justify-center">
        <motion.div
          role="dialog"
          aria-modal
          aria-label="Command palette"
          initial={hidden}
          animate={PANEL_SHOWN}
          exit={{ ...hidden, transition: PANEL_EXIT }}
          transition={reduce ? PANEL_REDUCED : PANEL_SPRING}
          style={{ pointerEvents }}
          onKeyDown={onKeyDown}
          // Clicks anywhere but the field leave focus in it.
          onMouseDown={(event) => event.target !== input.current && event.preventDefault()}
          className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-panel will-change-transform"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search threads, projects and messages… (> for actions)"
              role="combobox"
              aria-expanded
              aria-controls={`${uid}-list`}
              aria-activedescendant={rows.length ? `${uid}-option-${active}` : undefined}
              aria-autocomplete="list"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          {/*
            layoutScroll: the highlight's glide accounts for how far the list is scrolled.
            isolate: one stacking context for every row, so the gliding highlight passes under
            the rows it crosses instead of over the ones before its own.
          */}
          <motion.div
            ref={list}
            id={`${uid}-list`}
            role="listbox"
            aria-label="Results"
            layoutScroll
            className="isolate min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
          >
            {rows.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing matches</div> : null}
            {rows.map((row, index) => (
              <Fragment key={row.id}>
                {row.section !== rows[index - 1]?.section ? (
                  <div aria-hidden className={cn("px-2 pb-1 text-[11px] text-muted-foreground", index > 0 ? "pt-2.5" : "pt-1")}>
                    {row.section}
                  </div>
                ) : null}
                <PaletteRow row={row} index={index} active={index === active} glide={index === active && glide} uid={uid} onPoint={moveTo} />
              </Fragment>
            ))}
          </motion.div>
        </motion.div>
      </div>
    </>
  );
};

/** Memoized, so moving the highlight re-renders only the two rows it moves between. */
const PaletteRow = memo(function PaletteRow(props: {
  row: Row;
  index: number;
  active: boolean;
  uid: string;
  /** Whether the highlight glides in from the previous row, rather than appearing here. */
  glide: boolean;
  onPoint: (id: string) => void;
}) {
  const { row, index, active } = props;
  return (
    <button
      type="button"
      role="option"
      tabIndex={-1}
      id={`${props.uid}-option-${index}`}
      data-index={index}
      aria-selected={active}
      // Not mouseenter: rows scrolling under a resting pointer would take the highlight from the keyboard.
      onMouseMove={active ? undefined : () => props.onPoint(row.id)}
      onClick={row.run}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {active ? (
        <motion.span
          layoutId={`${props.uid}-highlight`}
          transition={props.glide ? HIGHLIGHT_SPRING : INSTANT}
          className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-muted"
        />
      ) : null}
      <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-3.5">{row.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{row.label}</span>
        {row.detail ? <span className="block truncate text-[11px] text-muted-foreground">{row.detail}</span> : null}
      </span>
      {index < 9 ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">⌘{index + 1}</span>
      ) : row.hint ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">{row.hint}</span>
      ) : null}
    </button>
  );
});
