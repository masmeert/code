import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { pairWithHost, parsePairingLink } from "@/lib/hosts.ts";
import { addHost } from "@/lib/store.ts";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairingWith, setPairingWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
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
      contentContainerClassName="gap-4 p-5"
      keyboardShouldPersistTaps="handled"
    >
      {Platform.OS === "ios" ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            accessibilityLabel="Cancel"
            onPress={() => router.dismissTo("/")}
          />
        </Stack.Toolbar>
      ) : null}
      <Text className="text-sm leading-6 text-muted-foreground">
        In MassCode on your computer, open Settings → Phone → Pair a phone, then scan the code.
      </Text>
      <View className="h-64 overflow-hidden rounded-2xl border border-border bg-card">
        {permission?.granted ? (
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
        ) : (
          <View className="flex-1 items-center justify-center gap-4 p-6">
            <Text className="text-center text-sm leading-6 text-muted-foreground">
              {permission?.canAskAgain === false
                ? "Camera access is off for MassCode. Turn it on in the Settings app, or enter the code below."
                : "MassCode needs the camera to scan the pairing code."}
            </Text>
            {permission?.canAskAgain === false ? null : (
              <Button variant="secondary" onPress={() => void requestPermission()}>
                <Text>Allow camera</Text>
              </Button>
            )}
          </View>
        )}
        {pairingWith ? (
          <View className="absolute inset-0 items-center justify-center gap-3 bg-background/80">
            <ActivityIndicator />
            <Text className="text-sm">Pairing with {pairingWith}…</Text>
          </View>
        ) : null}
      </View>
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="gap-3">
        <Text className="text-xs font-medium text-muted-foreground">Or type what it shows</Text>
        <View className="flex-row gap-2">
          <View className="flex-1 gap-1.5">
            <Text className="text-xs text-muted-foreground">Tailscale address</Text>
            <Input
              value={address}
              onChangeText={setAddress}
              placeholder="100.64.0.1"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
          </View>
          <View className="w-28 gap-1.5">
            <Text className="text-xs text-muted-foreground">Code</Text>
            <Input
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              keyboardType="number-pad"
              className="font-mono"
            />
          </View>
        </View>
        <Button
          disabled={!address.trim() || code.length !== 6 || pairingWith !== null}
          // 47822 is the host's phone port, as its pairing code carries it.
          onPress={() =>
            void pair({ host: address.trim(), port: 47822, code, name: address.trim() })
          }
        >
          <Text>Pair</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
