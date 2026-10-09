import { router } from "expo-router";
import { Button } from "heroui-native";
import { Alert, ScrollView, Text, View } from "react-native";
import { type MacConnection, removeMac, useStore } from "../src/lib/store.ts";

const CONNECTION_LABEL: Record<MacConnection, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  offline:
    "Can't reach it. Check it's awake with MassCode open, and Tailscale is on here and there.",
  unpaired: "This Mac unpaired the phone. Forget it, then pair again.",
  outdated: "This app and MassCode on the Mac are different versions. Update the older one.",
};

const CONNECTION_DOT: Record<MacConnection, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  offline: "bg-danger",
  unpaired: "bg-danger",
  outdated: "bg-danger",
};

export default function MacsScreen() {
  const macs = useStore((state) => state.macs);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-5">
      <View className="bg-surface overflow-hidden rounded-2xl">
        {Object.values(macs).map(({ mac, connection }, index) => (
          <View key={mac.id} className={index > 0 ? "border-separator border-t" : ""}>
            <View className="flex-row items-center gap-3 px-4 py-3">
              <View className={`size-2 rounded-full ${CONNECTION_DOT[connection]}`} />
              <View className="flex-1">
                <Text className="text-[16px] text-foreground">{mac.name}</Text>
                <Text className="text-[13px] text-muted">
                  {mac.host} · {CONNECTION_LABEL[connection]}
                </Text>
              </View>
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  Alert.alert(
                    `Forget ${mac.name}?`,
                    "This phone stops reaching it. To unpair it on the Mac too, use Settings → Phone there.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Forget",
                        style: "destructive",
                        onPress: () => void removeMac(mac.id),
                      },
                    ],
                  )
                }
              >
                Forget
              </Button>
            </View>
          </View>
        ))}
        {Object.keys(macs).length === 0 ? (
          <Text className="px-4 py-3 text-[15px] text-muted">No Macs paired yet.</Text>
        ) : null}
      </View>
      <Button variant="secondary" onPress={() => router.push("/pair")}>
        Pair a Mac
      </Button>
    </ScrollView>
  );
}
