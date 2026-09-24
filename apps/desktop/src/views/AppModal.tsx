import { Button } from "@/components/motion/button/base";
import { MorphingModal } from "@/components/motion/morphing-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { PROVIDER_AVATAR_CLASS, PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@/lib/utils";
import { DEFAULT_SETTLE_DELAY_MINUTES, type ProviderKind, type ProviderStatus, type Theme } from "@apcode/contracts";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { defaultModel, encodeChoice, PROVIDER_LABEL, recommendedBadge } from "../lib/models.ts";
import { send, updateSettings, useStore } from "../lib/store.ts";

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
    <MorphingModal viewId={view} onClose={() => onView(null)} placement="center" className="max-w-lg">
      {view === "settings" ? (
        <SettingsView />
      ) : null}
    </MorphingModal>
  );
};

// ---------------------------------------------------------------------------

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-5 last:mb-0">
    <h3 className="mb-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
    {children}
  </section>
);

/** Grouped list: one rounded surface, rows separated by hairlines. No overflow clip, so selects can open out of it. */
const SettingsGroup = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-rule rounded-xl border border-border bg-card">{children}</div>
);

const SettingsRow = ({ label, children }: { label: React.ReactNode; children?: React.ReactNode }) => (
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

const SettingsView = () => {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);

  // Sign-in state can change outside the app (e.g. `claude auth logout` in a terminal).
  useEffect(() => send({ _tag: "providers.refresh" }), []);

  return (
    <>
      <h2 className="mb-4 text-sm font-medium">Settings</h2>
      <Section title="Appearance">
        <SettingsGroup>
          <SettingsRow label="Theme">
            <Tabs
              value={settings.theme}
              onValueChange={(v) => updateSettings({ ...settings, theme: v as Theme })}
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
      </Section>
      <Section title="Threads">
        <SettingsGroup>
          <SettingsRow
            label={
              <>
                <p>Settle threads</p>
                <p className="text-xs text-muted-foreground">How long a finished thread you've seen stays in Active</p>
              </>
            }
          >
            <Select
              value={String(settings.settleDelayMinutes ?? DEFAULT_SETTLE_DELAY_MINUTES)}
              onValueChange={(v) => updateSettings({ ...settings, settleDelayMinutes: Number(v) })}
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
                <p>Messages while the agent works</p>
                <p className="text-xs text-muted-foreground">⌘↩ does the other one for a single message</p>
              </>
            }
          >
            <Select
              value={settings.followUp ?? "queue"}
              onValueChange={(v) => updateSettings({ ...settings, followUp: v as "queue" | "steer" })}
              className="w-44"
            >
              <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
                <SelectValue className="min-w-0 truncate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="queue" className="text-[13px]">
                  Wait for the turn
                </SelectItem>
                <SelectItem value="steer" className="text-[13px]">
                  Send right away
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Harnesses">
        <div className="flex flex-col gap-3">
          {(["claude", "codex"] as const).map((kind) => (
            <ProviderCard key={kind} kind={kind} status={providers.find((p) => p.kind === kind)} />
          ))}
          <CommitModelRow />
        </div>
      </Section>
    </>
  );
};

/** Picks the model that writes commit messages left empty; "auto" follows the last harness's default model. */
const CommitModelRow = () => {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const linked = providers.filter((p) => p.linked && p.models.length);
  if (!linked.length) return null;
  const saved = settings.commitModel;
  const listed = saved && linked.some((p) => p.models.some((m) => encodeChoice(p.kind, m.id) === saved));
  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <>
            <p>Commit messages</p>
            <p className="text-xs text-muted-foreground">Writes the message when you commit without one</p>
          </>
        }
      >
        <Select
          value={listed ? saved : "auto"}
          onValueChange={(v) => updateSettings({ ...settings, commitModel: v === "auto" ? null : v })}
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
              return p.models.map((m) => (
                <SelectItem key={encodeChoice(p.kind, m.id)} value={encodeChoice(p.kind, m.id)} label={m.label} className="text-[13px]">
                  <span className="flex items-center gap-1.5">
                    <Logo aria-label={PROVIDER_LABEL[p.kind]} className="size-3.5 shrink-0" />
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

/** CLIs report versions as e.g. "2.1.281 (Claude Code)" or "codex-cli 0.154.0"; keep just the number. */
const shortVersion = (raw: string) => raw.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? raw;

const ProviderCard = ({ kind, status }: { kind: ProviderKind; status: ProviderStatus | undefined }) => {
  const settings = useStore((s) => s.settings);
  const flow = useStore((s) => s.authFlows[kind]);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [code, setCode] = useState("");
  const inFlow = flow && (flow.stage === "starting" || flow.stage === "browser" || flow.stage === "awaiting-code");
  const Logo = PROVIDER_LOGO[kind];

  const statusLine = !status
    ? "Checking…"
    : !status.installed
      ? (status.error ?? "Not installed")
      : status.linked
        ? (status.account ?? "Signed in")
        : "Not signed in";

  const setDefault = (model: string) =>
    send({
      _tag: "settings.update",
      settings: { ...settings, providers: { ...settings.providers, [kind]: { defaultModel: model } } },
    });

  const action = !status?.installed ? null : inFlow ? (
    <Button size="sm" variant="ghost" className="h-7 rounded-lg" onClick={() => send({ _tag: "provider.linkCancel", provider: kind })}>
      Cancel
    </Button>
  ) : status.linked ? (
    confirmUnlink ? (
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 rounded-lg" onClick={() => setConfirmUnlink(false)}>
          Keep
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
          onClick={() => {
            setConfirmUnlink(false);
            send({ _tag: "provider.unlink", provider: kind });
          }}
        >
          Sign out
        </Button>
      </div>
    ) : (
      <Button size="sm" variant="secondary" className="h-7 rounded-lg" onClick={() => setConfirmUnlink(true)}>
        Unlink
      </Button>
    )
  ) : (
    <Button size="sm" className="h-7 rounded-lg" onClick={() => send({ _tag: "provider.link", provider: kind })}>
      Link
    </Button>
  );

  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <div className="flex items-center gap-3">
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", PROVIDER_AVATAR_CLASS[kind])}>
              <Logo className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium">{PROVIDER_LABEL[kind]}</span>
                {status?.version ? (
                  <span className="text-xs text-muted-foreground tabular-nums">v{shortVersion(status.version)}</span>
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
                    status?.linked ? "bg-emerald-500" : status?.installed ? "bg-warning" : "bg-muted-foreground/40",
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
          This signs {PROVIDER_LABEL[kind]} out on this Mac, including in your terminal.
        </p>
      ) : null}

      {inFlow ? (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">
          {flow.stage === "starting" ? (
            "Starting sign-in…"
          ) : flow.stage === "browser" ? (
            "Finish signing in in your browser."
          ) : (
            <>
              <p className="mb-2">Sign in in your browser, then paste the code it shows.</p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && code.trim()) send({ _tag: "provider.linkCode", provider: kind, code });
                  }}
                  placeholder="Paste code"
                  className="selectable h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
                <Button
                  size="sm"
                  className="h-7 rounded-lg"
                  disabled={!code.trim()}
                  onClick={() => send({ _tag: "provider.linkCode", provider: kind, code })}
                >
                  Submit
                </Button>
              </div>
            </>
          )}
          {flow.url ? (
            <a href={flow.url} target="_blank" rel="noreferrer" className="mt-2 block truncate underline">
              Open sign-in page again
            </a>
          ) : null}
        </div>
      ) : flow?.stage === "failed" ? (
        <p className="px-3 py-2.5 text-xs text-destructive">{flow.message ?? "Sign-in failed"}</p>
      ) : null}

      {status?.linked && status.models.length ? (
        <SettingsRow label="Default model">
          <Select value={defaultModel([status], settings, kind) ?? status.models[0]!.id} onValueChange={setDefault} className="w-52">
            <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
              <SelectValue className="min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent>
              {status.models.map((m) => (
                <SelectItem key={m.id} value={m.id} label={m.label} className="text-[13px]">
                  <span className="flex items-center gap-1.5">
                    {m.label}
                    {m.recommended ? recommendedBadge() : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
};
