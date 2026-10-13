import "@/polyfills.ts";
import "../global.css";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaListener } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

// The desktop's Vesper palette (global.css) for the native headers, which Tailwind can't reach.
const LIGHT = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: "#a8642f",
    background: "#fcfcfc",
    card: "#fcfcfc",
    text: "#111111",
    border: "rgba(17, 17, 17, 0.06)",
  },
};

const DARK = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: "#ffc799",
    background: "#101010",
    card: "#101010",
    text: "#ffffff",
    border: "rgba(255, 255, 255, 0.05)",
  },
};

export default function RootLayout() {
  const isDark = useColorScheme() === "dark";

  return (
    <GestureHandlerRootView>
      {/* Uniwind's safe-area classes (pb-safe…) read the insets it's handed here. */}
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <KeyboardProvider>
          <ThemeProvider value={isDark ? DARK : LIGHT}>
            <StatusBar style="auto" />
            <Stack
              screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" }}
            >
              <Stack.Screen name="index" options={{ title: "Threads" }} />
              <Stack.Screen
                name="settings"
                options={{ headerShown: false, presentation: "modal" }}
              />
              <Stack.Screen
                name="pair"
                options={{ title: "Pair a computer", presentation: "modal" }}
              />
              <Stack.Screen
                name="new"
                options={{ title: "Choose project", presentation: "modal" }}
              />
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
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaListener>
    </GestureHandlerRootView>
  );
}
