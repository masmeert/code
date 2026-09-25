import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem } from "@pierre/diffs/react";
import { ChevronLeft, Columns2, ListTree, RefreshCw, Rows2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResizeHandle } from "@apcode/ui/components/resize-handle";
import { cn } from "@apcode/ui/lib/utils";
import { useResizable } from "@apcode/ui/hooks/use-resizable";
import { send, useStore } from "../lib/store.ts";
import { ChangedFilesTree } from "./ChangedFilesTree.tsx";
import { HIGHLIGHT, THEMES, useDiffWorkersReady, useResolvedTheme } from "./DiffWorkers.tsx";

type DiffStyle = "unified" | "split";

export const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";
export const defaultPanelWidth = () => Math.min(960, Math.round(window.innerWidth * 0.45));
const TREE_WIDTH_KEY = "apcode.diffTreeWidth";
/** The chat keeps at least this much room next to the panel. */
const MIN_CHAT = 380;
const MIN_PANEL = 360;
const MIN_TREE = 160;
const MIN_DIFF = 320;

const STYLE_KEY = "apcode.diffStyle";
const TREE_KEY = "apcode.diffTree";

const readTree = () => {
  try {
    return localStorage.getItem(TREE_KEY) !== "0";
  } catch {
    return true;
  }
};

const readStyle = (): DiffStyle => {
  try {
    return localStorage.getItem(STYLE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
};

/** Last parse per patch string, so reopening the panel (or another thread in the same repo) skips the work. */
let lastParse: { patch: string; files: Array<FileDiffMetadata> } = { patch: "", files: [] };

const parseFiles = (patch: string): Array<FileDiffMetadata> => {
  if (patch === lastParse.patch) return lastParse.files;
  let files: Array<FileDiffMetadata> = [];
  try {
    // Key each file's highlight cache by its blob ids, so an unchanged file is never re-highlighted
    // and a changed one never shows a stale render.
    files = parsePatchFiles(patch)
      .flatMap((parsed) => parsed.files)
      .map((file) => ({ ...file, cacheKey: `${file.name}:${file.prevObjectId ?? ""}:${file.newObjectId ?? ""}` }));
  } catch {}
  lastParse = { patch, files };
  return files;
};

const countLines = (files: ReadonlyArray<FileDiffMetadata>) => {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }
  return { additions, deletions };
};

const IconButton = (props: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) => (
  <button
    type="button"
    title={props.label}
    aria-label={props.label}
    aria-pressed={props.active}
    onClick={props.onClick}
    className={cn(
      "grid size-7 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      props.active && "bg-muted/60 text-foreground",
    )}
  >
    {props.children}
  </button>
);

/**
 * Uncommitted changes in the thread's folder (vs HEAD, untracked files included), or with
 * `turn`, just what one turn changed (from the snapshots taken around it).
 * `refreshKey` changes whenever the thread may have touched files, which re-reads the diff.
 */
export const DiffPanel = ({
  cwd,
  refreshKey,
  turn,
  onShowAll,
  onClose,
}: {
  cwd: string;
  refreshKey: string;
  turn: { readonly threadId: string; readonly messageId: string } | null;
  onShowAll: () => void;
  onClose: () => void;
}) => {
  const turnKey = turn ? `${turn.threadId}:${turn.messageId}` : null;
  const diff = useStore((s) => (turnKey ? s.turnDiffs[turnKey] : s.diffs[cwd]));
  const refresh = useCallback(
    () => send(turn ? { _tag: "checkpoint.diff", threadId: turn.threadId, messageId: turn.messageId } : { _tag: "git.diff", path: cwd }),
    [cwd, turn?.threadId, turn?.messageId],
  );
  const theme = useResolvedTheme();
  const workersReady = useDiffWorkersReady();
  const [style, setStyle] = useState<DiffStyle>(readStyle);
  const [showTree, setShowTree] = useState(readTree);
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const aside = useRef<HTMLElement>(null);
  const panel = useResizable({
    key: PANEL_WIDTH_KEY,
    initial: defaultPanelWidth(),
    side: "start",
    clamp: (w) => Math.max(MIN_PANEL, Math.min(w, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - MIN_CHAT)),
  });
  const tree = useResizable({
    key: TREE_WIDTH_KEY,
    initial: 256,
    side: "end",
    clamp: (w) => Math.max(MIN_TREE, Math.min(w, (aside.current?.clientWidth ?? 720) - MIN_DIFF)),
  });
  const jumpTo = useCallback((path: string) => viewer.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" }), []);

  // Agents edit in bursts; wait for a short lull before re-reading. A finished turn's changes don't change.
  useEffect(() => {
    const timer = window.setTimeout(refresh, turnKey ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [refresh, turnKey ? null : refreshKey]);

  const files = useMemo(() => parseFiles(diff?.patch ?? ""), [diff?.patch]);
  // CodeView reconciles by id; a file whose content changed keeps its id, so its version must go up.
  const versions = useRef(new Map<string, { key: string; version: number }>());
  const items = useMemo(
    () =>
      files.map((file): CodeViewItem<undefined> => {
        const key = file.cacheKey ?? "";
        const seen = versions.current.get(file.name);
        const version = !seen ? 0 : seen.key === key ? seen.version : seen.version + 1;
        versions.current.set(file.name, { key, version });
        return { id: file.name, type: "diff", fileDiff: file, version };
      }),
    [files],
  );
  // One theme, matching the worker pool's (see DiffWorkers), so its cached highlighting is used as is.
  const options = useMemo(
    () => ({
      ...HIGHLIGHT,
      diffStyle: style,
      themeType: theme,
      theme: THEMES[theme],
      overflow: "scroll" as const,
      stickyHeaders: true,
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    }),
    [style, theme],
  );
  const truncated = diff?.truncated ?? false;
  const renderFooter = useCallback(
    () => (truncated ? <p className="p-3 text-center text-xs text-muted-foreground">Some files were left out to keep the diff small.</p> : null),
    [truncated],
  );
  const { additions, deletions } = useMemo(() => countLines(files), [files]);
  // The thread view re-renders on every streamed delta; these subtrees only change with the diff.
  const fileTree = useMemo(() => <ChangedFilesTree files={files} onPick={jumpTo} />, [files, jumpTo]);
  const codeView = useMemo(
    () => (
      // Virtualized: only the files and lines on screen are in the DOM.
      <CodeView
        ref={viewer}
        items={items}
        className="h-full min-w-0 flex-1 overflow-auto overscroll-contain"
        options={options}
        renderCodeViewFooter={renderFooter}
      />
    ),
    [items, options, renderFooter],
  );

  const toggleTree = () => {
    setShowTree(!showTree);
    try {
      localStorage.setItem(TREE_KEY, showTree ? "0" : "1");
    } catch {}
  };

  const pickStyle = (next: DiffStyle) => {
    setStyle(next);
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {}
  };

  return (
    <aside
      ref={aside}
      aria-label="Changes"
      // Never wider than the room left for the chat, even if the window shrank since the last drag.
      style={{ width: panel.width, maxWidth: `calc(100% - ${MIN_CHAT}px)` }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
    >
      <ResizeHandle side="start" label="Resize changes panel" value={panel.width} dragging={panel.dragging} {...panel.handleProps} />
      <div className={cn("flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2", turn ? "pl-2" : "pl-4")}>
        {turn ? (
          <IconButton label="All uncommitted changes" onClick={onShowAll}>
            <ChevronLeft className="size-3.5" />
          </IconButton>
        ) : null}
        <span className="text-sm font-medium text-foreground">{turn ? "Turn changes" : "Changes"}</span>
        {files.length ? (
          <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
            <span className="text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            {additions ? <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> : null}
            {deletions ? <span className="text-rose-600 dark:text-rose-400">−{deletions}</span> : null}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton label="File tree" active={showTree} onClick={toggleTree}>
            <ListTree className="size-3.5" />
          </IconButton>
          <IconButton label="Unified" active={style === "unified"} onClick={() => pickStyle("unified")}>
            <Rows2 className="size-3.5" />
          </IconButton>
          <IconButton label="Split" active={style === "split"} onClick={() => pickStyle("split")}>
            <Columns2 className="size-3.5" />
          </IconButton>
          <IconButton label="Refresh" onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton label="Close changes" onClick={onClose}>
            <X className="size-3.5" />
          </IconButton>
        </span>
      </div>

      <div className="selectable flex min-h-0 flex-1">
        {!diff || !workersReady ? (
          <Empty>Loading changes…</Empty>
        ) : diff.error ? (
          <Empty>{diff.error}</Empty>
        ) : !files.length ? (
          <Empty>{turn ? "This turn changed no files" : "No uncommitted changes"}</Empty>
        ) : (
          <>
            {showTree ? (
              <div
                style={{ width: tree.width, maxWidth: `calc(100% - ${MIN_DIFF}px)` }}
                className="relative shrink-0 border-r border-border"
              >
                {fileTree}
                <ResizeHandle side="end" label="Resize file tree" value={tree.width} dragging={tree.dragging} {...tree.handleProps} />
              </div>
            ) : null}
            {codeView}
          </>
        )}
      </div>
    </aside>
  );
};

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{children}</div>
);
