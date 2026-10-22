import { livePhrase, summarize, type ToolItem, useNow } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { send } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { Pulsing, Text } from "@/shared/ui";
import { Disclosure, ToolCallRow } from "./transcript-turn.tsx";

/** Latest calls a subagent row unfolds to; older ones are in its row in the transcript. */
const RECENT_AGENT_CALLS = 5;

/** Subagents still at work, at the transcript's end above the composer, as the desktop lists them above its own. */
export function RunningAgents({
  hostId,
  threadId,
  agents,
  canStopOne,
}: {
  hostId: string;
  threadId: string;
  agents: ReadonlyArray<ToolItem>;
  /** Stopping one Codex subagent leaves the main agent waiting on it; Stop ends them all. */
  canStopOne: boolean;
}) {
  // Beyond two, the rows fold into one summary so the transcript's end stays short.
  if (agents.length > 2)
    return (
      <View className="px-4 py-1">
        <Disclosure
          label={
            <Pulsing className="shrink">
              <Text numberOfLines={1} className="text-sm text-foreground">
                {agents.length} subagents running
              </Text>
            </Pulsing>
          }
        >
          {agents.map((agent) => (
            <RunningAgent
              key={agent.id}
              hostId={hostId}
              threadId={threadId}
              agent={agent}
              canStop={canStopOne}
            />
          ))}
        </Disclosure>
      </View>
    );

  return (
    <View className="px-4 py-1">
      {agents.map((agent) => (
        <RunningAgent
          key={agent.id}
          hostId={hostId}
          threadId={threadId}
          agent={agent}
          canStop={canStopOne}
        />
      ))}
    </View>
  );
}

function RunningAgent({
  hostId,
  threadId,
  agent,
  canStop,
}: {
  hostId: string;
  threadId: string;
  agent: ToolItem;
  canStop: boolean;
}) {
  const [isStopping, setIsStopping] = useState(false);
  const now = useNow(1000);
  const name = agent.summary || "Subagent";
  const calls = agent.children ?? [];
  const lastCall = calls.at(-1);
  const earlier = calls.length - RECENT_AGENT_CALLS;

  return (
    <View>
      <Disclosure
        label={
          <>
            <Pulsing>
              <View className="size-1.5 rounded-full bg-success" />
            </Pulsing>
            <View className="shrink">
              <Text numberOfLines={1} className="text-sm text-foreground">
                {name}
              </Text>
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {isStopping
                  ? "Stopping…"
                  : (agent.progress ??
                    (lastCall
                      ? lastCall.output === null
                        ? livePhrase(lastCall)
                        : summarize([lastCall])
                      : "Starting…"))}
              </Text>
            </View>
            {agent.tokens === undefined ? null : (
              <Text className="text-xs text-muted-foreground/70 tabular-nums">
                {Math.round(agent.tokens / 1000)}K tokens
                {agent.startedAt === undefined
                  ? null
                  : ` in ${now - agent.startedAt >= 60_000 ? `${Math.floor((now - agent.startedAt) / 60_000)}m ` : ""}${Math.floor((now - agent.startedAt) / 1000) % 60}s`}
              </Text>
            )}
          </>
        }
      >
        {earlier > 0 ? (
          <Text className="py-1 text-xs text-muted-foreground">
            {earlier} earlier {earlier === 1 ? "call" : "calls"} in its row above
          </Text>
        ) : null}
        {calls.length > 0 ? (
          calls
            .slice(-RECENT_AGENT_CALLS)
            .map((call) => <ToolCallRow key={call.id} call={call} isLive />)
        ) : (
          <Text className="py-1 text-xs text-muted-foreground">No calls yet</Text>
        )}
      </Disclosure>
      {canStop ? (
        <Pressable
          hitSlop={8}
          disabled={isStopping}
          accessibilityLabel={`Stop ${name}`}
          onPress={() => {
            setIsStopping(true);
            send(
              hostId,
              ClientCommand.cases["thread.stopAgent"].make({ threadId, toolId: agent.id }),
            );
          }}
          className={cn(
            "mb-1 self-start rounded-lg px-2 py-1 active:bg-destructive/10",
            isStopping && "opacity-50",
          )}
        >
          <Text className="text-xs text-destructive">Stop agent</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
