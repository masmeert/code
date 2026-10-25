import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@masmeert/ui/select";
import { Switch } from "@masmeert/ui/switch";
import { Textarea } from "@masmeert/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@masmeert/ui/tabs";
import { IconButton } from "@/shared/ui";
import {
  formatHarnessLabel,
  getHarnessTint,
  PROVIDER_LOGO,
  useProviders,
} from "@/entities/provider";
import { cn } from "@masscode/ui/lib/utils";
import {
  ClientCommand,
  HarnessColor,
  ProviderKind,
  PROVIDER_NAME,
  type ProviderStatus,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import {
  IconArrowDown,
  IconArrowUp,
  IconDeviceDesktop,
  IconServer,
  IconStar,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { findDefaultModel, orderModels } from "@masscode/client";
import { buildMachineOptions, THIS_MAC, toMachine, useHostStore } from "@/entities/host";
import { updateHarness, useSetting, useSettings } from "@/entities/settings";
import { send } from "@/shared/api";
import {
  RowLabel,
  SettingsDisclosure,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsTextField,
} from "./settings-controls.tsx";
import { ProviderCard } from "./provider-card.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

const CONFIG_DIR: Record<ProviderKind, { env: string; placeholder: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", placeholder: "~/.claude" },
  codex: { env: "CODEX_HOME", placeholder: "~/.codex" },
  cursor: { env: "CURSOR_CONFIG_DIR", placeholder: "~/.masscode/cursor" },
};

export function HarnessesPage() {
  const settings = useSettings();
  const hosts = useHostStore((state) => state.hosts);
  const [kind, setKind] = useState<ProviderKind>("claude");
  // The machine whose harnesses are on show: this Mac (null) or a remote host.
  const [machine, setMachine] = useState<string | null>(null);
  const providers = useProviders(machine);
  const status = providers.find((provider) => provider.kind === kind);

  // Sign-in state can change outside the app, on a host too.
  useEffect(() => {
    if (machine !== null) send(ClientCommand.cases["providers.refresh"].make({}), machine);
  }, [machine]);

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <Tabs
          value={kind}
          onValueChange={(value) => Schema.is(ProviderKind)(value) && setKind(value)}
        >
          <TabsList>
            {ProviderKind.literals.map((entry) => {
              const Logo = PROVIDER_LOGO[entry];

              return (
                <TabsTrigger key={entry} value={entry}>
                  <span className="flex items-center gap-1.5">
                    <Logo className="size-3.5" />
                    {formatHarnessLabel(settings, entry)}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        {Object.keys(hosts).length > 0 ? (
          <SettingsSelect
            value={machine ?? THIS_MAC}
            onChange={(value) => setMachine(toMachine(value))}
            options={buildMachineOptions(hosts).map((option) => ({
              value: option.value,
              label: option.label,
              icon: option.machine ? (
                <IconServer className="size-3.5" />
              ) : (
                <IconDeviceDesktop className="size-3.5" />
              ),
            }))}
          />
        ) : null}
      </div>
      {/* Keyed so drafts and confirmations don't carry over to the other harness or machine. */}
      <div key={`${kind}:${machine ?? THIS_MAC}`}>
        <SettingsSection title="Account">
          <ProviderCard kind={kind} status={status} host={machine} />
        </SettingsSection>
        {/* Name, color and models apply everywhere, and a host's launch settings are its own. */}
        {machine === null ? <LocalHarnessSettings kind={kind} status={status} /> : null}
      </div>
    </>
  );
}

function LocalHarnessSettings({
  kind,
  status,
}: {
  kind: ProviderKind;
  status: ProviderStatus | undefined;
}) {
  const harness = useSetting((settings) => settings.providers[kind]);
  const settings = useSettings();

  return (
    <>
      <SettingsSection title="Display">
        <SettingsGroup>
          <SettingsRow label="Name">
            <SettingsTextField
              label="Display name"
              value={harness.displayName ?? ""}
              placeholder={PROVIDER_NAME[kind]}
              onCommit={(displayName) => updateHarness(kind, { displayName })}
            />
          </SettingsRow>
          <SettingsRow label="Color">
            <div role="radiogroup" aria-label="Color" className="flex gap-1">
              {HarnessColor.literals.map((color) => {
                const isSelected = (harness.color ?? "brand") === color;

                return (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={color}
                    title={color}
                    onClick={() => updateHarness(kind, { color })}
                    className={cn(
                      "grid size-7 place-items-center rounded-full border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected && "border-foreground/70",
                    )}
                  >
                    <span
                      className={cn(
                        "size-4 rounded-full",
                        getHarnessTint(settings, kind, color).swatch,
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      {status?.linked && status.models.length ? <ModelsSection status={status} /> : null}
      <SettingsDisclosure
        title="Advanced"
        isInitiallyOpen={Boolean(
          harness.binaryPath ||
          harness.configDir ||
          harness.launchArgs?.length ||
          Object.keys(harness.env ?? {}).length,
        )}
      >
        <SettingsGroup>
          <SettingsRow
            label={<RowLabel title="Binary path" description="Empty uses the one on your PATH" />}
          >
            <SettingsTextField
              label="Binary path"
              isMonospace
              value={harness.binaryPath ?? ""}
              placeholder={`/usr/local/bin/${kind}`}
              onCommit={(binaryPath) => updateHarness(kind, { binaryPath })}
            />
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Config folder"
                description={<span className="font-mono">{CONFIG_DIR[kind].env}</span>}
              />
            }
          >
            <SettingsTextField
              label={CONFIG_DIR[kind].env}
              isMonospace
              value={harness.configDir ?? ""}
              placeholder={CONFIG_DIR[kind].placeholder}
              onCommit={(configDir) => updateHarness(kind, { configDir })}
            />
          </SettingsRow>
          <SettingsRow
            label={<RowLabel title="Launch arguments" description="Added to every launch" />}
          >
            <SettingsTextField
              label="Launch arguments"
              isMonospace
              value={(harness.launchArgs ?? []).join(" ")}
              placeholder={kind === "codex" ? "-c key=value" : "--flag value"}
              onCommit={(args) =>
                updateHarness(kind, { launchArgs: args.split(/\s+/).filter(Boolean) })
              }
            />
          </SettingsRow>
          <VariablesField provider={kind} />
        </SettingsGroup>
      </SettingsDisclosure>
    </>
  );
}

function VariablesField({ provider }: { provider: ProviderKind }) {
  const env = useSetting((settings) => settings.providers[provider].env);

  const saved = Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const [draft, setDraft] = useState(saved);

  const lines = draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const invalidLine = draft
    .split("\n")
    .findIndex((line) => line.trim() && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim()));

  return (
    <div className="px-3 py-2">
      <RowLabel title="Environment variables" description="One KEY=value per line" />
      <Textarea
        aria-label="Environment variables"
        aria-invalid={invalidLine !== -1 || undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (invalidLine !== -1 || draft === saved) return;
          updateHarness(provider, {
            env: Object.fromEntries(
              lines.map((line) => [
                line.slice(0, line.indexOf("=")),
                line.slice(line.indexOf("=") + 1),
              ]),
            ),
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && draft !== saved) {
            event.stopPropagation();
            setDraft(saved);
          }
        }}
        placeholder="ANTHROPIC_BASE_URL=https://…"
        spellCheck={false}
        className={cn(typeClass("caption"), "mt-2 min-h-14 rounded-lg bg-background font-mono")}
      />
      {invalidLine !== -1 ? (
        <p className={cn(typeClass("caption"), "mt-1 text-destructive")}>
          Line {invalidLine + 1} isn't saved: write it as KEY=value, like DEBUG=1.
        </p>
      ) : null}
    </div>
  );
}

/** Default model, then every model with its favorite, order and visibility; all of it shapes the model picker. */
function ModelsSection({ status }: { status: ProviderStatus }) {
  const settings = useSettings();
  const kind = status.kind;
  const harness = settings.providers[kind];
  const models = orderModels(status.models, harness);
  const hidden = harness.hiddenModels ?? [];
  const favorites = harness.favoriteModels ?? [];
  const shown = models.filter((model) => !hidden.includes(model.id));

  function moveModel(index: number, offset: number) {
    const target = index + offset;

    if (target < 0 || target >= models.length) return;
    const ids = models.map((model) => model.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    updateHarness(kind, { modelOrder: ids });
  }

  return (
    <SettingsSection title="Models">
      <div className="flex flex-col gap-3">
        <SettingsGroup>
          <SettingsRow label="Default model">
            <Select
              value={findDefaultModel([status], settings, kind) ?? shown[0]?.id}
              onValueChange={(model) => updateHarness(kind, { defaultModel: model })}
              className="w-52"
            >
              <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
                <SelectValue className="min-w-0 truncate" />
              </SelectTrigger>
              <SelectContent>
                {shown.map((model) => (
                  <SelectItem key={model.id} value={model.id} className="text-[13px]">
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup>
          {models.map((model, index) => {
            const isHidden = hidden.includes(model.id);
            const isFavorite = favorites.includes(model.id);

            return (
              <div
                key={model.id}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown"))
                    return;
                  event.preventDefault();
                  moveModel(index, event.key === "ArrowUp" ? -1 : 1);
                }}
                className="group/model flex h-11 items-center gap-1 pr-3 pl-1.5"
              >
                <IconButton
                  label={isFavorite ? `Unfavorite ${model.label}` : `Favorite ${model.label}`}
                  onClick={() =>
                    updateHarness(kind, {
                      favoriteModels: isFavorite
                        ? favorites.filter((id) => id !== model.id)
                        : [...favorites, model.id],
                    })
                  }
                >
                  <IconStar className={cn("size-3.5", isFavorite && "fill-brand text-brand")} />
                </IconButton>
                <span
                  title={model.id}
                  className={cn(
                    typeClass("body"),
                    "min-w-0 flex-1 truncate pl-1",
                    isHidden && "text-muted-foreground",
                  )}
                >
                  {model.label}
                </span>
                {model.recommended ? (
                  <span className="mr-1 shrink-0 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                    Recommended
                  </span>
                ) : null}
                <div className="flex opacity-0 transition-opacity group-focus-within/model:opacity-100 group-hover/model:opacity-100">
                  <IconButton
                    label={`Move ${model.label} up (⌥↑)`}
                    disabled={index === 0}
                    onClick={() => moveModel(index, -1)}
                  >
                    <IconArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={`Move ${model.label} down (⌥↓)`}
                    disabled={index === models.length - 1}
                    onClick={() => moveModel(index, 1)}
                  >
                    <IconArrowDown className="size-3.5" />
                  </IconButton>
                </div>
                <Switch
                  checked={!isHidden}
                  // The picker always keeps one model to pick.
                  disabled={!isHidden && shown.length === 1}
                  ariaLabel={`Show ${model.label} in the model picker`}
                  onCheckedChange={(isShown) =>
                    updateHarness(kind, {
                      hiddenModels: isShown
                        ? hidden.filter((id) => id !== model.id)
                        : [...hidden, model.id],
                    })
                  }
                  size="compact"
                  className="ml-2"
                />
              </div>
            );
          })}
        </SettingsGroup>
      </div>
      <p className={cn(typeClass("caption"), "mt-2 px-1 text-muted-foreground")}>
        Starred models are listed first in the picker; switched-off ones are hidden from it.
      </p>
    </SettingsSection>
  );
}
