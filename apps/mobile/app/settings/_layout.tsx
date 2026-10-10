import { Stack } from "expo-router";

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen name="computers/index" options={{ title: "Computers" }} />
      <Stack.Screen name="computers/[hostId]" options={{ title: "" }} />
      <Stack.Screen name="archived" options={{ title: "Archived threads" }} />
      <Stack.Screen name="new-threads" options={{ title: "New threads" }} />
      <Stack.Screen name="behavior" options={{ title: "Thread behavior" }} />
    </Stack>
  );
}
