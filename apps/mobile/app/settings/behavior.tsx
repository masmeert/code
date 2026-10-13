import { DEFAULT_AUTO_SHELVE_DAYS } from "@masscode/contracts";
import { FormChoiceSection, FormList } from "@/components/form-list.tsx";
import { SettingsScopeHeader } from "@/components/settings-scope-header.tsx";
import { uniformSetting, updateSettings, useSettingsScope } from "@/lib/settings-scope.ts";

const AUTO_SHELVE_DAYS = [1, 3, 7, 14, 30];

export default function ThreadBehaviorSettingsScreen() {
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
