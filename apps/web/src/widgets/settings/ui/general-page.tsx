import { Button } from "@masmeert/ui/button";
import { Switch } from "@masmeert/ui/switch";
import { DEFAULT_AUTO_SHELVE_DAYS, PermissionLevel, UpdateStatus } from "@masscode/contracts";
import { useEffect, useState } from "react";
import { EFFORT_LABEL, EFFORTS, PERMISSION_DESCRIPTION, PERMISSION_LABEL } from "@masscode/client";
import { buildModelChoices, decodeChoice, useProviderStore } from "@/entities/provider";
import { updateSettings, useSettings } from "@/entities/settings";
import { useUpdateAction, useUpdateStatus } from "@/features/update-app";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsModelSelect,
  RowLabel,
} from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";

const AUTO_SHELVE_DAYS = [1, 3, 7, 14, 30];

export function GeneralPage() {
  const settings = useSettings();
  const providers = useProviderStore((state) => state.providers);
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
          <SettingsRow label="Model">
            {linked.length ? (
              <SettingsModelSelect
                value={savedModel}
                onChange={(newThreadModel) => updateSettings({ ...settings, newThreadModel })}
                fallback="Last used"
                className="w-44"
              />
            ) : (
              <p className={cn(typeClass("caption"), "text-muted-foreground")}>
                Link a harness in Harnesses first
              </p>
            )}
          </SettingsRow>
          {linked.length ? (
            <SettingsRow
              label={
                <RowLabel
                  title="Effort"
                  description="How long the model thinks before it answers"
                />
              }
            >
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
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            label={
              <RowLabel
                title="Permissions"
                description={PERMISSION_DESCRIPTION[settings.newThreadPermission ?? "ask"]}
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
            label={
              <RowLabel
                title="Start in"
                description={
                  settings.workspace === "worktree"
                    ? "A fresh git worktree, so threads don't touch each other's files"
                    : "The project's own checkout"
                }
              />
            }
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
          <SettingsRow
            label={
              <RowLabel
                title="Branch worktrees from origin"
                description="The remote's latest commit, not your local branch"
              />
            }
          >
            <Switch
              checked={settings.worktreeFromOrigin === true}
              ariaLabel="Branch worktrees from origin"
              onCheckedChange={(checked) =>
                updateSettings({ ...settings, worktreeFromOrigin: checked })
              }
              size="compact"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="While threads run">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Messages sent mid-turn"
                description={
                  settings.followUp === "steer"
                    ? "The agent reads them right away. ⌘↩ queues instead"
                    : "Queued until the agent finishes. ⌘↩ sends right away"
                }
              />
            }
          >
            <SettingsSelect
              value={settings.followUp ?? "queue"}
              onChange={(followUp) => updateSettings({ ...settings, followUp })}
              options={[
                { value: "queue", label: "Queue" },
                { value: "steer", label: "Send right away" },
              ]}
            />
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
              size="compact"
              checked={settings.notifications !== false}
              onCheckedChange={(notifications) => updateSettings({ ...settings, notifications })}
              ariaLabel="Notifications"
            />
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Shelve idle threads"
                description="Folds them into Shelved until there's new activity"
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
          <SettingsRow
            label={
              <RowLabel
                title="Compact idle Claude threads"
                description="Makes the next message cheaper in threads over 100K tokens"
              />
            }
          >
            <Switch
              size="compact"
              checked={settings.compactIdleThreads === true}
              onCheckedChange={(compactIdleThreads) =>
                updateSettings({ ...settings, compactIdleThreads })
              }
              ariaLabel="Compact idle Claude threads"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Ask before">
        <SettingsGroup>
          <SettingsRow label="Archiving a thread">
            <Switch
              checked={settings.confirmArchive === true}
              ariaLabel="Ask before archiving a thread"
              onCheckedChange={(checked) =>
                updateSettings({ ...settings, confirmArchive: checked })
              }
              size="compact"
            />
          </SettingsRow>
          <SettingsRow label="Deleting a thread or branch">
            <Switch
              checked={settings.confirmDelete !== false}
              ariaLabel="Ask before deleting a thread or branch"
              onCheckedChange={(checked) => updateSettings({ ...settings, confirmDelete: checked })}
              size="compact"
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
  const updateAction = useUpdateAction(status);

  return (
    <SettingsSection title="About">
      <SettingsGroup>
        <SettingsRow
          label={
            <RowLabel
              title={
                <span className="flex items-baseline gap-1.5">
                  MassCode
                  {version ? (
                    <span className={cn(typeClass("caption"), "font-mono text-muted-foreground")}>
                      {version}
                    </span>
                  ) : null}
                </span>
              }
              description={
                UpdateStatus.guards.failed(status) ? (
                  <span className="text-destructive">{status.message}</span>
                ) : isReady ? (
                  `${status.version} installs when MassCode restarts.${updateAction.warning ? ` ${updateAction.warning}` : ""}`
                ) : isAvailable ? (
                  `${status.version} is available`
                ) : null
              }
            />
          }
        >
          <Button
            size="compact"
            variant={isReady || isAvailable ? "primary" : "secondary"}
            disabled={updateAction.isBusy}
            className={cn(
              "h-7 rounded-lg tabular-nums disabled:opacity-100",
              updateAction.isConfirming &&
                "bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive",
            )}
            onClick={updateAction.run}
          >
            {updateAction.label}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
