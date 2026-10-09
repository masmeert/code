import type { TranscriptItem } from "./store.ts";

/** The approval Claude asks for to leave plan mode; its detail is the plan. */
export const PLAN_APPROVAL_TITLE = "ExitPlanMode";

export const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];

export type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** Where a thread's own conversation starts: forked from or started by another thread. */
export type MarkerItem = Extract<TranscriptItem, { kind: "forked" | "startedBy" }>;

/** Consecutive agent items form one turn under a single avatar. */
export type Turn =
  | { readonly from: "user"; readonly id: string; readonly item: UserItem }
  | {
      readonly from: "assistant";
      readonly id: string;
      readonly items: Array<TranscriptItem>;
    }
  | { readonly from: "marker"; readonly id: string; readonly item: MarkerItem }
  | {
      readonly from: "setup";
      readonly id: string;
      readonly item: Extract<TranscriptItem, { kind: "setup" }>;
    };

export function toTurns(items: ReadonlyArray<TranscriptItem>): Array<Turn> {
  const turns: Array<Turn> = [];

  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ from: "user", id: item.id, item });
      continue;
    }

    if (item.kind === "forked" || item.kind === "startedBy") {
      turns.push({ from: "marker", id: item.id, item });
      continue;
    }

    if (item.kind === "setup") {
      turns.push({ from: "setup", id: item.id, item });
      continue;
    }

    const last = turns.at(-1);

    if (last?.from === "assistant") last.items.push(item);
    else turns.push({ from: "assistant", id: item.id, items: [item] });
  }

  return turns;
}

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/**
 * Within a turn, consecutive tool calls collapse into one group row, and the thinking, tool
 * calls and messages on the way to the answer fold into one work row.
 */
export type Block =
  | { readonly kind: "tools"; readonly id: string; readonly calls: Array<ToolItem> }
  | { readonly kind: "work"; readonly id: string; readonly items: Array<TranscriptItem> }
  | Exclude<TranscriptItem, ToolItem>;

export function toToolGroups(items: ReadonlyArray<TranscriptItem>): Array<Block> {
  const blocks: Array<Block> = [];

  for (const item of items) {
    if (item.kind !== "tool") {
      blocks.push(item);
      continue;
    }

    const last = blocks.at(-1);

    if (last?.kind === "tools") last.calls.push(item);
    else blocks.push({ kind: "tools", id: item.id, calls: [item] });
  }

  return blocks;
}

/** Approvals granted along the way render nothing, so they shouldn't split the work row. */
function isWork(item: TranscriptItem) {
  return (
    item.kind === "reasoning" ||
    item.kind === "tool" ||
    item.kind === "assistant" ||
    (item.kind === "approval" &&
      item.resolved &&
      item.decision !== "deny" &&
      !item.questions &&
      item.title !== PLAN_APPROVAL_TITLE)
  );
}

export function toBlocks(
  items: ReadonlyArray<TranscriptItem>,
  heldAnswerId?: string,
): Array<Block> {
  const lastWork = items.findLast(isWork);

  const answer =
    lastWork?.kind === "assistant" && lastWork.id !== heldAnswerId ? lastWork : undefined;

  const blocks: Array<Block> = [];

  for (const item of items) {
    if (item.kind !== "tool" && (item === answer || !isWork(item))) {
      blocks.push(item);
      continue;
    }

    const last = blocks.at(-1);

    if (last?.kind === "work") last.items.push(item);
    else blocks.push({ kind: "work", id: item.id, items: [item] });
  }

  // A lone thinking block or tool group already folds to one row; lone held text still needs the work row to fold into.
  return blocks.flatMap((block) => {
    if (block.kind !== "work") return [block];
    const inner = toToolGroups(block.items);

    return inner.length === 1 && inner[0].id !== heldAnswerId ? inner : [block];
  });
}

/** Whether `item`, the newest one, is in `block`. */
export function hasNewestItem(block: Block, item: TranscriptItem | undefined) {
  return block.kind === "work" ? block.items.at(-1) === item : block === item;
}

/** Whether the newest row already shows the agent at work, so a "Thinking…" placeholder would repeat it. */
export function isShowingWork(items: ReadonlyArray<TranscriptItem>) {
  const turnStart =
    items.findLastIndex(
      (item) => item.kind === "user" || item.kind === "forked" || item.kind === "startedBy",
    ) + 1;

  const newest = toBlocks(items.slice(turnStart)).at(-1);

  if (newest?.kind === "tools") return newest.calls.at(-1)?.output === null;

  return newest?.kind === "work" || newest?.kind === "assistant" || newest?.kind === "reasoning";
}

/** Same items, by identity: the store only replaces the item that changed. */
export function hasSameItems(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
