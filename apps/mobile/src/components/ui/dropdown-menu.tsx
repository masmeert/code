import * as DropdownMenuPrimitive from "@rn-primitives/dropdown-menu";
import { Check } from "lucide-react-native";
import * as React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { FadeIn, ReduceMotion } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";
import { cn } from "@/lib/cn.ts";
import { Icon } from "./icon.tsx";
import { NativeOnlyAnimatedView } from "./native-only-animated-view.tsx";
import { TextClassContext } from "./text.tsx";

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

// Over the native header and modals too, which a plain portal sits under on iOS.
const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

/** The desktop's menu: a rounded popover card; tapping outside closes it. */
function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <FullWindowOverlay>
        <DropdownMenuPrimitive.Overlay style={StyleSheet.absoluteFill} asChild>
          <NativeOnlyAnimatedView
            entering={FadeIn.reduceMotion(ReduceMotion.System)}
            as="Pressable"
          >
            <TextClassContext.Provider value="text-foreground">
              <DropdownMenuPrimitive.Content
                className={cn(
                  "min-w-52 overflow-hidden rounded-xl border border-border-strong bg-popover p-1.5 shadow-lg shadow-black/10",
                  className,
                )}
                {...props}
              />
            </TextClassContext.Provider>
          </NativeOnlyAnimatedView>
        </DropdownMenuPrimitive.Overlay>
      </FullWindowOverlay>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  children?: React.ReactNode;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-foreground">
      <DropdownMenuPrimitive.RadioItem
        className={cn(
          "flex-row items-center gap-2 rounded-lg py-2 pr-8 pl-2 active:bg-muted",
          props.disabled && "opacity-50",
          className,
        )}
        {...props}
      >
        <>{children}</>
        <View className="absolute right-2 size-4 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <Icon as={Check} className="size-4 text-foreground" />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
      </DropdownMenuPrimitive.RadioItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <TextClassContext.Provider value="text-sm text-foreground">
      <DropdownMenuPrimitive.Item
        className={cn(
          "flex-row items-center gap-2.5 rounded-lg px-2 py-2 active:bg-muted",
          props.disabled && "opacity-50",
          className,
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
