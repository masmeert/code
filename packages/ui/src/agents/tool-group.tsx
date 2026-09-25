import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { AgentDisclosure } from "@apcode/ui/agents/agent-disclosure";
import { ThinkingShimmer } from "@apcode/ui/agents/loading-states/thinking-shimmer";
import { ToolResultOutput } from "@apcode/ui/agents/tool-result";
import type { AgentCodeLanguage } from "@apcode/ui/agents/agent-code";
import { cn } from "@apcode/ui/lib/utils";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** `null` while the tool is still running. */
  readonly output: string | null;
  readonly isError: boolean;
  /** Calls made by the subagent this call started. */
  readonly children?: ReadonlyArray<ToolCall>;
}

type Category = "run" | "read" | "edit" | "search" | "web" | "agent" | "todo" | "browser" | "other";

const CATEGORY = new Map<string, Category>([
  ["Bash", "run"],
  ["shell", "run"],
  ["Read", "read"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["Write", "edit"],
  ["NotebookEdit", "edit"],
  ["edit", "edit"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["WebFetch", "web"],
  ["WebSearch", "web"],
  ["Task", "agent"],
  ["Agent", "agent"],
  ["TodoWrite", "todo"],
]);

const categoryOf = (name: string): Category =>
  name.startsWith("mcp__browser__") ? "browser" : (CATEGORY.get(name) ?? "other");

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Past-tense phrase for one category, e.g. "read index.ts" or "ran 3 commands". */
const phrase = (category: Category, calls: ReadonlyArray<ToolCall>): string => {
  const n = calls.length;
  const one = n === 1;
  switch (category) {
    case "run":
      return one ? "ran a command" : `ran ${n} commands`;
    case "read":
      return one ? `read ${basename(calls[0]!.summary)}` : `read ${n} files`;
    case "edit":
      return one ? `edited ${basename(calls[0]!.summary)}` : `edited ${n} files`;
    case "search":
      return one ? "searched the code" : `ran ${n} searches`;
    case "web":
      return one ? "searched the web" : `made ${n} web requests`;
    case "agent":
      return one ? "ran a subagent" : `ran ${n} subagents`;
    case "todo":
      return "updated the todo list";
    case "browser":
      return one ? "used the browser" : `took ${n} browser actions`;
    case "other":
      return one ? `used ${calls[0]!.name}` : `used ${n} tools`;
  }
};

/** Present-tense label for the call that is currently running; for a subagent, what it's doing now. */
const livePhrase = (call: ToolCall): string => {
  const child = call.children?.findLast((child) => child.output === null);
  if (child) return `${call.summary || "Subagent"}: ${livePhrase(child)}`;
  switch (categoryOf(call.name)) {
    case "run":
      return "Running a command…";
    case "read":
      return `Reading ${basename(call.summary)}…`;
    case "edit":
      return `Editing ${basename(call.summary)}…`;
    case "search":
      return "Searching the code…";
    case "web":
      return "Searching the web…";
    case "agent":
      return "Running a subagent…";
    case "todo":
      return "Updating the todo list…";
    case "browser":
      return "Using the browser…";
    case "other":
      return `Using ${call.name}…`;
  }
};

const VERB: Record<Category, string> = {
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

const summarize = (calls: ReadonlyArray<ToolCall>): string => {
  const byCategory = new Map<Category, Array<ToolCall>>();
  for (const call of calls) {
    const category = categoryOf(call.name);
    byCategory.set(category, [...(byCategory.get(category) ?? []), call]);
  }
  return capitalize([...byCategory].map(([category, group]) => phrase(category, group)).join(", "));
};

const outputLanguage = (call: ToolCall): AgentCodeLanguage =>
  call.name === "edit" ? "diff" : categoryOf(call.name) === "run" ? "bash" : "text";

function Chevron({ open }: { open: boolean }) {
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

function ToolCallRow({ call, live }: { call: ToolCall; live: boolean }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const running = live && call.output === null;
  const children = call.children ?? [];
  const expandable = Boolean(call.output) || children.length > 0;
  const category = categoryOf(call.name);

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? contentId : undefined}
        onClick={() => setOpen(!open)}
        className="group flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:cursor-default"
      >
        <span
          className={cn(
            "shrink-0",
            call.isError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
          )}
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
                <ToolCallRow key={child.id} call={child} live={live} />
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
export function ToolGroup({ calls, live }: { calls: ReadonlyArray<ToolCall>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const running = live ? calls.find((call) => call.output === null) : undefined;
  const failed = calls.filter((call) => call.isError).length;

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
        {failed > 0 ? (
          <span className="shrink-0 text-rose-600 dark:text-rose-400">· {failed} failed</span>
        ) : null}
        <Chevron open={open} />
      </button>
      <AgentDisclosure id={contentId} open={open}>
        <div className="mt-0.5 ml-1.5 border-l border-border pl-3">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} live={live} />
          ))}
        </div>
      </AgentDisclosure>
    </div>
  );
}
