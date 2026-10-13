import { isShowingWork, toTurns } from "@masscode/client";
import { ClientCommand, isTurnActive } from "@masscode/contracts";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Composer } from "@/components/composer.tsx";
import { OrbFace, type OrbFaceState } from "@/components/orb-face.tsx";
import { Pulsing } from "@/components/pulsing.tsx";
import { Text } from "@/components/ui/text.tsx";
import { ThreadHeader } from "@/components/thread-header.tsx";
import { TranscriptTurn } from "@/components/transcript-turn.tsx";
import { loadOlder, openThread, send, transcriptKey, useStore } from "@/lib/store.ts";

export default function ThreadScreen() {
  const { hostId, threadId } = useLocalSearchParams<{ hostId: string; threadId: string }>();
  const host = useStore((state) => state.hosts[hostId]);
  const thread = host?.threads[threadId];
  const transcript = useStore((state) => state.transcripts[transcriptKey(hostId, threadId)]);
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

  const project = host.projects.find((candidate) => candidate.id === thread.projectId);
  const isThinking = thread.status === "running" && !isShowingWork(transcript?.items ?? []);
  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.from === "assistant" ? lastTurn.items.at(-1) : undefined;

  const faceState: OrbFaceState | null = isThinking
    ? "thinking"
    : lastItem === undefined
      ? null
      : isTurnActive(thread.status)
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
          <TranscriptTurn hostId={hostId} threadId={threadId} turn={item} />
        )}
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
          faceState ? (
            <View className="flex-row items-center gap-2 px-4 py-2">
              <OrbFace state={faceState} size={28} />
              {isThinking ? (
                <Pulsing>
                  <Text className="text-sm text-muted-foreground">Thinking…</Text>
                </Pulsing>
              ) : null}
            </View>
          ) : null
        }
      />
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0">
        <KeyboardStickyView>
          <View
            ref={composer}
            onLayout={(event) => {
              // Growing into the card would cover the transcript's end; it stays in view instead.
              const wasAtEnd = list.current?.getState().isAtEnd;

              onComposerLayout(event);

              if (wasAtEnd)
                requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
            }}
          >
            {host.connection === "connected" ? null : (
              <Text className="px-4 pt-2 text-center text-xs text-warning">
                Not connected to {host.paired.name}; showing what was last loaded.
              </Text>
            )}
            <Composer
              hostId={hostId}
              thread={thread}
              settings={host.settings}
              providers={host.providers}
            />
          </View>
        </KeyboardStickyView>
      </View>
    </View>
  );
}
