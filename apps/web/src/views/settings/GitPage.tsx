import { Button } from "@masscode/ui/motion/button/base";
import { Switch } from "@masscode/ui/motion/switch";
import { Skeleton } from "@masscode/ui/components/skeleton";
import { Textarea } from "@masscode/ui/components/textarea";
import { SOURCE_CONTROL_LABEL, SOURCE_CONTROL_LOGO } from "@/components/source-control-logo";
import { cn } from "@masscode/ui/lib/utils";
import {
  ClientCommand,
  MergeMethod,
  SourceControlKind,
  type SourceControlStatus,
  WritingStyle,
} from "@masscode/contracts";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { send, updateSettings, useStore } from "../../lib/store.ts";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsModelSelect,
} from "./SettingsControls.tsx";

const MERGE_METHODS: Array<{ value: MergeMethod | "last"; label: string }> = [
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

export function GitPage() {
  const settings = useStore((state) => state.settings);
  const sourceControl = useStore((state) => state.sourceControl);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => send(ClientCommand.cases["sourceControl.refresh"].make({})), []);
  useEffect(() => {
    if (sourceControl) setIsChecking(false);
  }, [sourceControl]);

  return (
    <>
      <SettingsSection title="Repositories">
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
                updateSettings({ ...settings, mergeMethod: value === "last" ? null : value })
              }
              options={MERGE_METHODS}
              className="w-52"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Source control">
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
      </SettingsSection>
      <SettingsSection title="Writing">
        <SettingsGroup>
          <SettingsRow label="Writing style">
            <SettingsSelect
              value={settings.writingStyle ?? "repo_conventions"}
              onChange={(writingStyle) => updateSettings({ ...settings, writingStyle })}
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
