import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
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

export function AppProviders({ children }: { children: ReactNode }) {
  const isDark = useColorScheme() === "dark";

  return (
    <GestureHandlerRootView>
      {/* Uniwind's safe-area classes (pb-safe…) read the insets it's handed here. */}
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <KeyboardProvider>
          <ThemeProvider value={isDark ? DARK : LIGHT}>
            <StatusBar style="auto" />
            {children}
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaListener>
    </GestureHandlerRootView>
  );
}
