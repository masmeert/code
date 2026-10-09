import { Button } from "@masscode/ui/motion/button/base";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@masscode/ui/motion/select";
import { Input } from "@masscode/ui/motion/input";
import { SharedLayoutBg } from "@masscode/ui/motion/shared-layout-bg";
import { Switch } from "@masscode/ui/motion/switch";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@masscode/ui/motion/popover-morph";
import { ModelList } from "@masscode/ui/agents/prompt-input";
import { Skeleton } from "@masscode/ui/components/skeleton";
import { ScrollArea } from "@masscode/ui/components/scroll-area";
import { Textarea } from "@masscode/ui/components/textarea";
import { Tabs, TabsList, TabsTrigger } from "@masscode/ui/motion/tabs";
import { IconButton } from "@/components/icon-button";
import { getHarnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { SOURCE_CONTROL_LABEL, SOURCE_CONTROL_LOGO } from "@/components/source-control-logo";
import { cn } from "@masscode/ui/lib/utils";
import {
  ClientCommand,
  DEFAULT_AUTO_SHELVE_DAYS,
  Effort,
  HarnessColor,
  MergeMethod,
  PermissionLevel,
  ProviderKind,
  SourceControlKind,
  type SourceControlStatus,
  WritingStyle,
  HostStatus,
  type ProjectConfig,
  PROVIDER_NAME,
  type ProviderStatus,
  Theme,
  UpdateStatus,
} from "@masscode/contracts";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Columns2,
  FolderGit2,
  GitCommitHorizontal,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Rows2,
  Search,
  Server,
  Settings2,
  Star,
  Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  EFFORT_LABEL,
  EFFORTS,
  forgetFullAccessAsRoot,
  PERMISSION_LABEL,
} from "../lib/composer.ts";
import {
  decodeChoice,
  findDefaultModel,
  getFavoriteChoices,
  formatHarnessLabel,
  buildModelChoices,
  orderModels,
} from "../lib/models.ts";
import {
  readProjectConfig,
  scanProjects,
  send,
  updateProjectConfig,
  toggleFavoriteModel,
  updateHarness,
  updateSettings,
  useProviders,
  useStore,
} from "../lib/store.ts";
import { useUpdateStatus } from "../lib/updates.ts";

export type ModalView = "settings";

/** One modal for the whole app; switching views morphs the panel between them. */
export function AppModal(props: {
  view: ModalView | null;
  onView: (view: ModalView | null) => void;
}) {
  const { view, onView } = props;

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
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Grouped list: one rounded surface, rows separated by hairlines. No overflow clip, so selects can open out of it. */
function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-rule rounded-xl border border-border bg-card">{children}</div>
  );
}

function SettingsRow({ label, children }: { label: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
      <div className="min-w-0 flex-1">{label}</div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

/** A settings dropdown; `label` is what the closed trigger shows when an option's content isn't plain text. */
function SettingsSelect(props: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string; icon?: React.ReactNode }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={props.onChange}
      disabled={props.disabled}
      className={props.className ?? "w-44"}
    >
      <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            label={option.label}
            className="text-[13px]"
          >
            {option.icon ? (
              <span className="flex items-center gap-1.5">
                {option.icon}
                {option.label}
              </span>
            ) : (
              option.label
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Every linked harness's models behind the composer's favorites and harness tabs, under a row for `fallback` (saved as null). */
function SettingsModelSelect(props: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  fallback: string;
  className: string;
}) {
  const settings = useStore((state) => state.settings);
  const providers = useStore((state) => state.providers);
  const [isOpen, setIsOpen] = useState(false);
  const models = buildModelChoices(providers, settings);
  const current = models.find((option) => option.value === props.value);

  return (
    <MorphPopover open={isOpen} onOpenChange={setIsOpen} className={props.className}>
      <MorphPopoverTrigger>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] whitespace-nowrap text-foreground transition-colors outline-none hover:border-border-strong focus-visible:ring-4 focus-visible:ring-ring"
        >
          {current ? (
            <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
              {current.groupIcon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">
            {current?.label ?? props.fallback}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out",
              isOpen && "rotate-180",
            )}
          />
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="start" sideOffset={6} radius={12}>
        <div className="border-b border-border p-1">
          <button
            type="button"
            onClick={() => {
              props.onChange(null);
              setIsOpen(false);
            }}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors outline-none hover:bg-muted focus-visible:bg-muted",
              current ? "text-muted-foreground hover:text-foreground" : "text-foreground",
            )}
          >
            <span className="flex-1">{props.fallback}</span>
            {current ? null : <Check className="size-3.5 shrink-0" />}
          </button>
        </div>
        <ModelList
          models={models}
          value={current?.value}
          onChange={props.onChange}
          onClose={() => setIsOpen(false)}
          favorites={getFavoriteChoices(settings)}
          onToggleFavorite={toggleFavoriteModel}
        />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

function RowLabel({ title, description }: { title: string; description: string }) {
  return (
    <>
      <p>{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </>
  );
}

const AUTO_SHELVE_DAYS = [1, 3, 7, 14, 30];

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const PAGES = [
  { page: "general", title: "General", icon: Settings2 },
  { page: "projects", title: "Projects", icon: FolderGit2 },
  { page: "appearance", title: "Appearance", icon: Palette },
  { page: "harnesses", title: "Harnesses", icon: Bot },
  { page: "git", title: "Git", icon: GitCommitHorizontal },
  { page: "connections", title: "Connections", icon: Server },
] as const;

type SettingsPage = (typeof PAGES)[number]["page"];

function SettingsView() {
  const settings = useStore((state) => state.settings);
  const [page, setPage] = useState<SettingsPage>("general");

  // Hosts are reached over SSH by the desktop app.
  const pages = PAGES.filter((entry) => entry.page !== "connections" || window.desktop);

  // Sign-in state can change outside the app (e.g. `claude auth logout` in a terminal).
  useEffect(() => send(ClientCommand.cases["providers.refresh"].make({})), []);

  return (
    <div className="-m-5 flex h-[min(36rem,calc(100vh-4rem))]">
      <nav
        aria-label="Settings"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const next =
            pages[
              (pages.findIndex((entry) => entry.page === page) +
                (event.key === "ArrowDown" ? 1 : -1) +
                pages.length) %
                pages.length
            ].page;
          setPage(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus();
        }}
        className="flex w-48 shrink-0 flex-col border-r border-border bg-sidebar p-3"
      >
        <h2 className="px-2 pt-1 pb-3 text-sm font-medium">Settings</h2>
        <SharedLayoutBg inset={0} pillClassName="rounded-lg bg-muted/50" className="gap-0.5">
          {pages.map(({ page: entry, title, icon: Icon }) => (
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
      <ScrollArea className="min-w-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:py-7 [&>[data-slot=scroll-area-scrollbar]]:pr-0.5">
        <div className="p-5">
          {Match.value(page).pipe(
            Match.when("general", () => <GeneralPage />),
            Match.when("projects", () => <ProjectsPage />),
            Match.when("appearance", () => (
              <SettingsGroup>
                <SettingsRow label="Theme">
                  <Tabs
                    value={settings.theme}
                    onValueChange={(value) =>
                      Schema.is(Theme)(value) && updateSettings({ ...settings, theme: value })
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
            Match.when("git", () => <GitPage />),
            Match.when("connections", () => <ConnectionsPage />),
            Match.exhaustive,
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function GeneralPage() {
  const settings = useStore((state) => state.settings);
  const providers = useStore((state) => state.providers);
  const linked = providers.filter((provider) => provider.linked && provider.models.length);
  const savedModel = settings.newThreadModel;
  const effortProvider =
    savedModel &&
    buildModelChoices(providers, settings).some((option) => option.value === savedModel)
      ? decodeChoice(savedModel).provider
      : settings.lastProvider;
  const savedEffort = settings.newThreadEffort;

  return (
    <>
      <Section title="New threads">
        <SettingsGroup>
          <SettingsRow label="Default model">
            {linked.length ? (
              <div className="flex gap-2">
                <SettingsModelSelect
                  value={savedModel}
                  onChange={(newThreadModel) => updateSettings({ ...settings, newThreadModel })}
                  fallback="Last used"
                  className="w-44"
                />
                <SettingsSelect
                  value={
                    savedEffort && EFFORTS[effortProvider].includes(savedEffort)
                      ? savedEffort
                      : "default"
                  }
                  onChange={(value) =>
                    updateSettings({
                      ...settings,
                      newThreadEffort: Schema.is(Effort)(value) ? value : null,
                    })
                  }
                  options={[
                    { value: "default", label: "Model default" },
                    ...EFFORTS[effortProvider].map((effort) => ({
                      value: effort,
                      label: EFFORT_LABEL[effort],
                    })),
                  ]}
                  className="w-36"
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Link a harness to pick one</p>
            )}
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Default permissions"
                description="What new threads may do without asking"
              />
            }
          >
            <SettingsSelect
              value={settings.newThreadPermission ?? "ask"}
              onChange={(value) =>
                Schema.is(PermissionLevel)(value) &&
                updateSettings({ ...settings, newThreadPermission: value })
              }
              options={PermissionLevel.literals.map((level) => ({
                value: level,
                label: PERMISSION_LABEL[level],
              }))}
            />
          </SettingsRow>
          <SettingsRow
            label={<RowLabel title="Default workspace" description="Where new threads start" />}
          >
            <SettingsSelect
              value={settings.workspace ?? "local"}
              onChange={(value) =>
                updateSettings({
                  ...settings,
                  workspace: value === "worktree" ? "worktree" : "local",
                })
              }
              options={[
                { value: "local", label: "Project folder" },
                { value: "worktree", label: "New worktree" },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Organization">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Shelve idle threads"
                description="Read or not; new activity brings them back"
              />
            }
          >
            <SettingsSelect
              value={
                settings.autoShelve === false
                  ? "never"
                  : String(settings.autoShelveDays ?? DEFAULT_AUTO_SHELVE_DAYS)
              }
              onChange={(value) =>
                updateSettings(
                  value === "never"
                    ? { ...settings, autoShelve: false }
                    : { ...settings, autoShelve: true, autoShelveDays: Number(value) },
                )
              }
              options={[
                { value: "never", label: "Never" },
                ...AUTO_SHELVE_DAYS.map((days) => ({
                  value: String(days),
                  label: days === 1 ? "After 1 day" : `After ${days} days`,
                })),
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Behavior">
        <SettingsGroup>
          <SettingsRow label="Diff layout">
            <Tabs
              value={settings.diffLayout ?? "unified"}
              onValueChange={(value) =>
                updateSettings({ ...settings, diffLayout: value === "split" ? "split" : "unified" })
              }
            >
              <TabsList>
                <TabsTrigger value="unified">
                  <span className="flex items-center gap-1.5">
                    <Rows2 className="size-3.5" />
                    Stacked
                  </span>
                </TabsTrigger>
                <TabsTrigger value="split">
                  <span className="flex items-center gap-1.5">
                    <Columns2 className="size-3.5" />
                    Split
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Notifications"
                description="When a thread finishes or needs you, while MassCode is in the background"
              />
            }
          >
            <Switch
              size="sm"
              checked={settings.notifications !== false}
              onCheckedChange={(notifications) => updateSettings({ ...settings, notifications })}
              ariaLabel="Notifications"
            />
          </SettingsRow>
          <SettingsRow
            label={<RowLabel title="Follow-up behavior" description="⌘↩ does the opposite once" />}
          >
            <SettingsSelect
              value={settings.followUp ?? "queue"}
              onChange={(value) =>
                updateSettings({ ...settings, followUp: value === "steer" ? "steer" : "queue" })
              }
              options={[
                { value: "queue", label: "Queue until done" },
                { value: "steer", label: "Send immediately" },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Projects & threads">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Start from origin"
                description="Branch new worktrees from origin, not local"
              />
            }
          >
            <Switch
              checked={settings.worktreeFromOrigin === true}
              ariaLabel="Start new worktrees from origin"
              onCheckedChange={(checked) =>
                updateSettings({ ...settings, worktreeFromOrigin: checked })
              }
              size="sm"
            />
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Add project starts in"
                description="Where the Add Project browser opens"
              />
            }
          >
            <SettingsTextField
              label="Add project starts in"
              isMonospace
              value={settings.addProjectFolder ?? ""}
              placeholder="~/"
              onCommit={(folder) =>
                updateSettings({ ...settings, addProjectFolder: folder || undefined })
              }
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Confirmations">
        <SettingsGroup>
          <SettingsRow
            label={<RowLabel title="Archive confirmation" description="Second click to archive" />}
          >
            <Switch
              checked={settings.confirmArchive === true}
              ariaLabel="Archive confirmation"
              onCheckedChange={(checked) =>
                updateSettings({ ...settings, confirmArchive: checked })
              }
              size="sm"
            />
          </SettingsRow>
          <SettingsRow
            label={<RowLabel title="Delete confirmation" description="Second click to delete" />}
          >
            <Switch
              checked={settings.confirmDelete !== false}
              ariaLabel="Delete confirmation"
              onCheckedChange={(checked) => updateSettings({ ...settings, confirmDelete: checked })}
              size="sm"
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      {window.desktop ? <UpdatesSection /> : null}
    </>
  );
}

function UpdatesSection() {
  const status = useUpdateStatus() ?? UpdateStatus.cases.idle.make({});
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.desktop?.appVersion().then(setVersion, () => {});
  }, []);

  const isReady = UpdateStatus.guards.ready(status);
  const isAvailable = UpdateStatus.guards.available(status);

  return (
    <Section title="About">
      <SettingsGroup>
        <SettingsRow
          label={
            <>
              <p className="flex items-baseline gap-1.5">
                Version
                {version ? (
                  <span className="font-mono text-xs text-muted-foreground">{version}</span>
                ) : null}
              </p>
              {UpdateStatus.guards.failed(status) ? (
                <p className="text-xs text-destructive">{status.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {isReady
                    ? `Version ${status.version} is downloaded and installs when MassCode restarts.`
                    : isAvailable
                      ? `Version ${status.version} is available.`
                      : "Current version of the application."}
                </p>
              )}
            </>
          }
        >
          <Button
            size="sm"
            variant={isReady || isAvailable ? "primary" : "secondary"}
            disabled={UpdateStatus.isAnyOf(["checking", "downloading"])(status)}
            className="h-7 rounded-lg tabular-nums disabled:opacity-100"
            onClick={() =>
              isReady
                ? window.desktop?.installUpdate()
                : isAvailable
                  ? window.desktop?.downloadUpdate()
                  : window.desktop?.checkForUpdates()
            }
          >
            {Match.value(status).pipe(
              Match.tag("idle", () => "Check for updates"),
              Match.tag("checking", () => "Checking…"),
              Match.tag("up-to-date", () => "Up to date"),
              Match.tag("available", () => "Download update"),
              Match.tag("downloading", ({ percent }) => `Downloading ${Math.round(percent)}%`),
              Match.tag("ready", () => "Restart to update"),
              Match.tag("failed", () => "Try again"),
              Match.exhaustive,
            )}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </Section>
  );
}

const MERGE_METHODS = [
  { value: "last", label: "Last selected" },
  { value: "merge", label: "Merge" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
];

const WRITING_STYLES: Array<{ value: WritingStyle; label: string }> = [
  { value: "repo_conventions", label: "Repository conventions" },
  { value: "conventional_commits", label: "Conventional Commits" },
  { value: "custom", label: "Custom instructions" },
];

function ProjectsPage() {
  const projects = useStore((state) => state.projects);
  const projectHosts = useStore((state) => state.projectHosts);
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];

  if (!project)
    return <p className="px-1 text-sm text-muted-foreground">Add a project to set it up here.</p>;

  return (
    <>
      <Section title="Project">
        <SettingsGroup>
          <SettingsRow label={<RowLabel title="Settings for" description={project.path} />}>
            <SettingsSelect
              value={project.id}
              onChange={setProjectId}
              options={projects.map((candidate) => ({
                value: candidate.id,
                label: projectHosts[candidate.id]
                  ? `${candidate.name} on ${projectHosts[candidate.id]}`
                  : candidate.name,
              }))}
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <ProjectThreadSettings
        key={project.id}
        host={projectHosts[project.id] ?? null}
        path={project.path}
      />
    </>
  );
}

interface WorktreeDraft {
  readonly startIn: "settings" | "worktree" | "local";
  readonly setup: string;
  readonly waitForSetup: boolean;
}

/** What a project's own `masscode.toml` says about its new threads; each change saves straight away, like the rest of Settings. */
function ProjectThreadSettings({ host, path }: { host: string | null; path: string }) {
  const [draft, setDraft] = useState<WorktreeDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leaving the setup box unchanged shouldn't rewrite the file.
  const savedSetup = useRef("");

  useEffect(() => {
    let isCancelled = false;
    void readProjectConfig(host, path).then((frame) => {
      if (isCancelled) return;
      if (!frame)
        return setError(
          "MassCode's daemon didn't answer, so the project's settings couldn't be read. Check it's running and open this page again.",
        );

      const worktree = frame.config.worktree;
      savedSetup.current = worktree?.setup ?? "";
      setDraft({
        startIn:
          worktree?.default === undefined ? "settings" : worktree.default ? "worktree" : "local",
        setup: worktree?.setup ?? "",
        waitForSetup: worktree?.wait_for_setup !== false,
      });
      setNotice(
        frame.error
          ? `${frame.error}. Changing anything here replaces it.`
          : frame.text && /^\s*#/m.test(frame.text)
            ? "masscode.toml has comments in it; changing anything here rewrites the file without them."
            : null,
      );
    });

    return () => {
      isCancelled = true;
    };
  }, [host, path]);

  async function saveWorktreeSettings(next: WorktreeDraft) {
    setDraft(next);
    savedSetup.current = next.setup;
    setIsSaving(true);
    const setup = next.setup.trim() ? next.setup.trimEnd() : "";
    const worktree: NonNullable<ProjectConfig["worktree"]> = {
      ...(next.startIn !== "settings" && { default: next.startIn === "worktree" }),
      ...(setup && { setup }),
      ...(setup && !next.waitForSetup && { wait_for_setup: false }),
    };

    setError(
      await updateProjectConfig(host, path, ({ worktree: _replaced, ...rest }) =>
        Object.keys(worktree).length ? { ...rest, worktree } : rest,
      ),
    );
    setIsSaving(false);
  }

  return (
    <Section title="New threads">
      {notice ? (
        <p className="mb-2 rounded-lg border border-warning/40 px-3 py-2 text-xs text-warning">
          {notice}
        </p>
      ) : null}
      {draft === null ? (
        error ? null : (
          <Skeleton className="h-40 rounded-xl" />
        )
      ) : (
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Start in"
                description="Where this project's new threads start; you can still switch per thread"
              />
            }
          >
            <SettingsSelect
              value={draft.startIn}
              onChange={(value) =>
                void saveWorktreeSettings({
                  ...draft,
                  startIn: value === "worktree" || value === "local" ? value : "settings",
                })
              }
              options={[
                { value: "settings", label: "Same as General" },
                { value: "worktree", label: "New worktree" },
                { value: "local", label: "Project folder" },
              ]}
            />
          </SettingsRow>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <RowLabel
              title="Worktree setup"
              description="Runs in each new worktree, like installing dependencies. $MASSCODE_PROJECT_ROOT is the project's own checkout, for linking files git ignores, like .env."
            />
            <Textarea
              aria-label="Worktree setup"
              placeholder={'pnpm install\nln -s "$MASSCODE_PROJECT_ROOT/.env" .env'}
              spellCheck={false}
              value={draft.setup}
              onChange={(event) => setDraft({ ...draft, setup: event.target.value })}
              onBlur={() => draft.setup !== savedSetup.current && void saveWorktreeSettings(draft)}
              className="min-h-16 rounded-lg bg-background font-mono text-xs leading-5 md:text-xs dark:bg-background"
            />
          </div>
          <SettingsRow
            label={
              <RowLabel
                title="Wait for setup"
                description="Hold the first message until setup finishes"
              />
            }
          >
            <Switch
              size="sm"
              checked={draft.waitForSetup}
              disabled={!draft.setup.trim()}
              onCheckedChange={(waitForSetup) =>
                void saveWorktreeSettings({ ...draft, waitForSetup })
              }
              ariaLabel="Wait for setup"
            />
          </SettingsRow>
        </SettingsGroup>
      )}
      <p
        className={cn(
          "mt-2 px-1 text-xs",
          error ? "selectable text-destructive" : "text-muted-foreground",
        )}
      >
        {error ??
          (isSaving
            ? "Saving…"
            : "Saved to masscode.toml in the project; commit it to share with your team.")}
      </p>
    </Section>
  );
}

function GitPage() {
  const settings = useStore((state) => state.settings);
  const sourceControl = useStore((state) => state.sourceControl);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => send(ClientCommand.cases["sourceControl.refresh"].make({})), []);
  useEffect(() => {
    if (sourceControl) setIsChecking(false);
  }, [sourceControl]);

  return (
    <>
      <Section title="Repositories">
        <SettingsGroup>
          <SettingsRow label="Pull the default branch automatically">
            <Switch
              size="sm"
              checked={settings.autoPull ?? false}
              onCheckedChange={(autoPull) => updateSettings({ ...settings, autoPull })}
              ariaLabel="Pull the default branch automatically"
            />
          </SettingsRow>
          <SettingsRow label="Default merge method">
            <SettingsSelect
              value={settings.mergeMethod ?? "last"}
              onChange={(value) =>
                updateSettings({
                  ...settings,
                  mergeMethod: Schema.is(MergeMethod)(value) ? value : null,
                })
              }
              options={MERGE_METHODS}
              className="w-52"
            />
          </SettingsRow>
        </SettingsGroup>
      </Section>
      <Section title="Source control">
        <SettingsGroup>
          {SourceControlKind.literals.map((kind) => {
            const status = sourceControl?.find((entry) => entry.kind === kind);
            const Logo = SOURCE_CONTROL_LOGO[kind];
            return (
              <SettingsRow
                key={kind}
                label={
                  <div className="flex items-center gap-3">
                    <Logo className="size-5 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-medium">{SOURCE_CONTROL_LABEL[kind]}</span>
                        {status?.version ? (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {status.version}
                          </span>
                        ) : null}
                      </div>
                      {!status ? (
                        <Skeleton aria-label="Checking…" className="mt-1 h-3 w-36" />
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {status.authenticated
                            ? status.account
                              ? `Signed in as ${status.account}`
                              : "Signed in"
                            : status.detail}
                        </p>
                      )}
                    </div>
                  </div>
                }
              >
                {status ? (
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-px text-[10px] font-medium",
                      status.authenticated
                        ? "bg-success/15 text-success"
                        : status.installed
                          ? "bg-warning/15 text-warning"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatSignInLabel(status)}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-16" />
                )}
              </SettingsRow>
            );
          })}
        </SettingsGroup>
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 rounded-lg text-xs"
            disabled={isChecking}
            onClick={() => {
              setIsChecking(true);
              send(ClientCommand.cases["sourceControl.refresh"].make({}));
            }}
          >
            <RefreshCw className={cn("size-3.5", isChecking && "animate-spin")} />
            {isChecking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </Section>
      <Section title="Writing">
        <SettingsGroup>
          <SettingsRow label="Writing style">
            <SettingsSelect
              value={settings.writingStyle ?? "repo_conventions"}
              onChange={(value) =>
                Schema.is(WritingStyle)(value) &&
                updateSettings({ ...settings, writingStyle: value })
              }
              options={WRITING_STYLES}
              className="w-52"
            />
          </SettingsRow>
          {settings.writingStyle === "custom" ? <WritingInstructionsField /> : null}
          <SettingsRow label="Follow pull request templates">
            <Switch
              size="sm"
              checked={settings.followTemplates ?? true}
              onCheckedChange={(followTemplates) =>
                updateSettings({ ...settings, followTemplates })
              }
              ariaLabel="Follow pull request templates"
            />
          </SettingsRow>
          <SettingsRow label="Writer model">
            <WriterModelSelect />
          </SettingsRow>
        </SettingsGroup>
      </Section>
    </>
  );
}

function formatSignInLabel(status: SourceControlStatus) {
  if (status.authenticated) return "Signed in";
  if (!status.installed) return "Not installed";
  return status.authenticated === null ? "Unknown" : "Not signed in";
}

/** Rules for commit messages and pull requests, saved on blur; Esc reverts an edit. */
function WritingInstructionsField() {
  const settings = useStore((state) => state.settings);
  const saved = settings.writingInstructions ?? "";
  const [draft, setDraft] = useState(saved);

  return (
    <div className="px-3 py-2">
      <Textarea
        aria-label="Writing instructions"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() =>
          draft !== saved && updateSettings({ ...settings, writingInstructions: draft })
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && draft !== saved) {
            event.stopPropagation();
            setDraft(saved);
          }
        }}
        placeholder="e.g. Subjects in lowercase. Mention the ticket from the branch name."
        className="min-h-20 rounded-lg bg-background text-[13px] md:text-[13px]"
      />
    </div>
  );
}

/** Model writing commit messages left empty and pull requests; "auto" follows the last harness's default model. */
function WriterModelSelect() {
  const settings = useStore((state) => state.settings);
  const providers = useStore((state) => state.providers);
  const linked = providers.filter((provider) => provider.linked && provider.models.length);

  if (!linked.length && providers.some((provider) => provider.checking))
    return <Skeleton className="h-7 w-52 rounded-lg" />;
  if (!linked.length)
    return <span className="text-[13px] text-muted-foreground">Link a harness first</span>;

  return (
    <SettingsModelSelect
      value={settings.commitModel}
      onChange={(commitModel) => updateSettings({ ...settings, commitModel })}
      fallback="Default model"
      className="w-52"
    />
  );
}

const CONFIG_DIR: Record<ProviderKind, { env: string; placeholder: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", placeholder: "~/.claude" },
  codex: { env: "CODEX_HOME", placeholder: "~/.codex" },
  cursor: { env: "CURSOR_CONFIG_DIR", placeholder: "~/.masscode/cursor" },
};

function ConnectionsPage() {
  const hosts = useStore((state) => state.hosts);
  const [query, setQuery] = useState("");
  const [aliases, setAliases] = useState<ReadonlyArray<string>>([]);

  // Unreadable ~/.ssh/config just means no suggestions; a typed address still works.
  useEffect(() => void window.desktop?.sshAliases().then(setAliases, () => {}), []);

  const typed = query.trim();

  function isMatchingQuery(name: string) {
    return name.toLowerCase().includes(typed.toLowerCase());
  }

  const added = Object.entries(hosts).filter(([name]) => isMatchingQuery(name));
  // Configs can list dozens, so they show once there's a search, or while there's no host yet.
  const suggestions =
    typed || Object.keys(hosts).length === 0
      ? aliases.filter((name) => !hosts[name] && isMatchingQuery(name))
      : [];
  // What's typed is a host of its own, like me@server, when it isn't the start of a listed one.
  const addable = [
    ...(typed && !hosts[typed] && suggestions.length === 0 && !/\s/.test(typed) ? [typed] : []),
    ...suggestions,
  ];

  function addHost(alias: string) {
    void window.desktop?.addHost(alias);
    setQuery("");
  }

  return (
    <>
      <Input
        aria-label="Search or add an SSH host"
        value={query}
        onChange={setQuery}
        placeholder="Search or add an SSH host, like devbox or me@server"
        spellCheck={false}
        autoComplete="off"
        leftIcon={<Search />}
        onKeyDown={(event) => {
          if (event.key === "Enter" && addable.length === 1) addHost(addable[0]);
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
        className="mb-5"
        classNames={{
          field: "h-9 rounded-lg bg-background",
          leftIcon: "left-2.5",
          input: "pl-9 text-[13px]",
        }}
      />
      <Section title="Remote hosts">
        {added.length ? (
          <SettingsGroup>
            {added.map(([name, host]) => (
              <HostRow key={name} alias={name} status={host.status} />
            ))}
          </SettingsGroup>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">
            {Object.keys(hosts).length
              ? "No host matches."
              : "None yet. A Linux host runs agents over SSH while this Mac sleeps."}
          </p>
        )}
      </Section>
      {addable.length ? (
        <Section title="Add host">
          <SettingsGroup>
            {addable.map((alias) => (
              <SettingsRow
                key={alias}
                label={
                  <RowLabel
                    title={alias}
                    description={aliases.includes(alias) ? "In ~/.ssh/config" : "Typed address"}
                  />
                }
              >
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 rounded-lg"
                  onClick={() => addHost(alias)}
                >
                  Add
                </Button>
              </SettingsRow>
            ))}
          </SettingsGroup>
        </Section>
      ) : null}
    </>
  );
}

function HostRow({ alias, status }: { alias: string; status: HostStatus }) {
  const [confirmingAction, setConfirmingAction] = useState<"remove" | "restart" | null>(null);
  const settings = useStore((state) => state.settings);
  const isConfirming = confirmingAction !== null;

  return (
    <>
      <SettingsRow
        label={
          <div className="min-w-0">
            <p className="font-mono text-[13px]">{alias}</p>
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  Match.value(status).pipe(
                    Match.tag("connected", () => "bg-success"),
                    Match.tag("failed", () => "bg-destructive"),
                    Match.orElse(() => "bg-warning"),
                  ),
                )}
              />
              <span
                className={cn("min-w-0", HostStatus.guards.failed(status) && "text-destructive")}
              >
                {Match.value(status).pipe(
                  Match.tag("connecting", ({ step }) => `${step}…`),
                  Match.tag("connected", () => "Connected"),
                  Match.tag(
                    "updating",
                    () => "Updating: the new version starts once its running turns end",
                  ),
                  Match.tag("failed", ({ message }) => message),
                  Match.exhaustive,
                )}
              </span>
            </div>
          </div>
        }
      >
        {isConfirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setConfirmingAction(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => {
                setConfirmingAction(null);
                if (confirmingAction === "remove") {
                  forgetFullAccessAsRoot(alias);
                  void window.desktop?.removeHost(alias);
                } else void window.desktop?.restartHost(alias);
              }}
            >
              {confirmingAction === "remove" ? "Remove" : "Restart now"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {HostStatus.guards.failed(status) ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => void window.desktop?.hostDaemon(alias)}
              >
                Retry
              </Button>
            ) : null}
            {HostStatus.guards.updating(status) ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => setConfirmingAction("restart")}
              >
                Restart now
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setConfirmingAction("remove")}
            >
              Remove
            </Button>
          </div>
        )}
      </SettingsRow>
      {isConfirming ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          {confirmingAction === "remove"
            ? `This stops MassCode on ${alias}, and any agents working there. Its threads stay on ${alias} for when you add it again.`
            : `This stops the turns running on ${alias} and restarts it on this version.`}
        </p>
      ) : null}
      <SettingsRow
        label={
          <RowLabel
            title="Projects folder"
            description={`Git repos in it are added as projects on ${alias}, and clones go there`}
          />
        }
      >
        <SettingsTextField
          label={`Projects folder on ${alias}`}
          isMonospace
          value={settings.hostProjectFolders?.[alias] ?? ""}
          placeholder="~"
          onCommit={(folder) => {
            updateSettings({
              ...settings,
              hostProjectFolders: { ...settings.hostProjectFolders, [alias]: folder },
            });
            scanProjects(alias);
          }}
        />
      </SettingsRow>
    </>
  );
}

const THIS_MAC = "\u0000this-mac";

function HarnessesPage() {
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
            onChange={(value) => setMachine(value === THIS_MAC ? null : value)}
            options={[
              { value: THIS_MAC, label: "This Mac", icon: <Monitor className="size-3.5" /> },
              ...Object.keys(hosts).map((alias) => ({
                value: alias,
                label: alias,
                icon: <Server className="size-3.5" />,
              })),
            ]}
          />
        ) : null}
      </div>
      {/* Keyed so drafts and confirmations don't carry over to the other harness or machine. */}
      <div key={`${kind}:${machine ?? THIS_MAC}`}>
        <Section title="Account">
          <ProviderCard kind={kind} status={status} host={machine} />
        </Section>
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
      <Section title="Display">
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
      </Section>
      <Section title="Launch">
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
      </Section>
      {status?.linked && status.models.length ? <ModelsSection status={status} /> : null}
    </>
  );
}

/** Text setting saved on blur or Enter. Esc reverts an edit; with nothing to revert it closes Settings as usual. */
function SettingsTextField(props: {
  label: string;
  value: string;
  placeholder: string;
  isMonospace?: boolean;
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
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape" && draft !== props.value) {
          event.stopPropagation();
          setDraft(props.value);
        }
      }}
      className="w-64"
      classNames={{
        field: "h-8 rounded-lg bg-background",
        input: cn("pl-2.5 text-[13px]", props.isMonospace && "font-mono text-xs"),
      }}
    />
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
    <Section title="Models">
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
    </Section>
  );
}

/** CLIs report versions as e.g. "2.1.281 (Claude Code)" or "codex-cli 0.154.0"; keep just the number. */
function formatShortVersion(raw: string) {
  return raw.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? raw;
}

function formatStatusLine(status: ProviderStatus | undefined) {
  if (!status) return "Checking…";
  if (!status.installed) return status.error ?? "Not installed";
  return status.linked ? (status.account ?? "Signed in") : "Not signed in";
}

function ProviderCard({
  kind,
  status,
  host = null,
}: {
  kind: ProviderKind;
  status: ProviderStatus | undefined;
  /** The remote host whose harness this is; this Mac's when left out. */
  host?: string | null;
}) {
  const settings = useStore((state) => state.settings);
  const flow = useStore((state) =>
    host === null ? state.authFlows[kind] : state.hosts[host]?.authFlows[kind],
  );
  const [isConfirmingUnlink, setIsConfirmingUnlink] = useState(false);
  const [code, setCode] = useState("");

  const isSigningIn =
    flow &&
    (flow.stage === "starting" || flow.stage === "browser" || flow.stage === "awaiting-code");
  const Logo = PROVIDER_LOGO[kind];
  const isChecking = !status || status.checking === true;

  function renderAction() {
    if (isChecking) return <Skeleton className="h-7 w-16 rounded-lg" />;
    if (!status?.installed) return null;

    if (isSigningIn)
      return (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg"
          onClick={() =>
            send(ClientCommand.cases["provider.linkCancel"].make({ provider: kind }), host)
          }
        >
          Cancel
        </Button>
      );

    if (status.linked && isConfirmingUnlink)
      return (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg"
            onClick={() => setIsConfirmingUnlink(false)}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
            onClick={() => {
              setIsConfirmingUnlink(false);
              send(ClientCommand.cases["provider.unlink"].make({ provider: kind }), host);
            }}
          >
            Sign out
          </Button>
        </div>
      );

    if (status.linked)
      return (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 rounded-lg"
          onClick={() => setIsConfirmingUnlink(true)}
        >
          Unlink
        </Button>
      );

    if (host !== null && kind === "codex") return null;

    return (
      <Button
        size="sm"
        className="h-7 rounded-lg"
        onClick={() => send(ClientCommand.cases["provider.link"].make({ provider: kind }), host)}
      >
        Link
      </Button>
    );
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                getHarnessTint(settings, kind).avatar,
              )}
            >
              <Logo className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium">{formatHarnessLabel(settings, kind)}</span>
                {status?.version ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    v{formatShortVersion(status.version)}
                  </span>
                ) : null}
                {status?.linked && status.plan ? (
                  <span className="self-center rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground capitalize">
                    {status.plan}
                  </span>
                ) : null}
              </div>
              {isChecking ? (
                <Skeleton aria-label="Checking…" className="mt-1 h-3 w-36" />
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      status?.linked
                        ? "bg-success"
                        : status?.installed
                          ? "bg-warning"
                          : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">{formatStatusLine(status)}</span>
                </div>
              )}
            </div>
          </div>
        }
      >
        {renderAction()}
      </SettingsRow>

      {isConfirmingUnlink ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          This signs {formatHarnessLabel(settings, kind)} out on {host ?? "this Mac"}, including in
          your terminal.
        </p>
      ) : null}

      {host !== null && kind === "codex" && status?.installed && !status.linked && !isChecking ? (
        // Codex's sign-in page calls back to a server on the host, which this Mac's browser can't reach.
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          To link it, run <code className="selectable font-mono">codex login --device-auth</code> in
          a terminal on {host}, for example one opened from a thread there.
        </p>
      ) : null}

      {isSigningIn ? (
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
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && code.trim())
                        send(
                          ClientCommand.cases["provider.linkCode"].make({
                            provider: kind,
                            code: code.trim(),
                          }),
                          host,
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
                      send(
                        ClientCommand.cases["provider.linkCode"].make({
                          provider: kind,
                          code: code.trim(),
                        }),
                        host,
                      )
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
}
