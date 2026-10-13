import { router } from "expo-router";
import { FormLinkRow, FormList, FormSection } from "@/components/form-list.tsx";
import { SettingsScopeHeader } from "@/components/settings-scope-header.tsx";
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
    <>
      <SettingsScopeHeader closeSettings />
      <FormList>
        <FormSection title="Connections">
          <FormLinkRow
            icon="laptopcomputer"
            label="Computers"
            value={String(hostList.length)}
            onPress={() => router.push("/settings/computers")}
          />
        </FormSection>
        <FormSection title="Threads">
          <FormLinkRow
            icon="archivebox"
            label="Archived threads"
            value={archivedCount ? String(archivedCount) : undefined}
            onPress={() => router.push("/settings/archived")}
          />
        </FormSection>
        <FormSection
          title="Computer settings"
          footer={
            targets.length === 0
              ? "Connect to a computer to change its settings."
              : `Saved on ${targets.map((host) => host.paired.name).join(", ")}, so ${targets.length === 1 ? "its desktop uses" : "their desktops use"} them too.`
          }
        >
          <FormLinkRow
            icon="square.and.pencil"
            label="New threads"
            isDisabled={targets.length === 0}
            onPress={() => router.push("/settings/new-threads")}
          />
          <FormLinkRow
            icon="slider.horizontal.3"
            label="Thread behavior"
            isDisabled={targets.length === 0}
            onPress={() => router.push("/settings/behavior")}
          />
        </FormSection>
      </FormList>
    </>
  );
}
