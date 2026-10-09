import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AgentDisclosure } from "@masscode/ui/agents/agent-disclosure";
import { ThinkingShimmer } from "@masscode/ui/agents/loading-states/thinking-shimmer";
import { ToolResultOutput } from "@masscode/ui/agents/tool-result";
import type { AgentCodeLanguage } from "@masscode/ui/agents/agent-code";
import { cn } from "@masscode/ui/lib/utils";
import {
  categoryOf,
  livePhrase,
  summarize,
  type ToolCall,
  type ToolCategory,
} from "@masscode/client";

const VERB: Record<ToolCategory, string> = {
  run: "Ran",
  read: "Read",
  edit: "Edited",
  search: "Searched",
  web: "Fetched",
  agent: "Agent",
  todo: "Todos",
  browser: "Browser",
  other: "Used",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const outputLanguage = (call: ToolCall): AgentCodeLanguage =>
  call.name === "edit" ? "diff" : categoryOf(call.name) === "run" ? "bash" : "text";

export function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground/50 transition duration-200 ease-out group-hover:text-muted-foreground",
        open && "rotate-90",
      )}
    />
  );
}

/** A call to open and scroll to; a new object each time, so asking again works after closing it. */
export interface ToolReveal {
  readonly toolId: string;
}

/** Opens on a new `reveal`, during render rather than in an effect, so a group and its row open together and the row can be scrolled to. */
export function useRevealOpen(reveal: ToolReveal | null) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(reveal);
  if (reveal !== seen) {
    setSeen(reveal);
    if (reveal) setOpen(true);
  }
  return [open, setOpen] as const;
}

export function ToolCallRow({
  call,
  live,
  reveal,
}: {
  call: ToolCall;
  live: boolean;
  reveal: ToolReveal | null;
}) {
  const revealHere = reveal?.toolId === call.id ? reveal : null;
  const [open, setOpen] = useRevealOpen(revealHere);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (revealHere) row.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [revealHere]);
  const contentId = useId();
  const running = live && call.output === null;
  const children = call.children ?? [];
  const expandable = Boolean(call.output) || children.length > 0;
  const category = categoryOf(call.name);

  return (
    <div ref={row}>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? contentId : undefined}
        onClick={() => setOpen(!open)}
        className="group flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:cursor-default"
      >
        <span
          className={cn("shrink-0", call.isError ? "text-destructive" : "text-muted-foreground")}
        >
          {category === "other"
            ? call.name
            : category === "browser"
              ? capitalize(call.name.slice("mcp__browser__".length))
              : VERB[category]}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-mono text-xs text-muted-foreground/70 transition-colors",
            expandable && "group-hover:text-foreground/80",
            running && "animate-pulse",
          )}
        >
          {call.summary}
        </span>
        {children.length ? (
          <span className="shrink-0 text-xs text-muted-foreground/50">
            {children.length} {children.length === 1 ? "call" : "calls"}
          </span>
        ) : null}
        {expandable ? <Chevron open={open} /> : null}
      </button>
      {expandable ? (
        <AgentDisclosure id={contentId} open={open}>
          {children.length ? (
            <div className="mb-1.5 ml-1.5 border-l border-border pl-3">
              {children.map((child) => (
                <ToolCallRow key={child.id} call={child} live={live} reveal={null} />
              ))}
            </div>
          ) : null}
          {call.output ? (
            <div className="mb-1.5 scrollbar-hide max-h-72 overflow-y-auto rounded-lg bg-muted/80 p-3">
              <ToolResultOutput language={outputLanguage(call)} className="text-xs">
                {call.output}
              </ToolResultOutput>
            </div>
          ) : null}
        </AgentDisclosure>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls collapsed into a single muted summary line.
 * `live` is whether the thread is still working: a call left without output after
 * the thread stops (interrupt, crash, restart) never finished and isn't running.
 */
export function ToolGroup({
  calls,
  live,
  reveal = null,
}: {
  calls: ReadonlyArray<ToolCall>;
  live: boolean;
  reveal?: ToolReveal | null;
}) {
  const revealHere = calls.some((call) => call.id === reveal?.toolId) ? reveal : null;
  const [open, setOpen] = useRevealOpen(revealHere);
  const contentId = useId();
  const running = live ? calls.find((call) => call.output === null) : undefined;
  const failed = calls.filter((call) => call.isError).length;

  if (calls.length === 1)
    return (
      <div className="w-full text-sm">
        <ToolCallRow call={calls[0]!} live={live} reveal={revealHere} />
      </div>
    );

  return (
    <div className="w-full text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
        className="group flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
      >
        {running ? (
          <ThinkingShimmer className="truncate font-normal">{livePhrase(running)}</ThinkingShimmer>
        ) : (
          <span className="truncate">{summarize(calls)}</span>
        )}
        {failed > 0 ? <span className="shrink-0 text-destructive">{failed} failed</span> : null}
        <Chevron open={open} />
      </button>
      <AgentDisclosure id={contentId} open={open}>
        <div className="mt-0.5 ml-1.5 border-l border-border pl-3">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} live={live} reveal={revealHere} />
          ))}
        </div>
      </AgentDisclosure>
    </div>
  );
}
