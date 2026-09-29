import { matches } from "@apcode/ui/lib/keys";
import { Button } from "@apcode/ui/motion/button/base";
import { Textarea } from "@apcode/ui/components/textarea";
import { MessageSquare, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describe, KEYBINDINGS } from "../lib/keybindings.ts";
import { describeRange, type ReviewComment } from "../lib/reviewComments.ts";

/** A saved comment under the lines it's about; clicking its text edits it. */
export function DiffComment({
  comment,
  onEdit,
  onRemove,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      // The diff starts a line selection on pointerdown; the comment isn't part of the code.
      onPointerDown={(event) => event.stopPropagation()}
      className="group/comment flex items-start gap-2.5 border-l-2 border-primary/60 bg-primary/5 py-2 pr-2 pl-3 font-sans text-foreground"
    >
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
      <button
        type="button"
        title="Edit comment"
        onClick={onEdit}
        className="min-w-0 flex-1 cursor-text text-left text-[13px] leading-5 whitespace-pre-wrap outline-none focus-visible:underline"
      >
        {comment.text}
      </button>
      <button
        type="button"
        title="Delete comment"
        aria-label="Delete comment"
        onClick={onRemove}
        className="-my-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] outline-none group-hover/comment:opacity-100 hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/** Writing a new comment, or editing one, under the lines it's about. */
export function DiffCommentForm({
  comment,
  onSave,
  onCancel,
}: {
  comment: ReviewComment;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(comment.text);
  const trimmed = text.trim();
  const input = useRef<HTMLTextAreaElement>(null);
  // Not autoFocus: inside the diff it left the caret before the text being edited.
  useEffect(() => {
    const node = input.current;
    node?.focus({ preventScroll: true });
    node?.setSelectionRange(node.value.length, node.value.length);
  }, []);
  return (
    <div
      onPointerDown={(event) => event.stopPropagation()}
      className="border-l-2 border-primary/60 bg-primary/5 px-3 py-2 font-sans text-foreground"
    >
      <Textarea
        ref={input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (matches(event, KEYBINDINGS["diff.saveComment"])) {
            event.preventDefault();
            event.stopPropagation();
            if (trimmed) onSave(trimmed);
          }
        }}
        placeholder={`Comment on ${describeRange(comment.range)} for the agent…`}
        aria-label={`Comment on ${comment.path}, ${describeRange(comment.range)}`}
        className="min-h-16 bg-background text-[13px] dark:bg-background"
      />
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
          <kbd aria-hidden className="font-sans text-[10px] text-muted-foreground">
            esc
          </kbd>
        </Button>
        <Button size="sm" disabled={!trimmed} onClick={() => onSave(trimmed)}>
          {comment.text ? "Save" : "Comment"}
          <kbd aria-hidden className="font-sans text-[10px] opacity-70">
            {describe("diff.saveComment")}
          </kbd>
        </Button>
      </div>
    </div>
  );
}
