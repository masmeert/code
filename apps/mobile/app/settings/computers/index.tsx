import { router, Stack } from "expo-router";
import { Laptop, Plus } from "lucide-react-native";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ComputerRow } from "@/components/ComputerRow.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useStore } from "@/lib/store.ts";

export default function ComputersScreen() {
  const hosts = useStore((state) => state.hosts);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-2 p-4"
    >
      {Platform.OS === "ios" ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="plus"
            accessibilityLabel="Pair a computer"
            onPress={() => router.push("/pair")}
          />
        </Stack.Toolbar>
      ) : null}
      {Object.keys(hosts).length === 0 ? (
        <Pressable
          onPress={() => router.push("/pair")}
          className="items-center gap-3 rounded-2xl bg-card px-6 py-8 active:bg-muted"
        >
          <View className="size-12 items-center justify-center rounded-2xl bg-muted">
            <Icon as={Laptop} className="size-5 text-muted-foreground" />
          </View>
          <Text className="text-center text-sm leading-5 text-muted-foreground">
            No computers paired yet.{"\n"}Tap to pair one.
          </Text>
        </Pressable>
      ) : (
        <View className="overflow-hidden rounded-2xl bg-card">
          {Object.values(hosts).map((host) => (
            <ComputerRow
              key={host.paired.id}
              host={host}
              onPress={() =>
                router.push({
                  pathname: "/settings/computers/[hostId]",
                  params: { hostId: host.paired.id },
                })
              }
            />
          ))}
        </View>
      )}
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
