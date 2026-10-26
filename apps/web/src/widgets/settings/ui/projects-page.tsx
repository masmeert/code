import { Button } from "@masmeert/ui/button";
import { Switch } from "@masmeert/ui/switch";
import { Skeleton } from "@masmeert/ui/skeleton";
import { Textarea } from "@masmeert/ui/textarea";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand, type Project, type ProjectConfig } from "@masscode/contracts";
import { IconPlus } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { readProjectConfig, updateProjectConfig, useProjectStore } from "@/entities/project";
import { updateSettings, useSettings } from "@/entities/settings";
import { useThreadStore } from "@/entities/thread";
import { addProject } from "@/features/add-project";
import { send } from "@/shared/api";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  RowLabel,
  SettingsTextField,
} from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export function ProjectsPage() {
  const settings = useSettings();
  const projects = useProjectStore((state) => state.projects);
  const projectHosts = useProjectStore((state) => state.projectHosts);
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];

  return (
    <>
      <SettingsSection
        title="All projects"
        action={
          <Button
            size="compact"
            variant="secondary"
            className="h-7 rounded-lg"
            onClick={() => void addProject()}
          >
            <IconPlus className="size-3.5" />
            Add project
          </Button>
        }
      >
        <SettingsGroup>
          <SettingsRow label="Add Project opens in">
            <SettingsTextField
              label="Add Project opens in"
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
      {project ? (
        <SettingsSection
          title="This project"
          action={
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
          }
        >
          <ProjectThreadSettings
            key={project.id}
            host={projectHosts[project.id] ?? null}
            path={project.path}
          />
          <RemoveProject key={`remove:${project.id}`} project={project} />
        </SettingsSection>
      ) : (
        <p className={cn(typeClass("caption"), "px-1 text-muted-foreground")}>
          No projects yet. Use Add project above to pick a folder or clone a repository.
        </p>
      )}
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
    <>
      {notice ? (
        <p
          className={cn(
            typeClass("caption"),
            "mb-2 rounded-lg border border-warning/40 px-3 py-2 text-warning",
          )}
        >
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
                title="New threads start in"
                description="You can still switch per thread"
              />
            }
          >
            <SettingsSelect
              value={draft.startIn}
              onChange={(startIn) => void saveWorktreeSettings({ ...draft, startIn })}
              options={[
                { value: "settings", label: "Same as General" },
                { value: "worktree", label: "New worktree" },
                { value: "local", label: "Project folder" },
              ]}
            />
          </SettingsRow>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <RowLabel
              title="Worktree setup script"
              description={
                <>
                  Runs in each new worktree.{" "}
                  <code className="selectable font-mono">$MASSCODE_PROJECT_ROOT</code> is the main
                  checkout, for linking ignored files like .env.
                </>
              }
            />
            <Textarea
              aria-label="Worktree setup"
              placeholder={'pnpm install\nln -s "$MASSCODE_PROJECT_ROOT/.env" .env'}
              spellCheck={false}
              value={draft.setup}
              onChange={(event) => setDraft({ ...draft, setup: event.target.value })}
              onBlur={() => draft.setup !== savedSetup.current && void saveWorktreeSettings(draft)}
              className={cn(
                typeClass("caption"),
                "min-h-16 rounded-lg bg-background font-mono leading-5 dark:bg-background",
              )}
            />
          </div>
          {draft.setup.trim() ? (
            <SettingsRow
              label={
                <RowLabel
                  title="Wait for setup"
                  description="The first message is sent once the script finishes"
                />
              }
            >
              <Switch
                size="compact"
                checked={draft.waitForSetup}
                onCheckedChange={(waitForSetup) =>
                  void saveWorktreeSettings({ ...draft, waitForSetup })
                }
                ariaLabel="Wait for setup"
              />
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      )}
      <p
        className={cn(
          typeClass("caption"),
          "mt-2 px-1",
          error ? "selectable text-destructive" : "text-muted-foreground",
        )}
      >
        {error ??
          (isSaving
            ? "Saving…"
            : "Saved to masscode.toml in the project. Commit it to share with your team.")}
      </p>
    </>
  );
}

/** Removing a project deletes its threads with it, so it asks first and says so. */
function RemoveProject({ project }: { project: Project }) {
  const threadCount = useThreadStore(
    (state) => Object.values(state.threads).filter((info) => info.projectId === project.id).length,
  );

  const [stage, setStage] = useState<"idle" | "confirming" | "removing">("idle");

  return (
    <div className="mt-4">
      <SettingsGroup>
        <SettingsRow
          label={
            <RowLabel
              title="Remove project"
              description={
                threadCount === 0
                  ? "The folder on disk stays as it is."
                  : `Deletes its ${threadCount === 1 ? "thread" : `${threadCount} threads`}, and their worktrees with no changes left in them. The folder on disk stays as it is.`
              }
            />
          }
        >
          {stage === "idle" ? (
            <Button
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setStage("confirming")}
            >
              Remove…
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="compact"
                variant="ghost"
                className="h-7 rounded-lg"
                disabled={stage === "removing"}
                onClick={() => setStage("idle")}
              >
                Cancel
              </Button>
              <Button
                size="compact"
                variant="ghost"
                className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
                disabled={stage === "removing"}
                onClick={() => {
                  setStage("removing");
                  send(ClientCommand.cases["project.remove"].make({ projectId: project.id }));
                }}
              >
                {stage === "removing"
                  ? "Removing…"
                  : threadCount === 0
                    ? `Remove ${project.name}`
                    : `Remove ${project.name} and ${threadCount === 1 ? "its thread" : `${threadCount} threads`}`}
              </Button>
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
