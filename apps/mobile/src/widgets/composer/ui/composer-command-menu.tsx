import type { SFSymbol } from "expo-symbols";
import { Pressable, ScrollView, View } from "react-native";
import { cn } from "@/shared/lib/cn";
import { Icon, Text } from "@/shared/ui";

export interface ComposerCommandItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly onSelect: () => void;
}

/** Matches for the `/`, `$` or `@` word at the caret, floating above the composer; a tap inserts one. */
export function ComposerCommandMenu({
  title,
  icon,
  items,
  emptyText,
}: {
  title: string;
  icon: SFSymbol;
  items: ReadonlyArray<ComposerCommandItem>;
  /** Shown instead of rows when nothing matches, or while matches load. */
  emptyText: string;
}) {
  return (
    <View className="absolute inset-x-3 bottom-full z-10 mb-2">
      <View className="shadow-composer-shadow overflow-hidden rounded-2xl border border-border-strong bg-muted shadow-[0_6px_28px]">
        <Text className="px-3.5 pt-2.5 pb-1 text-[10px] font-bold tracking-[0.8px] text-muted-foreground uppercase">
          {title}
        </Text>
        {items.length > 0 ? (
          <ScrollView
            className="max-h-[180px]"
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {items.map((item, index) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityHint={item.description || undefined}
                onPress={item.onSelect}
                className={cn(
                  "flex-row items-center gap-2.5 px-3.5 py-2.5 active:opacity-60",
                  index < items.length - 1 && "border-b-[0.5px] border-border-strong",
                )}
              >
                <Icon name={icon} className="size-3.5 text-muted-foreground" />
                <Text numberOfLines={1} className="shrink-0 font-medium">
                  {item.label}
                </Text>
                {item.description ? (
                  <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {item.description}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text className="px-3.5 py-2.5 text-xs text-muted-foreground">{emptyText}</Text>
        )}
      </View>
    </View>
  );
}
