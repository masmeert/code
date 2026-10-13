import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { focusComposer } from "../lib/drafts.ts";
import { formatKeybinding, useKeybinding } from "../lib/keybindings.ts";

/**
 * ⌘F in the transcript. Matches are painted with the CSS Highlight API (`find` and `find-active`,
 * styled by the scroller), so React's DOM is never touched.
 */
export function TranscriptFind({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<Range>>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Streaming re-runs the search; only a new query or a step should move the view.
  const shouldReveal = useRef(false);

  const current = Math.min(active, matches.length - 1);

  useKeybinding("thread.find", () => {
    setIsOpen(true);
    input.current?.focus();
    input.current?.select();
  });
  useKeybinding(isOpen ? "thread.findNext" : undefined, () => moveToMatch(1));

  useEffect(() => {
    const root = scope.current;
    const needle = query.toLowerCase();

    if (!isOpen || !root || !needle) return setMatches([]);

    let frame = 0;

    function findMatches() {
      const found: Array<Range> = [];
      const walker = document.createTreeWalker(root!, NodeFilter.SHOW_TEXT);

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent!.toLowerCase();
        let index = text.indexOf(needle);

        // Collapsed tool output and the like stay in the DOM, unseen.
        if (index === -1 || !node.parentElement?.checkVisibility()) continue;

        for (; index !== -1; index = text.indexOf(needle, index + needle.length)) {
          const range = new Range();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          found.push(range);
        }
      }

      setMatches(found);
    }

    findMatches();

    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(findMatches);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [isOpen, query, scope]);

  useEffect(() => {
    CSS.highlights.set("find", new Highlight(...matches));
    const range = matches[current];

    if (range) {
      CSS.highlights.set("find-active", new Highlight(range));

      if (shouldReveal.current)
        range.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }

    shouldReveal.current = false;

    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-active");
    };
  }, [matches, current]);

  function moveToMatch(direction: number) {
    if (!matches.length) return;
    shouldReveal.current = true;
    setActive((current + direction + matches.length) % matches.length);
  }

  function closeFind() {
    setIsOpen(false);
    focusComposer();
  }

  if (!isOpen) return null;

  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="absolute top-11 right-4 z-20 flex w-80 max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-border bg-popover p-1 text-xs text-foreground shadow-panel"
    >
      <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        autoFocus
        value={query}
        placeholder="Find in thread"
        aria-label="Find in thread"
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          shouldReveal.current = true;
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;

          if (event.key === "Enter") {
            event.preventDefault();
            moveToMatch(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            closeFind();
          }
        }}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      <span aria-live="polite" className="shrink-0 px-1 text-muted-foreground tabular-nums">
        {query ? (matches.length ? `${current + 1} of ${matches.length}` : "No results") : ""}
      </span>
      {(
        [
          ["Previous match (⇧↩)", ChevronUp, () => moveToMatch(-1)],
          [
            `Next match (↩ or ${formatKeybinding("thread.findNext")})`,
            ChevronDown,
            () => moveToMatch(1),
          ],
          ["Close (Esc)", X, closeFind],
        ] as const
      ).map(([label, Icon, onClick]) => (
        <button
          key={label}
          type="button"
          title={label}
          aria-label={label}
          disabled={Icon !== X && !matches.length}
          onClick={onClick}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
