import { isShowingWork, toTurns } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Spinner } from "heroui-native";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Text, View } from "react-native";
import { Composer } from "../../../src/components/Composer.tsx";
import { TranscriptTurn } from "../../../src/components/TranscriptTurn.tsx";
import { loadOlder, openThread, send, transcriptKey, useStore } from "../../../src/lib/store.ts";

export default function ThreadScreen() {
  const { macId, threadId } = useLocalSearchParams<{ macId: string; threadId: string }>();
  const mac = useStore((state) => state.macs[macId]);
  const thread = mac?.threads[threadId];
  const transcript = useStore((state) => state.transcripts[transcriptKey(macId, threadId)]);
  const turns = useMemo(() => toTurns(transcript?.items ?? []), [transcript?.items]);
  const screen = useRef<ComponentRef<typeof View>>(null);
  // How far down the window the screen starts (below the header); the keyboard is measured from the top.
  const [screenTop, setScreenTop] = useState(0);

  useEffect(() => openThread(macId, threadId), [macId, threadId]);

  const seenRev = thread?.seenRev;
  const updatedAt = thread?.updatedAt;

  // Looking at the thread reads what's new, on the Mac too.
  useEffect(() => {
    if (seenRev !== undefined && updatedAt !== undefined && seenRev < updatedAt)
      send(macId, ClientCommand.cases["thread.seen"].make({ threadId, rev: updatedAt }));
  }, [macId, threadId, seenRev, updatedAt]);

  if (!mac || !thread)
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        <Text className="text-center text-[15px] text-muted">
          {mac?.connection === "connected"
            ? "This thread is gone; it was deleted on the Mac."
            : "Connecting to the Mac…"}
        </Text>
      </View>
    );

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
        <Stack.Screen options={{ title: thread.title || "New thread" }} />
        {transcript?.status === "loading" ? (
          <View className="flex-1 items-center justify-center">
            <Spinner />
          </View>
        ) : (
          <LegendList
            data={turns}
            keyExtractor={(turn) => turn.id}
            renderItem={({ item }) => (
              <TranscriptTurn macId={macId} threadId={threadId} turn={item} />
            )}
            estimatedItemSize={120}
            initialScrollAtEnd
            maintainScrollAtEnd
            alignItemsAtEnd
            onStartReached={() => loadOlder(macId, threadId)}
            ListHeaderComponent={
              transcript?.loadingOlder ? (
                <View className="items-center py-3">
                  <Spinner size="sm" />
                </View>
              ) : null
            }
            ListFooterComponent={
              isThinking ? (
                <Text className="px-4 py-2 text-[14px] text-muted">Thinking…</Text>
              ) : null
            }
          />
        )}
        {mac.connection === "connected" ? null : (
          <Text className="px-4 py-1 text-center text-[13px] text-warning">
            Not connected to {mac.mac.name}; showing what was last loaded.
          </Text>
        )}
        <Composer macId={macId} thread={thread} settings={mac.settings} />
      </KeyboardAvoidingView>
    </View>
  );
}
