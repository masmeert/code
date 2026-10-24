import { Button } from "@masmeert/ui/button";
import { Switch } from "@masmeert/ui/switch";
import { cn } from "@masscode/ui/lib/utils";
import { spring } from "@masmeert/ui/lib/springs";
import { ClientCommand, type PairedPhone, type PairingOffer } from "@masscode/contracts";
import { Collapsible } from "@masmeert/ui/collapsible";
import { ActionSwapRollText } from "@masscode/ui/motion/action-swap-roll";
import { IconLoader2, IconX } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { startPhonePairing, useHostStore } from "@/entities/host";
import { updateSettings, useSettings } from "@/entities/settings";
import { send } from "@/shared/api";
import { formatAge } from "@masscode/client";
import { useNow } from "@masscode/client";
import { RowLabel, SettingsGroup, SettingsRow, SettingsSection } from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export function PhonesPage() {
  const settings = useSettings();
  const phones = useHostStore((state) => state.phones);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedCount, setPairedCount] = useState(phones.length);
  // The last code stays drawn while its panel folds shut.
  const [shownOffer, setShownOffer] = useState(offer);

  if (offer && offer !== shownOffer) setShownOffer(offer);

  // A phone that just paired closes the code it used.
  if (phones.length !== pairedCount) {
    setPairedCount(phones.length);

    if (phones.length > pairedCount) setOffer(null);
  }

  async function pair() {
    setIsStarting(true);
    setError(null);

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
              size="compact"
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
                size="compact"
                variant="secondary"
                className="h-7 rounded-lg"
                disabled={isStarting}
                onClick={() => void pair()}
              >
                {/* Every label stacked in one cell, so the button keeps its width whichever shows. */}
                <span className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1",
                      (isStarting || offer !== null) && "invisible",
                    )}
                  >
                    Pair a phone
                  </span>
                  <span
                    className={cn(
                      "col-start-1 row-start-1",
                      (isStarting || offer === null) && "invisible",
                    )}
                  >
                    New code
                  </span>
                  {isStarting ? (
                    <IconLoader2 className="col-start-1 row-start-1 size-3.5 animate-spin" />
                  ) : null}
                </span>
              </Button>
            </SettingsRow>
          ) : null}
          <Collapsible open={error !== null}>
            <p className={cn(typeClass("caption"), "px-3 py-2.5 text-destructive")}>{error}</p>
          </Collapsible>
          <Collapsible open={offer !== null}>
            {shownOffer ? <PairingCode offer={shownOffer} onClose={() => setOffer(null)} /> : null}
          </Collapsible>
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
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState<"code" | "address" | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  async function copy(text: string, what: "code" | "address") {
    await navigator.clipboard?.writeText(text);
    setCopied(what);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1600);
  }

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
    <div className="relative flex items-center gap-6 px-4 py-4">
      <motion.div
        // A new code fades in over the old one rather than jumping.
        key={offer.code}
        initial={reduce ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={spring.moderate}
        className="flex items-center gap-6"
      >
        <div
          className={cn(
            "shrink-0 rounded-xl bg-white p-2 transition-opacity",
            secondsLeft === 0 && "opacity-20",
          )}
        >
          <svg
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label="Pairing code to scan with MassCode on your phone"
            className="size-32"
          >
            <path
              fill="#101010"
              d={data
                .flatMap((row, y) =>
                  row.flatMap((isDark, x) => (isDark ? [`M${x} ${y}h1v1h-1z`] : [])),
                )
                .join("")}
            />
          </svg>
        </div>
        <div className="min-w-0">
          {secondsLeft === 0 ? (
            <p className={cn(typeClass("body"), "text-destructive")}>
              This code expired. Get a new one.
            </p>
          ) : (
            <>
              <p className={cn(typeClass("caption"), "text-muted-foreground")}>
                <ActionSwapRollText value={copied ?? "idle"}>
                  {copied ? `${copied === "code" ? "Code" : "Address"} copied` : "Pairing code"}
                </ActionSwapRollText>
              </p>
              <motion.button
                type="button"
                title="Copy code"
                onClick={() => copy(offer.code, "code")}
                whileTap={reduce ? undefined : { scale: 0.97 }}
                transition={spring.fast}
                className={cn(
                  typeClass("display"),
                  "-mx-1.5 mt-0.5 block rounded-lg px-1.5 font-mono tabular-nums transition-colors outline-none hover:bg-hover focus-visible:ring-4 focus-visible:ring-ring",
                )}
              >
                {offer.code.slice(0, 3)}
                <span className="ml-1">{offer.code.slice(3)}</span>
              </motion.button>
              <p className={cn(typeClass("caption"), "mt-1 text-muted-foreground tabular-nums")}>
                Expires in {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, "0")}
              </p>
            </>
          )}
          <p className={cn(typeClass("caption"), "mt-4 max-w-72 leading-5 text-muted-foreground")}>
            Can't scan? On the phone, enter{" "}
            <motion.button
              type="button"
              title="Copy address"
              onClick={() => copy(offer.host, "address")}
              whileTap={reduce ? undefined : { scale: 0.97 }}
              transition={spring.fast}
              className="inline-block rounded-md px-1 font-mono text-foreground transition-colors outline-none hover:bg-hover focus-visible:ring-4 focus-visible:ring-ring"
            >
              {offer.host}
            </motion.button>{" "}
            and this code.
          </p>
        </div>
      </motion.div>
      <button
        type="button"
        aria-label="Close pairing code"
        onClick={onClose}
        className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
      >
        <IconX className="size-4" />
      </button>
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
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setIsConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => send(ClientCommand.cases["phone.unpair"].make({ phoneId: phone.id }))}
            >
              Unpair
            </Button>
          </div>
        ) : (
          <Button
            size="compact"
            variant="ghost"
            className="h-7 rounded-lg"
            onClick={() => setIsConfirming(true)}
          >
            Unpair
          </Button>
        )}
      </SettingsRow>
      {isConfirming ? (
        <p className={cn(typeClass("caption"), "px-3 py-2.5 text-muted-foreground")}>
          {phone.name} is disconnected at once and has to be paired again to reach this Mac.
        </p>
      ) : null}
    </>
  );
}
