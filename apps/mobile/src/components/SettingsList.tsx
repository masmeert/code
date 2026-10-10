import { type Href, Link, router, Stack } from "expo-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
  ListFilter,
  ListFilterPlus,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { cn } from "@/lib/cn.ts";
import { useSettingsScope } from "@/lib/settings-scope.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

/** Picks which connected computers the settings screens edit, once there's more than one. */
export function SettingsScopeHeader({ closeSettings }: { closeSettings?: boolean }) {
  const { available, selectedIds, selectAll, toggle } = useSettingsScope();
  const hasChoice = available.length > 1;

  if (Platform.OS === "ios")
    return hasChoice || closeSettings ? (
      <Stack.Toolbar placement="right">
        {hasChoice ? (
          <Stack.Toolbar.Menu
            icon={
              selectedIds === null
                ? "line.3.horizontal.decrease"
                : "line.3.horizontal.decrease.circle.fill"
            }
            accessibilityLabel="Choose which computers to change"
            title="Change settings on"
          >
            <Stack.Toolbar.MenuAction isOn={selectedIds === null} onPress={selectAll}>
              All connected computers
            </Stack.Toolbar.MenuAction>
            {available.map((host) => (
              <Stack.Toolbar.MenuAction
                key={host.paired.id}
                icon="laptopcomputer"
                subtitle={host.paired.dnsName ?? host.paired.address}
                isOn={selectedIds === null || selectedIds.has(host.paired.id)}
                onPress={() => toggle(host.paired.id)}
              >
                {host.paired.name}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : null}
        {closeSettings ? (
          <Stack.Toolbar.Button
            icon="xmark"
            accessibilityLabel="Close"
            onPress={() => router.back()}
          />
        ) : null}
      </Stack.Toolbar>
    ) : null;

  return (
    <Stack.Screen
      options={{
        headerRight: hasChoice
          ? () => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Pressable
                    accessibilityLabel="Choose which computers to change"
                    hitSlop={12}
                    className="size-9 items-center justify-center"
                  >
                    <Icon
                      as={selectedIds === null ? ListFilter : ListFilterPlus}
                      className="size-5 text-foreground"
                    />
                  </Pressable>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} insets={{ right: 16 }}>
                  <DropdownMenuLabel>Change settings on</DropdownMenuLabel>
                  {[
                    {
                      id: null,
                      name: "All connected computers",
                      isOn: selectedIds === null,
                    },
                    ...available.map((host) => ({
                      id: host.paired.id,
                      name: host.paired.name,
                      isOn: selectedIds === null || selectedIds.has(host.paired.id),
                    })),
                  ].map((item) => (
                    <DropdownMenuItem
                      key={item.id ?? "all"}
                      onPress={() => (item.id === null ? selectAll() : toggle(item.id))}
                    >
                      <Text className="flex-1 text-sm">{item.name}</Text>
                      {item.isOn ? <Icon as={Check} className="size-4 text-foreground" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          : undefined,
      }}
    />
  );
}

/** A titled group of rows on one rounded card, as iOS Settings lays them out. */
export function SettingsSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {title ? <Text className="px-4 text-[13px] text-muted-foreground">{title}</Text> : null}
      <View className="overflow-hidden rounded-2xl bg-card">{children}</View>
      {footer ? (
        <Text className="px-4 text-[13px] leading-5 text-muted-foreground">{footer}</Text>
      ) : null}
    </View>
  );
}

export function SettingsLinkRow({
  icon,
  label,
  value,
  href,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  href: Href;
  disabled?: boolean;
}) {
  return (
    <Link href={href} asChild disabled={disabled}>
      <Pressable
        className={cn(
          "min-h-14 flex-row items-center gap-3 px-4 active:bg-muted",
          disabled && "opacity-50",
        )}
      >
        <Icon as={icon} className="size-5 text-foreground" />
        <Text numberOfLines={1} className="flex-1 text-[17px]">
          {label}
        </Text>
        {value ? <Text className="text-[15px] text-muted-foreground">{value}</Text> : null}
        <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
      </Pressable>
    </Link>
  );
}

/** A row whose value opens a menu of the choices; a null value is computers that differ. */
export function SettingsChoiceRow<Value extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description?: string;
  value: Value | null;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
        >
          <View className="flex-1 gap-0.5">
            <Text className="text-[17px]">{label}</Text>
            {description ? (
              <Text className="text-[13px] leading-5 text-muted-foreground">{description}</Text>
            ) : null}
          </View>
          <Text
            numberOfLines={1}
            accessibilityLabel={
              value === null ? "The selected computers use different values" : undefined
            }
            className="max-w-40 text-[15px] text-muted-foreground"
          >
            {value === null ? "Mixed" : options.find((option) => option.value === value)?.label}
          </Text>
          <Icon as={ChevronDown} className="size-4 text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} insets={{ right: 16 }} className="max-h-96">
        <ScrollView bounces={false}>
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={(chosen) => {
              const option = options.find((candidate) => candidate.value === chosen);

              if (option) onChange(option.value);
            }}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} closeOnPress>
                <Text className="text-[15px]">{option.label}</Text>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </ScrollView>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
