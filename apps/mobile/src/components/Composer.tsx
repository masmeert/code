import {
  EFFORT_LABEL,
  EFFORTS,
  findDefaultModel,
  PERMISSION_DESCRIPTION,
  PERMISSION_LABEL,
  PERMISSIONS,
} from "@masscode/client";
import {
  AttachmentInput,
  ClientCommand,
  type Effort,
  isTurnActive,
  type PermissionLevel,
  PROVIDER_NAME,
  type ProviderKind,
  type ProviderStatus,
  type Settings,
  type ThreadInfo,
  type TurnOptions,
} from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import {
  ArrowUp,
  ChevronDown,
  FilePen,
  ImagePlus,
  ListChecks,
  LockOpen,
  type LucideIcon,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Image, Pressable, TextInput, View } from "react-native";
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

/** What each thread (or the new-thread draft, as "new") was last sent with from this phone, while the app runs. */
const prefsByThread = new Map<string, TurnPrefs>();

/** The last picks, else the host's defaults for new threads, fitted to the harness. */
function fitTurnPrefs(
  settings: Settings | null,
  remembered: TurnPrefs | undefined,
  provider: ProviderKind,
): TurnPrefs {
  const permission = remembered?.permission ?? settings?.newThreadPermission ?? "ask";
  const effort = remembered ? remembered.effort : (settings?.newThreadEffort ?? null);

  return {
    effort: effort && EFFORTS[provider].includes(effort) ? effort : null,
    permission: PERMISSIONS[provider].includes(permission)
      ? permission
      : // Every harness offers a level besides plan.
        (PERMISSIONS[provider].find((level) => level !== "plan") ?? "ask"),
  };
}

/**
 * The desktop's composer card: the message, then the turn's effort and permission, then send.
 * Without a thread it drafts a new one: `onCreate` starts it, and `modelMenu` picks its model.
 */
export function Composer({
  hostId,
  settings,
  providers,
  ...target
}: {
  hostId: string;
  settings: Settings | null;
  providers: ReadonlyArray<ProviderStatus>;
} & (
  | { thread: ThreadInfo }
  | {
      thread: null;
      provider: ProviderKind;
      model: string | null;
      modelMenu: React.ReactNode;
      disabled: boolean;
      onCreate: (text: string, options: TurnOptions) => void;
    }
)) {
  const thread = target.thread;
  const provider = target.thread ? target.thread.provider : target.provider;
  const [text, setText] = useState("");
  const [images, setImages] = useState<ReadonlyArray<{ uri: string; input: AttachmentInput }>>([]);
  const prefsKey = thread?.id ?? "new";
  const [remembered, setRemembered] = useState(() => prefsByThread.get(prefsKey));
  const prefs = fitTurnPrefs(settings, remembered, provider);
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const insets = useSafeAreaInsets();
  // A bottom inset means a home indicator or gesture bar, on a screen with rounded corners.
  const isAtScreenEdge = !isKeyboardVisible && insets.bottom > 0;
  const isWorking = thread !== null && isTurnActive(thread.status);
  const willQueue = isWorking && settings?.followUp !== "steer";
  const canSend = Boolean(text.trim()) && !(target.thread === null && target.disabled);

  const modelId =
    (target.thread ? target.thread.model : target.model) ??
    (settings && findDefaultModel(providers, settings, provider));

  const model = providers
    .find((status) => status.kind === provider)
    ?.models.find((option) => option.id === modelId);

  const effort = prefs.effort ?? model?.defaultEffort ?? null;

  function changePrefs(patch: Partial<TurnPrefs>) {
    const next = { ...prefs, ...patch };
    prefsByThread.set(prefsKey, next);
    setRemembered(next);
  }

  function submit() {
    const message = text.trim();

    if (!canSend) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const options = { ...prefs, attachments: images.map((image) => image.input) };

    // A draft keeps its text and images until the thread exists, in case the host doesn't start it.
    if (target.thread === null) return target.onCreate(message, options);

    send(
      hostId,
      ClientCommand.cases["thread.send"].make({
        threadId: target.thread.id,
        text: message,
        options,
        queue: willQueue,
        messageId: crypto.randomUUID(),
      }),
    );
    setText("");
    setImages([]);
  }

  async function pickImages() {
    // ponytail: photos go as base64 in one WebSocket frame, which Bun caps at 16 MB; 4 photos at
    // this quality stay well under. Downscale with expo-image-manipulator if they don't.
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.5,
      base64: true,
    });

    if (picked.canceled) return;

    setImages((current) => [
      ...current,
      ...picked.assets.flatMap((asset) =>
        asset.base64
          ? [
              {
                uri: asset.uri,
                input: AttachmentInput.cases.data.make({
                  name: asset.fileName ?? "photo.jpg",
                  mediaType: asset.mimeType ?? "image/jpeg",
                  data: asset.base64,
                }),
              },
            ]
          : [],
      ),
    ]);
  }

  return (
    <View className={cn("gap-2 bg-background pt-1", isAtScreenEdge ? "px-2 pb-2" : "px-3 pb-2")}>
      {thread?.queue?.map((queued) => (
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
        {images.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5 pb-1.5">
            {images.map((image) => (
              <View key={image.uri}>
                <Image source={{ uri: image.uri }} className="size-14 rounded-lg bg-muted" />
                <Pressable
                  accessibilityLabel="Remove this photo"
                  hitSlop={8}
                  onPress={() => setImages((current) => current.filter((other) => other !== image))}
                  className="absolute -top-1.5 -right-1.5 size-5 items-center justify-center rounded-full border border-border bg-popover"
                >
                  <Icon as={X} className="size-3 text-foreground" />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={willQueue ? "Queue a follow-up" : `Ask ${PROVIDER_NAME[provider]}…`}
          placeholderTextColorClassName="accent-muted-foreground/55"
          selectionColorClassName="accent-brand"
          cursorColorClassName="accent-brand"
          className="max-h-40 min-h-14 rounded-xl border border-border bg-background px-3.5 pt-2.5 pb-2.5 font-sans text-[15px] leading-6 text-foreground"
        />
        <View className="flex-row items-center gap-1.5 pt-1.5">
          <Pressable
            accessibilityLabel="Attach photos"
            onPress={() => void pickImages()}
            className="size-9 items-center justify-center rounded-full border border-border bg-background active:bg-muted"
          >
            <Icon as={ImagePlus} className="size-4 text-muted-foreground" />
          </Pressable>
          {target.thread === null ? target.modelMenu : null}
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
              ...(model?.efforts ?? EFFORTS[provider]).map((option) => ({
                value: option,
                label: EFFORT_LABEL[option],
              })),
            ]}
            onChange={(picked) => changePrefs({ effort: picked === "default" ? null : picked })}
          >
            {thread ? (
              <>
                <ProviderLogo provider={provider} className="size-3.5 text-foreground" />
                <Text numberOfLines={1} className="shrink text-xs">
                  {model?.label ?? PROVIDER_NAME[provider]}
                </Text>
              </>
            ) : null}
            {effort || !thread ? (
              <Text className="text-xs text-muted-foreground">
                {effort ? EFFORT_LABEL[effort] : "Effort"}
              </Text>
            ) : null}
          </PrefMenu>
          <PrefMenu
            title="Permissions"
            value={prefs.permission}
            options={PERMISSIONS[provider].map((level) => ({
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
          {thread && isWorking && !text.trim() ? (
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
              disabled={!canSend}
              onPress={submit}
              className={cn(
                "ml-auto size-9 items-center justify-center rounded-full bg-primary active:opacity-85",
                !canSend && "opacity-40",
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
export function PrefMenu<Value extends string>(props: {
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
