import { formatProjectLabel, isShowingWork, toTurns } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, View } from "react-native";
import { Composer } from "@/components/Composer.tsx";
import { ProjectBadge } from "@/components/ProjectBadge.tsx";
import { Pulsing } from "@/components/Pulsing.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TranscriptTurn } from "@/components/TranscriptTurn.tsx";
import { loadOlder, openThread, send, transcriptKey, useStore } from "@/lib/store.ts";

export default function ThreadScreen() {
  const { hostId, threadId } = useLocalSearchParams<{ hostId: string; threadId: string }>();
  const host = useStore((state) => state.hosts[hostId]);
  const thread = host?.threads[threadId];
  const transcript = useStore((state) => state.transcripts[transcriptKey(hostId, threadId)]);
  const turns = useMemo(() => toTurns(transcript?.items ?? []), [transcript?.items]);
  const screen = useRef<ComponentRef<typeof View>>(null);
  // How far down the window the screen starts (below the header); the keyboard is measured from the top.
  const [screenTop, setScreenTop] = useState(0);

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

  return (
    <View
      ref={screen}
      onLayout={() => screen.current?.measureInWindow((_x, y) => setScreenTop(y))}
      className="flex-1"
    >
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={screenTop}
        className="flex-1 bg-background"
      >
        <Stack.Screen
          options={{
            headerTitle: () => (
              <View className="max-w-64 items-center">
                <Text numberOfLines={1} className="text-[15px] font-semibold">
                  {thread.title || "New thread"}
                </Text>
                {project ? (
                  <View className="flex-row items-center gap-1.5">
                    <ProjectBadge project={project} />
                    <Text numberOfLines={1} className="text-xs text-muted-foreground">
                      {formatProjectLabel(project.name, null)}
                      {thread.branch ? ` · ${thread.branch}` : ""}
                    </Text>
                  </View>
                ) : null}
              </View>
            ),
          }}
        />
        {transcript?.status === "loading" ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : (
          <LegendList
            data={turns}
            keyExtractor={(turn) => turn.id}
            renderItem={({ item }) => (
              <TranscriptTurn hostId={hostId} threadId={threadId} turn={item} />
            )}
            estimatedItemSize={120}
            initialScrollAtEnd
            maintainScrollAtEnd
            alignItemsAtEnd
            onStartReached={() => loadOlder(hostId, threadId)}
            ListHeaderComponent={
              transcript?.loadingOlder ? (
                <View className="items-center py-3">
                  <ActivityIndicator size="small" />
                </View>
              ) : null
            }
            ListFooterComponent={
              isThinking ? (
                <Pulsing className="px-4 py-2">
                  <Text className="text-sm text-muted-foreground">Thinking…</Text>
                </Pulsing>
              ) : null
            }
          />
        )}
        {host.connection === "connected" ? null : (
          <Text className="px-4 py-1 text-center text-xs text-warning">
            Not connected to {host.paired.name}; showing what was last loaded.
          </Text>
        )}
        <Composer
          hostId={hostId}
          thread={thread}
          settings={host.settings}
          providers={host.providers}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
