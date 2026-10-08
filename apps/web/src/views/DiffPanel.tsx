import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem } from "@pierre/diffs/react";
import { ChevronLeft, Columns2, ListTree, RefreshCw, Rows2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResizeHandle } from "@apcode/ui/components/resize-handle";
import { cn } from "@apcode/ui/lib/utils";
import { useResizable } from "@apcode/ui/hooks/use-resizable";
import { IconButton } from "../components/icon-button.tsx";
import { ClientCommand } from "@apcode/contracts";
import {
  isAnchoredIn,
  removeReviewComment,
  type ReviewComment,
  saveReviewComment,
  selectRows,
  useReviewComments,
} from "../lib/reviewComments.ts";
import { getSettings, send, updateSettings, useStore } from "../lib/store.ts";
import { ChangedFilesTree } from "./ChangedFilesTree.tsx";
import { DiffComment, DiffCommentForm } from "./DiffComment.tsx";
import { HIGHLIGHT, useDiffWorkersReady } from "./DiffWorkers.tsx";

export const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";
export const defaultPanelWidth = () => Math.min(960, Math.round(window.innerWidth * 0.45));
const TREE_WIDTH_KEY = "apcode.diffTreeWidth";
/** The chat keeps at least this much room next to the panel. */
const MIN_CHAT = 380;
const MIN_PANEL = 360;
const MIN_TREE = 160;
const MIN_DIFF = 320;
/** Below this, each side of a split diff is too narrow to read a line of code. */
const MIN_SPLIT_DIFF = 720;

const TREE_KEY = "apcode.diffTree";

const readTree = () => {
  try {
    return localStorage.getItem(TREE_KEY) !== "0";
  } catch {
    return true;
  }
};

interface ParsedPatch {
  readonly patch: string;
  readonly files: Array<FileDiffMetadata>;
}

/** Last parse per patch string, so reopening the panel (or another thread in the same repo) skips the work. */
let lastParse: ParsedPatch = { patch: "", files: [] };

const parseFiles = (patch: string): Array<FileDiffMetadata> => {
  if (patch === lastParse.patch) return lastParse.files;
  let files: Array<FileDiffMetadata> = [];
  try {
    // Key each file's highlight cache by its blob ids, so an unchanged file is never re-highlighted
    // and a changed one never shows a stale render.
    files = parsePatchFiles(patch)
      .flatMap((parsed) => parsed.files)
      .map((file) => ({
        ...file,
        cacheKey: `${file.name}:${file.prevObjectId ?? ""}:${file.newObjectId ?? ""}`,
      }));
  } catch {}
  lastParse = { patch, files };
  return files;
};

/** What sits under one diff line: its saved comments, and the one being written. */
interface CommentSlot {
  readonly entries: ReadonlyArray<{ readonly comment: ReviewComment; readonly editing: boolean }>;
}

/** Comments grouped under the last line each covers, the one being written included. */
function commentAnnotations(
  comments: ReadonlyArray<ReviewComment>,
  draft: ReviewComment | null,
): Array<DiffLineAnnotation<CommentSlot>> {
  const slots = new Map<string, DiffLineAnnotation<CommentSlot>>();
  const shown = comments.map((comment) =>
    comment.id === draft?.id ? { comment: draft, editing: true } : { comment, editing: false },
  );
  if (draft && !comments.some((comment) => comment.id === draft.id))
    shown.push({ comment: draft, editing: true });
  for (const entry of shown) {
    const { end, endSide } = entry.comment.range;
    const key = `${endSide}:${end}`;
    const slot = slots.get(key);
    slots.set(key, {
      side: endSide,
      lineNumber: end,
      metadata: { entries: [...(slot?.metadata.entries ?? []), entry] },
    });
  }
  return [...slots.values()];
}

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

/**
 * Uncommitted changes in the thread's folder (vs HEAD, untracked files included), or with
 * `turn`, just what one turn changed (from the snapshots taken around it).
 * `refreshKey` changes whenever the thread may have touched files, which re-reads the diff.
 */
export const DiffPanel = ({
  threadId,
  cwd,
  refreshKey,
  turn,
  reveal,
  onRevealed,
  onShowAll,
  onClose,
}: {
  /** Whose review comments the diff shows and takes. */
  threadId: string;
  cwd: string;
  refreshKey: string;
  turn: { readonly threadId: string; readonly messageId: string } | null;
  /** A comment to scroll to, once its file is in the diff. */
  reveal: ReviewComment | null;
  onRevealed: () => void;
  onShowAll: () => void;
  onClose: () => void;
}) => {
  const turnThreadId = turn?.threadId;
  const turnMessageId = turn?.messageId;
  const turnKey = turn ? `${turn.threadId}:${turn.messageId}` : null;
  const diff = useStore((s) => (turnKey ? s.turnDiffs[turnKey] : s.diffs[cwd]));
  const refresh = useCallback(
    () =>
      send(
        turnThreadId !== undefined && turnMessageId !== undefined
          ? ClientCommand.cases["checkpoint.diff"].make({
              threadId: turnThreadId,
              messageId: turnMessageId,
            })
          : ClientCommand.cases["git.diff"].make({ path: cwd }),
      ),
    [cwd, turnThreadId, turnMessageId],
  );
  const workersReady = useDiffWorkersReady();
  const preferredStyle = useStore((s) => s.settings.diffLayout ?? "unified");
  const [showTree, setShowTree] = useState(readTree);
  const viewer = useRef<CodeViewHandle<CommentSlot, undefined>>(null);
  const comments = useReviewComments(threadId);
  // The comment being written or edited; it only reaches the thread's comments once saved.
  const [draft, setDraft] = useState<ReviewComment | null>(null);
  const aside = useRef<HTMLElement>(null);
  const panel = useResizable({
    key: PANEL_WIDTH_KEY,
    initial: defaultPanelWidth(),
    side: "start",
    clamp: (w) =>
      Math.max(
        MIN_PANEL,
        Math.min(w, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - MIN_CHAT),
      ),
  });
  const tree = useResizable({
    key: TREE_WIDTH_KEY,
    initial: 256,
    side: "end",
    clamp: (w) => Math.max(MIN_TREE, Math.min(w, (aside.current?.clientWidth ?? 720) - MIN_DIFF)),
  });
  const [asideWidth, setAsideWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = aside.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAsideWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const splitFits = asideWidth - (showTree ? tree.width : 0) >= MIN_SPLIT_DIFF;
  const style = splitFits ? preferredStyle : "unified";
  const jumpTo = useCallback(
    (path: string) =>
      viewer.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" }),
    [],
  );

  // Agents edit in bursts; wait for a short lull before re-reading. A finished turn's changes don't change.
  const changesKey = turnKey ? null : refreshKey;
  useEffect(() => {
    const timer = window.setTimeout(refresh, turnKey ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [refresh, turnKey, changesKey]);

  const files = useMemo(() => parseFiles(diff?.patch ?? ""), [diff?.patch]);
  // CodeView reconciles by id; a file whose content or comments changed keeps its id, so its version must go up.
  const versions = useRef(new Map<string, { key: string; version: number }>());
  const items = useMemo(
    () =>
      files.map((file): CodeViewItem<CommentSlot> => {
        const annotations = commentAnnotations(
          comments.filter((comment) => comment.path === file.name && isAnchoredIn(comment, file)),
          draft?.path === file.name ? draft : null,
        );
        const key = `${file.cacheKey ?? ""}|${annotations
          .flatMap((slot) =>
            slot.metadata.entries.map(
              ({ comment, editing }) => `${comment.id}:${editing}:${comment.text}`,
            ),
          )
          .join("|")}`;
        const seen = versions.current.get(file.name);
        const version = !seen ? 0 : seen.key === key ? seen.version : seen.version + 1;
        versions.current.set(file.name, { key, version });
        return { id: file.name, type: "diff", fileDiff: file, annotations, version };
      }),
    [files, comments, draft],
  );
  const startComment = useCallback((range: SelectedLineRange, fileDiff: FileDiffMetadata) => {
    const rows = selectRows(fileDiff, range);
    if (!rows) return;
    setDraft({ id: crypto.randomUUID(), path: fileDiff.name, ...rows, text: "" });
  }, []);
  const closeComment = useCallback(() => {
    setDraft(null);
    viewer.current?.clearSelectedLines();
  }, []);
  const renderAnnotation = useCallback(
    (annotation: { metadata?: CommentSlot }) => (
      <div className="flex flex-col gap-px">
        {annotation.metadata?.entries.map(({ comment, editing }) =>
          editing ? (
            <DiffCommentForm
              key={comment.id}
              comment={comment}
              onSave={(text) => {
                saveReviewComment(threadId, { ...comment, text });
                closeComment();
              }}
              onCancel={closeComment}
            />
          ) : (
            <DiffComment
              key={comment.id}
              comment={comment}
              onEdit={() => setDraft(comment)}
              onRemove={() => removeReviewComment(threadId, comment.id)}
            />
          ),
        )}
      </div>
    ),
    [threadId, closeComment],
  );

  useEffect(() => {
    if (!reveal || !items.some((item) => item.id === reveal.path)) return;
    viewer.current?.scrollTo({
      type: "line",
      id: reveal.path,
      lineNumber: reveal.range.start,
      side: reveal.range.side,
      align: "center",
      behavior: "smooth",
    });
    onRevealed();
  }, [reveal, items, onRevealed]);

  const writing = draft !== null;
  // Matches the worker pool's options (see DiffWorkers), so its cached highlighting is used as is.
  // A fixed themeType: changing it rebuilds every diff. CSS picks the theme instead (see className).
  const options = useMemo(
    () => ({
      ...HIGHLIGHT,
      diffStyle: style,
      themeType: "system" as const,
      overflow: "scroll" as const,
      stickyHeaders: true,
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      // Hovering a line offers a comment button in its gutter; dragging it covers several lines.
      // Off while one is being written, so a stray click doesn't throw that one away.
      enableGutterUtility: !writing,
      enableLineSelection: !writing,
      onGutterUtilityClick: (
        range: SelectedLineRange,
        context: { item: CodeViewItem<CommentSlot> },
      ) => {
        if (context.item.type === "diff") startComment(range, context.item.fileDiff);
      },
    }),
    [style, writing, startComment],
  );
  const truncated = diff?.truncated ?? false;
  const renderFooter = useCallback(
    () =>
      truncated ? (
        <p className="p-3 text-center text-xs text-muted-foreground">
          Some files were left out to keep the diff small.
        </p>
      ) : null,
    [truncated],
  );
  const { additions, deletions } = useMemo(() => countLines(files), [files]);
  // The thread view re-renders on every streamed delta; these subtrees only change with the diff.
  const fileTree = useMemo(
    () => <ChangedFilesTree files={files} onPick={jumpTo} />,
    [files, jumpTo],
  );
  const codeView = useMemo(
    () => (
      // Virtualized: only the files and lines on screen are in the DOM.
      <CodeView
        ref={viewer}
        items={items}
        // Each diff's shadow root says `color-scheme: light dark` (the OS's); follow the app's theme instead.
        className="h-full min-w-0 flex-1 overflow-auto overscroll-contain [&_diffs-container]:[color-scheme:light] dark:[&_diffs-container]:[color-scheme:dark]"
        options={options}
        renderCodeViewFooter={renderFooter}
        renderAnnotation={renderAnnotation}
      />
    ),
    [items, options, renderFooter, renderAnnotation],
  );

  const toggleTree = () => {
    setShowTree(!showTree);
    try {
      localStorage.setItem(TREE_KEY, showTree ? "0" : "1");
    } catch {}
  };

  return (
    <aside
      ref={aside}
      aria-label="Changes"
      // Never wider than the room left for the chat, even if the window shrank since the last drag.
      style={{ width: panel.width, maxWidth: `calc(100% - ${MIN_CHAT}px)` }}
      className="@container relative flex min-h-0 min-w-80 shrink flex-col border-l border-border bg-background"
    >
      <ResizeHandle
        side="start"
        label="Resize changes panel"
        value={panel.width}
        dragging={panel.dragging}
        {...panel.handleProps}
      />
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2",
          turn ? "pl-2" : "pl-4",
        )}
      >
        {turn ? (
          <IconButton label="All uncommitted changes" onClick={onShowAll}>
            <ChevronLeft className="size-3.5" />
          </IconButton>
        ) : null}
        <span className="text-sm font-medium text-foreground">
          {turn ? "Turn changes" : "Changes"}
        </span>
        {files.length ? (
          <span className="flex items-center gap-2 font-mono text-xs tabular-nums @max-[400px]:hidden">
            <span className="text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            {additions ? <span className="text-success">+{additions}</span> : null}
            {deletions ? <span className="text-destructive">−{deletions}</span> : null}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton
            label="File tree"
            active={showTree}
            onClick={toggleTree}
            className="@max-[480px]:hidden"
          >
            <ListTree className="size-3.5" />
          </IconButton>
          <IconButton
            label="Stacked"
            active={style === "unified"}
            onClick={() => updateSettings({ ...getSettings(), diffLayout: "unified" })}
          >
            <Rows2 className="size-3.5" />
          </IconButton>
          <IconButton
            label={splitFits ? "Split" : "Split (widen the panel to use it)"}
            active={style === "split"}
            disabled={!splitFits}
            onClick={() => updateSettings({ ...getSettings(), diffLayout: "split" })}
          >
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
                // Below MIN_TREE + MIN_DIFF the tree would be squeezed to icons; give the diff the room instead.
                className="relative shrink-0 border-r border-border @max-[480px]:hidden"
              >
                {fileTree}
                <ResizeHandle
                  side="end"
                  label="Resize file tree"
                  value={tree.width}
                  dragging={tree.dragging}
                  {...tree.handleProps}
                />
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
  <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
    {children}
  </div>
);
