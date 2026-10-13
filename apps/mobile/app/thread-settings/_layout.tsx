import { Stack } from "expo-router";

export default function ThreadSettingsLayout() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" }}>
      <Stack.Screen name="index" options={{ title: "Thread settings" }} />
      <Stack.Screen name="choice" options={{ title: "" }} />
    </Stack>
  );
}
