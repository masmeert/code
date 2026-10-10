import { Archive, Laptop, MessageSquarePlus, SlidersHorizontal } from "lucide-react-native";
import { ScrollView } from "react-native";
import {
  SettingsLinkRow,
  SettingsScopeHeader,
  SettingsSection,
} from "@/components/SettingsList.tsx";
import { useSettingsScope } from "@/lib/settings-scope.ts";
import { useStore } from "@/lib/store.ts";

export default function SettingsScreen() {
  const hosts = useStore((state) => state.hosts);
  const hostList = Object.values(hosts);
  const { targets } = useSettingsScope();

  const archivedCount = hostList.reduce(
    (count, host) =>
      count + Object.values(host.threads).filter((thread) => thread.archivedAt !== null).length,
    0,
  );

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 p-4"
    >
      <SettingsScopeHeader closeSettings />
      <SettingsSection title="Connections">
        <SettingsLinkRow
          icon={Laptop}
          label="Computers"
          value={String(hostList.length)}
          href="/settings/computers"
        />
      </SettingsSection>
      <SettingsSection title="Threads">
        <SettingsLinkRow
          icon={Archive}
          label="Archived threads"
          value={archivedCount ? String(archivedCount) : undefined}
          href="/settings/archived"
        />
      </SettingsSection>
      <SettingsSection
        title="Computer settings"
        footer={
          targets.length === 0
            ? "Connect to a computer to change its settings."
            : `Saved on ${targets.map((host) => host.paired.name).join(", ")}, so ${targets.length === 1 ? "its desktop uses" : "their desktops use"} them too.`
        }
      >
        <SettingsLinkRow
          icon={MessageSquarePlus}
          label="New threads"
          disabled={targets.length === 0}
          href="/settings/new-threads"
        />
        <SettingsLinkRow
          icon={SlidersHorizontal}
          label="Thread behavior"
          disabled={targets.length === 0}
          href="/settings/behavior"
        />
      </SettingsSection>
    </ScrollView>
  );
}
