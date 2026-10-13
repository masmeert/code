import type { ComponentProps } from "react";
import { Text as RNText } from "react-native";
import { cn } from "@/lib/cn.ts";

/** React Native's `Text` in the app's font and color, which `className` adds to. */
export function Text({ className, ...props }: ComponentProps<typeof RNText>) {
  return <RNText className={cn("font-sans text-base text-foreground", className)} {...props} />;
}
