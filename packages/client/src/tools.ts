import type { ThreadActivity } from "@masscode/contracts";
import type { ToolCall } from "./transcript.ts";

export type ToolCategory =
  | "run"
  | "read"
  | "edit"
  | "search"
  | "web"
  | "agent"
  | "todo"
  | "browser"
  | "other";

const CATEGORY = new Map<string, ToolCategory>([
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

export const categoryOf = (name: string): ToolCategory =>
  name.startsWith("mcp__browser__") ? "browser" : (CATEGORY.get(name) ?? "other");

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Past-tense phrase for one category, e.g. "read index.ts" or "ran 3 commands". */
const phrase = (category: ToolCategory, calls: ReadonlyArray<ToolCall>): string => {
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

/** Present-tense label for the call that is currently running; a subagent's progress lives in its own row. */
export const livePhrase = (call: ToolCall): string => {
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
      return "Started a subagent";
    case "todo":
      return "Updating the todo list…";
    case "browser":
      return "Using the browser…";
    case "other":
      return `Using ${call.name}…`;
  }
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const summarize = (calls: ReadonlyArray<ToolCall>): string => {
  const byCategory = new Map<ToolCategory, Array<ToolCall>>();
  for (const call of calls) {
    const category = categoryOf(call.name);
    byCategory.set(category, [...(byCategory.get(category) ?? []), call]);
  }
  return capitalize([...byCategory].map(([category, group]) => phrase(category, group)).join(", "));
};

/** What a running thread is doing: the command it runs, else the tool call in words. */
export function describeActivity(activity: ThreadActivity | undefined) {
  if (!activity) return "Thinking…";

  if (categoryOf(activity.tool) === "run") return activity.summary;

  return livePhrase({
    id: activity.toolId,
    name: activity.tool,
    summary: activity.summary,
    output: null,
    isError: false,
  });
}
