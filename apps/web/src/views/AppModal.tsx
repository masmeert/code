import { Button } from "@apcode/ui/motion/button/base";
import { MorphingModal } from "@apcode/ui/motion/morphing-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@apcode/ui/motion/select";
import { Input } from "@apcode/ui/motion/input";
import { SharedLayoutBg } from "@apcode/ui/motion/shared-layout-bg";
import { Switch } from "@apcode/ui/motion/switch";
import { Textarea } from "@apcode/ui/components/textarea";
import { Tabs, TabsList, TabsTrigger } from "@apcode/ui/motion/tabs";
import { IconButton } from "@/components/icon-button";
import { harnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@apcode/ui/lib/utils";
import {
  ClientCommand,
  DEFAULT_SETTLE_DELAY_MINUTES,
  HarnessColor,
  ProviderKind,
  type ProviderStatus,
  Theme,
} from "@apcode/contracts";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  GitCommitHorizontal,
  Monitor,
  Moon,
  Palette,
  Settings2,
  Star,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  defaultModel,
  encodeChoice,
  harnessLabel,
  orderedModels,
  PROVIDER_LABEL,
  visibleModels,
} from "../lib/models.ts";
import { send, updateHarness, updateSettings, useStore } from "../lib/store.ts";

export type ModalView = "settings";

/** One modal for the whole app; switching views morphs the panel between them. */
export const AppModal = (props: {
  view: ModalView | null;
  onView: (view: ModalView | null) => void;
}) => {
  const { view, onView } = props;
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onView(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onView]);

  return (
    <MorphingModal
      viewId={view}
      onClose={() => onView(null)}
      placement="center"
      className="max-w-3xl"
    >
      {view === "settings" ? <SettingsView /> : null}
    </MorphingModal>
  );
};

// ---------------------------------------------------------------------------

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-5 last:mb-0">
    <h3 className="mb-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {title}
    </h3>
    {children}
  </section>
);

/** Grouped list: one rounded surface, rows separated by hairlines. No overflow clip, so selects can open out of it. */
const SettingsGroup = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-rule rounded-xl border border-border bg-card">{children}</div>
);

const SettingsRow = ({
  label,
  children,
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
}) => (
  <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
    <div className="min-w-0 flex-1">{label}</div>
    {children ? <div className="shrink-0">{children}</div> : null}
  </div>
);

const SETTLE_DELAYS: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: "Right away" },
  { minutes: 1, label: "After 1 minute" },
  { minutes: 5, label: "After 5 minutes" },
  { minutes: 15, label: "After 15 minutes" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
];

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const PAGES = [
  { page: "general", title: "General", icon: Settings2 },
  { page: "appearance", title: "Appearance", icon: Palette },
  { page: "harnesses", title: "Harnesses", icon: Bot },
  { page: "git", title: "Git", icon: GitCommitHorizontal },
] as const;

type SettingsPage = (typeof PAGES)[number]["page"];

function SettingsView() {
  const settings = useStore((s) => s.settings);
  const [page, setPage] = useState<SettingsPage>("general");

  // Sign-in state can change outside the app (e.g. `claude auth logout` in a terminal).
  useEffect(() => send(ClientCommand.cases["providers.refresh"].make({})), []);

  return (
    <div className="-m-5 flex h-[min(36rem,calc(100vh-4rem))]">
      <nav
        aria-label="Settings"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const next =
            PAGES[
              (PAGES.findIndex((entry) => entry.page === page) +
                (e.key === "ArrowDown" ? 1 : -1) +
                PAGES.length) %
                PAGES.length
            ]!.page;
          setPage(next);
          e.currentTarget.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus();
        }}
        className="flex w-48 shrink-0 flex-col border-r border-border bg-sidebar p-3"
      >
        <h2 className="px-2 pt-1 pb-3 text-sm font-medium">Settings</h2>
        <SharedLayoutBg inset={0} pillClassName="rounded-lg bg-muted/50" className="gap-0.5">
          {PAGES.map(({ page: entry, title, icon: Icon }) => (
            <div key={entry}>
              <button
                type="button"
                aria-current={entry === page ? "page" : undefined}
                tabIndex={entry === page ? 0 : -1}
                data-page={entry}
                onClick={() => setPage(entry)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring",
                  entry === page && "bg-muted text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {title}
              </button>
            </div>
          ))}
        </SharedLayoutBg>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-5">
        {Match.value(page).pipe(
          Match.when("general", () => (
            <Section title="Threads">
              <SettingsGroup>
                <SettingsRow
                  label={
                    <>
                      <p>Settle threads</p>
                      <p className="text-xs text-muted-foreground">
                        How long a finished thread stays in Active once seen
                      </p>
                    </>
                  }
                >
                  <Select
                    value={String(settings.settleDelayMinutes ?? DEFAULT_SETTLE_DELAY_MINUTES)}
                    onValueChange={(v) =>
                      updateSettings({ ...settings, settleDelayMinutes: Number(v) })
                    }
                    className="w-44"
                  >
                    <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
                      <SelectValue className="min-w-0 truncate" />
                    </SelectTrigger>
                    <SelectContent>
                      {SETTLE_DELAYS.map(({ minutes, label }) => (
                        <SelectItem key={minutes} value={String(minutes)} className="text-[13px]">
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
                <SettingsRow
                  label={
                    <>
                      <p>Sending while the agent works</p>
                      <p className="text-xs text-muted-foreground">
                        ⌘↩ does the opposite for one message
                      </p>
                    </>
                  }
                >
                  <Select
                    value={settings.followUp ?? "queue"}
                    onValueChange={(v) =>
                      updateSettings({ ...settings, followUp: v === "steer" ? "steer" : "queue" })
                    }
                    className="w-44"
                  >
                    <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
                      <SelectValue className="min-w-0 truncate" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="queue" className="text-[13px]">
                        Queue until done
                      </SelectItem>
                      <SelectItem value="steer" className="text-[13px]">
                        Send immediately
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsRow>
              </SettingsGroup>
            </Section>
          )),
          Match.when("appearance", () => (
            <SettingsGroup>
              <SettingsRow label="Theme">
                <Tabs
                  value={settings.theme}
                  onValueChange={(v) =>
                    Schema.is(Theme)(v) && updateSettings({ ...settings, theme: v })
                  }
                >
                  <TabsList>
                    {THEMES.map(({ value, label, icon: Icon }) => (
                      <TabsTrigger key={value} value={value}>
                        <span className="flex items-center gap-1.5">
                          <Icon className="size-3.5" />
                          {label}
                        </span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </SettingsRow>
            </SettingsGroup>
          )),
          Match.when("harnesses", () => <HarnessesPage />),
          Match.when("git", () => <CommitModelRow />),
          Match.exhaustive,
        )}
      </div>
    </div>
  );
}

/** Picks the model that writes commit messages left empty; "auto" follows the last harness's default model. */
const CommitModelRow = () => {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const linked = providers.filter((p) => p.linked && p.models.length);
  if (!linked.length)
    return (
      <p className="px-1 text-sm text-muted-foreground">
        Link Claude Code or Codex to pick the model that writes commit messages.
      </p>
    );
  const saved = settings.commitModel;
  const listed =
    saved &&
    linked.some((p) =>
      visibleModels(p.models, settings.providers[p.kind]).some(
        (m) => encodeChoice(p.kind, m.id) === saved,
      ),
    );
  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <>
            <p>Commit messages</p>
            <p className="text-xs text-muted-foreground">
              Writes the message when you commit without one
            </p>
          </>
        }
      >
        <Select
          value={listed ? saved : "auto"}
          onValueChange={(v) =>
            updateSettings({ ...settings, commitModel: v === "auto" ? null : v })
          }
          className="w-52"
        >
          <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto" className="text-[13px]">
              Default model
            </SelectItem>
            {linked.flatMap((p) => {
              const Logo = PROVIDER_LOGO[p.kind];
              return visibleModels(p.models, settings.providers[p.kind]).map((m) => (
                <SelectItem
                  key={encodeChoice(p.kind, m.id)}
                  value={encodeChoice(p.kind, m.id)}
                  label={m.label}
                  className="text-[13px]"
                >
                  <span className="flex items-center gap-1.5">
                    <Logo
                      aria-label={harnessLabel(settings, p.kind)}
                      className="size-3.5 shrink-0"
                    />
                    {m.label}
                  </span>
                </SelectItem>
              ));
            })}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
};

const CONFIG_DIR: Record<ProviderKind, { env: string; placeholder: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", placeholder: "~/.claude" },
  codex: { env: "CODEX_HOME", placeholder: "~/.codex" },
};

function HarnessesPage() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const [kind, setKind] = useState<ProviderKind>("claude");
  const status = providers.find((p) => p.kind === kind);
  const harness = settings.providers[kind];

  return (
    <>
      <Tabs
        value={kind}
        onValueChange={(v) => Schema.is(ProviderKind)(v) && setKind(v)}
        className="mb-5"
      >
        <TabsList>
          {ProviderKind.literals.map((entry) => {
            const Logo = PROVIDER_LOGO[entry];
            return (
              <TabsTrigger key={entry} value={entry}>
                <span className="flex items-center gap-1.5">
                  <Logo className="size-3.5" />
                  {harnessLabel(settings, entry)}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      {/* Keyed so drafts and confirmations don't carry over to the other harness. */}
      <div key={kind}>
        <Section title="Account">
          <ProviderCard kind={kind} status={status} />
        </Section>
        <Section title="Display">
          <SettingsGroup>
            <SettingsRow label="Name">
              <SettingsTextField
                label="Display name"
                value={harness.displayName ?? ""}
                placeholder={PROVIDER_LABEL[kind]}
                onCommit={(displayName) => updateHarness(kind, { displayName })}
              />
            </SettingsRow>
            <SettingsRow label="Color">
              <div role="radiogroup" aria-label="Color" className="flex gap-1">
                {HarnessColor.literals.map((color) => {
                  const selected = (harness.color ?? "brand") === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={color}
                      title={color}
                      onClick={() => updateHarness(kind, { color })}
                      className={cn(
                        "grid size-7 place-items-center rounded-full border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "border-foreground/70",
                      )}
                    >
                      <span
                        className={cn(
                          "size-4 rounded-full",
                          harnessTint(settings, kind, color).swatch,
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            </SettingsRow>
          </SettingsGroup>
        </Section>
        <Section title="Launch">
          <SettingsGroup>
            <SettingsRow label="Binary">
              <SettingsTextField
                label="Binary path"
                mono
                value={harness.binaryPath ?? ""}
                placeholder={`/usr/local/bin/${kind}`}
                onCommit={(binaryPath) => updateHarness(kind, { binaryPath })}
              />
            </SettingsRow>
            <SettingsRow label="Config folder">
              <SettingsTextField
                label={CONFIG_DIR[kind].env}
                mono
                value={harness.configDir ?? ""}
                placeholder={CONFIG_DIR[kind].placeholder}
                onCommit={(configDir) => updateHarness(kind, { configDir })}
              />
            </SettingsRow>
            <SettingsRow label="Launch arguments">
              <SettingsTextField
                label="Launch arguments"
                mono
                value={(harness.launchArgs ?? []).join(" ")}
                placeholder={kind === "claude" ? "--flag value" : "-c key=value"}
                onCommit={(args) =>
                  updateHarness(kind, { launchArgs: args.split(/\s+/).filter(Boolean) })
                }
              />
            </SettingsRow>
            <VariablesField provider={kind} />
          </SettingsGroup>
        </Section>
        {status?.linked && status.models.length ? <ModelsSection status={status} /> : null}
      </div>
    </>
  );
}

/** Text setting saved on blur or Enter. Esc reverts an edit; with nothing to revert it closes Settings as usual. */
function SettingsTextField(props: {
  label: string;
  value: string;
  placeholder: string;
  mono?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  return (
    <Input
      aria-label={props.label}
      value={draft}
      onChange={setDraft}
      placeholder={props.placeholder}
      spellCheck={false}
      autoComplete="off"
      onBlur={() => draft.trim() !== props.value && props.onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape" && draft !== props.value) {
          e.stopPropagation();
          setDraft(props.value);
        }
      }}
      className="w-64"
      classNames={{
        field: "h-8 rounded-lg bg-background",
        input: cn("pl-2.5 text-[13px]", props.mono && "font-mono text-xs"),
      }}
    />
  );
}

function VariablesField({ provider }: { provider: ProviderKind }) {
  const env = useStore((s) => s.settings.providers[provider].env);
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
        onChange={(e) => setDraft(e.target.value)}
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
        onKeyDown={(e) => {
          if (e.key === "Escape" && draft !== saved) {
            e.stopPropagation();
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
  const settings = useStore((s) => s.settings);
  const kind = status.kind;
  const harness = settings.providers[kind];
  const models = orderedModels(status.models, harness);
  const hidden = harness.hiddenModels ?? [];
  const favorites = harness.favoriteModels ?? [];
  const shown = models.filter((m) => !hidden.includes(m.id));

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= models.length) return;
    const ids = models.map((m) => m.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    updateHarness(kind, { modelOrder: ids });
  }

  return (
    <Section title="Models">
      <div className="flex flex-col gap-3">
        <SettingsGroup>
          <SettingsRow label="Default model">
            <Select
              value={defaultModel([status], settings, kind) ?? shown[0]!.id}
              onValueChange={(model) => updateHarness(kind, { defaultModel: model })}
              className="w-52"
            >
              <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
                <SelectValue className="min-w-0 truncate" />
              </SelectTrigger>
              <SelectContent>
                {shown.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-[13px]">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup>
          {models.map((model, index) => {
            const off = hidden.includes(model.id);
            const favorite = favorites.includes(model.id);
            return (
              <div
                key={model.id}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(index, e.key === "ArrowUp" ? -1 : 1);
                }}
                className="flex h-11 items-center gap-1 pr-3 pl-1.5"
              >
                <IconButton
                  label={favorite ? `Unfavorite ${model.label}` : `Favorite ${model.label}`}
                  onClick={() =>
                    updateHarness(kind, {
                      favoriteModels: favorite
                        ? favorites.filter((id) => id !== model.id)
                        : [...favorites, model.id],
                    })
                  }
                >
                  <Star className={cn("size-3.5", favorite && "fill-amber-500 text-amber-500")} />
                </IconButton>
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-baseline gap-2 pl-1",
                    off && "opacity-50",
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
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label={`Move ${model.label} down (⌥↓)`}
                  disabled={index === models.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <Switch
                  checked={!off}
                  // The picker always keeps one model to pick.
                  disabled={!off && shown.length === 1}
                  ariaLabel={`Show ${model.label} in the model picker`}
                  onCheckedChange={(on) =>
                    updateHarness(kind, {
                      hiddenModels: on
                        ? hidden.filter((id) => id !== model.id)
                        : [...hidden, model.id],
                    })
                  }
                  className="ml-2"
                />
              </div>
            );
          })}
        </SettingsGroup>
      </div>
    </Section>
  );
}

/** CLIs report versions as e.g. "2.1.281 (Claude Code)" or "codex-cli 0.154.0"; keep just the number. */
const shortVersion = (raw: string) => raw.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? raw;

const ProviderCard = ({
  kind,
  status,
}: {
  kind: ProviderKind;
  status: ProviderStatus | undefined;
}) => {
  const settings = useStore((s) => s.settings);
  const flow = useStore((s) => s.authFlows[kind]);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [code, setCode] = useState("");
  const inFlow =
    flow &&
    (flow.stage === "starting" || flow.stage === "browser" || flow.stage === "awaiting-code");
  const Logo = PROVIDER_LOGO[kind];

  const statusLine = !status
    ? "Checking…"
    : !status.installed
      ? (status.error ?? "Not installed")
      : status.linked
        ? (status.account ?? "Signed in")
        : "Not signed in";

  const action = !status?.installed ? null : inFlow ? (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 rounded-lg"
      onClick={() => send(ClientCommand.cases["provider.linkCancel"].make({ provider: kind }))}
    >
      Cancel
    </Button>
  ) : status.linked ? (
    confirmUnlink ? (
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg"
          onClick={() => setConfirmUnlink(false)}
        >
          Keep
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
          onClick={() => {
            setConfirmUnlink(false);
            send(ClientCommand.cases["provider.unlink"].make({ provider: kind }));
          }}
        >
          Sign out
        </Button>
      </div>
    ) : (
      <Button
        size="sm"
        variant="secondary"
        className="h-7 rounded-lg"
        onClick={() => setConfirmUnlink(true)}
      >
        Unlink
      </Button>
    )
  ) : (
    <Button
      size="sm"
      className="h-7 rounded-lg"
      onClick={() => send(ClientCommand.cases["provider.link"].make({ provider: kind }))}
    >
      Link
    </Button>
  );

  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                harnessTint(settings, kind).avatar,
              )}
            >
              <Logo className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium">{harnessLabel(settings, kind)}</span>
                {status?.version ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    v{shortVersion(status.version)}
                  </span>
                ) : null}
                {status?.linked && status.plan ? (
                  <span className="self-center rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground capitalize">
                    {status.plan}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    status?.linked
                      ? "bg-emerald-500"
                      : status?.installed
                        ? "bg-warning"
                        : "bg-muted-foreground/40",
                  )}
                />
                <span className="truncate">{statusLine}</span>
              </div>
            </div>
          </div>
        }
      >
        {action}
      </SettingsRow>

      {confirmUnlink ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          This signs {harnessLabel(settings, kind)} out on this Mac, including in your terminal.
        </p>
      ) : null}

      {inFlow ? (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">
          {Match.value(flow.stage).pipe(
            Match.when("starting", () => "Starting sign-in…"),
            Match.when("browser", () => "Finish signing in in your browser."),
            Match.orElse(() => (
              <>
                <p className="mb-2">Sign in in your browser, then paste the code it shows.</p>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && code.trim())
                        send(
                          ClientCommand.cases["provider.linkCode"].make({ provider: kind, code }),
                        );
                    }}
                    placeholder="Paste code"
                    className="selectable h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                  <Button
                    size="sm"
                    className="h-7 rounded-lg"
                    disabled={!code.trim()}
                    onClick={() =>
                      send(ClientCommand.cases["provider.linkCode"].make({ provider: kind, code }))
                    }
                  >
                    Submit
                  </Button>
                </div>
              </>
            )),
          )}
          {flow.url ? (
            <a
              href={flow.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block truncate underline"
            >
              Open sign-in page again
            </a>
          ) : null}
        </div>
      ) : flow?.stage === "failed" ? (
        <p className="px-3 py-2.5 text-xs text-destructive">{flow.message ?? "Sign-in failed"}</p>
      ) : null}
    </SettingsGroup>
  );
};
