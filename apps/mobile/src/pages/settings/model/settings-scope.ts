import { ClientCommand, type Settings } from "@masscode/contracts";
import { create } from "zustand";
import { type HostState, useHostStore } from "@/entities/host";
import { send } from "@/shared/api";

export type SettingsTarget = HostState & { readonly settings: Settings };

/** The computers the settings screens edit; null is every connected one, including ones paired later. */
const useSelection = create<{ selectedIds: ReadonlySet<string> | null }>(() => ({
  selectedIds: null,
}));

export function useSettingsScope() {
  const hosts = useHostStore((state) => state.hosts);
  const selectedIds = useSelection((state) => state.selectedIds);

  const available = Object.values(hosts).filter(
    (host): host is SettingsTarget => host.connection === "connected" && host.settings !== null,
  );

  return {
    available,
    targets: available.filter((host) => selectedIds === null || selectedIds.has(host.paired.id)),
    selectedIds,
    selectAll: () => useSelection.setState({ selectedIds: null }),
    toggle: (hostId: string) =>
      useSelection.setState(({ selectedIds: current }) => {
        const ids = available.map((host) => host.paired.id);
        const next = new Set(ids.filter((id) => current === null || current.has(id)));

        if (next.has(hostId)) next.delete(hostId);
        else next.add(hostId);

        // Unticking the last one would leave nothing to edit.
        if (next.size === 0) return { selectedIds: current };

        return { selectedIds: ids.every((id) => next.has(id)) ? null : next };
      }),
  };
}

export function updateSettings(targets: ReadonlyArray<SettingsTarget>, changes: Partial<Settings>) {
  for (const host of targets)
    send(
      host.paired.id,
      ClientCommand.cases["settings.update"].make({
        settings: { ...host.settings, ...changes },
      }),
    );
}

/** The value every target shares, or null when they differ. */
export function uniformSetting<Value>(
  targets: ReadonlyArray<SettingsTarget>,
  read: (host: SettingsTarget) => Value,
): Value | null {
  const values = targets.map(read);

  return values.every((value) => value === values[0]) ? (values[0] ?? null) : null;
}
