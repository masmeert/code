import { EFFORT_LABEL, EFFORTS, getVisibleModels, PERMISSION_LABEL } from "@masscode/client";
import { PermissionLevel, PROVIDER_NAME } from "@masscode/contracts";
import { useProviderStore } from "@/entities/provider";
import { FormChoiceSection, FormList } from "@/shared/ui";
import {
  type SettingsTarget,
  uniformSetting,
  updateSettings,
  useSettingsScope,
} from "../model/settings-scope.ts";
import { SettingsScopeHeader } from "./settings-scope-header.tsx";

export function NewThreadsSettingsPage() {
  const { targets } = useSettingsScope();
  const providersByHost = useProviderStore((state) => state.providers);

  function modelsOf(host: SettingsTarget) {
    return (providersByHost[host.paired.id] ?? []).flatMap((status) =>
      status.linked
        ? getVisibleModels(status.models, host.settings.providers[status.kind]).map((model) => ({
            value: `${status.kind}:${model.id}`,
            label: `${model.label} · ${PROVIDER_NAME[status.kind]}`,
            provider: status.kind,
          }))
        : [],
    );
  }

  function effortsOf(host: SettingsTarget) {
    const savedModel = modelsOf(host).find((model) => model.value === host.settings.newThreadModel);

    return EFFORTS[savedModel?.provider ?? host.settings.lastProvider];
  }

  // Only what every selected computer can run, so one choice fits them all.
  const models = targets
    .slice(0, 1)
    .flatMap(modelsOf)
    .filter((model) =>
      targets.every((host) => modelsOf(host).some((other) => other.value === model.value)),
    );

  const efforts = targets
    .slice(0, 1)
    .flatMap(effortsOf)
    .filter((effort) => targets.every((host) => effortsOf(host).includes(effort)));

  return (
    <>
      <SettingsScopeHeader />
      {targets.length > 0 ? (
        <FormList>
          <FormChoiceSection
            title="Model"
            value={uniformSetting(
              targets,
              (host) =>
                modelsOf(host).find((model) => model.value === host.settings.newThreadModel)
                  ?.value ?? "last",
            )}
            options={[{ value: "last", label: "Last used" }, ...models]}
            onChange={(value) =>
              updateSettings(targets, {
                newThreadModel: value === "last" ? null : value,
              })
            }
          />
          <FormChoiceSection
            title="Effort"
            value={uniformSetting(targets, (host) =>
              host.settings.newThreadEffort &&
              effortsOf(host).includes(host.settings.newThreadEffort)
                ? host.settings.newThreadEffort
                : "default",
            )}
            options={[
              { value: "default", label: "Model default" },
              ...efforts.map((effort) => ({
                value: effort,
                label: EFFORT_LABEL[effort],
              })),
            ]}
            onChange={(value) =>
              updateSettings(targets, {
                newThreadEffort: value === "default" ? null : value,
              })
            }
          />
          <FormChoiceSection
            title="Permissions"
            description="What new threads may do without asking"
            value={uniformSetting(targets, (host) => host.settings.newThreadPermission ?? "ask")}
            options={PermissionLevel.literals.map((level) => ({
              value: level,
              label: PERMISSION_LABEL[level],
            }))}
            onChange={(newThreadPermission) => updateSettings(targets, { newThreadPermission })}
          />
          <FormChoiceSection
            title="Workspace"
            description="Where new threads start"
            value={uniformSetting(targets, (host) => host.settings.workspace ?? "local")}
            options={[
              { value: "local", label: "Project folder" },
              { value: "worktree", label: "New worktree" },
            ]}
            onChange={(workspace) => updateSettings(targets, { workspace })}
          />
        </FormList>
      ) : null}
    </>
  );
}
