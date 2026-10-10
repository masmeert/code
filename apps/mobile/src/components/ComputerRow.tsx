import { ChevronRight, Laptop } from "lucide-react-native";
import { Pressable, Switch, View } from "react-native";
import { cn } from "@/lib/cn.ts";
import { type HostConnection, type HostState, setHostEnabled } from "@/lib/store.ts";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

const CONNECTION_LABEL: Record<HostConnection, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  offline:
    "Can't reach it. Check it's awake with MassCode open, and Tailscale is on here and there.",
  unpaired: "This computer unpaired the phone. Forget it, then pair again.",
  outdated: "This app and MassCode on that computer are different versions. Update the older one.",
  off: "Off",
};

const CONNECTION_DOT: Record<HostConnection, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  offline: "bg-destructive",
  unpaired: "bg-destructive",
  outdated: "bg-destructive",
  off: "bg-muted-foreground",
};

/** A paired computer with its connection and the switch that turns it off; `onPress` adds a chevron. */
export function ComputerRow({ host, onPress }: { host: HostState; onPress?: () => void }) {
  const { paired, connection } = host;

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `Manage ${paired.name}` : undefined}
      disabled={!onPress}
      onPress={onPress}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <View className={cn("size-2 rounded-full", CONNECTION_DOT[connection])} />
          <Icon as={Laptop} className="size-3.5 text-muted-foreground" />
          <Text numberOfLines={1} className="shrink text-[17px] font-semibold">
            {paired.name}
          </Text>
        </View>
        <Text selectable numberOfLines={1} className="text-[13px] text-muted-foreground">
          {paired.dnsName ?? paired.address}
        </Text>
        <Text
          className={cn(
            "text-[13px] leading-5",
            connection === "connected" || connection === "connecting" || connection === "off"
              ? "text-muted-foreground"
              : "text-destructive",
          )}
        >
          {CONNECTION_LABEL[connection]}
        </Text>
      </View>
      <Switch
        accessibilityLabel={`Connect to ${paired.name}`}
        value={connection !== "off"}
        onValueChange={(enabled) => setHostEnabled(paired.id, enabled)}
      />
      {onPress ? <Icon as={ChevronRight} className="size-4 text-muted-foreground" /> : null}
    </Pressable>
  );
}
