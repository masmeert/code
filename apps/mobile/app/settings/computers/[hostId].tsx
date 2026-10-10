import { PROVIDER_NAME } from "@masscode/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { ComputerRow } from "@/components/ComputerRow.tsx";
import { ProviderLogo } from "@/components/ProviderLogo.tsx";
import { SettingsSection } from "@/components/SettingsList.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { reconnectHost, removeHost, useStore } from "@/lib/store.ts";

export default function ComputerScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useStore((state) => state.hosts[hostId]);

  if (!host)
    return (
      <View className="flex-1 bg-background p-4">
        <Text className="px-4 text-[15px] text-muted-foreground">
          This computer is no longer paired with this phone.
        </Text>
      </View>
    );

  const { paired, connection } = host;
  const canReconnect = connection !== "connected" && connection !== "off";

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 p-4"
    >
      <Stack.Screen options={{ title: paired.name }} />
      <SettingsSection title="Connection">
        <ComputerRow host={host} />
      </SettingsSection>
      <SettingsSection
        footer={`Forgetting stops this phone reaching ${paired.name}. To unpair it on the computer too, use Settings → Phone there.`}
      >
        <Pressable
          accessibilityRole="button"
          disabled={!canReconnect}
          onPress={() => reconnectHost(paired.id)}
          className={cn(
            "min-h-14 justify-center px-4 active:bg-muted",
            !canReconnect && "opacity-50",
          )}
        >
          <Text className="text-[17px] text-primary">Reconnect now</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            Alert.alert(`Forget ${paired.name}?`, "Pair again to use it from this phone.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Forget",
                style: "destructive",
                onPress: () => {
                  router.back();
                  removeHost(paired.id);
                },
              },
            ])
          }
          className="min-h-14 justify-center px-4 active:bg-muted"
        >
          <Text className="text-[17px] text-destructive">Forget computer</Text>
        </Pressable>
      </SettingsSection>
      {host.providers.length > 0 ? (
        <SettingsSection title="Providers">
          {host.providers.map((provider) => (
            <View key={provider.kind} className="min-h-14 flex-row items-center gap-3 px-4 py-3">
              <ProviderLogo provider={provider.kind} className="size-5" />
              <View className="flex-1 gap-0.5">
                <Text className="text-[17px]">{PROVIDER_NAME[provider.kind]}</Text>
                {provider.version || provider.plan ? (
                  <Text className="text-[13px] text-muted-foreground">
                    {[provider.version, provider.plan].filter(Boolean).join(" · ")}
                  </Text>
                ) : null}
                {provider.error ? (
                  <Text selectable className="text-[13px] leading-5 text-destructive">
                    {provider.error}
                  </Text>
                ) : null}
              </View>
              <Text numberOfLines={1} className="max-w-48 text-[15px] text-muted-foreground">
                {provider.checking
                  ? "Checking…"
                  : !provider.installed
                    ? "Not installed"
                    : provider.linked
                      ? (provider.account ?? "Signed in")
                      : "Signed out"}
              </Text>
            </View>
          ))}
        </SettingsSection>
      ) : null}
    </ScrollView>
  );
}
