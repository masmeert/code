import { categoryOf, isShowingWork, type ToolItem, toTurns } from "@masscode/client";
import { ClientCommand, isTurnActive } from "@masscode/contracts";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Composer } from "@/widgets/composer";
import { ThreadHeader } from "@/widgets/thread-header";
import { useHostStore } from "@/entities/host";
import { useHostProjects } from "@/entities/project";
import { useHostProviders } from "@/entities/provider";
import { loadOlder, openThread, transcriptKey, useThreadStore } from "@/entities/thread";
import { send } from "@/shared/api";
import { OrbFace, type OrbFaceState, Pulsing, Text } from "@/shared/ui";
import { RunningAgents } from "./running-agents.tsx";
import { TranscriptTurn } from "./transcript-turn.tsx";

export function ThreadPage() {
  const { hostId, threadId } = useLocalSearchParams<{ hostId: string; threadId: string }>();
  const host = useHostStore((state) => state.hosts[hostId]);
  const thread = useThreadStore((state) => state.threads[hostId]?.[threadId]);
  const projects = useHostProjects(hostId);
  const providers = useHostProviders(hostId);
  const transcript = useThreadStore((state) => state.transcripts[transcriptKey(hostId, threadId)]);
  const turns = useMemo(() => toTurns(transcript?.items ?? []), [transcript?.items]);
  const list = useRef<LegendListRef>(null);
  const composer = useRef<ComponentRef<typeof View>>(null);

  // The composer floats over the transcript; its height is how far the transcript's end sits above the bottom.
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    list,
    composer,
  );

  useEffect(() => openThread(hostId, threadId), [hostId, threadId]);

  const seenRev = thread?.seenRev;
  const updatedAt = thread?.updatedAt;

  // Looking at the thread reads what's new, on the host too.
  useEffect(() => {
    if (seenRev !== undefined && updatedAt !== undefined && seenRev < updatedAt)
      send(hostId, ClientCommand.cases["thread.seen"].make({ threadId, rev: updatedAt }));
  }, [hostId, threadId, seenRev, updatedAt]);

  if (!host || !thread)
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        <Text className="text-center text-sm text-muted-foreground">
          {host?.connection === "connected"
            ? "This thread is gone; it was deleted on the computer."
            : "Connecting to the computer…"}
        </Text>
      </View>
    );

  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const isThinking = thread.status === "running" && !isShowingWork(transcript?.items ?? []);
  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.from === "assistant" ? lastTurn.items.at(-1) : undefined;
  const isBusy = isTurnActive(thread.status);

  const runningAgents = isBusy
    ? (transcript?.items ?? []).filter(
        (item): item is ToolItem =>
          item.kind === "tool" && categoryOf(item.name) === "agent" && item.output === null,
      )
    : [];

  const faceState: OrbFaceState | null = isThinking
    ? "thinking"
    : lastItem === undefined
      ? null
      : isBusy
        ? lastItem.kind === "assistant"
          ? "streaming"
          : "thinking"
        : lastItem.kind === "error"
          ? "error"
          : "done";

  return (
    <View className="flex-1 bg-background">
      <ThreadHeader
        title={thread.title || "New thread"}
        project={project}
        hostName={host.paired.name}
      />
      {/* First in the screen even while loading, so iOS finds it and blurs it under the glass header. */}
      <KeyboardAwareLegendList
        ref={list}
        data={turns}
        keyExtractor={(turn) => turn.id}
        renderItem={({ item }) => (
          <TranscriptTurn
            hostId={hostId}
            threadId={threadId}
            turn={item}
            isBusy={isBusy}
            isLast={item === lastTurn}
          />
        )}
        // Turns show unfinished calls as running only while the thread works, which their items alone don't tell.
        extraData={isBusy}
        estimatedItemSize={120}
        contentInsetAdjustmentBehavior="automatic"
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        // Opening the keyboard lifts the transcript only when its end is showing, as ChatGPT does.
        keyboardLiftBehavior="whenAtEnd"
        keyboardShouldPersistTaps="handled"
        initialScrollAtEnd
        maintainScrollAtEnd
        alignItemsAtEnd
        onStartReached={() => loadOlder(hostId, threadId)}
        ListEmptyComponent={
          transcript?.status === "loading" ? (
            <View className="items-center py-8">
              <ActivityIndicator />
            </View>
          ) : null
        }
        ListHeaderComponent={
          transcript?.loadingOlder ? (
            <View className="items-center py-3">
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        // One face, at the end of the newest reply: repeated down the thread it reads as wallpaper.
        // A single element in one place, so it stays mounted and animates between states.
        ListFooterComponent={
          <>
            {faceState ? (
              <View className="flex-row items-center gap-2 px-4 py-2">
                <OrbFace state={faceState} size={28} />
                {isThinking ? (
                  <Pulsing>
                    <Text className="text-sm text-muted-foreground">Thinking…</Text>
                  </Pulsing>
                ) : null}
              </View>
            ) : null}
            {runningAgents.length > 0 ? (
              <RunningAgents
                hostId={hostId}
                threadId={threadId}
                agents={runningAgents}
                canStopOne={thread.provider === "claude"}
              />
            ) : null}
          </>
        }
      />
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0">
        <KeyboardStickyView>
          {/* The list shifts its end by the composer's growth itself; scrolling here as well
              fought that shift and jumped the transcript while typing. */}
          <View ref={composer} onLayout={onComposerLayout}>
            {host.connection === "connected" ? null : (
              <Text className="px-4 pt-2 text-center text-xs text-warning">
                Not connected to {host.paired.name}; showing what was last loaded.
              </Text>
            )}
            <Composer
              hostId={hostId}
              thread={thread}
              settings={host.settings}
              providers={providers}
            />
          </View>
        </KeyboardStickyView>
      </View>
    </View>
  );
}
