import { router, Stack } from "expo-router";
import { FormButtonRow, FormLinkRow, FormList, FormSection } from "@/components/FormList.tsx";
import { CONNECTION_STATUS } from "@/lib/host-connection.ts";
import { useStore } from "@/lib/store.ts";

export default function ComputersScreen() {
  const hosts = useStore((state) => state.hosts);

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          accessibilityLabel="Pair a computer"
          onPress={() => router.push("/pair")}
        />
      </Stack.Toolbar>
      <FormList>
        <FormSection footer="Pair this phone from MassCode on your computer, in Settings → Phone. It reaches the computer over Tailscale.">
          {Object.values(hosts).map(({ paired, connection }) => (
            <FormLinkRow
              key={paired.id}
              icon="laptopcomputer"
              label={paired.name}
              detail={paired.dnsName ?? paired.address}
              value={CONNECTION_STATUS[connection]}
              onPress={() =>
                router.push({
                  pathname: "/settings/computers/[hostId]",
                  params: { hostId: paired.id },
                })
              }
            />
          ))}
          {/* With nothing paired, the list itself offers what the header plus does. */}
          {Object.keys(hosts).length === 0 ? (
            <FormButtonRow label="Pair a computer" onPress={() => router.push("/pair")} />
          ) : null}
        </FormSection>
      </FormList>
    </>
  );
}
