import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button, Input, Label, Spinner, TextField } from "heroui-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { pairWithMac, parsePairingLink } from "../src/lib/macs.ts";
import { addMac } from "../src/lib/store.ts";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairingWith, setPairingWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  // The camera reports a code many times a second; only the first starts pairing.
  const isPairing = useRef(false);

  async function pair(offer: {
    host: string;
    port: number;
    code: string;
    name: string;
    dnsName?: string | null;
  }) {
    if (isPairing.current) return;

    isPairing.current = true;
    setPairingWith(offer.name);
    setError(null);

    try {
      await addMac(await pairWithMac(offer));
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

  const link = useLocalSearchParams<{
    host?: string;
    port?: string;
    code?: string;
    name?: string;
    dns?: string;
  }>();

  const pairFromLink = useEffectEvent(() => {
    if (link.host && link.code && link.port)
      void pair({
        host: link.host,
        port: Number(link.port),
        code: link.code,
        name: link.name ?? link.host,
        dnsName: link.dns ?? null,
      });
  });

  // The pairing link (masscode://pair?…) opens this screen with the offer, from the Camera app too.
  useEffect(() => pairFromLink(), [link.host, link.code]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 p-5"
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.dismissTo("/")}
            >
              <Text className="text-[17px] text-foreground">Cancel</Text>
            </Pressable>
          ),
        }}
      />
      <Text className="text-[15px] text-muted">
        On your Mac, open MassCode → Settings → Phone, turn on access and choose Pair a phone. Then
        scan the code it shows.
      </Text>
      <View className="bg-surface-secondary aspect-square overflow-hidden rounded-3xl">
        {permission?.granted ? (
          <CameraView
            className="flex-1"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              const offer = parsePairingLink(data);

              if (offer) void pair(offer);
              else if (!error)
                setError(
                  "That isn't a MassCode pairing code. Scan the one in Settings → Phone on your Mac.",
                );
            }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4 p-6">
            <Text className="text-center text-[15px] text-muted">
              {permission?.canAskAgain === false
                ? "Camera access is off for MassCode. Turn it on in the Settings app, or enter the code below."
                : "MassCode needs the camera to scan the pairing code."}
            </Text>
            {permission?.canAskAgain === false ? null : (
              <Button variant="secondary" onPress={() => void requestPermission()}>
                Allow camera
              </Button>
            )}
          </View>
        )}
        {pairingWith ? (
          <View className="absolute inset-0 items-center justify-center gap-3 bg-background/80">
            <Spinner />
            <Text className="text-foreground">Pairing with {pairingWith}…</Text>
          </View>
        ) : null}
      </View>
      {error ? <Text className="text-danger text-[15px]">{error}</Text> : null}
      <View className="gap-3">
        <Text className="text-[13px] font-medium tracking-wide text-muted uppercase">
          Or enter it
        </Text>
        <TextField>
          <Label>Mac's Tailscale address</Label>
          <Input
            value={host}
            onChangeText={setHost}
            placeholder="100.64.0.1"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
          />
        </TextField>
        <TextField>
          <Label>Code</Label>
          <Input
            value={code}
            onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
            placeholder="6 digits"
            keyboardType="number-pad"
          />
        </TextField>
        <Button
          isDisabled={!host.trim() || code.length !== 6 || pairingWith !== null}
          // The Mac's phone listener port, as in its pairing code.
          // 47822 is the Mac's phone port, as its pairing code carries it.
          onPress={() => void pair({ host: host.trim(), port: 47822, code, name: host.trim() })}
        >
          Pair
        </Button>
      </View>
    </ScrollView>
  );
}
