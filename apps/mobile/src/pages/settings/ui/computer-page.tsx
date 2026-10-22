import { PROVIDER_NAME } from "@masscode/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert } from "react-native";
import {
  CONNECTION_HELP,
  CONNECTION_STATUS,
  reconnectHost,
  removeHost,
  setHostEnabled,
  useHostStore,
} from "@/entities/host";
import { ProviderLogo, useHostProviders } from "@/entities/provider";
import { FormButtonRow, FormInfoRow, FormList, FormSection, FormSwitchRow } from "@/shared/ui";
import { KeepAwakeSection } from "./keep-awake-section.tsx";

export function ComputerPage() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useHostStore((state) => state.hosts[hostId]);
  const providers = useHostProviders(hostId);

  if (!host)
    return (
      <FormList>
        <FormSection footer="This computer is no longer paired with this phone.">
          <FormButtonRow label="Back to computers" onPress={() => router.back()} />
        </FormSection>
      </FormList>
    );

  const { paired, connection } = host;

  return (
    <>
      <Stack.Screen options={{ title: paired.name }} />
      <FormList>
        <FormSection title="Connection" footer={CONNECTION_HELP[connection]}>
          <FormSwitchRow
            label="Connect to this computer"
            value={connection !== "off"}
            onChange={(enabled) => setHostEnabled(paired.id, enabled)}
          />
          <FormInfoRow
            label={paired.dnsName ?? paired.address}
            value={CONNECTION_STATUS[connection]}
          />
        </FormSection>
        <KeepAwakeSection host={host} />
        <FormSection
          footer={`Forgetting stops this phone reaching ${paired.name}. To unpair it on the computer too, use Settings → Phone there.`}
        >
          <FormButtonRow
            label="Reconnect now"
            isDisabled={connection === "connected" || connection === "off"}
            onPress={() => reconnectHost(paired.id)}
          />
          <FormButtonRow
            label="Forget computer"
            isDestructive
            onPress={() =>
              Alert.alert(`Forget ${paired.name}?`, "Pair again to use it from this phone.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Forget",
                  style: "destructive",
                  onPress: () => {
                    router.back();
                    removeHost(paired.id);
                  },
                },
              ])
            }
          />
        </FormSection>
        {providers.length > 0 ? (
          <FormSection title="Providers">
            {providers.map((provider) => (
              <FormInfoRow
                key={provider.kind}
                leading={<ProviderLogo provider={provider.kind} className="size-5" />}
                label={PROVIDER_NAME[provider.kind]}
                detail={
                  [provider.version, provider.plan, provider.error].filter(Boolean).join(" · ") ||
                  undefined
                }
                value={
                  provider.checking
                    ? "Checking…"
                    : !provider.installed
                      ? "Not installed"
                      : provider.linked
                        ? (provider.account ?? "Signed in")
                        : "Signed out"
                }
              />
            ))}
          </FormSection>
        ) : null}
      </FormList>
    </>
  );
}
