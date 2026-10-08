import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageGroup,
  MessageScroller,
} from "@apcode/ui/agents/message";
import { Markdown } from "@apcode/ui/agents/markdown";
import { Reasoning, thoughtTitle } from "@apcode/ui/agents/reasoning";
import * as Match from "effect/Match";
import { ThinkingShimmer } from "@apcode/ui/agents/loading-states/thinking-shimmer";
import { OrbFace } from "@apcode/ui/agents/orb-face";
import { PromptInputTray, PromptSelect } from "@apcode/ui/agents/prompt-input";
import { useRowCursor } from "@apcode/ui/hooks/use-row-cursor";
import { Fold } from "@apcode/ui/motion/fold";
import { StreamingResponse } from "@apcode/ui/agents/streaming-response";
import { ApprovalCard } from "@apcode/ui/agents/approval-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@apcode/ui/components/alert-dialog";
import { ToolApproval, ToolApprovalCode } from "@apcode/ui/agents/tool-approval";
import {
  categoryOf,
  livePhrase,
  summarize,
  ToolCallRow,
  ToolGroup,
  type ToolCall,
  type ToolReveal,
} from "@apcode/ui/agents/tool-group";
import { ProjectBadge, projectLabel } from "@/components/project-badge";
import { addProject, projectKey } from "../lib/projects.ts";
import { Button } from "@apcode/ui/motion/button/base";
import { Drawer } from "@apcode/ui/motion/drawer";
import { Textarea } from "@apcode/ui/components/textarea";
import { cn } from "@apcode/ui/lib/utils";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@apcode/ui/components/dropdown-menu";
import {
  type Attachment,
  ClientCommand,
  type CommandRun,
  isTurnActive,
  type LimitStop,
  type Project,
  type ProviderKind,
  type ProviderStatus,
  type QueuedMessage,
  repositoryOf,
  type Settings,
  type TurnOptions,
} from "@apcode/contracts";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "@apcode/ui/motion/animated-sidebar";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownRight,
  FileDiff,
  FileText,
  GitFork,
  FolderPlus,
  FolderTree,
  Gauge,
  Globe,
  ImageIcon,
  LoaderCircle,
  MessageSquare,
  Monitor,
  PanelLeft,
  Play,
  Pencil,
  Quote,
  Server,
  Square,
  SquareTerminal,
  Undo2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  lazy,
  memo,
  type ReactNode,
  type RefObject,
  Suspense,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toggleBrowser, useBrowser } from "../lib/browser.ts";
import {
  approvePlan,
  BUILD_WITH_LABEL,
  PERMISSIONS,
  fromSent,
  toTurnOptions,
  useNeedsRootConsent,
  useTurnPrefs,
} from "../lib/composer.ts";
import { appendToDraft, focusComposer, getDraft, setDraft } from "../lib/drafts.ts";
import { describe, useKeybinding } from "../lib/keybindings.ts";
import { TranscriptFind } from "./TranscriptFind.tsx";
import {
  describeRange,
  removeReviewComment,
  type ReviewComment,
  takeReviewComments,
  useReviewComments,
  withReviewComments,
} from "../lib/reviewComments.ts";
import { useNow } from "../lib/time.ts";
import { resetLabel } from "./UsageMeter.tsx";
import {
  decodeChoice,
  defaultModel,
  encodeChoice,
  harnessLabel,
  modelChoices,
} from "../lib/models.ts";
import {
  closeTerminal,
  cloneProject,
  createThread,
  dismissForkError,
  forkThread,
  openSideChat,
  askSideChat,
  closeSideChat,
  loadOlder,
  markSeen,
  queueMessage,
  respondApproval,
  runCommand,
  type RunningCommand,
  send,
  sendQueuedNow,
  switchToThread,
  takeQueued,
  toggleTerminalPanel,
  useFileRestoreBlocker,
  usePathHost,
  useProjectHost,
  useProviders,
  useStore,
  useThreadHost,
  useTranscript,
  type TranscriptItem,
} from "../lib/store.ts";
import { readWidth } from "@apcode/ui/hooks/use-resizable";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { Composer, RootFullAccessDialog } from "./Composer.tsx";
import { GitMenu } from "./GitMenu.tsx";
import { hasTrafficLights } from "./Sidebar.tsx";

/** Same key the panel saves its dragged width under. */
const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() => import("./DiffPanel.tsx").then((m) => ({ default: m.DiffPanel })));
const TerminalPanel = lazy(() =>
  import("./TerminalPanel.tsx").then((m) => ({ default: m.TerminalPanel })),
);
const TerminalView = lazy(() =>
  import("./TerminalPanel.tsx").then((m) => ({ default: m.TerminalView })),
);

/** Consecutive agent items form one turn under a single avatar. */
type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** Where a thread's own conversation starts: forked from or started by another thread. */
type MarkerItem = Extract<TranscriptItem, { kind: "forked" | "startedBy" }>;

type Turn =
  | { readonly from: "user"; readonly id: string; readonly item: UserItem }
  | {
      readonly from: "assistant";
      readonly id: string;
      readonly items: Array<TranscriptItem>;
    }
  | { readonly from: "marker"; readonly id: string; readonly item: MarkerItem };

const toTurns = (items: ReadonlyArray<TranscriptItem>): Array<Turn> => {
  const turns: Array<Turn> = [];
  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ from: "user", id: item.id, item });
      continue;
    }
    if (item.kind === "forked" || item.kind === "startedBy") {
      turns.push({ from: "marker", id: item.id, item });
      continue;
    }
    const last = turns.at(-1);
    if (last?.from === "assistant") last.items.push(item);
    else turns.push({ from: "assistant", id: item.id, items: [item] });
  }
  return turns;
};

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/**
 * Within a turn, consecutive tool calls collapse into one group row, and the thinking, tool
 * calls and messages on the way to the answer fold into one work row.
 */
type Block =
  | { readonly kind: "tools"; readonly id: string; readonly calls: Array<ToolItem> }
  | { readonly kind: "work"; readonly id: string; readonly items: Array<TranscriptItem> }
  | Exclude<TranscriptItem, ToolItem>;

function toToolGroups(items: ReadonlyArray<TranscriptItem>): Array<Block> {
  const blocks: Array<Block> = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      blocks.push(item);
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "tools") last.calls.push(item);
    else blocks.push({ kind: "tools", id: item.id, calls: [item] });
  }
  return blocks;
}

/** Approvals granted along the way render nothing, so they shouldn't split the work row. */
function isWork(item: TranscriptItem) {
  return (
    item.kind === "reasoning" ||
    item.kind === "tool" ||
    item.kind === "assistant" ||
    (item.kind === "approval" &&
      item.resolved &&
      item.decision !== "deny" &&
      !item.questions &&
      item.title !== "ExitPlanMode")
  );
}

function toBlocks(items: ReadonlyArray<TranscriptItem>): Array<Block> {
  const lastWork = items.findLast(isWork);
  const answer = lastWork?.kind === "assistant" ? lastWork : undefined;
  const blocks: Array<Block> = [];
  for (const item of items) {
    if (item.kind !== "tool" && (item === answer || !isWork(item))) {
      blocks.push(item);
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "work") last.items.push(item);
    else blocks.push({ kind: "work", id: item.id, items: [item] });
  }
  // A lone thinking block or tool group already folds to one row.
  return blocks.flatMap((block) => {
    if (block.kind !== "work") return [block];
    const inner = toToolGroups(block.items);
    return inner.length === 1 ? inner : [block];
  });
}

/** Whether `item`, the newest one, is in `block`. */
function holdsNewest(block: Block, item: TranscriptItem | undefined) {
  return block.kind === "work" ? block.items.at(-1) === item : block === item;
}

/** Top bar: project / title breadcrumb. Leaves room for the traffic lights when the sidebar is folded away. */
const Header = ({
  project,
  title,
  badge,
  actions,
}: {
  project?: Pick<Project, "id" | "name" | "remote" | "folder"> | undefined;
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) => {
  const { open } = useAnimatedSidebar();
  const host = useProjectHost(project?.id ?? "");
  return (
    // Same row geometry as the sidebar's title bar, so both line up with the traffic lights.
    <header
      className={`flex h-10 shrink-0 items-center gap-2 pr-4 pb-[3px] [-webkit-app-region:drag] ${open ? "pl-5" : hasTrafficLights ? "pl-[86px]" : "pl-3"}`}
    >
      {open ? null : (
        <AnimatedSidebarTrigger className="mr-1 size-7 rounded-lg text-muted-foreground [-webkit-app-region:no-drag] hover:bg-muted/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
      )}
      {project ? (
        <>
          <ProjectBadge project={project} className="translate-y-px" />
          <span className="shrink-0 text-sm text-muted-foreground">
            {projectLabel(project.name, host)}
          </span>
          <span className="shrink-0 text-sm text-muted-foreground/50">/</span>
        </>
      ) : null}
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
      {badge}
      {actions ? (
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 [-webkit-app-region:no-drag]">
          {actions}
        </span>
      ) : null}
    </header>
  );
};

const ADD_PROJECT = "\u0000add-project";

/** Which project a draft starts in, one entry per repo whatever machines it's on; also the way to add one. */
const ProjectList = ({
  cwd,
  onPick,
  focusSignal,
}: {
  cwd: string | null;
  onPick: (path: string | null) => void;
  focusSignal: number;
}) => {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const projectHosts = useStore((s) => s.projectHosts);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const copies = new Map<string, Array<Project>>();
  for (const project of projects)
    copies.set(projectKey(project), [...(copies.get(projectKey(project)) ?? []), project]);
  const current = projects.find((p) => p.path === cwd);
  const currentKey = current && projectKey(current);
  const lastUsed = (project: Project) =>
    Math.max(
      0,
      ...Object.values(threads).flatMap((info) =>
        info.projectId === project.id ? [info.updatedAt] : [],
      ),
    );
  // The copy on the machine the project was last worked on, else this Mac's.
  const preferred = (key: string) =>
    [...(copies.get(key) ?? [])].sort(
      (a, b) =>
        lastUsed(b) - lastUsed(a) ||
        Number(Boolean(projectHosts[a.id])) - Number(Boolean(projectHosts[b.id])),
    )[0]!;
  const onAnotherMachine = projects.some((project) => projectHosts[project.id]);
  const needle = query.trim().toLowerCase();
  const rows = [
    ...[...copies]
      .map(([key, projectCopies]) => ({
        key,
        projectCopies,
        lastUsedAt: Math.max(...projectCopies.map(lastUsed)),
      }))
      .sort(
        (a, b) =>
          b.lastUsedAt - a.lastUsedAt ||
          a.projectCopies[0]!.name.localeCompare(b.projectCopies[0]!.name),
      )
      .map(({ key, projectCopies }) => {
        const shown = preferred(key);
        const path = shown.path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
        return {
          id: key,
          project: shown,
          where: onAnotherMachine
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
    if (searching)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, searching]);

  function pick(row: (typeof rows)[number]) {
    setQuery("");
    if (row.project) {
      onPick(row.project.path);
      focusComposer();
    } else
      void addProject().then((path) => {
        if (!path) return;
        onPick(path);
        focusComposer();
      });
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-1 text-left [-webkit-app-region:no-drag]">
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setSearching(true)}
        onBlur={() => setSearching(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(rows[activeIndex]!);
          } else if (event.key === "Escape") {
            if (query) setQuery("");
            else if (cwd) focusComposer();
          }
        }}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={searching ? `${listId}-${activeIndex}` : undefined}
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
            onClick={() => pick(row)}
            className={cn(
              "flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground",
              searching && index === activeIndex && "bg-muted text-foreground",
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
};

const THIS_MAC = "\u0000this-mac";

/** Clones a project onto a machine that doesn't have it yet, from its git origin. */
const CloneCopy = ({
  project,
  machine,
  onCloned,
}: {
  project: Project;
  machine: string | null;
  onCloned: (path: string) => void;
}) => {
  const addProjectFolder = useStore((s) => s.settings.addProjectFolder);
  const hostProjectFolder = useStore((s) =>
    machine === null ? undefined : s.settings.hostProjectFolders?.[machine],
  );
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = machine ?? "this Mac";
  // This Mac's clone folder is a Mac path unless it's under ~, which means the host's home there.
  const parent =
    machine === null
      ? (addProjectFolder ?? "~")
      : hostProjectFolder || (addProjectFolder?.startsWith("~") ? addProjectFolder : "~/code");
  if (!project.remote)
    return (
      <span>
        {project.name} isn't a git repo with a remote, so it can't be cloned to {where}. Add its
        folder there with Add project.
      </span>
    );
  return (
    <span className="flex flex-col items-center gap-3">
      <span>
        {project.name} isn't on {where} yet.
      </span>
      <Button
        className="rounded-lg [-webkit-app-region:no-drag]"
        disabled={cloning}
        onClick={async () => {
          setCloning(true);
          setError(null);
          const cloned = await cloneProject(
            machine,
            project.remote!,
            parent,
            project.folder ?? undefined,
            // The same folder name as here, so both copies read the same; a subfolder's repo keeps its own.
            project.folder ? undefined : project.name,
          );
          setCloning(false);
          if (cloned.path) onCloned(cloned.path);
          else setError(cloned.error);
        }}
      >
        {cloning ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {cloning
          ? "Cloning…"
          : `Clone into ${[parent.replace(/\/$/, ""), project.folder ? repositoryOf(project.remote).split("/").at(-1) : project.name, project.folder].filter(Boolean).join("/")}`}
      </Button>
      {error ? <span className="max-w-md text-xs text-destructive">{error}</span> : null}
    </span>
  );
};

/** A new chat that only exists in this window until its first message creates the thread. */
export const DraftView = ({
  path,
  onPickProject,
}: {
  path: string | null;
  onPickProject: (path: string | null) => void;
}) => {
  const pathHost = usePathHost(path);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const projectHosts = useStore((s) => s.projectHosts);
  const hosts = useStore((s) => s.hosts);
  const project = projects.find((p) => p.path === path);
  // A machine picked that has no copy of the draft's project yet; it resets with the project.
  const [missing, setMissing] = useState<{ path: string; machine: string | null } | null>(null);
  const missingOn = missing && missing.path === path ? missing : null;
  const host = missingOn ? missingOn.machine : pathHost;
  const providers = useProviders(host);
  const copyOn = (machine: string | null) =>
    project &&
    projects.find(
      (candidate) =>
        projectKey(candidate) === projectKey(project) &&
        (projectHosts[candidate.id] ?? null) === machine,
    );
  // A scan on the picked machine can find its copy after the clone offer shows.
  const arrivedPath = missingOn ? copyOn(missingOn.machine)?.path : undefined;
  useEffect(() => {
    if (!arrivedPath) return;
    setMissing(null);
    onPickProject(arrivedPath);
  }, [arrivedPath, onPickProject]);
  const choices = modelChoices(providers, settings);
  const saved = settings.newThreadModel;
  const lastModel = defaultModel(providers, settings, settings.lastProvider);
  const preferred =
    saved && choices.some((o) => o.value === saved)
      ? saved
      : lastModel
        ? encodeChoice(settings.lastProvider, lastModel)
        : undefined;
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const selected =
    [choice, preferred].find((c) => c && choices.some((o) => o.value === c)) ?? choices[0]?.value;
  // Shift-click adds models: the prompt then starts one thread per model, each in its own worktree.
  const [extras, setExtras] = useState<Array<string>>([]);
  const extraModels = extras.filter((c) => c !== selected && choices.some((o) => o.value === c));
  const [workspace, setWorkspace] = useState(settings.workspace ?? "local");
  const [projectSignal, setProjectSignal] = useState(0);

  return (
    <>
      <Header
        project={path ? (project ?? { id: path, name: path.split("/").at(-1) ?? path }) : undefined}
        title="New thread"
      />
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground [-webkit-app-region:drag]">
        {missingOn && project ? (
          <CloneCopy
            project={project}
            machine={missingOn.machine}
            onCloned={(clonedPath) => {
              setMissing(null);
              onPickProject(clonedPath);
            }}
          />
        ) : choices.length ? (
          <div className="flex w-full flex-col items-center gap-6">
            <OrbFace className="size-20" />
            <ProjectList cwd={path} onPick={onPickProject} focusSignal={projectSignal} />
          </div>
        ) : providers.some((p) => p.checking) ? (
          "Checking Claude and Codex…"
        ) : host ? (
          `Link a harness on ${host} in Settings → Harnesses to start.`
        ) : (
          "Link a harness in Settings to start."
        )}
      </div>
      <Composer
        // Stable across the project pick, so effort/permission choices carry over.
        prefsKey="draft:new"
        provider={selected ? decodeChoice(selected).provider : settings.lastProvider}
        cwd={missingOn ? null : path}
        onNeedProject={() => setProjectSignal((n) => n + 1)}
        disabled={!selected || Boolean(missingOn)}
        machine={
          project && Object.keys(hosts).length
            ? {
                value: host ?? THIS_MAC,
                options: [null, ...Object.keys(hosts)].map((machine) => ({
                  value: machine ?? THIS_MAC,
                  label: machine ?? "This Mac",
                  description: copyOn(machine)?.path ?? "Not cloned here yet",
                  icon: machine ? <Server /> : <Monitor />,
                })),
                onChange: (value) => {
                  const machine = value === THIS_MAC ? null : value;
                  const copy = copyOn(machine);
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
          setExtras((prev) =>
            prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value],
          )
        }
        workspace={{ value: workspace, onChange: setWorkspace }}
        placeholder={
          !selected
            ? providers.some((p) => p.checking)
              ? "Checking harnesses…"
              : "No harness linked"
            : !path
              ? "Pick a project above to start…"
              : missingOn
                ? `Clone ${project?.name ?? "the project"} to ${missingOn.machine ?? "this Mac"} to start…`
                : extraModels.length
                  ? `Ask ${extraModels.length + 1} models, each in its own worktree…`
                  : `Ask ${harnessLabel(settings, decodeChoice(selected).provider)}…`
        }
        onSubmit={(text, options, how) => {
          if (!selected || !path) return;
          const all = [selected, ...extraModels];
          for (const value of all) {
            const { provider, model } = decodeChoice(value);
            // Several models, or ⌘Enter: start in the background and stay in the draft.
            const open = all.length === 1 && !how.alternate;
            createThread({
              path,
              provider,
              model,
              text,
              options,
              workspace: all.length > 1 ? "worktree" : workspace,
              open,
            });
          }
        }}
      />
    </>
  );
};

const AttachmentList = ({ attachments }: { attachments: ReadonlyArray<Attachment> }) => (
  <div className="flex flex-wrap justify-end gap-1.5">
    {attachments.map((attachment) => {
      const Icon = attachment.isImage ? ImageIcon : FileText;
      return (
        <span
          key={attachment.path}
          title={attachment.path}
          className="flex h-7 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground"
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate text-foreground">{attachment.name}</span>
        </span>
      );
    })}
  </div>
);

const NO_ITEMS: ReadonlyArray<TranscriptItem> = [];
const NO_QUEUE: ReadonlyArray<QueuedMessage> = [];
const NO_RUNS: ReadonlyArray<RunningCommand> = [];

/** Opens the changes panel on one turn; provided by the thread view to the checkpoint chips deep in the transcript. */
const TurnDiffContext = createContext<(messageId: string) => void>(() => {});
/** The tool call last picked in the running-subagents list, for its group to open and scroll to. */
const RevealContext = createContext<ToolReveal | null>(null);
/** Hands a shell block's command to the agent as a message; provided by the thread view to its replies. */
const RunCommandContext = createContext<((command: string) => void) | undefined>(undefined);

/** Held messages go back into the composer, after whatever is there. */
const returnToComposer = (threadId: string, queued: ReadonlyArray<QueuedMessage>) => {
  if (!queued.length) return;
  appendToDraft(threadId, queued.map((message) => message.text).join("\n\n"));
  focusComposer();
};

/** A message waiting for the turn to end: sends by itself then, or steers it now, or goes back to the composer. */
const QueuedFollowUp = ({
  threadId,
  followUp,
  next,
}: {
  threadId: string;
  followUp: QueuedMessage;
  /** First in line: it goes out at the next boundary, and the steer shortcut sends it. */
  next: boolean;
}) => (
  <div
    className="flex h-8 items-center gap-2 pl-1.5"
    title={
      next
        ? "Sends after the next tool call, or when the turn ends"
        : "Sends after the messages above it"
    }
  >
    <CornerDownRight className="size-3.5 shrink-0" />
    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">{followUp.text}</span>
    {followUp.attachments.length ? (
      <span className="shrink-0">
        {followUp.attachments.length} file
        {followUp.attachments.length === 1 ? "" : "s"}
      </span>
    ) : null}
    <button
      type="button"
      title={`Send now, into the running turn${next ? ` (${describe("composer.steerQueued")})` : ""}`}
      onClick={() => sendQueuedNow(threadId, followUp.id)}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CornerDownRight className="size-3.5" />
      Steer
    </button>
    <IconAction
      label="Edit in the composer"
      onClick={() => returnToComposer(threadId, takeQueued(threadId, followUp.id))}
    >
      <Pencil className="size-3.5" />
    </IconAction>
  </div>
);

/** A usage limit stopped the thread and holds its queue: when it resets, and the ways to carry on. */
function LimitStopNotice({
  threadId,
  stop,
  provider,
  providers,
  settings,
  options,
}: {
  threadId: string;
  stop: LimitStop;
  provider: ProviderKind;
  providers: ReadonlyArray<ProviderStatus>;
  settings: Settings;
  /** The composer's, for the message that continues the thread. */
  options: TurnOptions;
}) {
  const now = useNow(30_000);
  const waiting = stop.resetsAt !== null && stop.resetsAt > now;
  const others = providers.filter(
    (other) => other.linked && other.kind !== stop.provider && other.kind !== provider,
  );
  return (
    <div role="status" className="pb-1.5">
      <div className="flex h-8 items-center gap-2 pl-1.5">
        <Gauge className="size-3.5 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
          {harnessLabel(settings, stop.provider)} hit its usage limit
          {stop.resetsAt === null ? null : (
            <span className="ml-1 text-muted-foreground">
              {" "}
              {waiting ? resetLabel(stop.resetsAt, now) : "It has reset"}
            </span>
          )}
        </span>
        <IconAction
          label="Dismiss; queued messages go back to the composer"
          onClick={() => {
            send(ClientCommand.cases["thread.dismissLimitStop"].make({ threadId }));
            returnToComposer(threadId, takeQueued(threadId));
          }}
        >
          <X className="size-3.5" />
        </IconAction>
      </div>
      <div className="flex items-center gap-1 pl-5">
        <button
          type="button"
          title={`Continue with ${harnessLabel(settings, provider)} now`}
          onClick={() =>
            send(ClientCommand.cases["thread.resumeAfterLimit"].make({ threadId, options }))
          }
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Play className="size-3.5" />
          Resume
        </button>
        {waiting ? (
          <button
            type="button"
            aria-pressed={stop.resumeAtReset !== null}
            title={
              stop.resumeAtReset
                ? "Don't continue by itself"
                : "Continue by itself once the limit resets"
            }
            onClick={() =>
              send(
                ClientCommand.cases["thread.resumeAtReset"].make({
                  threadId,
                  options: stop.resumeAtReset ? null : options,
                }),
              )
            }
            className={cn(
              "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              stop.resumeAtReset && "text-amber-500",
            )}
          >
            <Clock className="size-3.5" />
            {stop.resumeAtReset ? "Resuming at reset" : "Resume at reset"}
          </button>
        ) : null}
        {others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="Move the thread to another harness and continue there; it's told what happened so far"
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
              >
                <ArrowLeftRight className="size-3.5" />
                Hand off
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} collisionPadding={8}>
              {others.map((other) => {
                const Logo = PROVIDER_LOGO[other.kind];
                return (
                  <DropdownMenuItem
                    key={other.kind}
                    onSelect={() =>
                      send(
                        ClientCommand.cases["thread.resumeAfterLimit"].make({
                          threadId,
                          // Effort levels differ per harness; the new one starts on its own.
                          options: { ...options, effort: null, fast: undefined },
                          provider: other.kind,
                        }),
                      )
                    }
                  >
                    <Logo className="size-3.5" />
                    {harnessLabel(settings, other.kind)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

/** A diff comment waiting to go out with the next message; clicking it shows it in the diff. */
function ReviewCommentRow({
  threadId,
  comment,
  onReveal,
}: {
  threadId: string;
  comment: ReviewComment;
  onReveal: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 pl-1.5">
      <MessageSquare className="size-3.5 shrink-0" />
      <button
        type="button"
        title={`Show in the diff: ${comment.path}, ${describeRange(comment.range)}`}
        onClick={onReveal}
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none focus-visible:underline"
      >
        <span className="shrink-0 font-mono text-[11px]">
          {comment.path.slice(comment.path.lastIndexOf("/") + 1)}, {describeRange(comment.range)}
        </span>
        <span className="min-w-0 truncate text-[13px] text-foreground/80">{comment.text}</span>
      </button>
      <IconAction label="Delete comment" onClick={() => removeReviewComment(threadId, comment.id)}>
        <X className="size-3.5" />
      </IconAction>
    </div>
  );
}

const IconAction = (props: { label: string; onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    title={props.label}
    aria-label={props.label}
    onClick={props.onClick}
    className="grid size-6 place-items-center rounded-md transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
  >
    {props.children}
  </button>
);

/**
 * Selecting text in an agent reply offers to quote it in the composer, where you can
 * comment on it (t3code's "Cite in composer").
 */
const QuoteSelection = ({
  container,
  threadId,
}: {
  container: RefObject<HTMLDivElement | null>;
  threadId: string;
}) => {
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const area = container.current;
    if (!area) return;
    const update = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      const node = selection?.anchorNode;
      const inReply =
        node &&
        area.contains(node) &&
        (node instanceof Element ? node : node.parentElement)?.closest('[data-from="assistant"]');
      if (!selection || selection.isCollapsed || !text || !inReply) return setQuote(null);
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const box = area.getBoundingClientRect();
      setQuote({
        text,
        top: rect.top - box.top - 34,
        left: Math.min(Math.max(rect.left - box.left + rect.width / 2, 40), box.width - 40),
      });
    };
    const clear = () => document.getSelection()?.isCollapsed && setQuote(null);
    area.addEventListener("mouseup", update);
    area.addEventListener("keyup", update);
    document.addEventListener("selectionchange", clear);
    return () => {
      area.removeEventListener("mouseup", update);
      area.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", clear);
    };
  }, [container]);
  if (!quote) return null;
  return (
    <button
      type="button"
      style={{ top: Math.max(quote.top, 4), left: quote.left }}
      // Keep the selection while clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        appendToDraft(
          threadId,
          `${quote.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}\n\n`,
        );
        document.getSelection()?.removeAllRanges();
        setQuote(null);
        focusComposer();
      }}
      className="absolute z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-panel"
    >
      <Quote className="size-3" />
      Quote in composer
    </button>
  );
};

export const ThreadView = ({ threadId }: { threadId: string }) => {
  const info = useStore((s) => s.threads[threadId])!;
  // Loaded on open: from the local cache first, then caught up by the daemon.
  const transcript = useTranscript(threadId);
  const items = transcript?.items ?? NO_ITEMS;
  const host = useThreadHost(threadId);
  const providers = useProviders(host);
  const settings = useStore((s) => s.settings);
  const { status, provider } = info;
  const busy = isTurnActive(status);
  // Another harness's model switches the thread to it, which waits for the turn to end.
  const choices = modelChoices(providers, settings, busy ? provider : undefined);
  const current = info.model ?? defaultModel(providers, settings, provider);
  const lastItem = items.at(-1);
  // `/btw` asks about the newest reply whose turn is over.
  const runningTurnStart = busy
    ? items.findLastIndex((item) => item.kind === "user" && !item.steer)
    : items.length;
  const asideReplyId = items.findLast(
    (item, index) => index < runningTurnStart && item.kind === "assistant",
  )?.id;
  const [reveal, setReveal] = useState<ToolReveal | null>(null);
  const runningAgents = busy
    ? items.filter(
        (item): item is ToolItem =>
          item.kind === "tool" && categoryOf(item.name) === "agent" && item.output === null,
      )
    : [];
  const project = useStore((s) => s.projects.find((p) => p.id === info.projectId));
  // Per thread: switching threads remounts this view, so the panel starts closed.
  const [diffOpen, setDiffOpen] = useState(false);
  // Null shows all uncommitted changes; a message id shows just what that turn changed.
  const [diffTurn, setDiffTurn] = useState<string | null>(null);
  const openTurnDiff = useCallback((messageId: string) => {
    setDiffTurn(messageId);
    setDiffOpen(true);
  }, []);
  // A rewind can take the turn on show with it.
  const diffTurnGone =
    diffTurn !== null &&
    transcript?.status === "live" &&
    !items.some((item) => item.id === diffTurn);
  useEffect(() => {
    if (diffTurnGone) setDiffTurn(null);
  }, [diffTurnGone]);
  const reviewComments = useReviewComments(threadId);
  const [revealedComment, setRevealedComment] = useState<ReviewComment | null>(null);
  const clearRevealedComment = useCallback(() => setRevealedComment(null), []);
  const followUps = useStore((s) => s.threads[threadId]?.queue) ?? NO_QUEUE;
  const followUpMode = useStore((s) => s.settings.followUp ?? "queue");
  const [{ effort, fast, permission }] = useTurnPrefs(threadId, provider, host);
  // The turn its output starts runs at the composer's effort and permission level.
  const runReplyCommand = useCallback(
    (command: string) =>
      runCommand(threadId, command, toTurnOptions({ effort, fast, permission }, [])),
    [threadId, effort, fast, permission],
  );
  const runs = useStore((s) => s.runs[threadId]) ?? NO_RUNS;
  // Leaves the draft alone, and waits while the agent needs an approval or an answer.
  useKeybinding(
    followUps[0] && status === "running" ? "composer.steerQueued" : undefined,
    () => followUps[0] && sendQueuedNow(threadId, followUps[0].id),
  );
  const history = useMemo(
    () => items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])),
    [items],
  );
  const scrollArea = useRef<HTMLDivElement>(null);
  const transcriptViewport = useRef<HTMLElement>(null);
  // Re-read the diff whenever a tool finishes or a turn ends: either may have changed files.
  const finishedTools = items.reduce(
    (n, item) => (item.kind === "tool" && item.output !== null ? n + 1 : n),
    0,
  );
  const diffKey = `${status}:${info.updatedAt}:${finishedTools}`;
  const activeTerminal = useStore((s) => s.activeTerminals[threadId]);
  useKeybinding("terminal.toggle", () => {
    toggleTerminalPanel(threadId);
    if (activeTerminal) focusComposer();
  });
  const browserOpen = useBrowser((state) => state.threads[threadId]?.open ?? false);
  useKeybinding(window.desktop ? "browser.toggle" : undefined, () => toggleBrowser(threadId));

  // Looking at a thread marks whatever it did since you last saw it as seen.
  const { updatedAt } = info;
  useEffect(() => {
    const mark = () => document.hasFocus() && markSeen(threadId);
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [threadId, updatedAt]);

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div ref={scrollArea} className="relative flex min-h-0 min-w-95 flex-1 flex-col">
          <Header
            project={
              project ?? { id: info.projectId, name: info.cwd.split("/").at(-1) ?? info.cwd }
            }
            title={info.title}
            badge={
              info.worktree ? (
                <span
                  title={`Worktree: ${info.cwd}`}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground [-webkit-app-region:no-drag]"
                >
                  <FolderTree className="size-3" />
                  {info.branch ?? "worktree"}
                </span>
              ) : null
            }
            actions={
              <>
                <GitMenu
                  cwd={info.cwd}
                  refreshKey={diffKey}
                  threadId={threadId}
                  worktree={info.worktree}
                />
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title={`${activeTerminal ? "Hide" : "Show"} terminal (${describe("terminal.toggle")})`}
                    aria-label={activeTerminal ? "Hide terminal" : "Show terminal"}
                    aria-pressed={activeTerminal !== undefined}
                    onClick={() => toggleTerminalPanel(threadId)}
                    className={`grid size-7 place-items-center rounded-lg transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${activeTerminal ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
                  >
                    <SquareTerminal className="size-4" />
                  </button>
                  <button
                    type="button"
                    title={diffOpen ? "Hide changes" : "Show changes"}
                    aria-label={diffOpen ? "Hide changes" : "Show changes"}
                    aria-pressed={diffOpen}
                    onClick={() => {
                      setDiffOpen(!diffOpen);
                      setDiffTurn(null);
                    }}
                    className={`grid size-7 place-items-center rounded-lg transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${diffOpen ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
                  >
                    <FileDiff className="size-4" />
                  </button>
                  {window.desktop ? (
                    <button
                      type="button"
                      title={`${browserOpen ? "Hide" : "Show"} browser (${describe("browser.toggle")})`}
                      aria-label={browserOpen ? "Hide browser" : "Show browser"}
                      aria-pressed={browserOpen}
                      onClick={() => toggleBrowser(threadId)}
                      className={`grid size-7 place-items-center rounded-lg transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${browserOpen ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
                    >
                      <Globe className="size-4" />
                    </button>
                  ) : null}
                </span>
              </>
            }
          />
          <QuoteSelection container={scrollArea} threadId={threadId} />
          <SideChatDrawer threadId={threadId} provider={provider} />
          <TranscriptFind scope={transcriptViewport} />
          <MessageScroller
            busy={busy}
            navigation="rail"
            viewportRef={transcriptViewport}
            className="min-h-0 flex-1"
            viewportClassName="@container px-3 py-5 sm:px-5 [&_*::highlight(find)]:bg-amber-300/40 [&_*::highlight(find-active)]:bg-amber-400 [&_*::highlight(find-active)]:text-black"
            contentClassName="mx-auto min-h-full w-full max-w-3xl"
          >
            <MessageGroup spacing="default">
              {transcript?.page?.hasMore ? (
                <button
                  type="button"
                  onClick={() => loadOlder(threadId)}
                  disabled={transcript.loadingOlder}
                  className="mx-auto rounded-lg px-3 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  {transcript.loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              ) : null}
              <TurnDiffContext value={openTurnDiff}>
                <RevealContext value={reveal}>
                  <RunCommandContext value={runReplyCommand}>
                    <TurnList items={items} threadId={threadId} busy={busy} />
                  </RunCommandContext>
                  {runs.map((run) => (
                    <RunningCommandWindow key={run.terminalId} threadId={threadId} run={run} />
                  ))}
                </RevealContext>
              </TurnDiffContext>

              {status === "running" &&
              lastItem?.kind !== "assistant" &&
              lastItem?.kind !== "reasoning" &&
              !(lastItem?.kind === "tool" && lastItem.output === null) ? (
                <Message
                  from="assistant"
                  animateIn
                  className="@min-[800px]:-ml-9 @min-[800px]:w-auto"
                >
                  {lastItem === undefined ||
                  lastItem.kind === "user" ||
                  lastItem.kind === "forked" ||
                  lastItem.kind === "startedBy" ? (
                    <OrbFace state="thinking" className="size-7 shrink-0" />
                  ) : (
                    // The turn above already shows the thinking face.
                    <MessageAvatar placeholder />
                  )}
                  <MessageContent>
                    <span role="status">
                      <ThinkingShimmer />
                    </span>
                  </MessageContent>
                </Message>
              ) : null}
            </MessageGroup>
          </MessageScroller>

          <Composer
            prefsKey={threadId}
            threadId={threadId}
            history={history}
            provider={provider}
            cwd={info.cwd}
            busy={busy}
            header={
              <>
                <PromptInputTray open={runningAgents.length > 0} detached>
                  <RunningAgents
                    threadId={threadId}
                    agents={runningAgents}
                    // Stopping one Codex subagent leaves the main agent waiting on it; Stop ends them all.
                    canStopOne={provider === "claude"}
                    onReveal={(toolId) => setReveal({ toolId })}
                  />
                </PromptInputTray>
                <PromptInputTray open={info.limitStop !== undefined} detached>
                  {info.limitStop ? (
                    <LimitStopNotice
                      threadId={threadId}
                      stop={info.limitStop}
                      provider={provider}
                      providers={providers}
                      settings={settings}
                      options={toTurnOptions({ effort, fast, permission }, [])}
                    />
                  ) : null}
                </PromptInputTray>
                <PromptInputTray open={followUps.length > 0 || reviewComments.length > 0}>
                  {reviewComments.map((comment) => (
                    <ReviewCommentRow
                      key={comment.id}
                      threadId={threadId}
                      comment={comment}
                      onReveal={() => {
                        setDiffOpen(true);
                        setRevealedComment(comment);
                      }}
                    />
                  ))}
                  {followUps.map((followUp, index) => (
                    <QueuedFollowUp
                      key={followUp.id}
                      threadId={threadId}
                      followUp={followUp}
                      next={index === 0}
                    />
                  ))}
                </PromptInputTray>
              </>
            }
            models={choices}
            model={current ? encodeChoice(provider, current) : undefined}
            onModelChange={(value) =>
              send(
                ClientCommand.cases["thread.setModel"].make({ threadId, ...decodeChoice(value) }),
              )
            }
            placeholder={
              busy
                ? followUpMode === "queue"
                  ? "Queue a follow-up (⌘↩ to send now)"
                  : `Steer ${harnessLabel(settings, provider)} (⌘↩ to queue)`
                : `Ask ${harnessLabel(settings, provider)}…`
            }
            pendingContent={reviewComments.length > 0}
            onSubmit={(typed, options, how) => {
              const text = withReviewComments(takeReviewComments(threadId), typed);
              // While the agent works, a message waits for the turn to end, or steers it; ⌘Enter flips that.
              const steer = (followUpMode === "steer") !== how.alternate;
              if (busy && !steer) queueMessage(threadId, text, options);
              else send(ClientCommand.cases["thread.send"].make({ threadId, text, options }));
            }}
            onAskAside={
              asideReplyId
                ? (question) => {
                    openSideChat(threadId, asideReplyId);
                    if (question) askSideChat(question);
                  }
                : undefined
            }
            onStop={() => {
              send(ClientCommand.cases["thread.interrupt"].make({ threadId }));
              returnToComposer(threadId, takeQueued(threadId));
            }}
          />
        </div>
        {diffOpen ? (
          <Suspense
            fallback={
              <div
                style={{
                  width: readWidth(
                    PANEL_WIDTH_KEY,
                    Math.min(960, Math.round(window.innerWidth * 0.45)),
                  ),
                }}
                className="shrink-0 border-l border-border"
              />
            }
          >
            <DiffPanel
              threadId={threadId}
              cwd={info.cwd}
              refreshKey={diffKey}
              turn={diffTurn ? { threadId, messageId: diffTurn } : null}
              reveal={revealedComment}
              onRevealed={clearRevealedComment}
              onShowAll={() => setDiffTurn(null)}
              onClose={() => setDiffOpen(false)}
            />
          </Suspense>
        ) : null}
        {browserOpen && window.desktop ? <BrowserPanel threadId={threadId} /> : null}
      </div>
      {activeTerminal ? (
        <Suspense fallback={null}>
          <TerminalPanel threadId={threadId} activeTerminal={activeTerminal} />
        </Suspense>
      ) : null}
    </>
  );
};

/** Same items, by identity: the store only replaces the item that changed. */
const sameItems = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * The transcript. Every delta re-renders this, but turns and blocks whose items are
 * unchanged bail out, so only the message actually streaming does any work.
 */
export const TurnList = ({
  items,
  threadId,
  busy,
}: {
  items: ReadonlyArray<TranscriptItem>;
  threadId: string;
  busy: boolean;
}) => {
  const turns = useMemo(() => toTurns(items), [items]);
  // Older turns skip layout and paint while off screen. Switched on after the first
  // frame with turns in it (the transcript can arrive after the view opens), so every
  // turn has been laid out once and its real height is remembered.
  const [settled, setSettled] = useState(false);
  const hasTurns = turns.length > 0;
  useEffect(() => {
    if (!hasTurns) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [hasTurns]);
  return (
    // Lighter than virtualizing (the message rail reads every turn's text from the DOM): the turns
    // stay in the document but cost nothing while scrolled away. Set here rather than on each turn,
    // so settling doesn't re-render them all. The latest exchange stays fully rendered: it's what
    // streams and what the scroller follows.
    <div
      data-settled={settled || undefined}
      className="contents *:[contain-intrinsic-size:auto_240px] data-settled:[&>*:nth-last-child(n+3)]:[content-visibility:auto]"
    >
      {turns.map((turn, index) => {
        if (turn.from === "marker") return <ThreadMarker key={turn.id} item={turn.item} />;
        return turn.from === "user" ? (
          <UserTurn
            key={turn.id}
            item={turn.item}
            threadId={threadId}
            busy={busy}
            animateIn={settled}
          />
        ) : (
          <AssistantTurn
            key={turn.id}
            items={turn.items}
            threadId={threadId}
            busy={busy}
            last={index === turns.length - 1}
          />
        );
      })}
    </div>
  );
};

/** A command from a reply while it runs: its terminal, live, and a way to stop it before it reaches the agent. */
function RunningCommandWindow({ threadId, run }: { threadId: string; run: RunningCommand }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex h-9 items-center gap-2 border-b border-border pr-1.5 pl-3 text-xs">
        <LoaderCircle className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        <code className="min-w-0 flex-1 truncate font-mono text-foreground/85">{run.command}</code>
        <button
          type="button"
          title="Stop it; the agent won't hear about this run"
          onClick={() => closeTerminal(threadId, run.terminalId)}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Square className="size-3" />
          Stop
        </button>
      </div>
      <Suspense fallback={<div className="h-48" />}>
        <TerminalView
          threadId={threadId}
          terminalId={run.terminalId}
          autoFocus={false}
          className="h-48 flex-none py-2"
        />
      </Suspense>
    </div>
  );
}

/** A finished run in the transcript, where its message to the agent would otherwise be. */
function CommandRunResult({ run }: { run: CommandRun }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-xs">
        {run.exitCode === 0 ? (
          <Check className="size-3.5 shrink-0 text-success" />
        ) : (
          <X className="size-3.5 shrink-0 text-destructive" />
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-foreground/85">{run.command}</code>
        {run.exitCode === 0 ? null : (
          <span className="shrink-0 text-destructive">Exit code {run.exitCode}</span>
        )}
      </div>
      {run.output ? (
        // Reversed, so it opens scrolled to the end, where results and errors are.
        <div className="flex max-h-48 flex-col-reverse overflow-auto">
          <pre className="selectable m-0 px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-foreground/85">
            {run.output}
          </pre>
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">No output</p>
      )}
    </div>
  );
}

const MARKERS: Record<MarkerItem["kind"], { readonly icon: LucideIcon; readonly label: string }> = {
  forked: { icon: GitFork, label: "Forked from" },
  startedBy: { icon: Workflow, label: "Started by" },
};

/** Where a thread's own conversation starts, with the way to the thread it came from. */
function ThreadMarker({ item }: { item: MarkerItem }) {
  const [threadId, title] = Match.value(item).pipe(
    Match.discriminatorsExhaustive("kind")({
      forked: (forked) => [forked.fromThreadId, forked.fromTitle] as const,
      startedBy: (started) => [started.byThreadId, started.byTitle] as const,
    }),
  );
  const source = useStore((s) => s.threads[threadId]);
  const { icon: Icon, label } = MARKERS[item.kind];
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <Icon className="size-3.5 shrink-0" />
      {source ? (
        <button
          type="button"
          onClick={() => switchToThread(threadId)}
          className="max-w-[60%] truncate rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label} {source.title}
        </button>
      ) : (
        <span className="max-w-[60%] truncate">
          {label} {title} (deleted)
        </span>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const UserTurn = memo(
  ({
    item,
    threadId,
    busy,
    animateIn,
  }: {
    item: UserItem;
    threadId: string;
    busy: boolean;
    animateIn: boolean;
  }) =>
    item.run ? (
      <CommandRunResult run={item.run} />
    ) : (
      <Message from="user" animateIn={animateIn} className="group/turn">
        <MessageContent className="gap-1.5">
          {item.handoff && item.provider ? (
            <HandoffNote handoff={item.handoff} to={item.provider} />
          ) : null}
          {item.attachments.length ? <AttachmentList attachments={item.attachments} /> : null}
          {item.text ? (
            <MessageBubble variant="soft">
              <MessageBubbleContent className="selectable whitespace-pre-wrap">
                {item.text}
              </MessageBubbleContent>
            </MessageBubble>
          ) : null}
          {/* A message sent mid-turn has no turn of its own to go back to. */}
          {busy || item.steer ? null : <EditFromHere item={item} threadId={threadId} />}
        </MessageContent>
      </Message>
    ),
  // `animateIn` is only read on mount, so it flipping once the list settles is no reason to re-render.
  (a, b) => a.item === b.item && a.threadId === b.threadId && a.busy === b.busy,
);

/** Above a message sent right after switching harness: what the new one was told it missed. */
function HandoffNote({
  handoff,
  to,
}: {
  handoff: NonNullable<UserItem["handoff"]>;
  to: ProviderKind;
}) {
  const [open, setOpen] = useState(false);
  const settings = useStore((s) => s.settings);
  return (
    <div className="flex flex-col items-end gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftRight className="size-3.5 shrink-0" />
        Gave {harnessLabel(settings, to)} the {handoff.messages}{" "}
        {handoff.messages === 1 ? "message" : "messages"} {harnessLabel(settings, handoff.from)} had
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <pre className="selectable max-h-72 w-full overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] whitespace-pre-wrap">
          {handoff.text}
        </pre>
      ) : null}
    </div>
  );
}

/** Rewinds to before this message and puts it back in the composer to edit and resend. */
function EditFromHere({ item, threadId }: { item: UserItem; threadId: string }) {
  const restoreBlocker = useFileRestoreBlocker(threadId);
  return (
    <div className="flex justify-end opacity-0 transition-opacity group-hover/turn:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      <PromptSelect
        title="Edit from here"
        icon={<Undo2 />}
        options={[
          {
            value: "keep",
            label: "Rewind conversation",
            description: "The files stay as they are now",
          },
          {
            value: "files",
            label: "Rewind conversation and files",
            description: restoreBlocker ?? "The folder goes back to how it was when this was sent",
            disabled: restoreBlocker !== null,
          },
        ]}
        value={undefined}
        placeholder="Edit from here"
        side="bottom"
        align="end"
        width="w-72"
        variant="plain"
        onChange={(choice) => {
          // An unsent draft stays, above the restored prompt.
          setDraft(threadId, (prev) => ({
            text: prev.text.trim() ? `${prev.text.trimEnd()}\n\n${item.text}` : item.text,
            attachments: [...prev.attachments, ...item.attachments.map(fromSent)],
          }));
          send(
            ClientCommand.cases["thread.rewind"].make({
              threadId,
              messageId: item.id,
              restoreFiles: choice === "files",
            }),
          );
          focusComposer();
        }}
      />
    </div>
  );
}

/** Asks before forking, and stays up with progress until the fork opens (or says why it didn't). */
function ForkDialog({
  threadId,
  item,
  onClose,
}: {
  threadId: string;
  item: Extract<TranscriptItem, { kind: "assistant" }>;
  onClose: () => void;
}) {
  const fork = useStore((s) => (s.forking?.messageId === item.id ? s.forking : null));
  const pending = fork !== null && fork.error === null;
  const forkButton = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (open || pending) return;
        dismissForkError();
        onClose();
      }}
    >
      <AlertDialogContent
        className="gap-4 bg-popover p-4 data-[size=default]:sm:max-w-xs"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          forkButton.current?.focus();
        }}
      >
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <GitFork className="size-4" />
          </span>
          <AlertDialogTitle className="text-sm">Fork from this reply?</AlertDialogTitle>
        </div>
        {fork?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {fork.error}
          </p>
        ) : null}
        <AlertDialogFooter className="flex-row justify-end">
          <AlertDialogCancel size="sm" disabled={pending}>
            Cancel
            <kbd aria-hidden className="font-sans text-[10px] text-muted-foreground">
              esc
            </kbd>
          </AlertDialogCancel>
          <AlertDialogAction
            ref={forkButton}
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // Stays open until the fork opens, which replaces this view.
              event.preventDefault();
              forkThread(threadId, item.id);
            }}
          >
            {pending ? "Forking…" : fork?.error ? "Try again" : "Fork"}
            {pending ? null : (
              <kbd aria-hidden className="font-sans text-[10px] text-primary-foreground/60">
                ↵
              </kbd>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Read-only side questions about one reply (BTW), over the thread; closing it ends them for good. */
function SideChatDrawer({ threadId, provider }: { threadId: string; provider: ProviderKind }) {
  const sideChat = useStore((s) => (s.sideChat?.threadId === threadId ? s.sideChat : null));
  const label = useStore((s) => harnessLabel(s.settings, provider));
  const [question, setQuestion] = useState("");
  useEffect(() => () => closeSideChat(threadId), [threadId]);
  const items = sideChat?.items ?? NO_ITEMS;
  const running = sideChat?.running ?? false;
  const lastItem = items.at(-1);
  const blocks = useMemo(() => toBlocks(items), [items]);
  function ask() {
    const text = question.trim();
    if (!text || running) return;
    askSideChat(text);
    setQuestion("");
  }
  return (
    <Drawer
      open={sideChat !== null}
      onOpenChange={(open) => open || closeSideChat(threadId)}
      ariaLabel="Side question"
      className="w-[32rem]"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">By the way</h2>
          <p className="text-xs text-muted-foreground">
            Ask {label} about this reply. It can read but not change anything, and nothing here goes
            into the thread.
          </p>
        </div>
        <button
          type="button"
          title="Close and discard (esc)"
          aria-label="Close and discard"
          onClick={() => closeSideChat(threadId)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <MessageScroller
        busy={running}
        className="min-h-0 flex-1"
        viewportClassName="px-4 py-4"
        contentClassName="min-h-full w-full"
      >
        <MessageGroup spacing="default">
          {sideChat
            ? blocks.map((block) =>
                block.kind === "user" ? (
                  <Message key={block.id} from="user">
                    <MessageContent>
                      <MessageBubble variant="soft">
                        <MessageBubbleContent className="selectable whitespace-pre-wrap">
                          {block.text}
                        </MessageBubbleContent>
                      </MessageBubble>
                    </MessageContent>
                  </Message>
                ) : (
                  <AgentBlock
                    key={block.id}
                    block={block}
                    threadId={sideChat.id}
                    live={running}
                    streaming={running && holdsNewest(block, lastItem)}
                    showActions={false}
                  />
                ),
              )
            : null}
          {running && lastItem?.kind !== "assistant" && lastItem?.kind !== "reasoning" ? (
            <span role="status">
              <ThinkingShimmer />
            </span>
          ) : null}
        </MessageGroup>
      </MessageScroller>
      <form
        className="border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <Textarea
          autoFocus
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            ask();
          }}
          placeholder={running ? `${label} is answering…` : "Ask a side question…"}
          aria-label="Side question"
          className="min-h-16 text-[13px]"
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!question.trim() || running}>
            Ask
            <kbd aria-hidden className="font-sans text-[10px] opacity-70">
              ↵
            </kbd>
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/** Latest calls a subagent row unfolds to; older ones are a jump to the chat away. */
const RECENT_AGENT_CALLS = 5;

/** Subagents still at work, above the composer: what each is doing, its latest calls, a jump to its row, and a stop button. */
function RunningAgents({
  threadId,
  agents,
  canStopOne,
  onReveal,
}: {
  threadId: string;
  agents: ReadonlyArray<ToolItem>;
  canStopOne: boolean;
  onReveal: (toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(1000);
  const listId = useId();
  // Beyond two, the rows fold into one summary so the tray stays short.
  const grouped = agents.length > 2;
  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      {grouped ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex h-8 w-full items-center gap-2 rounded-md pl-1.5 text-left transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
          </span>
          <span className="flex-1 text-[13px] text-foreground/80">
            {agents.length} subagents running
          </span>
          <ChevronRight
            className={cn("mr-2 size-3.5 transition-transform duration-200", open && "rotate-90")}
          />
        </button>
      ) : null}
      <Fold open={!grouped || open}>
        <ul id={listId}>
          {agents.map((agent) => {
            const calls = agent.children ?? [];
            const last = calls.at(-1);
            const name = agent.summary || "Subagent";
            const isUnfolded = unfolded.has(agent.id);
            const earlier = calls.length - RECENT_AGENT_CALLS;
            return (
              <li key={agent.id}>
                <div className="flex h-8 items-center gap-2 pl-1.5">
                  <span className="grid size-3.5 shrink-0 place-items-center">
                    <span className="size-1.5 animate-pulse rounded-full bg-success" />
                  </span>
                  <button
                    type="button"
                    title="Show it in the chat"
                    onClick={() => onReveal(agent.id)}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="shrink-0 text-[13px] text-foreground/80">{name}</span>
                    <span className="truncate">
                      {stopping.has(agent.id)
                        ? "Stopping…"
                        : (agent.progress ??
                          (!last
                            ? "Starting…"
                            : last.output === null
                              ? livePhrase(last)
                              : summarize([last])))}
                    </span>
                  </button>
                  {agent.tokens === undefined ? null : (
                    <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                      {new Intl.NumberFormat("en", { notation: "compact" }).format(agent.tokens)}{" "}
                      tokens
                      {agent.startedAt === undefined
                        ? null
                        : ` in ${now - agent.startedAt >= 60_000 ? `${Math.floor((now - agent.startedAt) / 60_000)}m ` : ""}${Math.floor((now - agent.startedAt) / 1000) % 60}s`}
                    </span>
                  )}
                  <IconAction
                    label={`${isUnfolded ? "Hide" : "Show"} what ${name} is doing`}
                    onClick={() => {
                      const next = new Set(unfolded);
                      if (!next.delete(agent.id)) next.add(agent.id);
                      setUnfolded(next);
                    }}
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform duration-200",
                        isUnfolded && "rotate-90",
                      )}
                    />
                  </IconAction>
                  {canStopOne ? (
                    <button
                      type="button"
                      aria-label={`Stop ${name}`}
                      title="Stop this subagent"
                      disabled={stopping.has(agent.id)}
                      onClick={() => {
                        setStopping(new Set(stopping).add(agent.id));
                        send(
                          ClientCommand.cases["thread.stopAgent"].make({
                            threadId,
                            toolId: agent.id,
                          }),
                        );
                      }}
                      className="grid size-6 shrink-0 place-items-center rounded-md transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <Square className="size-2.5 fill-current" />
                    </button>
                  ) : null}
                </div>
                <Fold open={isUnfolded}>
                  <div className="mr-2 mb-1 ml-[13px] border-l border-border pl-3 text-sm">
                    {earlier > 0 ? (
                      <button
                        type="button"
                        onClick={() => onReveal(agent.id)}
                        className="h-7 rounded-md text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {earlier} earlier {earlier === 1 ? "call" : "calls"} in the chat
                      </button>
                    ) : null}
                    {calls.length ? (
                      calls
                        .slice(-RECENT_AGENT_CALLS)
                        .map((call) => <ToolCallRow key={call.id} call={call} live reveal={null} />)
                    ) : (
                      <p className="py-1 text-xs text-muted-foreground">No calls yet</p>
                    )}
                  </div>
                </Fold>
              </li>
            );
          })}
        </ul>
      </Fold>
    </div>
  );
}

/** What a turn changed on disk; opens those changes. */
const CheckpointChip = ({ item }: { item: Extract<TranscriptItem, { kind: "checkpoint" }> }) => {
  const openTurnDiff = use(TurnDiffContext);
  return (
    <button
      type="button"
      onClick={() => openTurnDiff(item.messageId)}
      className="flex w-fit items-center gap-2 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileDiff className="size-3.5" />
      <span>
        {item.files} {item.files === 1 ? "file" : "files"} changed
      </span>
      <span className="font-mono tabular-nums">
        {item.additions ? <span className="text-success">+{item.additions}</span> : null}
        {item.additions && item.deletions ? " " : null}
        {item.deletions ? <span className="text-destructive">−{item.deletions}</span> : null}
      </span>
    </button>
  );
};

interface AssistantTurnProps {
  items: ReadonlyArray<TranscriptItem>;
  threadId: string;
  busy: boolean;
  /** The newest turn: its last block is the one streaming. */
  last: boolean;
}

const AssistantTurn = memo(
  ({ items, threadId, busy, last }: AssistantTurnProps) => {
    const blocks = useMemo(() => toBlocks(items), [items]);
    const lastItem = items.at(-1);
    const finalTextId = blocks.findLast((block) => block.kind === "assistant")?.id;
    const live = busy && last;
    return (
      // The face hangs in the margin once there's room, so replies share the composer's left edge.
      // The row widens rather than the face overflowing it: older turns clip to their box.
      <Message from="assistant" className="@min-[800px]:-ml-9 @min-[800px]:w-auto">
        {/* One face, on the newest reply: repeated down the thread it reads as wallpaper. */}
        {last ? (
          <OrbFace
            state={
              live
                ? lastItem?.kind === "assistant"
                  ? "streaming"
                  : "thinking"
                : lastItem?.kind === "error"
                  ? "error"
                  : "done"
            }
            className="size-7 shrink-0"
          />
        ) : (
          <MessageAvatar placeholder />
        )}
        <MessageContent className="gap-3">
          {blocks.map((block) => (
            <AgentBlock
              key={block.id}
              block={block}
              threadId={threadId}
              live={busy}
              streaming={busy && last && holdsNewest(block, lastItem)}
              showActions={block.id === finalTextId && !(busy && last)}
            />
          ))}
        </MessageContent>
      </Message>
    );
  },
  // `toTurns` rebuilds the turn arrays each time; the items inside keep their identity.
  (a, b) =>
    a.threadId === b.threadId &&
    a.busy === b.busy &&
    a.last === b.last &&
    sameItems(a.items, b.items),
);

/** The way to the answer, folded like thinking: what it's doing now while it streams, what it did once done. */
function WorkBlock({
  items,
  threadId,
  live,
  streaming,
}: {
  items: ReadonlyArray<TranscriptItem>;
  threadId: string;
  live: boolean;
  streaming: boolean;
}) {
  const reveal = use(RevealContext);
  const blocks = useMemo(() => toToolGroups(items), [items]);
  const newest = items.at(-1);
  const calls = items.filter((item) => item.kind === "tool");
  return (
    <Reasoning
      label={calls.length ? summarize(calls) : thoughtTitle(items[0]?.id ?? "")}
      streaming={streaming}
      live={newest?.kind === "tool" && newest.output === null ? livePhrase(newest) : undefined}
      reveal={calls.some((call) => call.id === reveal?.toolId) ? reveal : null}
    >
      <div className="flex flex-col gap-1">
        {blocks.map((block) => (
          <AgentBlock
            key={block.id}
            block={block}
            threadId={threadId}
            live={live}
            streaming={streaming && block === newest}
            showActions={false}
          />
        ))}
      </div>
    </Reasoning>
  );
}

interface AgentBlockProps {
  block: Block;
  threadId: string;
  live: boolean;
  streaming: boolean;
  /** Only the turn's final text block gets a copy button, once the turn is done. */
  showActions: boolean;
}

const AgentBlock = memo(
  (props: AgentBlockProps) => <AgentBlockContent {...props} />,
  // Tool groups are rebuilt by `toBlocks`; compare the calls they hold instead.
  (a, b) =>
    a.threadId === b.threadId &&
    a.live === b.live &&
    a.streaming === b.streaming &&
    a.showActions === b.showActions &&
    (a.block === b.block ||
      (a.block.kind === "tools" &&
        b.block.kind === "tools" &&
        sameItems(a.block.calls, b.block.calls)) ||
      (a.block.kind === "work" &&
        b.block.kind === "work" &&
        sameItems(a.block.items, b.block.items))),
);

const AgentBlockContent = ({
  block: item,
  threadId,
  live,
  streaming,
  showActions,
}: AgentBlockProps) => {
  const forking = useStore((s) => s.forking?.messageId === item.id && s.forking.error === null);
  const [confirmingFork, setConfirmingFork] = useState(false);
  const host = useThreadHost(threadId);
  const needsRootConsent = useNeedsRootConsent(host);
  const [confirmingRoot, setConfirmingRoot] = useState(false);
  const runCommand = use(RunCommandContext);
  const provider = useStore((s) => s.threads[threadId]?.provider);
  switch (item.kind) {
    case "user":
      return null;
    case "assistant":
      return (
        <MessageBubble variant="ghost" className="w-full">
          <MessageBubbleContent>
            <StreamingResponse
              status={streaming ? "streaming" : "complete"}
              copyText={item.text}
              onFork={live ? undefined : () => setConfirmingFork(true)}
              forking={forking}
              onAskAside={() => openSideChat(threadId, item.id)}
              showActions={showActions}
              showFeedback={false}
            >
              <Markdown
                streaming={streaming}
                onRunCommand={runCommand}
                className="selectable leading-relaxed"
              >
                {item.text}
              </Markdown>
            </StreamingResponse>
          </MessageBubbleContent>
          {confirmingFork ? (
            <ForkDialog threadId={threadId} item={item} onClose={() => setConfirmingFork(false)} />
          ) : null}
        </MessageBubble>
      );
    case "reasoning":
      return (
        <Reasoning label={thoughtTitle(item.id)} streaming={streaming}>
          <Markdown streaming={streaming} className="selectable leading-relaxed">
            {item.text}
          </Markdown>
        </Reasoning>
      );
    case "work":
      return <WorkBlock items={item.items} threadId={threadId} live={live} streaming={streaming} />;
    case "tools":
      return (
        <ToolGroup
          calls={item.calls satisfies ReadonlyArray<ToolCall>}
          live={live}
          reveal={use(RevealContext)}
        />
      );
    case "approval":
      if (item.title === "ExitPlanMode") {
        // Interrupted before an answer: the turn ended, so there's nothing left to approve.
        if (item.resolved && !item.decision) return null;
        return (
          <>
            <ToolApproval
              title="Approve this plan?"
              description={item.decision === "deny" ? "Rejected — say what to change" : undefined}
              status={
                item.decision === "deny"
                  ? "denied"
                  : item.decision
                    ? item.resolved
                      ? "approved"
                      : "approving"
                    : "pending"
              }
              defaultOpen
              approveLabel={BUILD_WITH_LABEL["auto-edit"]}
              approveOptions={(["ask", "auto-edit", "auto", "full-access"] as const).flatMap(
                (level) =>
                  provider !== undefined && !PERMISSIONS[provider].includes(level)
                    ? []
                    : [
                        {
                          id: level,
                          label: BUILD_WITH_LABEL[level],
                          onSelect: () =>
                            level === "full-access" && needsRootConsent
                              ? setConfirmingRoot(true)
                              : approvePlan(threadId, item.id, level),
                        },
                      ],
              )}
              denyLabel="Reject"
              onApprove={() => approvePlan(threadId, item.id, "auto-edit")}
              onDeny={() => respondApproval(threadId, item.id, "deny")}
            >
              <div className="max-h-96 overflow-y-auto">
                <Markdown className="selectable leading-relaxed">{item.detail}</Markdown>
              </div>
            </ToolApproval>
            {confirmingRoot && host ? (
              <RootFullAccessDialog
                host={host}
                onAllow={() => approvePlan(threadId, item.id, "full-access")}
                onClose={() => setConfirmingRoot(false)}
              />
            ) : null}
          </>
        );
      }
      if (item.questions) {
        const { questions, answers } = item;
        return (
          <ApprovalCard
            autoFocus={
              !getDraft(threadId).text.trim() &&
              (document.activeElement === document.body ||
                document.activeElement?.matches("textarea[data-composer]") === true)
            }
            status={
              item.resolved
                ? answers
                  ? "answered"
                  : "skipped"
                : item.decision
                  ? "submitting"
                  : "pending"
            }
            questions={questions.map((question) => ({
              id: question.id,
              title: question.question,
              description: item.agent ? `Asked by ${item.agent}` : undefined,
              options: question.options.map((option) => {
                const choice = {
                  value: option.label,
                  label: option.label,
                  description: option.description,
                };
                return option.preview === undefined
                  ? choice
                  : {
                      ...choice,
                      preview: (
                        <pre className="bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                          {option.preview}
                        </pre>
                      ),
                    };
              }),
              multiple: question.multiSelect,
              allowCustom: true,
              customPlaceholder: "Something else…",
            }))}
            onSubmit={(chosen) =>
              respondApproval(threadId, item.id, "allow", {
                answers: Object.fromEntries(
                  questions.map((question) => {
                    const custom = chosen[question.id]?.custom?.trim();
                    return [
                      question.id,
                      [...(chosen[question.id]?.selected ?? []), ...(custom ? [custom] : [])],
                    ];
                  }),
                ),
              })
            }
            onDismiss={
              item.resolved || item.decision
                ? undefined
                : () => respondApproval(threadId, item.id, "deny")
            }
            result={
              answers
                ? questions
                    .map(
                      (question) =>
                        `${questions.length > 1 ? `${question.header}: ` : ""}${(answers[question.id] ?? []).join(", ")}`,
                    )
                    .join("; ")
                : "Went on without an answer"
            }
          />
        );
      }
      // Once approved, the tool group shows what ran; only pending and denied requests stay visible.
      if (item.resolved && item.decision !== "deny") return null;
      return (
        <ToolApproval
          tool={item.title}
          title={`Allow ${item.title}${item.agent ? ` for ${item.agent}` : ""}?`}
          status={item.decision === "deny" ? "denied" : item.decision ? "approving" : "pending"}
          defaultOpen
          parameters={[
            {
              id: "input",
              label: "Input",
              value: <ToolApprovalCode code={item.detail} language="bash" />,
            },
          ]}
          onApprove={() => respondApproval(threadId, item.id, "allow")}
          onAlwaysAllow={() => respondApproval(threadId, item.id, "allow-session")}
          onDeny={() => respondApproval(threadId, item.id, "deny")}
        />
      );
    case "error":
      return <div className="selectable text-xs text-destructive">{item.text}</div>;
    case "checkpoint":
      return <CheckpointChip item={item} />;
  }
};
