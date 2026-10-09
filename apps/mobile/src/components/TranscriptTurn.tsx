import {
  type Block,
  categoryOf,
  hasSameItems,
  livePhrase,
  summarize,
  type ToolItem,
  toBlocks,
  toToolGroups,
  type Turn,
} from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { ChevronRight } from "lucide-react-native";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { send } from "../lib/store.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Markdown } from "./Markdown.tsx";

interface TurnProps {
  readonly macId: string;
  readonly threadId: string;
  readonly turn: Turn;
}

/** One turn: your message, or everything the agent did in answer, folded like the desktop's. */
export const TranscriptTurn = memo(function TranscriptTurn({ macId, threadId, turn }: TurnProps) {
  if (turn.from === "user")
    return (
      <View className="items-end px-4 py-2">
        <View className="bg-surface-secondary max-w-[85%] rounded-3xl px-4 py-2.5">
          <Text selectable className="text-[16px] leading-6 text-foreground">
            {turn.item.text}
          </Text>
          {turn.item.attachments.length > 0 ? (
            <Text className="mt-1 text-[13px] text-muted">
              {turn.item.attachments.map((attachment) => attachment.name).join(", ")}
            </Text>
          ) : null}
        </View>
      </View>
    );

  if (turn.from === "marker")
    return (
      <Text className="px-4 py-2 text-center text-[13px] text-muted">
        {turn.item.kind === "forked"
          ? `Forked from ${turn.item.fromTitle}`
          : `Started by ${turn.item.byTitle}`}
      </Text>
    );

  if (turn.from === "setup")
    return (
      <Text className="px-4 py-2 text-[13px] text-muted">
        {turn.item.stopped
          ? "Worktree setup was stopped"
          : turn.item.run.exitCode === 0
            ? "Worktree set up"
            : `Worktree setup failed (exit ${turn.item.run.exitCode})`}
      </Text>
    );

  return (
    <View className="gap-2 px-4 py-2">
      {toBlocks(turn.items).map((block) => (
        <BlockView key={block.id} macId={macId} threadId={threadId} block={block} />
      ))}
    </View>
  );
}, isSameTurn);

/** `toTurns` makes new turns on every change; one whose items are the same objects needn't render again. */
function isSameTurn(previous: TurnProps, next: TurnProps) {
  if (previous.macId !== next.macId || previous.threadId !== next.threadId) return false;

  const { turn } = previous;

  if (turn.from === "assistant")
    return next.turn.from === "assistant" && hasSameItems(turn.items, next.turn.items);

  return next.turn.from === turn.from && "item" in next.turn && next.turn.item === turn.item;
}

function BlockView({ macId, threadId, block }: { macId: string; threadId: string; block: Block }) {
  switch (block.kind) {
    case "assistant":
      return <Markdown text={block.text} />;
    case "reasoning":
      return (
        <Disclosure title="Thought">
          <Markdown text={block.text} isMuted />
        </Disclosure>
      );
    case "tools":
      return <ToolsRow macId={macId} threadId={threadId} calls={block.calls} />;
    case "work":
      return (
        <Disclosure
          title={
            summarize(block.items.filter((item): item is ToolItem => item.kind === "tool")) ||
            "Worked"
          }
        >
          <View className="gap-2">
            {toToolGroups(block.items).map((inner) => (
              <BlockView key={inner.id} macId={macId} threadId={threadId} block={inner} />
            ))}
          </View>
        </Disclosure>
      );
    case "approval":
      if (!block.resolved) return <ApprovalCard macId={macId} threadId={threadId} item={block} />;

      return block.decision === "deny" ? (
        <Text className="text-[14px] text-muted">Denied {block.title}</Text>
      ) : null;
    case "checkpoint":
      return (
        <Text className="text-[13px] text-muted">
          {block.files === 1 ? "1 file changed" : `${block.files} files changed`}{" "}
          <Text className="text-success">+{block.additions}</Text>{" "}
          <Text className="text-danger">−{block.deletions}</Text>
        </Text>
      );
    case "error":
      return <Text className="text-danger text-[15px]">{block.text}</Text>;
    default:
      return null;
  }
}

function ToolsRow({
  macId,
  threadId,
  calls,
}: {
  macId: string;
  threadId: string;
  calls: ReadonlyArray<ToolItem>;
}) {
  const running = calls.find((call) => call.output === null);

  return (
    <Disclosure
      title={running ? livePhrase(running) : summarize(calls)}
      isLive={running !== undefined}
    >
      <View className="gap-3">
        {calls.map((call) => (
          <View key={call.id} className="gap-1">
            <View className="flex-row items-center gap-2">
              <Text numberOfLines={1} className="flex-1 font-mono text-[13px] text-foreground">
                {call.name} {call.summary}
              </Text>
              {categoryOf(call.name) === "agent" && call.output === null ? (
                <Pressable
                  hitSlop={8}
                  onPress={() =>
                    send(
                      macId,
                      ClientCommand.cases["thread.stopAgent"].make({ threadId, toolId: call.id }),
                    )
                  }
                >
                  <Text className="text-danger text-[13px]">Stop</Text>
                </Pressable>
              ) : null}
            </View>
            {call.progress ? <Text className="text-[13px] text-muted">{call.progress}</Text> : null}
            {call.output ? (
              <Text
                numberOfLines={10}
                className={
                  call.isError
                    ? "bg-surface-secondary text-danger rounded-lg p-2 font-mono text-[12px] leading-4"
                    : "bg-surface-secondary rounded-lg p-2 font-mono text-[12px] leading-4 text-muted"
                }
              >
                {call.output}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Disclosure>
  );
}

/** A row that folds what the agent did on the way to its answer. */
function Disclosure({
  title,
  isLive = false,
  children,
}: {
  title: string;
  isLive?: boolean;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const muted = useCSSVariable("--color-muted");

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen((open) => !open)}
        className="flex-row items-center gap-1 py-1"
      >
        <View className={isOpen ? "rotate-90" : ""}>
          <ChevronRight size={14} color={String(muted)} />
        </View>
        <Text
          numberOfLines={1}
          className={
            isLive ? "flex-1 text-[14px] text-foreground" : "flex-1 text-[14px] text-muted"
          }
        >
          {title}
        </Text>
      </Pressable>
      {isOpen ? <View className="pt-1 pl-5">{children}</View> : null}
    </View>
  );
}
