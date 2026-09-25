import type { FileDiffMetadata } from "@pierre/diffs";
import { type GitStatus, type GitStatusEntry, prepareFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";

const STATUS: Record<FileDiffMetadata["type"], GitStatus> = {
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
  new: "added",
  deleted: "deleted",
};

/** Match the app's palette; the tree follows `color-scheme` for everything left unset. */
const TREE_STYLE = {
  height: "100%",
  // Opaque on purpose: the middle-truncation "…" masks clipped text with this color.
  "--trees-bg-override": "var(--background)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-selected-bg-override": "var(--muted)",
} as React.CSSProperties;

/**
 * The files in the current diff, as a tree with git status.
 * Selecting a file reports it so the diff view can scroll there.
 */
export const ChangedFilesTree = ({ files, onPick }: { files: ReadonlyArray<FileDiffMetadata>; onPick: (path: string) => void }) => {
  const paths = useMemo(() => files.map((file) => file.name), [files]);
  // Shape (and sort) once per diff, outside the tree's render path.
  const prepared = useMemo(() => prepareFileTreeInput(paths), [paths]);
  const status = useMemo(() => files.map((file): GitStatusEntry => ({ path: file.name, status: STATUS[file.type] })), [files]);

  // The model reads its options once; later callbacks go through a ref.
  const pick = useRef(onPick);
  pick.current = onPick;
  const { model } = useFileTree({
    preparedInput: prepared,
    gitStatus: status,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    density: "compact",
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      if (path && !path.endsWith("/")) pick.current(path);
    },
  });

  // After mount, updates go through model methods (the hook doesn't re-read options).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    model.resetPaths({ preparedInput: prepared });
    model.setGitStatus(status);
  }, [model, prepared, status]);

  return <FileTree model={model} style={TREE_STYLE} />;
};
