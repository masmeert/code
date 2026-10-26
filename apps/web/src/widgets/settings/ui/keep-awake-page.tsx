import { Button } from "@masmeert/ui/button";
import { Switch } from "@masmeert/ui/switch";
import { Collapsible } from "@masmeert/ui/collapsible";
import { Input } from "@masmeert/ui/input";
import {
  MorphingPopover,
  MorphingPopoverContent,
  MorphingPopoverTrigger,
} from "@masmeert/ui/morphing-popover";
import { useRowCursor } from "@masmeert/ui/hooks/use-row-cursor";
import { cn } from "@masscode/ui/lib/utils";
import {
  type AppChoice,
  DEFAULT_KEEP_AWAKE_BATTERY_FLOOR,
  DEFAULT_KEEP_AWAKE_MANUAL_MINUTES,
  DEFAULT_KEEP_AWAKE_MAX_HOURS,
  judgeApp,
  type KeepAwakeSettings,
  type KeepAwakeStatus,
  type MacApp,
} from "@masscode/contracts";
import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import { IconAppWindow, IconLoader2, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  listKeepAwakeApps,
  removeKeepAwake,
  setUpKeepAwake,
  startKeepAwake,
  stopKeepAwake,
  useKeepAwake,
} from "@/entities/keep-awake";
import { updateSettings, useSettings } from "@/entities/settings";
import {
  RowLabel,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

const MANUAL_MINUTES = [30, 60, 120, 240, 480, 720];

const MAX_HOURS = [1, 2, 4, 8, 12, 24];

const BATTERY_FLOORS = [0, 5, 10, 15, 20, 30];

export function KeepAwakePage() {
  const settings = useSettings();
  const status = useKeepAwake();
  const keepAwake = settings.keepAwake ?? { enabled: false };
  const [choices, setChoices] = useState<ReadonlyArray<AppChoice> | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;

    void listKeepAwakeApps().then(({ apps, error }) => {
      if (isCancelled) return;

      setChoices(apps);
      setAppsError(error);
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  function update(patch: Partial<KeepAwakeSettings>) {
    updateSettings({ ...settings, keepAwake: { ...keepAwake, ...patch } });
  }

  if (!status) return null;

  const freezeApps = keepAwake.freezeApps ?? [];
  const keepApps = keepAwake.keepApps ?? [];
  const icons = new Map((choices ?? []).map((choice) => [choice.bundleId, choice.icon]));
  const running = (choices ?? []).filter((choice) => choice.running);

  const pausedNow = running.filter(
    (choice) => judgeApp(choice.bundleId, keepAwake)[0] === "freeze",
  );

  const protectedNow = running.flatMap((choice) => {
    const [verdict, protection] = judgeApp(choice.bundleId, keepAwake);

    return verdict === "protected" && protection ? [{ ...choice, protection }] : [];
  });

  return (
    <>
      <SettingsSection title="Keep awake">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Keep this Mac awake for agents"
                description="So they keep working while you're away"
              />
            }
          >
            <Switch
              size="compact"
              checked={keepAwake.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
              ariaLabel="Keep this Mac awake for agents"
            />
          </SettingsRow>
          <SessionRow
            status={status}
            keepAwake={keepAwake}
            onPickMinutes={(manualMinutes) => update({ manualMinutes })}
          />
          <Collapsible open={keepAwake.enabled}>
            <SettingsRow
              label={
                <RowLabel
                  title="Start when an agent starts"
                  description="Ends 5 minutes after the last one finishes"
                />
              }
            >
              <Switch
                size="compact"
                checked={keepAwake.whileAgentsWork !== false}
                onCheckedChange={(whileAgentsWork) => update({ whileAgentsWork })}
                ariaLabel="Start when an agent starts"
              />
            </SettingsRow>
          </Collapsible>
          <Collapsible open={status.notice !== null}>
            <p className={cn(typeClass("caption"), "px-3 py-2.5 text-muted-foreground")}>
              {status.notice}
            </p>
          </Collapsible>
        </SettingsGroup>
      </SettingsSection>
      <Collapsible open={keepAwake.enabled}>
        <SettingsSection title="Limits">
          <SettingsGroup>
            <SettingsRow label="Stop after">
              <SettingsSelect
                value={String(keepAwake.maxHours ?? DEFAULT_KEEP_AWAKE_MAX_HOURS)}
                onChange={(value) => update({ maxHours: Number(value) })}
                options={MAX_HOURS.map((hours) => ({
                  value: String(hours),
                  label: hours === 1 ? "1 hour" : `${hours} hours`,
                }))}
              />
            </SettingsRow>
            <SettingsRow label="Stop on low battery">
              <SettingsSelect
                value={String(keepAwake.batteryFloor ?? DEFAULT_KEEP_AWAKE_BATTERY_FLOOR)}
                onChange={(value) => update({ batteryFloor: Number(value) })}
                options={BATTERY_FLOORS.map((percent) => ({
                  value: String(percent),
                  label: percent === 0 ? "Never" : `At ${percent}%`,
                }))}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title="With the lid closed">
          <SettingsGroup>
            <AccessRow status={status} />
            <Collapsible open={status.access === "ready"}>
              <div className="divide-y divide-rule">
                <SettingsRow
                  label={
                    <RowLabel
                      title="Low Power Mode"
                      description="On battery; it also turns on whenever the Mac runs hot"
                    />
                  }
                >
                  <Switch
                    size="compact"
                    checked={keepAwake.lowPowerWhenClosed !== false}
                    onCheckedChange={(lowPowerWhenClosed) => update({ lowPowerWhenClosed })}
                    ariaLabel="Low Power Mode with the lid closed"
                  />
                </SettingsRow>
                <SettingsRow label="Mute sound">
                  <Switch
                    size="compact"
                    checked={keepAwake.muteWhenClosed !== false}
                    onCheckedChange={(muteWhenClosed) => update({ muteWhenClosed })}
                    ariaLabel="Mute sound with the lid closed"
                  />
                </SettingsRow>
                <SettingsRow
                  label={
                    <RowLabel
                      title="Pause other apps"
                      description="Not terminals, editors, browsers, AI, meeting or password apps"
                    />
                  }
                >
                  <Switch
                    size="compact"
                    checked={keepAwake.freezeOthers === true}
                    onCheckedChange={(freezeOthers) => update({ freezeOthers })}
                    ariaLabel="Pause other apps with the lid closed"
                  />
                </SettingsRow>
                <AppListRow
                  title="Always pause"
                  apps={freezeApps}
                  icons={icons}
                  choices={choices}
                  error={appsError}
                  onChange={(apps) =>
                    update({
                      freezeApps: apps,
                      keepApps: keepApps.filter(
                        (kept) => !apps.some((app) => app.bundleId === kept.bundleId),
                      ),
                    })
                  }
                />
                <AppListRow
                  title="Never pause"
                  apps={keepApps}
                  icons={icons}
                  choices={choices}
                  error={appsError}
                  onChange={(apps) =>
                    update({
                      keepApps: apps,
                      freezeApps: freezeApps.filter(
                        (paused) => !apps.some((app) => app.bundleId === paused.bundleId),
                      ),
                    })
                  }
                />
              </div>
            </Collapsible>
          </SettingsGroup>
          {status.access === "ready" ? (
            <p className={cn(typeClass("caption"), "mt-2 px-1 text-muted-foreground")}>
              {choices === null ? (
                <span className="flex items-center gap-1.5">
                  <IconLoader2 className="size-3 animate-spin" />
                  Looking at what's running…
                </span>
              ) : (
                <>
                  Closing the lid now pauses{" "}
                  {pausedNow.length === 0
                    ? "nothing that's running"
                    : pausedNow.map((choice) => choice.name).join(", ")}
                  {keepAwake.freezeOthers && protectedNow.length > 0
                    ? `, and leaves ${protectedNow.map((choice) => `${choice.name} (${choice.protection})`).join(", ")} running`
                    : null}
                  .
                </>
              )}
            </p>
          ) : null}
        </SettingsSection>
      </Collapsible>
    </>
  );
}

/** Where the session stands, with what starts or stops it. */
function SessionRow(props: {
  status: KeepAwakeStatus;
  keepAwake: KeepAwakeSettings;
  onPickMinutes: (minutes: number) => void;
}) {
  const { session, lidClosed, frozen, access } = props.status;
  const now = useNow(session ? 15_000 : 60_000);
  const minutes = props.keepAwake.manualMinutes ?? DEFAULT_KEEP_AWAKE_MANUAL_MINUTES;

  if (!props.keepAwake.enabled) return null;

  const title = !session
    ? "Keep awake now"
    : session.reason === "manual"
      ? `Awake until ${formatClockTime(session.endsAt)}`
      : "Awake while agents work";

  const description = !session
    ? null
    : [
        session.reason === "manual"
          ? `${formatTimeLeft(session.endsAt - now)} left`
          : `Until they finish, ${formatClockTime(session.endsAt)} at the latest`,
        lidClosed
          ? `Lid closed${frozen.length > 0 ? `, ${frozen.map((app) => app.name).join(", ")} paused` : ""}`
          : access === "ready"
            ? null
            : "The Mac still sleeps when the lid closes",
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <SettingsRow label={<RowLabel title={title} description={description} />}>
      {session ? (
        <Button
          size="compact"
          variant="secondary"
          className="h-7 rounded-lg"
          onClick={stopKeepAwake}
        >
          Stop
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <SettingsSelect
            value={String(minutes)}
            onChange={(value) => props.onPickMinutes(Number(value))}
            options={MANUAL_MINUTES.map((option) => ({
              value: String(option),
              label: `For ${formatTimeLeft(option * 60_000)}`,
            }))}
            className="w-32"
          />
          <Button
            size="compact"
            variant="secondary"
            className="h-7 rounded-lg"
            onClick={() => startKeepAwake(minutes)}
          >
            Start
          </Button>
        </div>
      )}
    </SettingsRow>
  );
}

/** The one-time password prompt that lets sessions go on with the lid closed. */
function AccessRow({ status }: { status: KeepAwakeStatus }) {
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <>
      <SettingsRow
        label={
          <RowLabel
            title="Stay awake with the lid closed"
            description={
              status.access === "ready"
                ? "Allowed. MassCode can only switch sleep and Low Power Mode"
                : "Otherwise the Mac sleeps when you close it. Asks for your password once"
            }
          />
        }
      >
        {status.access === "ready" ? (
          isConfirming ? (
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
                onClick={() => {
                  setIsConfirming(false);
                  removeKeepAwake();
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <Button
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setIsConfirming(true)}
            >
              Remove
            </Button>
          )
        ) : (
          <Button
            size="compact"
            variant="secondary"
            className="h-7 rounded-lg"
            disabled={status.access === "installing"}
            onClick={setUpKeepAwake}
          >
            {status.access === "installing" ? (
              <span className="flex items-center gap-1.5">
                <IconLoader2 className="size-3.5 animate-spin" />
                Waiting for password…
              </span>
            ) : (
              "Allow…"
            )}
          </Button>
        )}
      </SettingsRow>
      <Collapsible open={isConfirming}>
        <p className={cn(typeClass("caption"), "px-3 py-2.5 text-muted-foreground")}>
          Asks for your password again. The Mac goes back to sleeping when the lid closes.
        </p>
      </Collapsible>
    </>
  );
}

function AppIcon({ icon }: { icon: string | null | undefined }) {
  return icon ? (
    <img src={icon} alt="" className="size-4 shrink-0" />
  ) : (
    <IconAppWindow className="size-4 shrink-0 text-muted-foreground" />
  );
}

/** A list of apps, each removable, with a picker to add more. */
function AppListRow(props: {
  title: string;
  apps: ReadonlyArray<MacApp>;
  icons: ReadonlyMap<string, string | null>;
  choices: ReadonlyArray<AppChoice> | null;
  error: string | null;
  onChange: (apps: ReadonlyArray<MacApp>) => void;
}) {
  return (
    <div className="px-3 py-2">
      <div className="flex min-h-7 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <RowLabel title={props.title} />
        </div>
        <AppPicker
          label={`Add an app to ${props.title.toLowerCase()}`}
          choices={props.choices}
          error={props.error}
          excluded={props.apps}
          onPick={(app) => props.onChange([...props.apps, app])}
        />
      </div>
      {props.apps.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {props.apps.map((app) => (
            <li
              key={app.bundleId}
              className={cn(
                typeClass("body", "compact"),
                "flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background pr-1 pl-2",
              )}
            >
              <AppIcon icon={props.icons.get(app.bundleId)} />
              {app.name}
              <button
                type="button"
                aria-label={`Remove ${app.name}`}
                title={`Remove ${app.name}`}
                onClick={() =>
                  props.onChange(props.apps.filter((other) => other.bundleId !== app.bundleId))
                }
                className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <IconX className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Searchable list of this Mac's apps, running ones first; ↑↓ and Enter pick, Esc closes. */
function AppPicker(props: {
  label: string;
  choices: ReadonlyArray<AppChoice> | null;
  error: string | null;
  excluded: ReadonlyArray<MacApp>;
  onPick: (app: MacApp) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const rows = (props.choices ?? [])
    .filter(
      (choice) =>
        !props.excluded.some((app) => app.bundleId === choice.bundleId) &&
        choice.name.toLowerCase().includes(needle),
    )
    .map((choice) => ({ ...choice, id: choice.bundleId }));

  const { activeIndex, moveTo, moveActive } = useRowCursor(rows, needle);

  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    // The panel mounts as it opens; the field can take focus a frame later.
    const frame = requestAnimationFrame(() => input.current?.focus());

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      // Esc closes the picker first, not the whole of Settings.
      event.stopPropagation();
      setIsOpen(false);
      setQuery("");
    }

    window.addEventListener("keydown", closeOnEscape, { capture: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape, { capture: true });
    };
  }, [isOpen]);

  function pick(choice: AppChoice) {
    props.onPick({ bundleId: choice.bundleId, name: choice.name });
    setIsOpen(false);
    setQuery("");
  }

  return (
    <MorphingPopover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);

        if (!open) setQuery("");
      }}
    >
      <MorphingPopoverTrigger>
        <Button
          size="compact"
          variant="ghost"
          className="h-7 gap-1 rounded-lg"
          aria-label={props.label}
          title={props.label}
        >
          <IconPlus className="size-3.5" />
          Add
        </Button>
      </MorphingPopoverTrigger>
      <MorphingPopoverContent side="bottom" align="end" sideOffset={6} radius={12} className="w-72">
        <div className="border-b border-border p-1">
          <Input
            ref={input}
            aria-label="Find an app"
            value={query}
            onChange={setQuery}
            placeholder="Find an app"
            spellCheck={false}
            autoComplete="off"
            leftIcon={<IconSearch className="size-3.5" />}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(event.key === "ArrowDown" ? 1 : -1);
              }

              if (event.key === "Enter" && rows[activeIndex]) {
                event.preventDefault();
                pick(rows[activeIndex]);
              }
            }}
            classNames={{
              field: "h-8 rounded-lg border-0 bg-transparent",
              input: typeClass("body", "compact"),
            }}
          />
        </div>
        <div role="listbox" aria-label="Apps" className="max-h-56 overflow-y-auto p-1">
          {props.choices === null ? (
            <p
              className={cn(
                typeClass("caption"),
                "flex items-center gap-1.5 px-2 py-1.5 text-muted-foreground",
              )}
            >
              <IconLoader2 className="size-3 animate-spin" />
              Loading apps…
            </p>
          ) : rows.length === 0 ? (
            <p className={cn(typeClass("caption"), "px-2 py-1.5 text-muted-foreground")}>
              {props.error ?? (needle ? "No app matches." : "No apps left to add.")}
            </p>
          ) : (
            rows.map((choice, index) => (
              <button
                key={choice.bundleId}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onPointerMove={() => moveTo(choice.bundleId)}
                onClick={() => pick(choice)}
                className={cn(
                  typeClass("body", "compact"),
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left outline-none",
                  index === activeIndex && "bg-hover",
                )}
              >
                <AppIcon icon={choice.icon} />
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {choice.running ? (
                  <span className={cn(typeClass("caption"), "shrink-0 text-muted-foreground")}>
                    Running
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </MorphingPopoverContent>
    </MorphingPopover>
  );
}
