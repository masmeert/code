import { Quote } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { appendToDraft, focusComposer } from "../lib/drafts.ts";

/**
 * Selecting text in an agent reply offers to quote it in the composer, where you can
 * comment on it (t3code's "Cite in composer").
 */
export function QuoteSelection({
  container,
  threadId,
}: {
  container: RefObject<HTMLDivElement | null>;
  threadId: string;
}) {
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    const area = container.current;
    if (!area) return;

    // Arrows rather than function declarations: those are hoisted, so `area` wouldn't stay narrowed inside them.
    const updateQuote = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      const node = selection?.anchorNode;
      const inReply =
        node &&
        area.contains(node) &&
        (node instanceof Element ? node : node.parentElement)?.closest('[data-from="assistant"]');
      if (!selection || selection.isCollapsed || !text || !inReply) {
        setQuote(null);
        return;
      }

      const selectionBox = selection.getRangeAt(0).getBoundingClientRect();
      const areaBox = area.getBoundingClientRect();
      setQuote({
        text,
        top: selectionBox.top - areaBox.top - 34,
        left: Math.min(
          Math.max(selectionBox.left - areaBox.left + selectionBox.width / 2, 40),
          areaBox.width - 40,
        ),
      });
    };

    function clearQuote() {
      if (document.getSelection()?.isCollapsed) setQuote(null);
    }

    area.addEventListener("mouseup", updateQuote);
    area.addEventListener("keyup", updateQuote);
    document.addEventListener("selectionchange", clearQuote);
    return () => {
      area.removeEventListener("mouseup", updateQuote);
      area.removeEventListener("keyup", updateQuote);
      document.removeEventListener("selectionchange", clearQuote);
    };
  }, [container]);

  if (!quote) return null;

  return (
    <button
      type="button"
      style={{ top: Math.max(quote.top, 4), left: quote.left }}
      // Keep the selection while clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        appendToDraft(
          threadId,
          `${quote.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}\n\n`,
        );
        document.getSelection()?.removeAllRanges();
        setQuote(null);
        focusComposer();
      }}
      className="absolute z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-panel"
    >
      <Quote className="size-3" />
      Quote in composer
    </button>
  );
}
