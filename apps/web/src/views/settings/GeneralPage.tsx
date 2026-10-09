import { Button } from "@masscode/ui/motion/button/base";
import { Switch } from "@masscode/ui/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@masscode/ui/motion/tabs";
import { DEFAULT_AUTO_SHELVE_DAYS, PermissionLevel, UpdateStatus } from "@masscode/contracts";
import { Columns2, Rows2 } from "lucide-react";
import { useEffect, useState } from "react";
import { EFFORT_LABEL, EFFORTS, PERMISSION_LABEL } from "../../lib/composer.ts";
import { decodeChoice, buildModelChoices } from "../../lib/models.ts";
import { updateSettings, useStore } from "../../lib/store.ts";
import { useUpdateStatus } from "../../lib/updates.ts";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsModelSelect,
  RowLabel,
  SettingsTextField,
} from "./SettingsControls.tsx";

const AUTO_SHELVE_DAYS = [1, 3, 7, 14, 30];

export function GeneralPage() {
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
      <SettingsSection title="New threads">
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
                      newThreadEffort: value === "default" ? null : value,
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
              onChange={(newThreadPermission) =>
                updateSettings({ ...settings, newThreadPermission })
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
              onChange={(workspace) => updateSettings({ ...settings, workspace })}
              options={[
                { value: "local", label: "Project folder" },
                { value: "worktree", label: "New worktree" },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Organization">
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
      </SettingsSection>
      <SettingsSection title="Behavior">
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
              onChange={(followUp) => updateSettings({ ...settings, followUp })}
              options={[
                { value: "queue", label: "Queue until done" },
                { value: "steer", label: "Send immediately" },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Projects & threads">
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
      </SettingsSection>
      <SettingsSection title="Confirmations">
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
      </SettingsSection>
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
    <SettingsSection title="About">
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
            {UpdateStatus.match(status, {
              idle: () => "Check for updates",
              checking: () => "Checking…",
              "up-to-date": () => "Up to date",
              available: () => "Download update",
              downloading: ({ percent }) => `Downloading ${Math.round(percent)}%`,
              ready: () => "Restart to update",
              failed: () => "Try again",
            })}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
