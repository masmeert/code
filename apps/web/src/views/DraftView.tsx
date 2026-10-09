import { OrbFace } from "@masscode/ui/agents/orb-face";
import { useRowCursor } from "@masscode/ui/hooks/use-row-cursor";
import { ProjectBadge } from "@/components/project-badge";
import { addProject, getProjectKey } from "../lib/projects.ts";
import { Button } from "@masscode/ui/motion/button/base";
import { cn } from "@masscode/ui/lib/utils";
import { type Project, parseRepository } from "@masscode/contracts";
import { Check, FolderPlus, LoaderCircle, Monitor, Server } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { focusComposer } from "../lib/drafts.ts";
import {
  decodeChoice,
  findDefaultModel,
  encodeChoice,
  formatHarnessLabel,
  buildModelChoices,
} from "../lib/models.ts";
import { cloneProject, createThread, usePathHost, useProviders, useStore } from "../lib/store.ts";
import { Composer } from "./Composer.tsx";
import { useProjectConfig } from "../lib/projectConfig.ts";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { buildMachineOptions, THIS_MAC, toMachine } from "../lib/machines.ts";
import { buildFallbackProject } from "../lib/fallbackProject.ts";

const ADD_PROJECT = "\u0000add-project";

/** Which project a draft starts in, one entry per repo whatever machines it's on; also the way to add one. */
function ProjectList({
  cwd,
  onPick,
  focusSignal,
}: {
  cwd: string | null;
  onPick: (path: string | null) => void;
  focusSignal: number;
}) {
  const projects = useStore((state) => state.projects);
  const threads = useStore((state) => state.threads);
  const projectHosts = useStore((state) => state.projectHosts);
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const copies = new Map<string, Array<Project>>();
  for (const project of projects) {
    copies.set(getProjectKey(project), [...(copies.get(getProjectKey(project)) ?? []), project]);
  }

  const current = projects.find((project) => project.path === cwd);
  const currentKey = current && getProjectKey(current);

  function getLastUsedAt(project: Project) {
    return Math.max(
      0,
      ...Object.values(threads).flatMap((info) =>
        info.projectId === project.id ? [info.updatedAt] : [],
      ),
    );
  }

  // The copy on the machine the project was last worked on, else this Mac's.
  function getPreferredCopy(key: string) {
    return [...(copies.get(key) ?? [])].sort(
      (left, right) =>
        getLastUsedAt(right) - getLastUsedAt(left) ||
        Number(Boolean(projectHosts[left.id])) - Number(Boolean(projectHosts[right.id])),
    )[0];
  }

  const isOnAnotherMachine = projects.some((project) => projectHosts[project.id]);
  const needle = query.trim().toLowerCase();
  const rows = [
    ...[...copies]
      .map(([key, projectCopies]) => ({
        key,
        projectCopies,
        lastUsedAt: Math.max(...projectCopies.map(getLastUsedAt)),
      }))
      .sort(
        (left, right) =>
          right.lastUsedAt - left.lastUsedAt ||
          left.projectCopies[0].name.localeCompare(right.projectCopies[0].name),
      )
      .map(({ key, projectCopies }) => {
        const shown = getPreferredCopy(key);
        const path = shown.path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
        return {
          id: key,
          project: shown,
          where: isOnAnotherMachine
            ? `${path} · ${projectCopies.map((copy) => projectHosts[copy.id] ?? "This Mac").join(", ")}`
            : path,
        };
      })
      .filter(
        (row) =>
          row.project.name.toLowerCase().includes(needle) ||
          row.where.toLowerCase().includes(needle),
      ),
    { id: ADD_PROJECT, project: null, where: "" },
  ];
  const { activeIndex, moveActive } = useRowCursor(rows, needle);

  useEffect(() => {
    if (focusSignal) searchRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  useEffect(() => {
    if (isSearching)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, isSearching]);

  function pickRow(row: (typeof rows)[number]) {
    setQuery("");
    if (row.project) {
      onPick(row.project.path);
      focusComposer();
    } else {
      void addProject().then((path) => {
        if (!path) return;
        onPick(path);
        focusComposer();
      });
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-1 text-left [-webkit-app-region:no-drag]">
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setIsSearching(true)}
        onBlur={() => setIsSearching(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            pickRow(rows[activeIndex]);
          } else if (event.key === "Escape") {
            if (query) setQuery("");
            else if (cwd) focusComposer();
          }
        }}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={isSearching ? `${listId}-${activeIndex}` : undefined}
        placeholder="Search projects…"
        className="mb-1 h-8 w-full rounded-lg bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Project"
        className="scrollbar-hide flex max-h-[45vh] flex-col gap-0.5 overflow-y-auto overscroll-contain"
      >
        {rows.map((row, index) => (
          <button
            key={row.id}
            id={`${listId}-${index}`}
            type="button"
            role="option"
            aria-selected={row.id === currentKey}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pickRow(row)}
            className={cn(
              "flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground",
              isSearching && index === activeIndex && "bg-muted text-foreground",
              row.id === currentKey && "text-foreground",
            )}
          >
            {row.project ? (
              <>
                <ProjectBadge project={row.project} />
                <span className="shrink-0">{row.project.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                  {row.where}
                </span>
                {row.id === currentKey ? <Check className="size-3.5 shrink-0" /> : null}
              </>
            ) : (
              <>
                <FolderPlus className="size-4 shrink-0" />
                Add project…
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Clones a project onto a machine that doesn't have it yet, from its git origin. */
function CloneCopy({
  project,
  machine,
  onCloned,
}: {
  project: Project;
  machine: string | null;
  onCloned: (path: string) => void;
}) {
  const addProjectFolder = useStore((state) => state.settings.addProjectFolder);
  const hostProjectFolder = useStore((state) =>
    machine === null ? undefined : state.settings.hostProjectFolders?.[machine],
  );
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const where = machine ?? "this Mac";
  // This Mac's clone folder is a Mac path unless it's under ~, which means the host's home there.
  const parent =
    machine === null
      ? (addProjectFolder ?? "~")
      : hostProjectFolder || (addProjectFolder?.startsWith("~") ? addProjectFolder : "~/code");

  if (!project.remote) {
    return (
      <span>
        {project.name} isn't a git repo with a remote, so it can't be cloned to {where}. Add its
        folder there with Add project.
      </span>
    );
  }

  return (
    <span className="flex flex-col items-center gap-3">
      <span>
        {project.name} isn't on {where} yet.
      </span>
      <Button
        className="rounded-lg [-webkit-app-region:no-drag]"
        disabled={isCloning}
        onClick={async () => {
          setIsCloning(true);
          setError(null);
          const cloned = await cloneProject(
            machine,
            project.remote!,
            parent,
            project.folder ?? undefined,
            // The same folder name as here, so both copies read the same; a subfolder's repo keeps its own.
            project.folder ? undefined : project.name,
          );
          setIsCloning(false);
          if (cloned.path) onCloned(cloned.path);
          else setError(cloned.error);
        }}
      >
        {isCloning ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {isCloning
          ? "Cloning…"
          : `Clone into ${[parent.replace(/\/$/, ""), project.folder ? parseRepository(project.remote).split("/").at(-1) : project.name, project.folder].filter(Boolean).join("/")}`}
      </Button>
      {error ? <span className="max-w-md text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/** A new chat that only exists in this window until its first message creates the thread. */
export function DraftView({
  path,
  onPickProject,
}: {
  path: string | null;
  onPickProject: (path: string | null) => void;
}) {
  const pathHost = usePathHost(path);
  const settings = useStore((state) => state.settings);
  const projects = useStore((state) => state.projects);
  const projectHosts = useStore((state) => state.projectHosts);
  const hosts = useStore((state) => state.hosts);
  const project = projects.find((candidate) => candidate.path === path);
  // A machine picked that has no copy of the draft's project yet; it resets with the project.
  const [missing, setMissing] = useState<{ path: string; machine: string | null } | null>(null);
  const missingOn = missing && missing.path === path ? missing : null;
  const host = missingOn ? missingOn.machine : pathHost;
  const providers = useProviders(host);

  function findCopyOn(machine: string | null) {
    return (
      project &&
      projects.find(
        (candidate) =>
          getProjectKey(candidate) === getProjectKey(project) &&
          (projectHosts[candidate.id] ?? null) === machine,
      )
    );
  }

  // A scan on the picked machine can find its copy after the clone offer shows.
  const arrivedPath = missingOn ? findCopyOn(missingOn.machine)?.path : undefined;
  useEffect(() => {
    if (!arrivedPath) return;
    setMissing(null);
    onPickProject(arrivedPath);
  }, [arrivedPath, onPickProject]);

  const choices = buildModelChoices(providers, settings);
  const saved = settings.newThreadModel;
  const lastModel = findDefaultModel(providers, settings, settings.lastProvider);
  const preferred =
    saved && choices.some((option) => option.value === saved)
      ? saved
      : lastModel
        ? encodeChoice(settings.lastProvider, lastModel)
        : undefined;
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const selected =
    [choice, preferred].find(
      (candidate) => candidate && choices.some((option) => option.value === candidate),
    ) ?? choices[0]?.value;
  // Shift-click adds models: the prompt then starts one thread per model, each in its own worktree.
  const [extras, setExtras] = useState<Array<string>>([]);
  const extraModels = extras.filter(
    (extra) => extra !== selected && choices.some((option) => option.value === extra),
  );
  // Null until picked in the composer: then the project's `masscode.toml` decides, else Settings.
  const [pickedWorkspace, setWorkspace] = useState<"local" | "worktree" | null>(null);
  const isWorktreeByDefault = useProjectConfig(host, missingOn ? null : path)?.config.worktree
    ?.default;
  const workspace =
    pickedWorkspace ??
    (isWorktreeByDefault === undefined
      ? (settings.workspace ?? "local")
      : isWorktreeByDefault
        ? "worktree"
        : "local");
  const [projectSignal, setProjectSignal] = useState(0);
  const isCheckingProviders = providers.some((provider) => provider.checking);

  function renderCenterContent() {
    if (missingOn && project) {
      return (
        <CloneCopy
          project={project}
          machine={missingOn.machine}
          onCloned={(clonedPath) => {
            setMissing(null);
            onPickProject(clonedPath);
          }}
        />
      );
    }
    if (choices.length) {
      return (
        <div className="flex w-full flex-col items-center gap-6">
          <OrbFace className="size-20" />
          <ProjectList cwd={path} onPick={onPickProject} focusSignal={projectSignal} />
        </div>
      );
    }
    if (isCheckingProviders) return "Checking Claude and Codex…";
    if (host) return `Link a harness on ${host} in Settings → Harnesses to start.`;
    return "Link a harness in Settings to start.";
  }

  function getPlaceholder() {
    if (!selected) return isCheckingProviders ? "Checking harnesses…" : "No harness linked";
    if (!path) return "Pick a project above to start…";
    if (missingOn) {
      return `Clone ${project?.name ?? "the project"} to ${missingOn.machine ?? "this Mac"} to start…`;
    }
    if (extraModels.length)
      return `Ask ${extraModels.length + 1} models, each in its own worktree…`;
    return `Ask ${formatHarnessLabel(settings, decodeChoice(selected).provider)}…`;
  }

  return (
    <>
      <ThreadHeader
        project={path ? (project ?? buildFallbackProject(path, path)) : undefined}
        title="New thread"
      />
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground [-webkit-app-region:drag]">
        {renderCenterContent()}
      </div>
      <Composer
        // Stable across the project pick, so effort/permission choices carry over.
        prefsKey="draft:new"
        provider={selected ? decodeChoice(selected).provider : settings.lastProvider}
        cwd={missingOn ? null : path}
        onNeedProject={() => setProjectSignal((signal) => signal + 1)}
        disabled={!selected || Boolean(missingOn)}
        machine={
          project && Object.keys(hosts).length
            ? {
                value: host ?? THIS_MAC,
                options: buildMachineOptions(hosts).map((option) => ({
                  value: option.value,
                  label: option.label,
                  description: findCopyOn(option.machine)?.path ?? "Not cloned here yet",
                  icon: option.machine ? <Server /> : <Monitor />,
                })),
                onChange: (value) => {
                  const machine = toMachine(value);
                  const copy = findCopyOn(machine);
                  if (copy) {
                    setMissing(null);
                    onPickProject(copy.path);
                  } else if (path) setMissing({ path, machine });
                },
              }
            : undefined
        }
        models={choices}
        model={selected}
        onModelChange={(value) => {
          setChoice(value);
          setExtras([]);
        }}
        extraModels={extraModels}
        onToggleModel={(value) =>
          setExtras((current) =>
            current.includes(value)
              ? current.filter((extra) => extra !== value)
              : [...current, value],
          )
        }
        workspace={{ value: workspace, onChange: setWorkspace }}
        placeholder={getPlaceholder()}
        onSubmit={(text, options, how) => {
          if (!selected || !path) return;
          const pickedModels = [selected, ...extraModels];
          for (const value of pickedModels) {
            const { provider, model } = decodeChoice(value);
            createThread({
              path,
              provider,
              model,
              text,
              options,
              workspace: pickedModels.length > 1 ? "worktree" : workspace,
              // Several models, or ⌘Enter: start in the background and stay in the draft.
              shouldOpen: pickedModels.length === 1 && !how.alternate,
            });
          }
        }}
      />
    </>
  );
}
