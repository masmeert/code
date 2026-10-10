import { findDefaultModel, getVisibleModels } from "@masscode/client";
import { PROVIDER_NAME } from "@masscode/contracts";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Composer, PrefMenu } from "@/components/Composer.tsx";
import { ProjectBadge } from "@/components/ProjectBadge.tsx";
import { ProviderLogo } from "@/components/ProviderLogo.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { createThread, useStore } from "@/lib/store.ts";

export default function NewThreadScreen() {
  const hosts = useStore((state) => state.hosts);
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const stopWaiting = useRef<() => void>(null);

  useEffect(() => () => stopWaiting.current?.(), []);

  const hostList = Object.values(hosts);

  const host =
    hostList.find((candidate) => candidate.paired.id === pickedHostId) ??
    hostList.find((candidate) => candidate.connection === "connected") ??
    hostList[0];

  if (!host)
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        <Text className="text-center text-sm text-muted-foreground">
          Pair this phone with a computer first.
        </Text>
      </View>
    );

  const { settings, providers, projects } = host;

  const latestThread = Object.values(host.threads).sort(
    (left, right) => right.updatedAt - left.updatedAt,
  )[0];

  const project =
    projects.find((candidate) => candidate.path === pickedPath) ??
    projects.find((candidate) => candidate.id === latestThread?.projectId) ??
    projects[0];

  const choices = providers.flatMap((status) =>
    status.linked && settings
      ? getVisibleModels(status.models, settings.providers[status.kind]).map((model) => ({
          value: `${status.kind}:${model.id}`,
          label: model.label,
          description: PROVIDER_NAME[status.kind],
          provider: status.kind,
          model: model.id,
        }))
      : [],
  );

  const lastModel = settings && findDefaultModel(providers, settings, settings.lastProvider);

  const choice =
    [pickedModel, settings?.newThreadModel, settings && `${settings.lastProvider}:${lastModel}`]
      .map((value) => choices.find((option) => option.value === value))
      .find(Boolean) ?? choices[0];

  const isConnected = host.connection === "connected";

  function getNotice() {
    if (!isConnected)
      return `Not connected to ${host?.paired.name}. Check it's awake with MassCode open.`;

    if (startError) return startError;

    if (!projects.length) return "Add a project in MassCode on your computer to start a thread.";

    if (!choice) return "Link a harness in MassCode's Settings on your computer to start a thread.";

    return null;
  }

  const notice = getNotice();

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-1 px-3 pt-3 pb-48"
      >
        {hostList.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2 grow-0">
            <View className="flex-row gap-1.5 px-1">
              {hostList.map((candidate) => (
                <Pressable
                  key={candidate.paired.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: candidate === host }}
                  onPress={() => {
                    setPickedHostId(candidate.paired.id);
                    setPickedPath(null);
                    setPickedModel(null);
                  }}
                  className={cn(
                    "h-8 justify-center rounded-full border px-3",
                    candidate === host ? "border-primary bg-primary" : "border-border bg-card",
                  )}
                >
                  <Text className={cn("text-xs", candidate === host && "text-primary-foreground")}>
                    {candidate.paired.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : null}
        <Text className="px-2 pb-1 text-xs font-medium text-muted-foreground">Project</Text>
        {projects.map((candidate) => (
          <Pressable
            key={candidate.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: candidate === project }}
            onPress={() => setPickedPath(candidate.path)}
            className={cn(
              "flex-row items-center gap-2.5 rounded-xl px-3 py-2.5 active:bg-muted",
              candidate === project && "bg-card",
            )}
          >
            <ProjectBadge project={candidate} />
            <Text
              numberOfLines={1}
              className={cn("flex-1 text-[15px]", candidate === project && "font-semibold")}
            >
              {candidate.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0">
        <KeyboardStickyView>
          <View className="bg-background">
            {isStarting ? (
              <View className="flex-row items-center justify-center gap-2 px-4 pt-2">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-muted-foreground">Starting the thread…</Text>
              </View>
            ) : notice ? (
              <Text className="px-4 pt-2 text-center text-xs text-warning">{notice}</Text>
            ) : null}
            <Composer
              hostId={host.paired.id}
              settings={settings}
              providers={providers}
              thread={null}
              provider={choice?.provider ?? settings?.lastProvider ?? "claude"}
              model={choice?.model ?? null}
              disabled={!isConnected || !project || !choice || isStarting}
              modelMenu={
                choice ? (
                  <PrefMenu
                    title="Model"
                    value={choice.value}
                    options={choices}
                    onChange={setPickedModel}
                  >
                    <ProviderLogo provider={choice.provider} className="size-3.5 text-foreground" />
                    <Text numberOfLines={1} className="shrink text-xs">
                      {choice.label}
                    </Text>
                  </PrefMenu>
                ) : null
              }
              onCreate={(text, options) => {
                if (!project || !choice) return;

                const hostId = host.paired.id;
                setIsStarting(true);
                setStartError(null);

                // The host's masscode.toml, else its Settings, decides whether it's a worktree.
                stopWaiting.current = createThread(
                  hostId,
                  {
                    path: project.path,
                    provider: choice.provider,
                    model: choice.model,
                    text,
                    options,
                  },
                  {
                    onCreated: (threadId) => router.replace(`/thread/${hostId}/${threadId}`),
                    onFailed: (message) => {
                      setIsStarting(false);
                      setStartError(message);
                    },
                  },
                );
              }}
            />
          </View>
        </KeyboardStickyView>
      </View>
    </View>
  );
}
