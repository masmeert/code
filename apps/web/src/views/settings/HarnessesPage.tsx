import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@masscode/ui/motion/select";
import { Switch } from "@masscode/ui/motion/switch";
import { Textarea } from "@masscode/ui/components/textarea";
import { Tabs, TabsList, TabsTrigger } from "@masscode/ui/motion/tabs";
import { IconButton } from "@/components/icon-button";
import { getHarnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@masscode/ui/lib/utils";
import {
  ClientCommand,
  HarnessColor,
  ProviderKind,
  PROVIDER_NAME,
  type ProviderStatus,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { ArrowDown, ArrowUp, Monitor, Server, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { findDefaultModel, formatHarnessLabel, orderModels } from "../../lib/models.ts";
import { send, updateHarness, useProviders, useStore } from "../../lib/store.ts";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsTextField,
} from "./SettingsControls.tsx";
import { ProviderCard } from "./ProviderCard.tsx";
import { buildMachineOptions, THIS_MAC, toMachine } from "../../lib/machines.ts";

const CONFIG_DIR: Record<ProviderKind, { env: string; placeholder: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", placeholder: "~/.claude" },
  codex: { env: "CODEX_HOME", placeholder: "~/.codex" },
  cursor: { env: "CURSOR_CONFIG_DIR", placeholder: "~/.masscode/cursor" },
};

export function HarnessesPage() {
  const settings = useStore((state) => state.settings);
  const hosts = useStore((state) => state.hosts);
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
                <Server className="size-3.5" />
              ) : (
                <Monitor className="size-3.5" />
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
  const harness = useStore((state) => state.settings.providers[kind]);
  const settings = useStore((state) => state.settings);

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
      <SettingsSection title="Launch">
        <SettingsGroup>
          <SettingsRow label="Binary">
            <SettingsTextField
              label="Binary path"
              isMonospace
              value={harness.binaryPath ?? ""}
              placeholder={`/usr/local/bin/${kind}`}
              onCommit={(binaryPath) => updateHarness(kind, { binaryPath })}
            />
          </SettingsRow>
          <SettingsRow label="Config folder">
            <SettingsTextField
              label={CONFIG_DIR[kind].env}
              isMonospace
              value={harness.configDir ?? ""}
              placeholder={CONFIG_DIR[kind].placeholder}
              onCommit={(configDir) => updateHarness(kind, { configDir })}
            />
          </SettingsRow>
          <SettingsRow label="Launch arguments">
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
      </SettingsSection>
      {status?.linked && status.models.length ? <ModelsSection status={status} /> : null}
    </>
  );
}

function VariablesField({ provider }: { provider: ProviderKind }) {
  const env = useStore((state) => state.settings.providers[provider].env);
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
      <p>Variables</p>
      <Textarea
        aria-label="Variables"
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
        className="mt-2 min-h-14 rounded-lg bg-background font-mono text-xs md:text-xs"
      />
      {invalidLine !== -1 ? (
        <p className="mt-1 text-xs text-destructive">
          Line {invalidLine + 1} isn't saved: write it as KEY=value, like DEBUG=1.
        </p>
      ) : null}
    </div>
  );
}

/** Default model, then every model with its favorite, order and visibility; all of it shapes the model picker. */
function ModelsSection({ status }: { status: ProviderStatus }) {
  const settings = useStore((state) => state.settings);
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
                className="flex h-11 items-center gap-1 pr-3 pl-1.5"
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
                  <Star className={cn("size-3.5", isFavorite && "fill-brand text-brand")} />
                </IconButton>
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-baseline gap-2 pl-1",
                    isHidden && "opacity-50",
                  )}
                >
                  <span className="shrink-0 text-sm">{model.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {model.id}
                  </span>
                </div>
                {model.recommended ? (
                  <span className="mr-1 shrink-0 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                    Recommended
                  </span>
                ) : null}
                <IconButton
                  label={`Move ${model.label} up (⌥↑)`}
                  disabled={index === 0}
                  onClick={() => moveModel(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label={`Move ${model.label} down (⌥↓)`}
                  disabled={index === models.length - 1}
                  onClick={() => moveModel(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
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
                  size="sm"
                  className="ml-2"
                />
              </div>
            );
          })}
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
}
