import {
  EFFORT_LABEL,
  EFFORTS,
  findDefaultModel,
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
  ProviderKind,
  type ProviderStatus,
  type Settings,
  type ThreadInfo,
  type TurnOptions,
} from "@masscode/contracts";
import { MenuView } from "@expo/ui/community/menu";
import * as Schema from "effect/Schema";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
import {
  type ChoiceGroup,
  type ThreadSettingsSession,
  useThreadSettings,
} from "@/features/thread-settings";
import { alertNotConnected, useIsHostConnected } from "@/entities/host";
import { useProjectStore } from "@/entities/project";
import { getSkillsKey, ProviderLogo, useProviderStore } from "@/entities/provider";
import { useThreadStore } from "@/entities/thread";
import { send } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { Icon, Text } from "@/shared/ui";
import {
  detectComposerTrigger,
  formatFileMention,
  matchFiles,
  nextPastedTextFileName,
  replaceTypedWord,
} from "../lib/composer-mentions.ts";
import {
  COMPOSER_EDITOR_INSET,
  useComposerEditorLayout,
} from "../model/use-composer-editor-layout.ts";
import { useVoiceInput } from "../model/use-voice-input.ts";
import { type ComposerCommandItem, ComposerCommandMenu } from "./composer-command-menu.tsx";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "./composer-dictation.tsx";
import {
  ComposerEditor,
  type ComposerEditorSelection,
  type ComposerTextPaste,
} from "./composer-editor.tsx";

interface TurnPrefs {
  readonly permission: PermissionLevel;
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
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

/** Where each harness looks for a project's skills. */
const SKILLS_FOLDER: Record<ProviderKind, string> = {
  claude: ".claude",
  codex: ".agents",
  cursor: ".cursor",
};

type FollowUp = "queue" | "steer";

const FOLLOW_UP: Record<FollowUp, { label: string; menuTitle: string; icon: SFSymbol }> = {
  queue: { label: "Queue", menuTitle: "Queue: run after the current turn", icon: "list.number" },
  steer: {
    label: "Steer",
    menuTitle: "Steer now: interrupt what the agent is doing",
    icon: "arrow.turn.left.up",
  },
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
      /** The project folder the thread will start in, for `@` files and `$` skills. */
      path: string;
      provider: ProviderKind;
      model: string | null;
      /** The draft's model as "provider:model", and how to change it. */
      modelChoice: { value: string; onChange: (value: string) => void } | null;
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
  // The editor's caret, which dictation and the `@`/`$`/`/` menu insert at.
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });

  const voiceInput = useVoiceInput({
    readDraft: () => ({ ownerKey: `${hostId}:${prefsKey}`, text, selection }),
    commitDraft: (dictated, dictatedSelection) => {
      setText(dictated);
      setSelection(dictatedSelection);
    },
  });

  /** Replaces the draft, with the caret at `caret`. */
  function changeDraft(nextText: string, caret = nextText.length) {
    setText(nextText);
    setSelection({ start: caret, end: caret });
  }

  const isConnected = useIsHostConnected(hostId);
  const isVoiceInputPresented = voiceInput.presentation.statusLabel !== null;
  const editorLayout = useComposerEditorLayout(text);
  const isWorking = thread !== null && isTurnActive(thread.status);
  const willQueue = isWorking && settings?.followUp !== "steer";

  // Offline, the draft stays here rather than going nowhere; the page says why.
  const canSend =
    Boolean(text.trim()) &&
    isConnected &&
    !(target.thread === null && target.disabled) &&
    !voiceInput.isBusy;

  const modelId =
    (target.thread ? target.thread.model : target.model) ??
    (settings && findDefaultModel(providers, settings, provider));

  const model = providers
    .find((status) => status.kind === provider)
    ?.models.find((option) => option.id === modelId);

  function changePrefs(patch: Partial<TurnPrefs>) {
    const next = { ...prefs, ...patch };
    prefsByThread.set(prefsKey, next);
    setRemembered(next);
  }

  /** Sends the draft; while a turn runs, `followUp` overrides the setting for queueing or steering. */
  function submit(followUp?: FollowUp) {
    const message = text.trim();

    if (!canSend) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const options = { ...prefs, attachments: files.map((file) => file.input) };

    // A draft keeps its text and files until the thread exists, in case the host doesn't start it.
    if (target.thread === null) return target.onCreate(message, options);

    if (
      !send(
        hostId,
        ClientCommand.cases["thread.send"].make({
          threadId: target.thread.id,
          text: message,
          options,
          queue: followUp ? followUp === "queue" : willQueue,
          messageId: crypto.randomUUID(),
        }),
      )
    )
      return alertNotConnected(hostId);

    changeDraft("");
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

  async function attachPastedImages(uris: ReadonlyArray<string>) {
    try {
      addFiles(
        await Promise.all(
          uris.map(async (uri) => {
            const file = new File(uri);

            return {
              uri,
              name: "Pasted image.png",
              isImage: true,
              sizeBytes: file.size,
              input: AttachmentInput.cases.data.make({
                name: "Pasted image.png",
                mediaType: "image/png",
                data: await file.base64(),
              }),
            };
          }),
        ),
      );
    } catch {
      Alert.alert("Couldn't attach the pasted image", "Copy the image again, then paste it.");
    }
  }

  /** Text too big to paste inline goes as a text file, if it fits under the cap; else inline after all. */
  async function pasteText(paste: ComposerTextPaste) {
    const sizeBytes = new TextEncoder().encode(paste.text).byteLength;
    const usedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);

    if (usedBytes + sizeBytes > MAX_FILES_BYTES)
      return changeDraft(
        paste.value.slice(0, paste.selection.start) +
          paste.text +
          paste.value.slice(paste.selection.end),
        paste.selection.start + paste.text.length,
      );

    const name = nextPastedTextFileName(files.map((file) => file.name));
    const file = new File(Paths.cache, `${crypto.randomUUID()}.txt`);

    try {
      await file.write(paste.text);
      addFiles([
        {
          uri: file.uri,
          name,
          isImage: false,
          sizeBytes,
          input: AttachmentInput.cases.data.make({
            name,
            mediaType: "text/plain",
            data: await file.base64(),
          }),
        },
      ]);
    } catch {
      Alert.alert(
        "Couldn't attach the pasted text",
        "This phone may be out of storage. Free some space, then paste again.",
      );
    }
  }

  // `/` commands (threads only, as on the desktop), `$` skills and `@` files at the caret.
  const folder = target.thread ? target.thread.cwd : target.path;

  const detectedTrigger =
    selection.start === selection.end && !voiceInput.isBusy
      ? detectComposerTrigger(text, selection.end)
      : null;

  const trigger = detectedTrigger?.kind === "command" && !thread ? null : detectedTrigger;
  const triggerKind = trigger?.kind ?? null;
  const threadId = thread?.id ?? null;
  const repoFiles = useProjectStore((state) => state.files[hostId]?.[folder]);

  const commands = useThreadStore((state) =>
    threadId ? state.commands[hostId]?.[threadId] : undefined,
  );

  const skillList = useProviderStore(
    (state) => state.skills[hostId]?.[getSkillsKey(provider, folder)],
  );

  // Asked afresh each time a menu opens, so it shows what's there now.
  useEffect(() => {
    if (triggerKind === "command" && threadId)
      send(hostId, ClientCommand.cases["thread.listCommands"].make({ threadId }));
    else if (triggerKind === "skill")
      send(hostId, ClientCommand.cases["skills.list"].make({ provider, path: folder }));
    else if (triggerKind === "file")
      send(hostId, ClientCommand.cases["git.listFiles"].make({ path: folder }));
  }, [triggerKind, threadId, hostId, provider, folder]);

  /** Puts `token` in place of the word typed at the caret. */
  function insertToken(typedLength: number, token: string) {
    const replaced = replaceTypedWord(text, selection.end, typedLength, token);
    changeDraft(replaced.text, replaced.caret);
  }

  function getCommandMenu() {
    if (!trigger) return null;

    const query = trigger.query.toLowerCase();

    if (trigger.kind === "command") {
      const items: ReadonlyArray<ComposerCommandItem> = [
        {
          id: "compact",
          label: "/compact",
          description: "Summarize the conversation so far to free up context",
          onSelect: () => {
            if (!threadId) return;

            if (!send(hostId, ClientCommand.cases["thread.compact"].make({ threadId })))
              return alertNotConnected(hostId);

            changeDraft("");
          },
        },
        ...(commands ?? [])
          .filter((command) => command.name !== "compact" && command.name !== "btw")
          .map((command) => ({
            id: command.name,
            label: `/${command.name}`,
            description: command.description,
            onSelect: () => changeDraft(`/${command.name} `),
          })),
      ].filter((item) => item.id.toLowerCase().startsWith(query));

      return items.length > 0
        ? { title: "Commands", icon: "terminal" as const, items, emptyText: "" }
        : null;
    }

    if (trigger.kind === "skill") {
      const matches = (skillList?.skills ?? [])
        .filter((skill) => skill.name.toLowerCase().includes(query))
        .sort(
          (first, second) =>
            Number(!first.name.toLowerCase().startsWith(query)) -
            Number(!second.name.toLowerCase().startsWith(query)),
        );

      // Once a name is typed, no match means it's likely prose ("$HOME"), so the menu steps aside.
      if (skillList && query && matches.length === 0) return null;

      return {
        title: "Skills",
        icon: "cube" as const,
        items: matches.map((skill) => ({
          id: skill.name,
          label: `$${skill.name}`,
          description: skill.description,
          onSelect: () => insertToken(trigger.typedLength, `$${skill.name} `),
        })),
        emptyText: !skillList
          ? "Loading skills…"
          : skillList.error
            ? `${PROVIDER_NAME[provider]} couldn't list this project's skills. Check it works on the computer, then type $ again.`
            : `No skills here yet. Add one as ${SKILLS_FOLDER[provider]}/skills/<name>/SKILL.md in the project.`,
      };
    }

    return {
      title: "Files",
      icon: "doc" as const,
      items: matchFiles(repoFiles ?? [], query).map((path) => ({
        id: path,
        label: path.slice(path.lastIndexOf("/") + 1),
        description: path.slice(0, path.lastIndexOf("/") + 1),
        onSelect: () => insertToken(trigger.typedLength, formatFileMention(path)),
      })),
      emptyText: repoFiles ? "No matching files" : "Loading files…",
    };
  }

  const commandMenu = getCommandMenu();

  const queuedRows = thread?.queue?.map((queued) => (
    <View
      key={queued.id}
      className="flex-row items-center gap-2 rounded-xl border border-border bg-card pl-3"
    >
      <Text className="text-xs text-muted-foreground">Queued</Text>
      <Text numberOfLines={1} className="flex-1 text-sm">
        {queued.text}
      </Text>
      {/* A 24-point circle in a 44-point tap target. */}
      <Pressable
        accessibilityLabel="Take back this message"
        accessibilityState={{ disabled: !isConnected }}
        disabled={!isConnected}
        onPress={() => {
          if (
            send(
              hostId,
              ClientCommand.cases["thread.unqueue"].make({
                threadId: thread.id,
                messageIds: [queued.id],
              }),
            )
          )
            changeDraft(queued.text);
          else alertNotConnected(hostId);
        }}
        className={cn("size-11 items-center justify-center", !isConnected && "opacity-40")}
      >
        {({ pressed }) => (
          <View
            className={cn("size-6 items-center justify-center rounded-full", pressed && "bg-muted")}
          >
            <Icon name="xmark" className="size-3.5 text-muted-foreground" />
          </View>
        )}
      </Pressable>
    </View>
  ));

  const optionGroups: ReadonlyArray<ChoiceGroup> = [
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
      onChange: (picked) => changePrefs({ effort: Schema.is(Effort)(picked) ? picked : null }),
    },
    {
      title: "Permissions",
      value: prefs.permission,
      options: PERMISSIONS[provider].map((level) => ({
        value: level,
        label: PERMISSION_LABEL[level],
      })),
      onChange: (permission) =>
        Schema.is(PermissionLevel)(permission) && changePrefs({ permission }),
    },
  ];

  // A draft picks its model; a thread switches its own between turns.
  const settingsSession: ThreadSettingsSession = {
    ownerKey: `${hostId}/${prefsKey}`,
    hostId,
    model: modelId ? `${provider}:${modelId}` : null,
    onModelChange:
      target.thread === null
        ? (target.modelChoice?.onChange ?? null)
        : isWorking || !isConnected
          ? null
          : (picked) => {
              const [kind, ...modelParts] = picked.split(":");

              if (!Schema.is(ProviderKind)(kind)) return;

              send(
                hostId,
                ClientCommand.cases["thread.setModel"].make({
                  threadId: target.thread.id,
                  provider: kind,
                  model: modelParts.join(":"),
                }),
              );
            },
    options: optionGroups,
  };

  // The open sheet keeps reading this composer's choices as they change.
  useEffect(() => {
    if (useThreadSettings.getState().session?.ownerKey === settingsSession.ownerKey)
      useThreadSettings.setState({ session: settingsSession });
  });

  // A 30-point circle in a 44-point tap target.
  const sendButton =
    thread && isWorking && !text.trim() ? (
      <Pressable
        accessibilityLabel="Stop the agent"
        accessibilityState={{ disabled: !isConnected }}
        disabled={!isConnected}
        onPress={() => {
          if (!send(hostId, ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id })))
            return alertNotConnected(hostId);

          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }}
        className={cn(
          "size-11 items-center justify-center active:opacity-70",
          !isConnected && "opacity-40",
        )}
      >
        <View className="size-[30px] items-center justify-center rounded-full bg-destructive">
          <Icon
            name="stop.fill"
            weight="semibold"
            className="size-3.5 text-destructive-foreground"
          />
        </View>
      </Pressable>
    ) : (
      // While a turn runs, a long press picks the other follow-up: queue it, or steer the turn now.
      <MenuView
        shouldOpenOnLongPress
        actions={
          isWorking && canSend
            ? (["queue", "steer"] as const).map((followUp) => ({
                id: followUp,
                title: FOLLOW_UP[followUp].menuTitle,
                image: FOLLOW_UP[followUp].icon,
                state:
                  followUp === (willQueue ? "queue" : "steer") ? ("on" as const) : ("off" as const),
              }))
            : []
        }
        onPressAction={({ nativeEvent }) =>
          submit(nativeEvent.event === "queue" ? "queue" : "steer")
        }
      >
        <Pressable
          accessibilityLabel={
            isWorking ? FOLLOW_UP[willQueue ? "queue" : "steer"].label : "Send message"
          }
          accessibilityHint={isWorking ? "Long press to choose queue or steer" : undefined}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={() => submit()}
          className="size-11 items-center justify-center active:opacity-70"
        >
          <View
            className={cn(
              "size-[30px] items-center justify-center rounded-full",
              canSend ? "bg-primary" : "bg-foreground/10",
            )}
          >
            <Icon
              name={isWorking ? FOLLOW_UP[willQueue ? "queue" : "steer"].icon : "arrow.up"}
              weight="semibold"
              className={cn(
                "size-4",
                canSend ? "text-primary-foreground" : "text-muted-foreground",
              )}
            />
          </View>
        </Pressable>
      </MenuView>
    );

  return (
    // The padding stays put as the keyboard opens, since a change in height would scroll the
    // transcript; the pages lift the composer by less instead (useComposerKeyboardOffset).
    <View className="pb-safe gap-2 px-3 pt-1.5">
      {/* The transcript fades out behind the composer's top, and is hidden around the rest of it. */}
      <View
        pointerEvents="none"
        className="absolute inset-0 bg-linear-to-b from-background/0 via-background to-background"
      />
      {commandMenu ? <ComposerCommandMenu {...commandMenu} /> : null}
      {queuedRows}
      {/* Opaque, as Liquid Glass let the transcript show through the draft. */}
      <View className="shadow-composer-shadow overflow-hidden rounded-[27px] border border-border-strong bg-muted py-0.5 shadow-[0_6px_28px]">
        {files.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-1.5 px-2 pt-1.5 pb-1"
          >
            {files.map((file) => (
              <View
                key={file.uri}
                className="h-10 max-w-52 flex-row items-center gap-2 rounded-xl bg-foreground/5 pr-1 pl-1"
              >
                {file.isImage ? (
                  <Image source={{ uri: file.uri }} className="size-8 rounded-lg bg-background" />
                ) : (
                  <View className="size-8 items-center justify-center rounded-lg bg-background">
                    <Icon name="doc.text" className="size-4 text-muted-foreground" />
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
                  <Icon name="xmark" className="size-3.5 text-muted-foreground" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View onLayout={editorLayout.onRowLayout}>
          <ComposerDictationDraftContent
            className="flex-row items-end"
            hidden={isVoiceInputPresented}
          >
            <MenuView
              actions={[
                { id: "photos", title: "Photo Library", image: "photo" },
                { id: "files", title: "Choose Files", image: "folder" },
              ]}
              onPressAction={({ nativeEvent }) =>
                void (nativeEvent.event === "photos" ? pickPhotos() : pickDocuments())
              }
            >
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel="Add attachment"
                className="size-11 items-center justify-center"
              >
                <Icon name="plus" className="size-5" />
              </View>
            </MenuView>
            {/* Holds the field's place in the row; the field itself floats over it, so it keeps
                focus when it moves above the controls. */}
            <Animated.View
              onLayout={editorLayout.onSlotLayout}
              className={editorLayout.isExpanded ? "w-0 flex-none" : "min-w-[40%] flex-1"}
              style={editorLayout.rowStyle}
            />
            <View
              className={cn(
                "min-w-0 shrink flex-row items-center",
                editorLayout.isExpanded && "flex-1 justify-end",
              )}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Model, effort and permissions"
                onPress={() => {
                  useThreadSettings.setState({ session: settingsSession });
                  router.push("/thread-settings");
                }}
                className="h-11 max-w-[190px] shrink flex-row items-center gap-2 rounded-xl px-2 active:bg-foreground/5"
              >
                <ProviderLogo provider={provider} className="size-4 text-foreground" />
                {/* A draft on one line needs the room; the logo still says whose model it is. */}
                {text && !editorLayout.isExpanded ? null : (
                  <>
                    <Text numberOfLines={1} className="shrink text-sm font-medium">
                      {model?.label ?? PROVIDER_NAME[provider]}
                    </Text>
                    <Icon name="chevron.down" weight="semibold" className="size-2.5" />
                  </>
                )}
              </Pressable>
              <ComposerDictationStartAction
                state={voiceInput.state}
                isAvailable={voiceInput.isAvailable}
                onStart={voiceInput.start}
                onCancel={voiceInput.cancel}
              />
              {sendButton}
            </View>
          </ComposerDictationDraftContent>
          <Animated.View
            className={cn(isVoiceInputPresented && !editorLayout.isExpanded && "hidden")}
            style={editorLayout.editorStyle}
          >
            <ComposerEditor
              value={text}
              selection={selection}
              onChangeText={setText}
              onSelectionChange={setSelection}
              onContentSizeChange={editorLayout.onContentSizeChange}
              onPasteImages={(uris) => void attachPastedImages(uris)}
              onPasteText={(paste) => void pasteText(paste)}
              onSubmit={(alternate) =>
                submit(alternate && isWorking ? (willQueue ? "steer" : "queue") : undefined)
              }
              submitTitle={
                isWorking
                  ? `${FOLLOW_UP[willQueue ? "queue" : "steer"].label} Message`
                  : "Send Message"
              }
              alternateSubmitTitle={
                isWorking
                  ? `${FOLLOW_UP[willQueue ? "steer" : "queue"].label} Message`
                  : "Send Message"
              }
              readOnly={voiceInput.isBusy}
              scrollEnabled
              placeholder={willQueue ? "Queue a follow-up" : `Ask ${PROVIDER_NAME[provider]}…`}
              contentInsetVertical={COMPOSER_EDITOR_INSET}
              className="flex-1"
            />
          </Animated.View>
        </View>
        {/* Dictating, the controls flip over to these. */}
        <View
          accessibilityElementsHidden={!isVoiceInputPresented}
          pointerEvents={isVoiceInputPresented ? "auto" : "none"}
          className="absolute inset-x-0 bottom-0.5"
        >
          <ComposerDictationToolbar showsDictation visible={isVoiceInputPresented}>
            <ComposerDictationCancelAction
              presentation={voiceInput.presentation}
              onCancel={voiceInput.cancel}
            />
            <ComposerDictationStatus
              audioLevels={voiceInput.audioLevels}
              elapsedSeconds={voiceInput.elapsedSeconds}
              phase={voiceInput.state.phase}
              presentation={voiceInput.presentation}
              onDismissError={voiceInput.cancel}
            />
            <View className="shrink-0 flex-row items-center">
              <ComposerDictationPrimaryAction
                state={voiceInput.state}
                presentation={voiceInput.presentation}
                isAvailable={voiceInput.isAvailable}
                onStart={voiceInput.start}
                onConfirm={voiceInput.stop}
                onCancel={voiceInput.cancel}
              />
              {/* Stopping the agent stays at hand while dictating; sending waits for the text. */}
              {voiceInput.presentation.showsSend || (isWorking && !text.trim()) ? sendButton : null}
            </View>
          </ComposerDictationToolbar>
        </View>
      </View>
    </View>
  );
}
