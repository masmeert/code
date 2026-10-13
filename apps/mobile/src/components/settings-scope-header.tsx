import { router, Stack } from "expo-router";
import { useSettingsScope } from "@/lib/settings-scope.ts";

/** Picks which connected computers the settings screens edit, once there's more than one. */
export function SettingsScopeHeader({ closeSettings }: { closeSettings?: boolean }) {
  const { available, selectedIds, selectAll, toggle } = useSettingsScope();
  const hasChoice = available.length > 1;

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
}
