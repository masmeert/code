import "../src/polyfills.ts";
import "../global.css";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

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
      <KeyboardProvider>
        <HeroUINativeProvider>
          <ThemeProvider value={isDark ? DARK : LIGHT}>
            <StatusBar style="auto" />
            <Stack
              screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" }}
            >
              <Stack.Screen name="index" options={{ title: "Threads" }} />
              <Stack.Screen name="macs" options={{ title: "Macs" }} />
              <Stack.Screen name="pair" options={{ title: "Pair a Mac", presentation: "modal" }} />
              <Stack.Screen name="thread/[macId]/[threadId]" options={{ title: "" }} />
            </Stack>
          </ThemeProvider>
        </HeroUINativeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
