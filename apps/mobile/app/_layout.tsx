import "@/polyfills.ts";
import "../global.css";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { PortalHost } from "@rn-primitives/portal";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaListener } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

// The desktop's font, for the native headers too.
const FONTS = {
  regular: { fontFamily: "Figtree", fontWeight: "400" },
  medium: { fontFamily: "Figtree", fontWeight: "500" },
  bold: { fontFamily: "Figtree", fontWeight: "600" },
  heavy: { fontFamily: "Figtree", fontWeight: "700" },
} as const;

// The desktop's Vesper palette (global.css) for the native headers, which Tailwind can't reach.
const LIGHT = {
  ...DefaultTheme,
  fonts: FONTS,
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
  fonts: FONTS,
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
              <Stack.Screen name="index" options={{ title: "Threads", headerLargeTitle: true }} />
              <Stack.Screen name="hosts" options={{ title: "Computers" }} />
              <Stack.Screen
                name="pair"
                options={{ title: "Pair a computer", presentation: "modal" }}
              />
              <Stack.Screen name="thread/[hostId]/[threadId]" options={{ title: "" }} />
            </Stack>
            <PortalHost />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaListener>
    </GestureHandlerRootView>
  );
}
