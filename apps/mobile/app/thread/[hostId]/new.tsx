import { findDefaultModel, getProjectKey, getVisibleModels } from "@masscode/client";
import { PROVIDER_NAME } from "@masscode/contracts";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Composer } from "@/components/Composer.tsx";
import { ThreadHeader } from "@/components/ThreadHeader.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { createThread, useStore } from "@/lib/store.ts";

export default function NewThreadScreen() {
  const { hostId, path } = useLocalSearchParams<{ hostId: string; path: string }>();
  const hosts = useStore((state) => state.hosts);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const stopWaiting = useRef<() => void>(null);

  useEffect(() => () => stopWaiting.current?.(), []);

  const host = hosts[hostId];
  const project = host?.projects.find((candidate) => candidate.path === path);

  if (!host || !project)
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        <Text className="text-center text-sm text-muted-foreground">
          This project is no longer on that computer. Go back and choose another.
        </Text>
      </View>
    );

  const { settings, providers } = host;

  // The same repo on the other computers, to start it on one of those instead.
  const copies = Object.values(hosts).flatMap((candidate) =>
    candidate.connection === "off"
      ? []
      : candidate.projects
          .filter((other) => getProjectKey(other) === getProjectKey(project))
          .map((other) => ({ host: candidate, project: other })),
  );

  const choices = providers.flatMap((status) =>
    status.linked && settings
      ? getVisibleModels(status.models, settings.providers[status.kind]).map((model) => ({
          value: `${status.kind}:${model.id}`,
          label: model.label,
          section: PROVIDER_NAME[status.kind],
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

    if (!choice) return "Link a harness in MassCode's Settings on your computer to start a thread.";

    return null;
  }

  const notice = getNotice();

  return (
    <View className="flex-1 bg-background">
      <ThreadHeader title="New thread" project={project} hostName={host.paired.name} />
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0">
        <KeyboardStickyView>
          <View>
            {copies.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} className="grow-0 pt-2">
                <View className="flex-row gap-1.5 px-4">
                  {copies.map((copy) => (
                    <Pressable
                      key={copy.host.paired.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: copy.host === host }}
                      onPress={() => {
                        router.setParams({ hostId: copy.host.paired.id, path: copy.project.path });
                        setPickedModel(null);
                      }}
                      className={cn(
                        "h-8 justify-center rounded-full border px-3",
                        copy.host === host ? "border-primary bg-primary" : "border-border bg-card",
                      )}
                    >
                      <Text
                        className={cn("text-xs", copy.host === host && "text-primary-foreground")}
                      >
                        {copy.host.paired.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            ) : null}
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
              path={project.path}
              provider={choice?.provider ?? settings?.lastProvider ?? "claude"}
              model={choice?.model ?? null}
              disabled={!isConnected || !choice || isStarting}
              modelChoice={choice ? { value: choice.value, onChange: setPickedModel } : null}
              onCreate={(text, options) => {
                if (!choice) return;

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
