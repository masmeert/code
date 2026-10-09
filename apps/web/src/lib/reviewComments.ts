import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";
import { useSyncExternalStore } from "react";

/**
 * Notes left on lines of a thread's diff. They wait above the composer and go out
 * with the next message, each quoting the lines it's about, so the agent can find
 * them even after it has moved the code around.
 */
export interface ReviewComment {
  readonly id: string;
  readonly path: string;
  /** Normalized: `start` is the earlier row. */
  readonly range: Required<SelectedLineRange>;
  /** The commented rows as diff lines (` `, `+` or `-` then the code), one per line. */
  readonly excerpt: string;
  readonly text: string;
}

interface DiffRow {
  readonly marker: " " | "+" | "-";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly content: string;
}

const NO_COMMENTS: ReadonlyArray<ReviewComment> = [];
const commentsByThread = new Map<string, ReadonlyArray<ReviewComment>>();
const listeners = new Set<() => void>();

function write(threadId: string, comments: ReadonlyArray<ReviewComment>) {
  if (comments.length) commentsByThread.set(threadId, comments);
  else commentsByThread.delete(threadId);
  for (const listener of listeners) listener();
}

function getReviewComments(threadId: string) {
  return commentsByThread.get(threadId) ?? NO_COMMENTS;
}

export function useReviewComments(threadId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getReviewComments(threadId),
  );
}

/** Adds the comment, or replaces the one with its id. */
export function saveReviewComment(threadId: string, comment: ReviewComment) {
  const comments = getReviewComments(threadId);
  write(
    threadId,
    comments.some((existing) => existing.id === comment.id)
      ? comments.map((existing) => (existing.id === comment.id ? comment : existing))
      : [...comments, comment],
  );
}

export function removeReviewComment(threadId: string, id: string) {
  write(
    threadId,
    getReviewComments(threadId).filter((comment) => comment.id !== id),
  );
}

/** Clears the thread's comments and returns them, for the message about to go out. */
export function takeReviewComments(threadId: string) {
  const comments = getReviewComments(threadId);
  write(threadId, NO_COMMENTS);
  return comments;
}

/** Every row of a parsed patch, in the order the unified view shows them. */
function diffRows(fileDiff: FileDiffMetadata): Array<DiffRow> {
  const rows: Array<DiffRow> = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let offset = 0; offset < segment.lines; offset++) {
          rows.push({
            marker: " ",
            oldLine: oldLine++,
            newLine: newLine++,
            content: fileDiff.additionLines[segment.additionLineIndex + offset] ?? "",
          });
        }
        continue;
      }

      for (let offset = 0; offset < segment.deletions; offset++) {
        rows.push({
          marker: "-",
          oldLine: oldLine++,
          newLine: null,
          content: fileDiff.deletionLines[segment.deletionLineIndex + offset] ?? "",
        });
      }

      for (let offset = 0; offset < segment.additions; offset++) {
        rows.push({
          marker: "+",
          oldLine: null,
          newLine: newLine++,
          content: fileDiff.additionLines[segment.additionLineIndex + offset] ?? "",
        });
      }
    }
  }

  return rows;
}

function rowIndex(rows: ReadonlyArray<DiffRow>, lineNumber: number, side: SelectionSide) {
  return rows.findIndex((row) =>
    side === "deletions" ? row.oldLine === lineNumber : row.newLine === lineNumber,
  );
}

/**
 * The rows a selection covers, with the selection put in top-to-bottom order.
 * Null when either end isn't in the diff.
 */
export function selectRows(fileDiff: FileDiffMetadata, range: SelectedLineRange) {
  const rows = diffRows(fileDiff);
  const startSide = range.side ?? "additions";
  const endSide = range.endSide ?? startSide;
  const startIndex = rowIndex(rows, range.start, startSide);
  const endIndex = rowIndex(rows, range.end, endSide);
  if (startIndex < 0 || endIndex < 0) return null;

  return {
    range:
      startIndex <= endIndex
        ? { start: range.start, side: startSide, end: range.end, endSide }
        : { start: range.end, side: endSide, end: range.start, endSide: startSide },
    excerpt: rows
      .slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
      .map((row) => `${row.marker}${row.content.replace(/\r?\n$/, "")}`)
      .join("\n"),
  };
}

/** Whether the comment's lines still read the same in this diff, so it can sit on them. */
export function isAnchoredIn(comment: ReviewComment, fileDiff: FileDiffMetadata) {
  return selectRows(fileDiff, comment.range)?.excerpt === comment.excerpt;
}

/** "line 12", "lines 12–14", or "removed line 12" for lines only the old file has. */
export function describeRange(range: Required<SelectedLineRange>) {
  const removed = range.side === "deletions" && range.endSide === "deletions" ? "removed " : "";
  return range.start === range.end && range.side === range.endSide
    ? `${removed}line ${range.start}`
    : `${removed}lines ${range.start}–${range.end}`;
}

function fence(code: string) {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const marks = "`".repeat(Math.max(3, longestRun + 1));
  return `${marks}diff\n${code}\n${marks}`;
}

/** The message that carries the comments, followed by whatever was typed with them. */
export function withReviewComments(comments: ReadonlyArray<ReviewComment>, text: string) {
  if (!comments.length) return text;

  const review = [
    "Review comments on the diff:",
    ...comments.map(
      (comment) =>
        `${comment.path}, ${describeRange(comment.range)}:\n${fence(comment.excerpt)}\n${comment.text}`,
    ),
  ].join("\n\n");
  return text ? `${review}\n\n${text}` : review;
}
