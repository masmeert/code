import {
  type Block,
  categoryOf,
  hasSameItems,
  livePhrase,
  summarize,
  thoughtTitle,
  type ToolCall,
  type ToolItem,
  toBlocks,
  toolVerb,
  toToolGroups,
  type Turn,
} from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { ChevronRight, FileDiff } from "lucide-react-native";
import { memo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { cn } from "@/lib/cn.ts";
import { send } from "@/lib/store.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { Pulsing } from "./Pulsing.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

interface TurnProps {
  readonly hostId: string;
  readonly threadId: string;
  readonly turn: Turn;
}

/** One turn: your message, or everything the agent did in answer, folded like the desktop's. */
export const TranscriptTurn = memo(function TranscriptTurn({ hostId, threadId, turn }: TurnProps) {
  if (turn.from === "user")
    return (
      <View className="items-end px-4 py-2">
        <View className="max-w-[82%] rounded-2xl bg-muted px-3.5 py-2.5">
          <Text selectable className="text-[15px] leading-6">
            {turn.item.text}
          </Text>
          {turn.item.attachments.length > 0 ? (
            <Text className="mt-1 text-xs text-muted-foreground">
              {turn.item.attachments.map((attachment) => attachment.name).join(", ")}
            </Text>
          ) : null}
        </View>
      </View>
    );

  if (turn.from === "marker")
    return (
      <Text className="px-4 py-2 text-center text-xs text-muted-foreground">
        {turn.item.kind === "forked"
          ? `Forked from ${turn.item.fromTitle}`
          : `Started by ${turn.item.byTitle}`}
      </Text>
    );

  if (turn.from === "setup")
    return (
      <Text className="px-4 py-2 text-xs text-muted-foreground">
        {turn.item.stopped
          ? "Worktree setup was stopped"
          : turn.item.run.exitCode === 0
            ? "Worktree set up"
            : `Worktree setup failed (exit ${turn.item.run.exitCode})`}
      </Text>
    );

  return (
    <View className="gap-1.5 px-4 py-2">
      {toBlocks(turn.items).map((block) => (
        <BlockView key={block.id} hostId={hostId} threadId={threadId} block={block} />
      ))}
    </View>
  );
}, isSameTurn);

/** `toTurns` makes new turns on every change; one whose items are the same objects needn't render again. */
function isSameTurn(previous: TurnProps, next: TurnProps) {
  if (previous.hostId !== next.hostId || previous.threadId !== next.threadId) return false;

  const { turn } = previous;

  if (turn.from === "assistant")
    return next.turn.from === "assistant" && hasSameItems(turn.items, next.turn.items);

  return next.turn.from === turn.from && "item" in next.turn && next.turn.item === turn.item;
}

function BlockView({
  hostId,
  threadId,
  block,
}: {
  hostId: string;
  threadId: string;
  block: Block;
}) {
  switch (block.kind) {
    case "assistant":
      return <Markdown text={block.text} />;
    case "reasoning":
      return (
        <Disclosure
          label={<Text className="text-sm text-muted-foreground">{thoughtTitle(block.id)}</Text>}
        >
          <Markdown text={block.text} isMuted />
        </Disclosure>
      );
    case "tools":
      return <ToolGroup hostId={hostId} threadId={threadId} calls={block.calls} />;
    case "work": {
      const calls = block.items.filter((item): item is ToolItem => item.kind === "tool");

      return (
        <Disclosure
          label={
            <Text numberOfLines={1} className="shrink text-sm text-muted-foreground">
              {calls.length > 0 ? summarize(calls) : thoughtTitle(block.items[0]?.id ?? "")}
            </Text>
          }
        >
          <View className="gap-1">
            {toToolGroups(block.items).map((inner) => (
              <BlockView key={inner.id} hostId={hostId} threadId={threadId} block={inner} />
            ))}
          </View>
        </Disclosure>
      );
    }

    case "approval":
      if (!block.resolved) return <ApprovalCard hostId={hostId} threadId={threadId} item={block} />;

      return block.decision === "deny" ? (
        <Text className="text-xs text-muted-foreground">Denied {block.title}</Text>
      ) : null;
    case "checkpoint":
      return (
        <View className="my-1 flex-row items-center gap-1.5 self-start rounded-lg border border-border px-2.5 py-1">
          <Icon as={FileDiff} className="size-3.5 text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {block.files === 1 ? "1 file changed" : `${block.files} files changed`}
          </Text>
          {block.additions > 0 ? (
            <Text className="text-xs text-success tabular-nums">+{block.additions}</Text>
          ) : null}
          {block.deletions > 0 ? (
            <Text className="text-xs text-destructive tabular-nums">−{block.deletions}</Text>
          ) : null}
        </View>
      );
    case "error":
      return <Text className="text-sm text-destructive">{block.text}</Text>;
    default:
      return null;
  }
}

/** Consecutive calls, one summary line; a lone call is its own row. */
function ToolGroup({
  hostId,
  threadId,
  calls,
}: {
  hostId: string;
  threadId: string;
  calls: ReadonlyArray<ToolItem>;
}) {
  const running = calls.find((call) => call.output === null);
  const failed = calls.filter((call) => call.isError).length;

  if (calls.length === 1)
    return <ToolCallRow hostId={hostId} threadId={threadId} call={calls[0]!} />;

  return (
    <Disclosure
      label={
        <>
          <Pulsing isLive={running !== undefined} className="shrink">
            <Text
              numberOfLines={1}
              className={cn("text-sm", running ? "text-foreground" : "text-muted-foreground")}
            >
              {running ? livePhrase(running) : summarize(calls)}
            </Text>
          </Pulsing>
          {failed > 0 ? <Text className="text-sm text-destructive">{failed} failed</Text> : null}
        </>
      }
    >
      {calls.map((call) => (
        <ToolCallRow key={call.id} hostId={hostId} threadId={threadId} call={call} />
      ))}
    </Disclosure>
  );
}

function ToolCallRow({
  hostId,
  threadId,
  call,
}: {
  hostId: string;
  threadId: string;
  call: ToolCall & { readonly progress?: string };
}) {
  const children = call.children ?? [];
  const isRunningAgent = categoryOf(call.name) === "agent" && call.output === null;

  const label = (
    <>
      <Text className={cn("text-sm", call.isError ? "text-destructive" : "text-muted-foreground")}>
        {toolVerb(call.name)}
      </Text>
      <Pulsing isLive={call.output === null} className="shrink">
        <Text numberOfLines={1} className="font-mono text-xs text-muted-foreground/70">
          {call.summary}
        </Text>
      </Pulsing>
      {children.length > 0 ? (
        <Text className="text-xs text-muted-foreground/50">
          {children.length} {children.length === 1 ? "call" : "calls"}
        </Text>
      ) : null}
    </>
  );

  return (
    <View>
      {call.output || children.length > 0 ? (
        <Disclosure label={label} isNested>
          {children.length > 0 ? (
            <View className="mb-1.5 ml-1.5 border-l border-border pl-3">
              {children.map((child) => (
                <ToolCallRow key={child.id} hostId={hostId} threadId={threadId} call={child} />
              ))}
            </View>
          ) : null}
          {call.output ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="mb-1.5 rounded-lg bg-muted/80"
              contentContainerClassName="p-3"
            >
              <Text
                selectable
                numberOfLines={16}
                className={cn(
                  "font-mono text-xs leading-5",
                  call.isError ? "text-destructive" : "text-foreground/85",
                )}
              >
                {call.output}
              </Text>
            </ScrollView>
          ) : null}
        </Disclosure>
      ) : (
        <View className="min-h-8 flex-row items-center gap-2">{label}</View>
      )}
      {call.progress && call.output === null ? (
        <Text className="mb-1 text-xs text-muted-foreground">{call.progress}</Text>
      ) : null}
      {isRunningAgent ? (
        <Pressable
          hitSlop={8}
          onPress={() =>
            send(
              hostId,
              ClientCommand.cases["thread.stopAgent"].make({ threadId, toolId: call.id }),
            )
          }
          className="mb-1 self-start rounded-lg px-2 py-1 active:bg-destructive/10"
        >
          <Text className="text-xs text-destructive">Stop agent</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A row that folds what the agent did on the way to its answer. */
function Disclosure({
  label,
  isNested = false,
  children,
}: {
  label: React.ReactNode;
  isNested?: boolean;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen((open) => !open)}
        className="min-h-8 flex-row items-center gap-1.5 active:opacity-60"
      >
        {label}
        <Icon
          as={ChevronRight}
          className={cn("size-3.5 text-muted-foreground/50", isOpen && "rotate-90")}
        />
      </Pressable>
      {isOpen ? (
        <Animated.View
          entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
          className={cn(isNested ? "pt-0.5" : "mt-0.5 ml-1.5 border-l border-border pl-3")}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}
