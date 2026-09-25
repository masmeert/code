import { ProjectBadge } from "@/components/project-badge";
import { cn } from "@apcode/ui/lib/utils";
import type { SearchHit } from "@apcode/contracts";
import { MessageSquare, Search } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { searchMessages, useStore } from "../lib/store.ts";

export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

interface Row {
  readonly key: string;
  readonly section: string;
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly hint?: string;
  readonly run: () => void;
}

const MAX_THREADS = 8;
const SEARCH_DELAY_MS = 150;

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

/**
 * ⌘K: jump to a thread or project, run an action, or find a message across every
 * thread. Start with ">" for actions only.
 */
export const CommandPalette = (props: {
  actions: ReadonlyArray<PaletteAction>;
  onOpenThread: (threadId: string) => void;
  onNewThreadIn: (path: string) => void;
  onClose: () => void;
}) => {
  const threads = useStore((s) => s.threads);
  const projects = useStore((s) => s.projects);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<ReadonlyArray<SearchHit>>([]);
  const list = useRef<HTMLDivElement>(null);
  const actionsOnly = query.startsWith(">");
  const needle = (actionsOnly ? query.slice(1) : query).trim().toLowerCase();

  // Message search goes to the daemon once there's something to look for.
  useEffect(() => {
    if (actionsOnly || needle.length < 2) return setHits([]);
    let cancelled = false;
    const timer = setTimeout(() => void searchMessages(needle).then((found) => !cancelled && setHits(found)), SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle, actionsOnly]);

  const rows = useMemo((): Array<Row> => {
    const close = (run: () => void) => () => {
      props.onClose();
      run();
    };
    const actions = props.actions
      .filter((action) => action.label.toLowerCase().includes(needle))
      .map((action) => ({ key: `action:${action.id}`, section: "Actions", icon: action.icon, label: action.label, ...(action.hint ? { hint: action.hint } : {}), run: close(action.run) }));
    if (actionsOnly) return actions;
    const matchingThreads = Object.values(threads)
      .filter((thread) => thread.title.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_THREADS)
      .map((thread) => {
        const project = projects.find((p) => p.id === thread.projectId);
        return {
          key: `thread:${thread.id}`,
          section: needle ? "Threads" : "Recent threads",
          icon: project ? <ProjectBadge project={project} /> : <MessageSquare />,
          label: thread.title,
          detail: `${project?.name ?? thread.cwd.split("/").at(-1)}${thread.archivedAt ? " · archived" : ""}`,
          run: close(() => props.onOpenThread(thread.id)),
        };
      });
    const matchingProjects = needle
      ? projects
          .filter((project) => project.name.toLowerCase().includes(needle))
          .map((project) => ({
            key: `project:${project.id}`,
            section: "New thread in",
            icon: <ProjectBadge project={project} />,
            label: project.name,
            detail: project.path,
            run: close(() => props.onNewThreadIn(project.path)),
          }))
      : [];
    const messages = hits.map((hit) => ({
      key: `message:${hit.threadId}:${hit.messageId}`,
      section: "Messages",
      icon: <Search />,
      label: <Snippet text={hit.snippet} />,
      detail: `${hit.from === "user" ? "You" : "Agent"} · ${threads[hit.threadId]?.title ?? ""}`,
      run: close(() => props.onOpenThread(hit.threadId)),
    }));
    return [...matchingThreads, ...(needle ? actions : []), ...matchingProjects, ...messages, ...(needle ? [] : actions)];
  }, [actionsOnly, hits, needle, projects, props, threads]);

  useEffect(() => setActive(0), [needle, actionsOnly]);
  const current = Math.min(active, rows.length - 1);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      setActive((current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      rows[current]?.run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      rows[Number(event.key) - 1]?.run();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/20 px-4 pt-[14vh]" onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-panel"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search threads, projects and messages… (> for actions)"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div ref={list} role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {rows.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing matches</div> : null}
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {row.section !== rows[index - 1]?.section ? (
                <div className={cn("px-2 pb-1 text-[11px] text-muted-foreground", index > 0 ? "pt-2.5" : "pt-1")}>{row.section}</div>
              ) : null}
              <button
                type="button"
                role="option"
                data-index={index}
                aria-selected={index === current}
                onMouseMove={() => index !== current && setActive(index)}
                onClick={row.run}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none",
                  index === current ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-3.5">{row.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{row.label}</span>
                  {row.detail ? <span className="block truncate text-[11px] text-muted-foreground">{row.detail}</span> : null}
                </span>
                {index < 9 ? <span className="shrink-0 text-[11px] text-muted-foreground/60">⌘{index + 1}</span> : row.hint ? <span className="shrink-0 text-[11px] text-muted-foreground/60">{row.hint}</span> : null}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};
