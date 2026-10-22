import { DEFAULT_AUTO_SHELVE_DAYS } from "@masscode/contracts";
import { FormChoiceSection, FormList } from "@/shared/ui";
import { uniformSetting, updateSettings, useSettingsScope } from "../model/settings-scope.ts";
import { SettingsScopeHeader } from "./settings-scope-header.tsx";

const AUTO_SHELVE_DAYS = [1, 3, 7, 14, 30];

export function ThreadBehaviorSettingsPage() {
  const { targets } = useSettingsScope();

  return (
    <>
      <SettingsScopeHeader />
      {targets.length > 0 ? (
        <FormList>
          <FormChoiceSection
            title="Follow-ups"
            description="A message sent while the agent works"
            value={uniformSetting(targets, (host) => host.settings.followUp ?? "queue")}
            options={[
              { value: "queue", label: "Queue until done" },
              { value: "steer", label: "Send immediately" },
            ]}
            onChange={(followUp) => updateSettings(targets, { followUp })}
          />
          <FormChoiceSection
            title="Shelve idle threads"
            description="Read or not; new activity brings them back"
            value={uniformSetting(targets, (host) =>
              host.settings.autoShelve === false
                ? "never"
                : String(host.settings.autoShelveDays ?? DEFAULT_AUTO_SHELVE_DAYS),
            )}
            options={[
              { value: "never", label: "Never" },
              ...AUTO_SHELVE_DAYS.map((days) => ({
                value: String(days),
                label: days === 1 ? "After 1 day" : `After ${days} days`,
              })),
            ]}
            onChange={(value) =>
              updateSettings(
                targets,
                value === "never"
                  ? { autoShelve: false }
                  : { autoShelve: true, autoShelveDays: Number(value) },
              )
            }
          />
          <FormChoiceSection
            title="Compact idle Claude threads"
            description="Just before the prompt cache expires, for threads over 100K tokens"
            value={uniformSetting(targets, (host) =>
              host.settings.compactIdleThreads === true ? "on" : "off",
            )}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(value) => updateSettings(targets, { compactIdleThreads: value === "on" })}
          />
          <FormChoiceSection
            title="New worktrees branch from"
            value={uniformSetting(targets, (host) =>
              host.settings.worktreeFromOrigin ? "origin" : "local",
            )}
            options={[
              { value: "local", label: "Local branch" },
              { value: "origin", label: "Origin" },
            ]}
            onChange={(value) =>
              updateSettings(targets, {
                worktreeFromOrigin: value === "origin",
              })
            }
          />
        </FormList>
      ) : null}
    </>
  );
}
