import { Switch } from "@masscode/ui/motion/switch";
import { Skeleton } from "@masscode/ui/components/skeleton";
import { Textarea } from "@masscode/ui/components/textarea";
import { cn } from "@masscode/ui/lib/utils";
import { type ProjectConfig } from "@masscode/contracts";
import { useEffect, useRef, useState } from "react";
import { readProjectConfig, updateProjectConfig, useStore } from "../../lib/store.ts";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  RowLabel,
} from "./SettingsControls.tsx";

export function ProjectsPage() {
  const projects = useStore((state) => state.projects);
  const projectHosts = useStore((state) => state.projectHosts);
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];

  if (!project)
    return <p className="px-1 text-sm text-muted-foreground">Add a project to set it up here.</p>;

  return (
    <>
      <SettingsSection title="Project">
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
      </SettingsSection>
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
    <SettingsSection title="New threads">
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
    </SettingsSection>
  );
}
