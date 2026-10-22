import { Button } from "@masscode/ui/motion/button/base";
import { Switch } from "@masscode/ui/motion/switch";
import { Fold } from "@masscode/ui/motion/fold";
import { Input } from "@masscode/ui/motion/input";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@masscode/ui/motion/popover-morph";
import { useRowCursor } from "@masscode/ui/hooks/use-row-cursor";
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
import { AppWindow, LoaderCircle, Plus, Search, X } from "lucide-react";
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
                description="Agents keep working when you close the lid or walk away"
              />
            }
          >
            <Switch
              size="sm"
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
          <Fold open={status.notice !== null}>
            <p className="px-3 py-2.5 text-xs text-muted-foreground">{status.notice}</p>
          </Fold>
        </SettingsGroup>
      </SettingsSection>
      <AccessSection status={status} />
      <Fold open={keepAwake.enabled}>
        <SettingsSection title="When">
          <SettingsGroup>
            <SettingsRow
              label={
                <RowLabel
                  title="While agents work"
                  description="Starts with a turn, ends 5 minutes after the last one finishes"
                />
              }
            >
              <Switch
                size="sm"
                checked={keepAwake.whileAgentsWork !== false}
                onCheckedChange={(whileAgentsWork) => update({ whileAgentsWork })}
                ariaLabel="While agents work"
              />
            </SettingsRow>
            <SettingsRow
              label={
                <RowLabel
                  title="Stop after"
                  description="The longest agents can keep the Mac awake in one go"
                />
              }
            >
              <SettingsSelect
                value={String(keepAwake.maxHours ?? DEFAULT_KEEP_AWAKE_MAX_HOURS)}
                onChange={(value) => update({ maxHours: Number(value) })}
                options={MAX_HOURS.map((hours) => ({
                  value: String(hours),
                  label: hours === 1 ? "1 hour" : `${hours} hours`,
                }))}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title="Battery">
          <SettingsGroup>
            <SettingsRow
              label={
                <RowLabel
                  title="Stop on low battery"
                  description="Lets the Mac sleep before it runs flat"
                />
              }
            >
              <SettingsSelect
                value={String(keepAwake.batteryFloor ?? DEFAULT_KEEP_AWAKE_BATTERY_FLOOR)}
                onChange={(value) => update({ batteryFloor: Number(value) })}
                options={BATTERY_FLOORS.map((percent) => ({
                  value: String(percent),
                  label: percent === 0 ? "Never" : `At ${percent}%`,
                }))}
              />
            </SettingsRow>
            <SettingsRow
              label={
                <RowLabel
                  title="Low Power Mode with the lid closed"
                  description="On battery; it also turns on whenever the Mac runs hot"
                />
              }
            >
              <Switch
                size="sm"
                checked={keepAwake.lowPowerWhenClosed !== false}
                onCheckedChange={(lowPowerWhenClosed) => update({ lowPowerWhenClosed })}
                ariaLabel="Low Power Mode with the lid closed"
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title="With the lid closed">
          <SettingsGroup>
            <SettingsRow
              label={<RowLabel title="Mute sound" description="Unmuted when you open the lid" />}
            >
              <Switch
                size="sm"
                checked={keepAwake.muteWhenClosed !== false}
                onCheckedChange={(muteWhenClosed) => update({ muteWhenClosed })}
                ariaLabel="Mute sound"
              />
            </SettingsRow>
            <SettingsRow
              label={
                <RowLabel
                  title="Pause every other app"
                  description="All but terminals, editors, browsers, AI, meeting and password apps"
                />
              }
            >
              <Switch
                size="sm"
                checked={keepAwake.freezeOthers === true}
                onCheckedChange={(freezeOthers) => update({ freezeOthers })}
                ariaLabel="Pause every other app"
              />
            </SettingsRow>
            <AppListRow
              title="Always pause"
              description="Resumed as soon as you open the lid"
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
              description="Keeps running even with every other app paused"
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
            <div className="px-3 py-2.5">
              <p className="text-[13px]">Closing the lid now would pause</p>
              {choices === null ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3 animate-spin" />
                  Looking at what's running…
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {pausedNow.length === 0
                    ? "Nothing that's running."
                    : pausedNow.map((choice) => choice.name).join(", ")}
                  {keepAwake.freezeOthers && protectedNow.length > 0
                    ? `. Left running: ${protectedNow.map((choice) => `${choice.name} (${choice.protection})`).join(", ")}.`
                    : null}
                </p>
              )}
            </div>
          </SettingsGroup>
        </SettingsSection>
      </Fold>
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
    ? "Not keeping awake right now"
    : session.reason === "manual"
      ? `Awake until ${formatClockTime(session.endsAt)}`
      : "Awake while agents work";

  const description = !session
    ? props.keepAwake.whileAgentsWork === false
      ? "Start it for a set time"
      : "Starts on its own when an agent starts working"
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
        <Button size="sm" variant="secondary" className="h-7 rounded-lg" onClick={stopKeepAwake}>
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
            size="sm"
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
function AccessSection({ status }: { status: KeepAwakeStatus }) {
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <SettingsSection title="Lid-closed access">
      <SettingsGroup>
        <SettingsRow
          label={
            <RowLabel
              title={status.access === "ready" ? "Set up" : "Not set up"}
              description={
                status.access === "ready"
                  ? "MassCode can turn sleep and Low Power Mode off and on, nothing else"
                  : "Without it the Mac sleeps when you close the lid. Asks for your password once"
              }
            />
          }
        >
          {status.access === "ready" ? (
            isConfirming ? (
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
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg"
                onClick={() => setIsConfirming(true)}
              >
                Remove
              </Button>
            )
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 rounded-lg"
              disabled={status.access === "installing"}
              onClick={setUpKeepAwake}
            >
              {status.access === "installing" ? (
                <span className="flex items-center gap-1.5">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Waiting for password…
                </span>
              ) : (
                "Set up…"
              )}
            </Button>
          )}
        </SettingsRow>
        <Fold open={isConfirming}>
          <p className="px-3 py-2.5 text-xs text-muted-foreground">
            Asks for your password again. The Mac goes back to sleeping when the lid closes.
          </p>
        </Fold>
      </SettingsGroup>
    </SettingsSection>
  );
}

function AppIcon({ icon }: { icon: string | null | undefined }) {
  return icon ? (
    <img src={icon} alt="" className="size-4 shrink-0" />
  ) : (
    <AppWindow className="size-4 shrink-0 text-muted-foreground" />
  );
}

/** A list of apps, each removable, with a picker to add more. */
function AppListRow(props: {
  title: string;
  description: string;
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
          <RowLabel title={props.title} description={props.description} />
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
              className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background pr-1 pl-2 text-[13px]"
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
                className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" />
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
    <MorphPopover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);

        if (!open) setQuery("");
      }}
    >
      <MorphPopoverTrigger>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 rounded-lg"
          aria-label={props.label}
          title={props.label}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="end" sideOffset={6} radius={12} className="w-72">
        <div className="border-b border-border p-1">
          <Input
            ref={input}
            aria-label="Find an app"
            value={query}
            onChange={setQuery}
            placeholder="Find an app"
            spellCheck={false}
            autoComplete="off"
            leftIcon={<Search className="size-3.5" />}
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
            classNames={{ field: "h-8 rounded-lg border-0 bg-transparent", input: "text-[13px]" }}
          />
        </div>
        <div role="listbox" aria-label="Apps" className="max-h-56 overflow-y-auto p-1">
          {props.choices === null ? (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Loading apps…
            </p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
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
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none",
                  index === activeIndex && "bg-muted",
                )}
              >
                <AppIcon icon={choice.icon} />
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {choice.running ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Running</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  );
}
