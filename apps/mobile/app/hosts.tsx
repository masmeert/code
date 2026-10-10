import { router, Stack } from "expo-router";
import { Laptop, Plus } from "lucide-react-native";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
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

function confirmForget(id: string, name: string) {
  Alert.alert(
    `Forget ${name}?`,
    "This phone stops reaching it. To unpair it on the computer too, use Settings → Phone there.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => removeHost(id) },
    ],
  );
}

export default function HostsScreen() {
  const hosts = useStore((state) => state.hosts);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-2 p-4"
    >
      {Platform.OS === "ios" ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button
              icon="xmark"
              accessibilityLabel="Close"
              onPress={() => router.back()}
            />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              icon="plus"
              accessibilityLabel="Pair a computer"
              onPress={() => router.push("/pair")}
            />
          </Stack.Toolbar>
        </>
      ) : null}
      <Text className="px-4 text-[13px] text-muted-foreground">Computers</Text>
      {Object.values(hosts).map(({ paired: host, connection }) => (
        <View
          key={host.id}
          className="flex-row items-center gap-3 rounded-2xl bg-card py-4 pr-2 pl-4"
        >
          <View className="flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <View className={cn("size-2 rounded-full", CONNECTION_DOT[connection])} />
              <Icon as={Laptop} className="size-4 text-muted-foreground" />
              <Text className="text-[17px] font-semibold">{host.name}</Text>
            </View>
            <Text selectable className="text-[13px] text-muted-foreground">
              {host.dnsName ?? host.address}
            </Text>
            <Text
              className={cn(
                "text-[13px] leading-5",
                connection === "connected" ? "text-muted-foreground" : "text-warning",
              )}
            >
              {CONNECTION_LABEL[connection]}
            </Text>
          </View>
          <Button size="sm" variant="ghost" onPress={() => confirmForget(host.id, host.name)}>
            <Text className="text-destructive">Forget</Text>
          </Button>
        </View>
      ))}
      {Object.keys(hosts).length === 0 ? (
        <Pressable
          onPress={() => router.push("/pair")}
          className="items-center gap-1 rounded-2xl bg-card px-4 py-6 active:bg-muted"
        >
          <Text className="text-[15px] font-semibold">No computers paired yet</Text>
          <Text className="text-[13px] text-muted-foreground">Tap to pair one.</Text>
        </Pressable>
      ) : null}
      <Text className="px-4 pt-1 text-[13px] leading-5 text-muted-foreground">
        Pair this phone from MassCode on your computer, in Settings → Phone. It reaches the computer
        over Tailscale.
      </Text>
      {/* Android drops SF Symbols, so it gets no header plus; this stands in. */}
      {Platform.OS === "ios" ? null : (
        <Button variant="secondary" className="mt-2" onPress={() => router.push("/pair")}>
          <Icon as={Plus} className="size-4" />
          <Text>Pair a computer</Text>
        </Button>
      )}
    </ScrollView>
  );
}
