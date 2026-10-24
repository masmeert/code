import { router, Stack } from "expo-router";
import { CONNECTION_STATUS, useHostStore } from "@/entities/host";
import { FormButtonRow, FormLinkRow, FormList, FormSection } from "@/shared/ui";

export function ComputersPage() {
  const hosts = useHostStore((state) => state.hosts);

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
        <FormSection footer="Pair this phone from MassCode on your computer, in Settings → Phone. It reaches the computer from anywhere, end-to-end encrypted, and directly over Tailscale when it can.">
          {Object.values(hosts).map(({ paired, connection }) => (
            <FormLinkRow
              key={paired.id}
              icon="laptopcomputer"
              label={paired.name}
              detail={paired.dnsName ?? paired.address ?? "Through the relay"}
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
