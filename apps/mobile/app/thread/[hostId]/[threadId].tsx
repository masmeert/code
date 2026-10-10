import { formatProjectLabel, isShowingWork, toTurns } from "@masscode/client";
import { ClientCommand, isTurnActive } from "@masscode/contracts";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { BlurView } from "expo-blur";
import { Stack, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { withUniwind } from "uniwind";
import { Composer } from "@/components/Composer.tsx";
import { OrbFace, type OrbFaceState } from "@/components/OrbFace.tsx";
import { ProjectBadge } from "@/components/ProjectBadge.tsx";
import { Pulsing } from "@/components/Pulsing.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TranscriptTurn } from "@/components/TranscriptTurn.tsx";
import { loadOlder, openThread, send, transcriptKey, useStore } from "@/lib/store.ts";

const StyledBlurView = withUniwind(BlurView);

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
      <Stack.Screen
        options={{
          // iOS draws its glass bar over the transcript, which scrolls on underneath.
          headerTransparent: Platform.OS === "ios",
          headerBackground:
            Platform.OS === "ios"
              ? () => (
                  <StyledBlurView
                    tint="systemChromeMaterial"
                    intensity={100}
                    className="flex-1 border-b-[0.5px] border-border-strong"
                  />
                )
              : undefined,
          headerTitle: () => (
            <View className="max-w-60 items-center gap-0.5">
              <Text numberOfLines={1} className="text-[15px] leading-5 font-semibold">
                {thread.title || "New thread"}
              </Text>
              {project ? (
                <View className="flex-row items-center gap-1">
                  <ProjectBadge project={project} />
                  <Text
                    numberOfLines={1}
                    className="shrink text-xs leading-4 text-muted-foreground"
                  >
                    {formatProjectLabel(project.name, null)}
                  </Text>
                  {thread.branch ? (
                    <>
                      <View className="mx-1 h-3 w-px bg-border-strong" />
                      <Text
                        numberOfLines={1}
                        className="shrink text-xs leading-4 text-muted-foreground/70"
                      >
                        {thread.branch}
                      </Text>
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          ),
        }}
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
          <View ref={composer} onLayout={onComposerLayout} className="bg-background">
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
