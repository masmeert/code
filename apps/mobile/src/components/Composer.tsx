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
  Effort,
  isTurnActive,
  PermissionLevel,
  PROVIDER_NAME,
  type ProviderKind,
  type ProviderStatus,
  type Settings,
  type ThreadInfo,
  type TurnOptions,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import {
  ArrowUp,
  ChevronDown,
  FilePen,
  FileText,
  Folder,
  Image as ImageIcon,
  ListChecks,
  LockOpen,
  type LucideIcon,
  Paperclip,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/cn.ts";
import { send } from "@/lib/store.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

interface TurnPrefs {
  readonly permission: PermissionLevel;
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
}

/** One single-choice list in a composer menu. */
export interface ChoiceGroup<Value extends string = string> {
  readonly title: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ value: Value; label: string; description?: string }>;
  readonly onChange: (value: Value) => void;
}

/** A file waiting to go with the next message. */
interface PendingFile {
  readonly uri: string;
  readonly name: string;
  readonly isImage: boolean;
  readonly sizeBytes: number;
  readonly input: AttachmentInput;
}

// Files ride as base64 in one WebSocket frame, which Bun caps at 16 MB; base64 adds a third.
const MAX_FILES_BYTES = 10 * 1024 * 1024;

function alertTooBig(names: ReadonlyArray<string>) {
  Alert.alert(
    names.length === 1 ? `${names[0]} is too big` : `${names.length} files are too big`,
    "A message from the phone can carry up to 10 MB of files. Send bigger files from your computer.",
  );
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
 * The desktop's composer, cut down for a phone: the message and its files, the model and effort,
 * permissions, then attach and send. Without a thread it drafts a new one: `onCreate` starts it,
 * and `modelChoice` picks its model.
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
      modelChoice: ChoiceGroup | null;
      disabled: boolean;
      onCreate: (text: string, options: TurnOptions) => void;
    }
)) {
  const thread = target.thread;
  const provider = target.thread ? target.thread.provider : target.provider;
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<PendingFile>>([]);
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
  const isFullAccess = prefs.permission === "full-access";

  function changePrefs(patch: Partial<TurnPrefs>) {
    const next = { ...prefs, ...patch };
    prefsByThread.set(prefsKey, next);
    setRemembered(next);
  }

  function submit() {
    const message = text.trim();

    if (!canSend) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const options = { ...prefs, attachments: files.map((file) => file.input) };

    // A draft keeps its text and files until the thread exists, in case the host doesn't start it.
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
    setFiles([]);
  }

  /** Adds what fits under the cap, and says which files didn't. */
  function addFiles(picked: ReadonlyArray<PendingFile>) {
    let totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const rejected: string[] = [];

    const fitting = picked.filter((file) => {
      if (files.some((other) => other.uri === file.uri)) return false;

      if (totalBytes + file.sizeBytes > MAX_FILES_BYTES) {
        rejected.push(file.name);

        return false;
      }

      totalBytes += file.sizeBytes;

      return true;
    });

    if (rejected.length > 0) alertTooBig(rejected);
    setFiles([...files, ...fitting]);
  }

  async function pickPhotos() {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.5,
      base64: true,
    });

    if (picked.canceled) return;

    addFiles(
      picked.assets.flatMap((asset) =>
        asset.base64
          ? [
              {
                uri: asset.uri,
                name: asset.fileName ?? "photo.jpg",
                isImage: true,
                sizeBytes: Math.ceil((asset.base64.length * 3) / 4),
                input: AttachmentInput.cases.data.make({
                  name: asset.fileName ?? "photo.jpg",
                  mediaType: asset.mimeType ?? "image/jpeg",
                  data: asset.base64,
                }),
              },
            ]
          : [],
      ),
    );
  }

  async function pickDocuments() {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true });

    if (picked.canceled) return;

    // Too big to send anyway, so not worth reading into memory.
    const tooBig = picked.assets.filter((asset) => (asset.size ?? 0) > MAX_FILES_BYTES);

    if (tooBig.length > 0) alertTooBig(tooBig.map((asset) => asset.name));

    const fitting = picked.assets.filter((asset) => !tooBig.includes(asset));

    try {
      addFiles(
        await Promise.all(
          fitting.map(async (asset) => {
            const mediaType = asset.mimeType ?? "application/octet-stream";

            return {
              uri: asset.uri,
              name: asset.name,
              isImage: mediaType.startsWith("image/"),
              sizeBytes: asset.size ?? 0,
              input: AttachmentInput.cases.data.make({
                name: asset.name,
                mediaType,
                data: await new File(asset.uri).base64(),
              }),
            };
          }),
        ),
      );
    } catch {
      Alert.alert(
        "Couldn't read that file",
        "Check it's downloaded to this phone, not only in iCloud, then attach it again.",
      );
    }
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
          "rounded-3xl border border-border bg-card p-2",
          // Down at the screen's rounded corners, the card's own corners follow them, and its
          // padding keeps the buttons clear of the corners and the home indicator.
          isAtScreenEdge && "rounded-b-[46px] px-3 pb-5",
        )}
      >
        {files.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-1.5 px-1 pt-1"
          >
            {files.map((file) => (
              <View
                key={file.uri}
                className="h-10 max-w-52 flex-row items-center gap-2 rounded-xl bg-muted pr-1 pl-1"
              >
                {file.isImage ? (
                  <Image source={{ uri: file.uri }} className="size-8 rounded-lg bg-background" />
                ) : (
                  <View className="size-8 items-center justify-center rounded-lg bg-background">
                    <Icon as={FileText} className="size-4 text-muted-foreground" />
                  </View>
                )}
                <Text numberOfLines={1} className="shrink text-xs">
                  {file.name}
                </Text>
                <Pressable
                  accessibilityLabel={`Remove ${file.name}`}
                  hitSlop={8}
                  onPress={() => setFiles((current) => current.filter((other) => other !== file))}
                  className="size-7 items-center justify-center rounded-lg active:bg-background"
                >
                  <Icon as={X} className="size-3.5 text-muted-foreground" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={willQueue ? "Queue a follow-up" : `Ask ${PROVIDER_NAME[provider]}…`}
          placeholderTextColorClassName="accent-muted-foreground/55"
          selectionColorClassName="accent-brand"
          cursorColorClassName="accent-brand"
          className="max-h-40 min-h-12 px-2 pt-2 pb-2 font-sans text-[15px] leading-6 text-foreground"
        />
        <View className="flex-row items-center gap-1.5 pt-1">
          <ChoiceMenu
            label="Model and effort"
            className="h-9 shrink flex-row items-center gap-1.5 rounded-full bg-muted px-3 active:opacity-80"
            groups={[
              ...(target.thread === null && target.modelChoice ? [target.modelChoice] : []),
              {
                title: "Effort",
                value: prefs.effort ?? "default",
                options: [
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
                ],
                onChange: (picked) =>
                  changePrefs({ effort: Schema.is(Effort)(picked) ? picked : null }),
              },
            ]}
          >
            <ProviderLogo provider={provider} className="size-3.5 text-foreground" />
            <Text numberOfLines={1} className="shrink text-[13px]">
              {model?.label ?? PROVIDER_NAME[provider]}
            </Text>
            {effort ? (
              <Text className="text-[13px] text-muted-foreground">{EFFORT_LABEL[effort]}</Text>
            ) : null}
            <Icon as={ChevronDown} className="size-3.5 text-muted-foreground" />
          </ChoiceMenu>
          <ChoiceMenu
            label={`Permissions: ${PERMISSION_LABEL[prefs.permission]}`}
            className={cn(
              "size-9 items-center justify-center rounded-full active:opacity-80",
              isFullAccess ? "bg-warning/15" : "bg-muted",
            )}
            groups={[
              {
                title: "Permissions",
                value: prefs.permission,
                options: PERMISSIONS[provider].map((level) => ({
                  value: level,
                  label: PERMISSION_LABEL[level],
                  description: PERMISSION_DESCRIPTION[level],
                })),
                onChange: (permission) =>
                  Schema.is(PermissionLevel)(permission) && changePrefs({ permission }),
              },
            ]}
          >
            <Icon
              as={PERMISSION_ICON[prefs.permission]}
              className={cn("size-4", isFullAccess ? "text-warning" : "text-muted-foreground")}
            />
          </ChoiceMenu>
          <View className="ml-auto flex-row items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Attach files"
                  className="size-9 items-center justify-center rounded-full bg-muted active:opacity-80"
                >
                  <Icon as={Paperclip} className="size-4 text-muted-foreground" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" sideOffset={6} insets={{ right: 12 }}>
                <DropdownMenuItem closeOnPress onPress={() => void pickPhotos()}>
                  <Icon as={ImageIcon} className="size-4 text-muted-foreground" />
                  <Text>Photos</Text>
                </DropdownMenuItem>
                <DropdownMenuItem closeOnPress onPress={() => void pickDocuments()}>
                  <Icon as={Folder} className="size-4 text-muted-foreground" />
                  <Text>Files</Text>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {thread && isWorking && !text.trim() ? (
              <Pressable
                accessibilityLabel="Stop the agent"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  send(
                    hostId,
                    ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }),
                  );
                }}
                className="size-9 items-center justify-center rounded-full bg-primary active:opacity-85"
              >
                <View className="size-3 rounded-[3px] bg-primary-foreground" />
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel={willQueue ? "Queue message" : "Send message"}
                disabled={!canSend}
                onPress={submit}
                className={cn(
                  "size-9 items-center justify-center rounded-full bg-primary active:opacity-85",
                  !canSend && "opacity-40",
                )}
              >
                <Icon as={ArrowUp} className="size-4 text-primary-foreground" />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

/** A composer button that opens one or more single-choice lists above it. */
function ChoiceMenu({
  label,
  className,
  groups,
  children,
}: {
  label: string;
  className: string;
  groups: ReadonlyArray<ChoiceGroup>;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable accessibilityRole="button" accessibilityLabel={label} className={className}>
          {children}
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        insets={{ left: 12, right: 12 }}
        className="max-h-96 w-72"
      >
        <ScrollView bounces={false}>
          {groups.map((group, index) => (
            <View key={group.title}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={group.value}
                onValueChange={(chosen) => {
                  if (group.options.some((option) => option.value === chosen))
                    group.onChange(chosen);
                }}
              >
                {group.options.map((option) => (
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
            </View>
          ))}
        </ScrollView>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
