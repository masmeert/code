import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { Alert, ScrollView, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { type HostConnection, removeHost, useStore } from "@/lib/store.ts";

const CONNECTION_LABEL: Record<HostConnection, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  offline:
    "Can't reach it. Check it's awake with MassCode open, and Tailscale is on here and there.",
  unpaired: "This computer unpaired the phone. Forget it, then pair again.",
  outdated: "This app and MassCode on that computer are different versions. Update the older one.",
};

const CONNECTION_DOT: Record<HostConnection, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  offline: "bg-destructive",
  unpaired: "bg-destructive",
  outdated: "bg-destructive",
};

export default function HostsScreen() {
  const hosts = useStore((state) => state.hosts);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-4"
    >
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        {Object.values(hosts).map(({ paired: host, connection }, index) => (
          <View
            key={host.id}
            className={cn(
              "flex-row items-center gap-3 py-3 pr-2 pl-4",
              index > 0 && "border-t border-border",
            )}
          >
            <View className={cn("size-2 rounded-full", CONNECTION_DOT[connection])} />
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-medium">{host.name}</Text>
              <Text className="text-xs leading-5 text-muted-foreground">
                {host.dnsName ?? host.address} · {CONNECTION_LABEL[connection]}
              </Text>
            </View>
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                Alert.alert(
                  `Forget ${host.name}?`,
                  "This phone stops reaching it. To unpair it on the computer too, use Settings → Phone there.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Forget",
                      style: "destructive",
                      onPress: () => void removeHost(host.id),
                    },
                  ],
                )
              }
            >
              <Text className="text-destructive">Forget</Text>
            </Button>
          </View>
        ))}
        {Object.keys(hosts).length === 0 ? (
          <Text className="px-4 py-3 text-sm text-muted-foreground">No computers paired yet.</Text>
        ) : null}
      </View>
      <Button variant="secondary" onPress={() => router.push("/pair")}>
        <Icon as={Plus} className="size-4" />
        <Text>Pair a computer</Text>
      </Button>
    </ScrollView>
  );
}
