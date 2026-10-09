import { EFFORTS, PERMISSIONS } from "@masscode/client";
import { ClientCommand, type Settings, type ThreadInfo } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { ArrowUp, Square, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useCSSVariable, useResolveClassNames } from "uniwind";
import { send } from "../lib/store.ts";

/** What a message from the phone runs with: the Mac's defaults for new threads, fitted to the thread's harness. */
function toTurnOptions(settings: Settings | null, thread: ThreadInfo) {
  const permission = settings?.newThreadPermission ?? "ask";
  const effort = settings?.newThreadEffort ?? null;

  return {
    effort: effort && EFFORTS[thread.provider].includes(effort) ? effort : null,
    permission: PERMISSIONS[thread.provider].includes(permission)
      ? permission
      : // Every harness offers a level besides plan.
        (PERMISSIONS[thread.provider].find((level) => level !== "plan") ?? "ask"),
    attachments: [],
  };
}

export function Composer({
  macId,
  thread,
  settings,
}: {
  macId: string;
  thread: ThreadInfo;
  settings: Settings | null;
}) {
  const [text, setText] = useState("");
  const placeholder = useResolveClassNames("text-muted");
  const accentForeground = useCSSVariable("--color-accent-foreground");
  const foreground = useCSSVariable("--color-foreground");
  const isWorking = thread.status === "running";
  const willQueue = isWorking && settings?.followUp !== "steer";

  function submit() {
    const message = text.trim();

    if (!message) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send(
      macId,
      ClientCommand.cases["thread.send"].make({
        threadId: thread.id,
        text: message,
        options: toTurnOptions(settings, thread),
        queue: willQueue,
        messageId: crypto.randomUUID(),
      }),
    );
    setText("");
  }

  return (
    <View className="border-separator pb-safe-or-2 gap-2 border-t bg-background px-3 pt-2">
      {thread.queue?.map((queued) => (
        <View
          key={queued.id}
          className="bg-surface-secondary flex-row items-center gap-2 rounded-xl px-3 py-2"
        >
          <Text numberOfLines={1} className="flex-1 text-[14px] text-muted">
            Queued: {queued.text}
          </Text>
          <Pressable
            accessibilityLabel="Take back this message"
            hitSlop={8}
            onPress={() => {
              setText(queued.text);
              send(
                macId,
                ClientCommand.cases["thread.unqueue"].make({
                  threadId: thread.id,
                  messageIds: [queued.id],
                }),
              );
            }}
          >
            <X size={16} color={String(foreground)} />
          </Pressable>
        </View>
      ))}
      <View className="flex-row items-end gap-2">
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={willQueue ? "Queue a message for when it's done" : "Message the agent"}
          placeholderTextColor={String(placeholder.color)}
          className="bg-surface-secondary max-h-40 min-h-11 flex-1 rounded-3xl px-4 py-2.5 text-[16px] text-foreground"
        />
        {isWorking && !text.trim() ? (
          <Pressable
            accessibilityLabel="Stop the agent"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              send(macId, ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
            }}
            className="size-11 items-center justify-center rounded-full bg-foreground"
          >
            <Square size={14} fill={String(accentForeground)} color={String(accentForeground)} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={willQueue ? "Queue message" : "Send message"}
            disabled={!text.trim()}
            onPress={submit}
            className={
              text.trim()
                ? "size-11 items-center justify-center rounded-full bg-accent"
                : "size-11 items-center justify-center rounded-full bg-accent opacity-40"
            }
          >
            <ArrowUp size={20} color={String(accentForeground)} />
          </Pressable>
        )}
      </View>
    </View>
  );
}
