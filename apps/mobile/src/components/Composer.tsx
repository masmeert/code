import {
  EFFORT_LABEL,
  EFFORTS,
  findDefaultModel,
  PERMISSION_DESCRIPTION,
  PERMISSION_LABEL,
  PERMISSIONS,
} from "@masscode/client";
import {
  ClientCommand,
  type Effort,
  isTurnActive,
  type PermissionLevel,
  PROVIDER_NAME,
  type ProviderStatus,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import {
  ArrowUp,
  ChevronDown,
  FilePen,
  ListChecks,
  LockOpen,
  type LucideIcon,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/cn.ts";
import { send } from "@/lib/store.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

interface TurnPrefs {
  readonly permission: PermissionLevel;
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
}

const PERMISSION_ICON: Record<PermissionLevel, LucideIcon> = {
  plan: ListChecks,
  ask: ShieldCheck,
  "auto-edit": FilePen,
  auto: Sparkles,
  "full-access": LockOpen,
};

/** What each thread was last sent with from this phone, while the app runs. */
const prefsByThread = new Map<string, TurnPrefs>();

/** The thread's last picks, else the host's defaults for new threads, fitted to the thread's harness. */
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

/** The desktop's composer card: the message, then the turn's effort and permission, then send. */
export function Composer({
  hostId,
  thread,
  settings,
  providers,
}: {
  hostId: string;
  thread: ThreadInfo;
  settings: Settings | null;
  providers: ReadonlyArray<ProviderStatus>;
}) {
  const [text, setText] = useState("");
  const [prefs, setPrefs] = useState(() => findTurnPrefs(settings, thread));
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const insets = useSafeAreaInsets();
  // A bottom inset means a home indicator or gesture bar, on a screen with rounded corners.
  const isAtScreenEdge = !isKeyboardVisible && insets.bottom > 0;
  const isWorking = isTurnActive(thread.status);
  const willQueue = isWorking && settings?.followUp !== "steer";

  const modelId =
    thread.model ?? (settings && findDefaultModel(providers, settings, thread.provider));

  const model = providers
    .find((status) => status.kind === thread.provider)
    ?.models.find((option) => option.id === modelId);

  const effort = prefs.effort ?? model?.defaultEffort ?? null;

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
      hostId,
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
    <View className={cn("gap-2 bg-background pt-1", isAtScreenEdge ? "px-2 pb-2" : "px-3 pb-2")}>
      {thread.queue?.map((queued) => (
        <View
          key={queued.id}
          className="flex-row items-center gap-2 rounded-xl border border-border bg-card py-2 pr-2 pl-3"
        >
          <Text className="text-xs text-muted-foreground">Queued</Text>
          <Text numberOfLines={1} className="flex-1 text-sm">
            {queued.text}
          </Text>
          <Pressable
            accessibilityLabel="Take back this message"
            hitSlop={8}
            onPress={() => {
              setText(queued.text);
              send(
                hostId,
                ClientCommand.cases["thread.unqueue"].make({
                  threadId: thread.id,
                  messageIds: [queued.id],
                }),
              );
            }}
            className="size-6 items-center justify-center rounded-full active:bg-muted"
          >
            <Icon as={X} className="size-3.5 text-muted-foreground" />
          </Pressable>
        </View>
      ))}
      <View
        className={cn(
          "rounded-2xl border border-border bg-card p-1.5",
          // Down at the screen's rounded corners, the card's own corners follow them, and its
          // padding keeps the buttons above the home indicator.
          isAtScreenEdge && "rounded-b-[46px] pb-5",
        )}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={willQueue ? "Queue a follow-up" : `Ask ${PROVIDER_NAME[thread.provider]}…`}
          placeholderTextColorClassName="accent-muted-foreground/55"
          selectionColorClassName="accent-brand"
          cursorColorClassName="accent-brand"
          className="max-h-40 min-h-14 rounded-xl border border-border bg-background px-3.5 pt-2.5 pb-2.5 font-sans text-[15px] leading-6 text-foreground"
        />
        <View className="flex-row items-center gap-1.5 pt-1.5">
          <PrefMenu
            title="Effort"
            value={prefs.effort ?? "default"}
            options={[
              {
                value: "default",
                label: model?.defaultEffort
                  ? `${EFFORT_LABEL[model.defaultEffort]} (model default)`
                  : "Model default",
              },
              ...(model?.efforts ?? EFFORTS[thread.provider]).map((option) => ({
                value: option,
                label: EFFORT_LABEL[option],
              })),
            ]}
            onChange={(picked) => changePrefs({ effort: picked === "default" ? null : picked })}
          >
            <ProviderLogo provider={thread.provider} className="size-3.5 text-foreground" />
            <Text numberOfLines={1} className="shrink text-xs">
              {model?.label ?? PROVIDER_NAME[thread.provider]}
            </Text>
            {effort ? (
              <Text className="text-xs text-muted-foreground">{EFFORT_LABEL[effort]}</Text>
            ) : null}
          </PrefMenu>
          <PrefMenu
            title="Permissions"
            value={prefs.permission}
            options={PERMISSIONS[thread.provider].map((level) => ({
              value: level,
              label: PERMISSION_LABEL[level],
              description: PERMISSION_DESCRIPTION[level],
            }))}
            onChange={(permission) => changePrefs({ permission })}
          >
            <Icon
              as={PERMISSION_ICON[prefs.permission]}
              className={cn(
                "size-3.5",
                prefs.permission === "full-access" ? "text-warning" : "text-muted-foreground",
              )}
            />
            <Text
              className={cn(
                "text-xs",
                prefs.permission === "full-access" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {PERMISSION_LABEL[prefs.permission]}
            </Text>
          </PrefMenu>
          {isWorking && !text.trim() ? (
            <Pressable
              accessibilityLabel="Stop the agent"
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                send(hostId, ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
              }}
              className="ml-auto size-9 items-center justify-center rounded-full bg-primary active:opacity-85"
            >
              <View className="size-3 rounded-[3px] bg-primary-foreground" />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={willQueue ? "Queue message" : "Send message"}
              disabled={!text.trim()}
              onPress={submit}
              className={cn(
                "ml-auto size-9 items-center justify-center rounded-full bg-primary active:opacity-85",
                !text.trim() && "opacity-40",
              )}
            >
              <Icon as={ArrowUp} className="size-4 text-primary-foreground" />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

/** A composer pill that opens a single-choice menu above it. */
function PrefMenu<Value extends string>(props: {
  title: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string; description?: string }>;
  onChange: (value: Value) => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.title}
          className="h-9 shrink flex-row items-center gap-1.5 rounded-full border border-border bg-background px-3 active:bg-muted"
        >
          {props.children}
          <Icon as={ChevronDown} className="size-3 text-muted-foreground opacity-60" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        insets={{ left: 12, right: 12 }}
        className="w-72"
      >
        <DropdownMenuLabel>{props.title}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.value}
          onValueChange={(chosen) => {
            const option = props.options.find((candidate) => candidate.value === chosen);

            if (option) props.onChange(option.value);
          }}
        >
          {props.options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnPress
              className="items-start"
            >
              <View className="flex-1 gap-0.5">
                <Text className="text-sm">{option.label}</Text>
                {option.description ? (
                  <Text className="text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
