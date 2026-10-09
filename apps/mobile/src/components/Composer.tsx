import { EFFORT_LABEL, EFFORTS, PERMISSION_LABEL, PERMISSIONS } from "@masscode/client";
import {
  ClientCommand,
  type Effort,
  type PermissionLevel,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { Menu } from "heroui-native";
import { ArrowUp, ChevronDown, Square, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useCSSVariable, useResolveClassNames } from "uniwind";
import { send } from "../lib/store.ts";

interface TurnPrefs {
  readonly permission: PermissionLevel;
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
}

/** What each thread was last sent with from this phone, while the app runs. */
const prefsByThread = new Map<string, TurnPrefs>();

/** The thread's last picks, else the Mac's defaults for new threads, fitted to the thread's harness. */
function findTurnPrefs(settings: Settings | null, thread: ThreadInfo): TurnPrefs {
  const remembered = prefsByThread.get(thread.id);
  const permission = remembered?.permission ?? settings?.newThreadPermission ?? "ask";
  const effort = remembered ? remembered.effort : (settings?.newThreadEffort ?? null);

  return {
    effort: effort && EFFORTS[thread.provider].includes(effort) ? effort : null,
    permission: PERMISSIONS[thread.provider].includes(permission)
      ? permission
      : // Every harness offers a level besides plan.
        (PERMISSIONS[thread.provider].find((level) => level !== "plan") ?? "ask"),
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
  const [prefs, setPrefs] = useState(() => findTurnPrefs(settings, thread));
  const placeholder = useResolveClassNames("text-muted");
  const accentForeground = useCSSVariable("--color-accent-foreground");
  const background = useCSSVariable("--color-background");
  const foreground = useCSSVariable("--color-foreground");
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const isWorking = thread.status === "running";
  const willQueue = isWorking && settings?.followUp !== "steer";

  function changePrefs(patch: Partial<TurnPrefs>) {
    const next = { ...prefs, ...patch };
    prefsByThread.set(thread.id, next);
    setPrefs(next);
  }

  function submit() {
    const message = text.trim();

    if (!message) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send(
      macId,
      ClientCommand.cases["thread.send"].make({
        threadId: thread.id,
        text: message,
        options: { ...prefs, attachments: [] },
        queue: willQueue,
        messageId: crypto.randomUUID(),
      }),
    );
    setText("");
  }

  return (
    <View
      className={
        // The keyboard covers the home indicator, so its padding would only leave a gap.
        isKeyboardVisible
          ? "border-separator gap-2 border-t bg-background px-3 pt-2 pb-2"
          : "border-separator pb-safe-or-2 gap-2 border-t bg-background px-3 pt-2"
      }
    >
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
            <Square size={14} fill={String(background)} color={String(background)} />
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
      <View className="flex-row gap-2">
        <PrefMenu
          label={PERMISSION_LABEL[prefs.permission]}
          value={prefs.permission}
          options={PERMISSIONS[thread.provider].map((level) => ({
            value: level,
            label: PERMISSION_LABEL[level],
          }))}
          onChange={(permission) => changePrefs({ permission })}
        />
        <PrefMenu
          label={prefs.effort ? `${EFFORT_LABEL[prefs.effort]} effort` : "Default effort"}
          value={prefs.effort ?? "default"}
          options={[
            { value: "default", label: "Default effort" },
            ...EFFORTS[thread.provider].map((effort) => ({
              value: effort,
              label: EFFORT_LABEL[effort],
            })),
          ]}
          onChange={(effort) => changePrefs({ effort: effort === "default" ? null : effort })}
        />
      </View>
    </View>
  );
}

/** A small pill that opens a single-choice menu above the composer. */
function PrefMenu<Value extends string>(props: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  const muted = useCSSVariable("--color-muted");

  return (
    <Menu>
      <Menu.Trigger asChild>
        <Pressable
          accessibilityRole="button"
          className="bg-surface-secondary flex-row items-center gap-1 rounded-full px-3 py-1.5"
        >
          <Text className="text-[13px] text-foreground">{props.label}</Text>
          <ChevronDown size={14} color={String(muted)} />
        </Pressable>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Overlay />
        <Menu.Content presentation="popover" placement="top" width={220}>
          <Menu.Group
            selectionMode="single"
            selectedKeys={[props.value]}
            onSelectionChange={(keys) => {
              const [chosen] = [...keys];
              const option = props.options.find((candidate) => candidate.value === chosen);

              if (option) props.onChange(option.value);
            }}
          >
            {props.options.map((option) => (
              <Menu.Item key={option.value} id={option.value}>
                <Menu.ItemIndicator />
                <Menu.ItemTitle>{option.label}</Menu.ItemTitle>
              </Menu.Item>
            ))}
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  );
}
