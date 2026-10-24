import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import { addHost } from "@/entities/host";
import {
  FormButtonRow,
  FormContentRow,
  FormInfoRow,
  FormList,
  FormSection,
  FormTextFieldRow,
} from "@/shared/ui";
import { pairWithHost, parsePairingLink, type PairingOffer } from "../api/pairing.ts";

export function PairPage() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairingWith, setPairingWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  // The camera reports a code many times a second; only the first starts pairing.
  const isPairing = useRef(false);

  async function pair(offer: PairingOffer) {
    if (isPairing.current) return;

    isPairing.current = true;
    setPairingWith(offer.name);
    setError(null);

    try {
      addHost(await pairWithHost(offer));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Back to the thread list, however this screen was opened.
      router.dismissTo("/");
    } catch (failure) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      isPairing.current = false;
      setPairingWith(null);
    }
  }

  const link = useLocalSearchParams<Record<string, string>>();

  const pairFromLink = useEffectEvent(() => {
    const offer = parsePairingLink(`masscode://pair?${new URLSearchParams(link)}`);

    if (offer) void pair(offer);
  });

  // The pairing link (masscode://pair?…) opens this screen with the offer, from the Camera app too.
  useEffect(() => pairFromLink(), [link.code]);

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Cancel"
          onPress={() => router.dismissTo("/")}
        />
      </Stack.Toolbar>
      <FormList>
        <FormSection
          footer={
            error ??
            (permission?.granted
              ? "In MassCode on your computer, open Settings → Phone → Pair a phone, then scan the code."
              : permission?.canAskAgain === false
                ? "Camera access is off for MassCode. Turn it on in the Settings app, or type the code below."
                : "MassCode needs the camera to scan the pairing code on your computer.")
          }
        >
          {pairingWith ? <FormInfoRow label={`Pairing with ${pairingWith}…`} /> : null}
          {permission?.granted ? (
            <FormContentRow>
              <View className="h-64 w-full overflow-hidden rounded-xl">
                <CameraView
                  className="flex-1"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    const offer = parsePairingLink(data);

                    if (offer) void pair(offer);
                    else if (!error)
                      setError(
                        "That isn't a MassCode pairing code. Scan the one in Settings → Phone on your computer.",
                      );
                  }}
                />
              </View>
            </FormContentRow>
          ) : permission?.canAskAgain === false ? null : (
            <FormButtonRow label="Allow camera" onPress={() => void requestPermission()} />
          )}
        </FormSection>
        <FormSection
          title="Or type what it shows"
          footer="Typing works on the same Tailscale network as the computer. Scan the code to reach it from anywhere."
        >
          <FormTextFieldRow
            label="Tailscale address"
            placeholder="100.64.0.1"
            keyboard="numbers-and-punctuation"
            onChange={setAddress}
          />
          <FormTextFieldRow
            label="Code"
            placeholder="000000"
            keyboard="number-pad"
            maxLength={6}
            onChange={(text) => setCode(text.replace(/\D/g, ""))}
          />
          <FormButtonRow
            label="Pair"
            isDisabled={!address.trim() || code.length !== 6 || pairingWith !== null}
            // 47822 is the host's phone port, as its pairing code carries it.
            onPress={() =>
              void pair({ host: address.trim(), port: 47822, code, name: address.trim() })
            }
          />
        </FormSection>
      </FormList>
    </>
  );
}
