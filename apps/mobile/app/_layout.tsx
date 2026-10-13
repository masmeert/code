import { AppProviders } from "@/app";
import "../global.css";
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <AppProviders>
      <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Screen name="index" options={{ title: "Threads" }} />
        <Stack.Screen name="settings" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="pair" options={{ title: "Pair a computer", presentation: "modal" }} />
        <Stack.Screen name="new" options={{ title: "Choose project", presentation: "modal" }} />
        <Stack.Screen name="thread/[hostId]/[threadId]" options={{ title: "" }} />
        <Stack.Screen name="thread/[hostId]/new" options={{ title: "" }} />
        <Stack.Screen
          name="thread-settings"
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
          }}
        />
      </Stack>
    </AppProviders>
  );
}
