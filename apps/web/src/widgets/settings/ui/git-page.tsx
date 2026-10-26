import { Button } from "@masmeert/ui/button";
import { Switch } from "@masmeert/ui/switch";
import { Skeleton } from "@masmeert/ui/skeleton";
import { Textarea } from "@masmeert/ui/textarea";
import { SOURCE_CONTROL_LABEL, SOURCE_CONTROL_LOGO } from "@/shared/ui";
import { cn } from "@masscode/ui/lib/utils";
import {
  ClientCommand,
  MergeMethod,
  SourceControlKind,
  type SourceControlStatus,
  WritingStyle,
} from "@masscode/contracts";
import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useProviderStore } from "@/entities/provider";
import { useRepoStore } from "@/entities/repo";
import { updateSettings, useSettings } from "@/entities/settings";
import { send } from "@/shared/api";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsModelSelect,
  RowLabel,
} from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

const MERGE_METHODS: Array<{ value: MergeMethod | "last"; label: string }> = [
  { value: "last", label: "Last used" },
  { value: "merge", label: "Merge" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
];

const WRITING_STYLES: Array<{ value: WritingStyle; label: string }> = [
  { value: "repo_conventions", label: "Repository conventions" },
  { value: "conventional_commits", label: "Conventional Commits" },
  { value: "custom", label: "Custom instructions" },
];

export function GitPage() {
  const settings = useSettings();
  const sourceControl = useRepoStore((state) => state.sourceControl);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => send(ClientCommand.cases["sourceControl.refresh"].make({})), []);
  useEffect(() => {
    if (sourceControl) setIsChecking(false);
  }, [sourceControl]);

  return (
    <>
      <SettingsSection title="Branches">
        <SettingsGroup>
          <SettingsRow
            label={
              <RowLabel
                title="Keep the default branch up to date"
                description="Fast-forwards it from origin in the background"
              />
            }
          >
            <Switch
              size="compact"
              checked={settings.autoPull ?? false}
              onCheckedChange={(autoPull) => updateSettings({ ...settings, autoPull })}
              ariaLabel="Keep the default branch up to date"
            />
          </SettingsRow>
          <SettingsRow label="Merge pull requests with">
            <SettingsSelect
              value={settings.mergeMethod ?? "last"}
              onChange={(value) =>
                updateSettings({ ...settings, mergeMethod: value === "last" ? null : value })
              }
              options={MERGE_METHODS}
              className="w-52"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title="Accounts"
        action={
          <Button
            size="compact"
            variant="ghost"
            className={cn(typeClass("caption"), "-my-1 h-6 gap-1.5 rounded-md px-1.5")}
            disabled={isChecking}
            onClick={() => {
              setIsChecking(true);
              send(ClientCommand.cases["sourceControl.refresh"].make({}));
            }}
          >
            <IconRefresh className={cn("size-3.5", isChecking && "animate-spin")} />
            {isChecking ? "Checking…" : "Check again"}
          </Button>
        }
      >
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
                          <span
                            className={cn(
                              typeClass("caption", "compact"),
                              "truncate font-mono text-muted-foreground",
                            )}
                          >
                            {status.version}
                          </span>
                        ) : null}
                      </div>
                      {!status ? (
                        <Skeleton aria-label="Checking…" className="mt-1 h-3 w-36" />
                      ) : (
                        <p className={cn(typeClass("caption"), "text-muted-foreground")}>
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
                      typeClass("micro"),
                      "rounded-md px-1.5 py-px font-medium",
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
      </SettingsSection>
      <SettingsSection title="Commit messages & pull requests">
        <SettingsGroup>
          <SettingsRow label="Style">
            <SettingsSelect
              value={settings.writingStyle ?? "repo_conventions"}
              onChange={(writingStyle) => updateSettings({ ...settings, writingStyle })}
              options={WRITING_STYLES}
              className="w-52"
            />
          </SettingsRow>
          {settings.writingStyle === "custom" ? <WritingInstructionsField /> : null}
          <SettingsRow
            label={
              <RowLabel title="Follow pull request templates" description="When the repo has one" />
            }
          >
            <Switch
              size="compact"
              checked={settings.followTemplates ?? true}
              onCheckedChange={(followTemplates) =>
                updateSettings({ ...settings, followTemplates })
              }
              ariaLabel="Follow pull request templates"
            />
          </SettingsRow>
          <SettingsRow
            label={
              <RowLabel
                title="Model"
                description="Writes pull requests, and commit messages you leave empty"
              />
            }
          >
            <WriterModelSelect />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
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
  const settings = useSettings();
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
  const settings = useSettings();
  const providers = useProviderStore((state) => state.providers);
  const linked = providers.filter((provider) => provider.linked && provider.models.length);

  if (!linked.length && providers.some((provider) => provider.checking))
    return <Skeleton className="h-7 w-52 rounded-lg" />;

  if (!linked.length)
    return (
      <span className={cn(typeClass("body", "compact"), "text-muted-foreground")}>
        Link a harness in Harnesses first
      </span>
    );

  return (
    <SettingsModelSelect
      value={settings.commitModel}
      onChange={(commitModel) => updateSettings({ ...settings, commitModel })}
      fallback="Default model"
      className="w-52"
    />
  );
}
