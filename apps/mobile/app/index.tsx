import { PROTOCOL_VERSION } from "@masscode/contracts";
import { Text, View } from "react-native";

export default function Home() {
  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-black">
      <Text className="text-base text-black dark:text-white">
        MassCode protocol v{PROTOCOL_VERSION}
      </Text>
    </View>
  );
}
