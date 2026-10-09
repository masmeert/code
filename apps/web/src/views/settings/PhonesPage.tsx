import { Button } from "@masscode/ui/motion/button/base";
import { Switch } from "@masscode/ui/motion/switch";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand, type PairedPhone, type PairingOffer } from "@masscode/contracts";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { encode } from "uqr";
import { send, startPhonePairing, updateSettings, useStore } from "../../lib/store.ts";
import { formatAge, useNow } from "../../lib/time.ts";
import { RowLabel, SettingsGroup, SettingsRow, SettingsSection } from "./SettingsControls.tsx";

export function PhonesPage() {
  const settings = useStore((state) => state.settings);
  const phones = useStore((state) => state.phones);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [pairedCount, setPairedCount] = useState(phones.length);

  // A phone that just paired closes the code it used.
  if (phones.length !== pairedCount) {
    setPairedCount(phones.length);

    if (phones.length > pairedCount && offer) {
      setOffer(null);
      setPairedName(phones.at(-1)?.name ?? null);
    }
  }

  async function pair() {
    setIsStarting(true);
    setError(null);
    setPairedName(null);

    const started = await startPhonePairing();
    setIsStarting(false);
    setOffer(started.offer);
    setError(started.error);
  }

  return (
    <>
      <SettingsSection title="Phone access">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Let phones reach this Mac"
                description="Paired phones see and steer threads over Tailscale while MassCode runs"
              />
            }
          >
            <Switch
              size="sm"
              checked={settings.remoteAccess === true}
              onCheckedChange={(remoteAccess) => {
                setOffer(null);
                setError(null);
                updateSettings({ ...settings, remoteAccess });
              }}
              ariaLabel="Let phones reach this Mac"
            />
          </SettingsRow>
          {settings.remoteAccess ? (
            <SettingsRow
              label={
                <RowLabel
                  title="Pair a phone"
                  description="Open MassCode on the phone and scan the code; it works once, for five minutes"
                />
              }
            >
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-lg"
                disabled={isStarting}
                onClick={() => void pair()}
              >
                {isStarting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : offer ? (
                  "New code"
                ) : (
                  "Pair a phone"
                )}
              </Button>
            </SettingsRow>
          ) : null}
          {error ? <p className="px-3 py-2.5 text-xs text-destructive">{error}</p> : null}
          {pairedName ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">Paired {pairedName}.</p>
          ) : null}
          {offer ? <PairingCode offer={offer} onClose={() => setOffer(null)} /> : null}
        </SettingsGroup>
      </SettingsSection>
      {phones.length > 0 ? (
        <SettingsSection title="Paired phones">
          <SettingsGroup>
            {phones.map((phone) => (
              <PhoneRow key={phone.id} phone={phone} />
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </>
  );
}

/** The QR code a phone scans, with the code and address typed by hand when the camera can't. */
function PairingCode({ offer, onClose }: { offer: PairingOffer; onClose: () => void }) {
  const now = useNow(1000);
  const secondsLeft = Math.max(0, Math.round((offer.expiresAt - now) / 1000));
  const { data, size } = encode(offer.url, { border: 1 });

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      // Esc closes the code first, not the whole of Settings.
      event.stopPropagation();
      onClose();
    }

    window.addEventListener("keydown", closeOnEscape, { capture: true });

    return () => window.removeEventListener("keydown", closeOnEscape, { capture: true });
  }, [onClose]);

  return (
    <div className="flex items-center gap-5 px-3 py-4">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Pairing code to scan with MassCode on your phone"
        className={cn("size-40 rounded-lg bg-white", secondsLeft === 0 && "opacity-20")}
      >
        <path
          fill="#101010"
          d={data
            .flatMap((row, y) => row.flatMap((isDark, x) => (isDark ? [`M${x} ${y}h1v1h-1z`] : [])))
            .join("")}
        />
      </svg>
      <div className="min-w-0 text-[13px]">
        {secondsLeft === 0 ? (
          <p className="text-destructive">This code expired. Get a new one.</p>
        ) : (
          <>
            <p className="font-mono text-2xl tracking-[0.2em]">{offer.code}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
            </p>
          </>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Can't scan? Enter <span className="font-mono text-foreground">{offer.host}</span> and the
          code on the phone.
        </p>
        <Button size="sm" variant="ghost" className="mt-2 -ml-2 h-7 rounded-lg" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function PhoneRow({ phone }: { phone: PairedPhone }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const now = useNow();

  return (
    <>
      <SettingsRow
        label={
          <RowLabel
            title={phone.name}
            description={`${phone.platform === "ios" ? "iPhone" : "Android"} · ${
              phone.lastSeenAt === null
                ? "Hasn't connected yet"
                : `Last seen ${formatAge(phone.lastSeenAt, now) === "now" ? "just now" : `${formatAge(phone.lastSeenAt, now)} ago`}`
            }`}
          />
        }
      >
        {isConfirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setIsConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => send(ClientCommand.cases["phone.unpair"].make({ phoneId: phone.id }))}
            >
              Unpair
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg"
            onClick={() => setIsConfirming(true)}
          >
            Unpair
          </Button>
        )}
      </SettingsRow>
      {isConfirming ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          {phone.name} is disconnected at once and has to be paired again to reach this Mac.
        </p>
      ) : null}
    </>
  );
}
