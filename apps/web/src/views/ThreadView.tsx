import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageGroup,
  MessageHeader,
  MessageScroller,
} from "@apcode/ui/agents/message";
import { Markdown } from "@apcode/ui/agents/markdown";
import { ThinkingShimmer } from "@apcode/ui/agents/loading-states/thinking-shimmer";
import { PromptSelect } from "@apcode/ui/agents/prompt-input";
import { StreamingResponse } from "@apcode/ui/agents/streaming-response";
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
import { ProjectBadge } from "@/components/project-badge";
import { cn } from "@apcode/ui/lib/utils";
import { harnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { type Attachment, ClientCommand, type Project, type ProviderKind } from "@apcode/contracts";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "@apcode/ui/motion/animated-sidebar";
import {
  ArrowUp,
  ChevronRight,
  FileDiff,
  FileText,
  FolderTree,
  Globe,
  ImageIcon,
  PanelLeft,
  Quote,
  Square,
  SquareTerminal,
  Undo2,
  X,
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
import { approvePlan, BUILD_WITH_LABEL, fromSent } from "../lib/composer.ts";
import { appendToDraft, focusComposer, setDraft } from "../lib/drafts.ts";
import { describe, useKeybinding } from "../lib/keybindings.ts";
import {
  decodeChoice,
  defaultModel,
  encodeChoice,
  harnessLabel,
  modelChoices,
} from "../lib/models.ts";
import {
  createThread,
  type FollowUp,
  loadOlder,
  markSeen,
  queueFollowUp,
  respondApproval,
  send,
  sendFollowUpNow,
  takeFollowUps,
  toggleTerminalPanel,
  useStore,
  useTranscript,
  type TranscriptItem,
} from "../lib/store.ts";
import { readWidth } from "@apcode/ui/hooks/use-resizable";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { Composer } from "./Composer.tsx";
import { GitMenu } from "./GitMenu.tsx";
import { hasTrafficLights } from "./Sidebar.tsx";

/** Same key the panel saves its dragged width under. */
const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() => import("./DiffPanel.tsx").then((m) => ({ default: m.DiffPanel })));
const TerminalPanel = lazy(() =>
  import("./TerminalPanel.tsx").then((m) => ({ default: m.TerminalPanel })),
);

/** Consecutive agent items form one turn under a single avatar. */
type UserItem = Extract<TranscriptItem, { kind: "user" }>;

type Turn =
  | { readonly from: "user"; readonly id: string; readonly item: UserItem }
  | { readonly from: "assistant"; readonly id: string; readonly items: Array<TranscriptItem> };

const toTurns = (items: ReadonlyArray<TranscriptItem>): Array<Turn> => {
  const turns: Array<Turn> = [];
  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ from: "user", id: item.id, item });
      continue;
    }
    const last = turns.at(-1);
    if (last?.from === "assistant") last.items.push(item);
    else turns.push({ from: "assistant", id: item.id, items: [item] });
  }
  return turns;
};

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Within a turn, consecutive tool calls collapse into one group row. */
type Block =
  | { readonly kind: "tools"; readonly id: string; readonly calls: Array<ToolItem> }
  | Exclude<TranscriptItem, ToolItem>;

const toBlocks = (items: ReadonlyArray<TranscriptItem>): Array<Block> => {
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
};

/** Top bar: project / title breadcrumb. Leaves room for the traffic lights when the sidebar is folded away. */
const Header = ({
  project,
  title,
  badge,
  actions,
}: {
  project?: Pick<Project, "id" | "name"> | undefined;
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) => {
  const { open } = useAnimatedSidebar();
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
          <span className="shrink-0 text-sm text-muted-foreground">{project.name}</span>
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

/** A new chat that only exists in this window until its first message creates the thread. */
export const DraftView = ({
  path,
  onPickProject,
}: {
  path: string | null;
  onPickProject: (path: string | null) => void;
}) => {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const project = useStore((s) => s.projects.find((p) => p.path === path));
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

  return (
    <>
      <Header
        project={
          path
            ? { id: project?.id ?? path, name: project?.name ?? path.split("/").at(-1) ?? path }
            : undefined
        }
        title="New thread"
      />
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground [-webkit-app-region:drag]">
        {choices.length
          ? "What should we work on?"
          : providers.some((p) => p.checking)
            ? "Checking Claude and Codex…"
            : "Link Claude or Codex in Settings to start."}
      </div>
      <Composer
        // Stable across the project pick, so effort/permission choices carry over.
        prefsKey="draft:new"
        provider={selected ? decodeChoice(selected).provider : settings.lastProvider}
        cwd={path}
        onPickProject={onPickProject}
        disabled={!selected}
        sendDisabled={!path}
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
              ? "Pick a project below to start…"
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
const NO_FOLLOW_UPS: ReadonlyArray<FollowUp> = [];

/** Opens the changes panel on one turn; provided by the thread view to the checkpoint chips deep in the transcript. */
const TurnDiffContext = createContext<(messageId: string) => void>(() => {});
/** The tool call last picked in the running-subagents list, for its group to open and scroll to. */
const RevealContext = createContext<ToolReveal | null>(null);

/** Held messages go back into the composer, after whatever is there. */
const returnToComposer = (threadId: string, followUps: ReadonlyArray<FollowUp>) => {
  if (!followUps.length) return;
  appendToDraft(threadId, followUps.map((f) => f.text).join("\n\n"));
  focusComposer();
};

/** A message waiting for the turn to end: sends by itself then, or now, or goes back to the composer. */
const FollowUpBubble = ({ threadId, followUp }: { threadId: string; followUp: FollowUp }) => (
  <Message from="user" animateIn>
    <MessageContent className="items-end gap-1">
      <div className="max-w-full rounded-2xl border border-dashed border-border px-3.5 py-2 text-sm whitespace-pre-wrap text-muted-foreground">
        {followUp.text}
      </div>
      <div className="flex items-center gap-0.5 text-muted-foreground">
        <span className="px-1 text-[11px]">Sends when the turn ends</span>
        <IconAction label="Send now" onClick={() => sendFollowUpNow(threadId, followUp.id)}>
          <ArrowUp className="size-3.5" />
        </IconAction>
        <IconAction
          label="Back to the composer"
          onClick={() => returnToComposer(threadId, takeFollowUps(threadId, followUp.id))}
        >
          <X className="size-3.5" />
        </IconAction>
      </div>
    </MessageContent>
  </Message>
);

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
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const { status, provider } = info;
  // The harness is fixed per thread; only its model can change.
  const choices = modelChoices(providers, settings, provider);
  const current = info.model ?? defaultModel(providers, settings, provider);
  const busy = status === "running" || status === "awaiting-approval";
  const lastItem = items.at(-1);
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
  const followUps = useStore((s) => s.followUps[threadId]) ?? NO_FOLLOW_UPS;
  const followUpMode = useStore((s) => s.settings.followUp ?? "queue");
  const history = useMemo(
    () => items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])),
    [items],
  );
  const scrollArea = useRef<HTMLDivElement>(null);
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

  // Looking at a thread settles whatever it did since you last saw it.
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
                <GitMenu cwd={info.cwd} refreshKey={diffKey} />
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
          <MessageScroller
            busy={busy}
            navigation="rail"
            className="min-h-0 flex-1"
            viewportClassName="px-3 py-5 sm:px-5"
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
                  <TurnList items={items} provider={provider} threadId={threadId} busy={busy} />
                </RevealContext>
              </TurnDiffContext>

              {status === "running" &&
              lastItem?.kind !== "assistant" &&
              !(lastItem?.kind === "tool" && lastItem.output === null) ? (
                <Message from="assistant" animateIn>
                  <MessageAvatar placeholder />
                  <MessageContent>
                    <span role="status">
                      <ThinkingShimmer />
                    </span>
                  </MessageContent>
                </Message>
              ) : null}
              {followUps.map((followUp) => (
                <FollowUpBubble key={followUp.id} threadId={threadId} followUp={followUp} />
              ))}
            </MessageGroup>
          </MessageScroller>

          {runningAgents.length ? (
            <RunningAgents
              threadId={threadId}
              agents={runningAgents}
              // Stopping one Codex subagent leaves the main agent waiting on it; Stop ends them all.
              canStopOne={provider === "claude"}
              onReveal={(toolId) => setReveal({ toolId })}
            />
          ) : null}
          <Composer
            prefsKey={threadId}
            threadId={threadId}
            history={history}
            provider={provider}
            cwd={info.cwd}
            busy={busy}
            models={choices}
            model={current ? encodeChoice(provider, current) : undefined}
            onModelChange={(value) =>
              send(
                ClientCommand.cases["thread.setModel"].make({
                  threadId,
                  model: decodeChoice(value).model,
                }),
              )
            }
            placeholder={
              busy
                ? followUpMode === "queue"
                  ? "Queue a follow-up · ⌘↩ to send now"
                  : `Steer ${harnessLabel(settings, provider)} · ⌘↩ to queue`
                : `Ask ${harnessLabel(settings, provider)}…`
            }
            onSubmit={(text, options, how) => {
              // While the agent works, a message waits for the turn to end, or steers it; ⌘Enter flips that.
              const steer = (followUpMode === "steer") !== how.alternate;
              if (busy && !steer) queueFollowUp(threadId, text, options);
              else send(ClientCommand.cases["thread.send"].make({ threadId, text, options }));
            }}
            onStop={() => {
              send(ClientCommand.cases["thread.interrupt"].make({ threadId }));
              returnToComposer(threadId, takeFollowUps(threadId));
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
              cwd={info.cwd}
              refreshKey={diffKey}
              turn={diffTurn ? { threadId, messageId: diffTurn } : null}
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
  provider,
  threadId,
  busy,
}: {
  items: ReadonlyArray<TranscriptItem>;
  provider: ProviderKind;
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
  return turns.map((turn, index) => {
    // The latest exchange stays fully rendered: it's what streams and what the scroller follows.
    const className = settled && index < turns.length - 2 ? OFFSCREEN_SKIP : KEEP_RENDERED;
    return turn.from === "user" ? (
      <UserTurn
        key={turn.id}
        item={turn.item}
        threadId={threadId}
        busy={busy}
        animateIn={settled}
        className={className}
      />
    ) : (
      <AssistantTurn
        key={turn.id}
        items={turn.items}
        provider={provider}
        threadId={threadId}
        busy={busy}
        last={index === turns.length - 1}
        className={className}
      />
    );
  });
};

/**
 * Lighter than virtualizing (the message rail reads every turn's text from the DOM):
 * the turns stay in the document but cost nothing while scrolled away.
 */
const OFFSCREEN_SKIP = "[content-visibility:auto] [contain-intrinsic-size:auto_240px]";
const KEEP_RENDERED = "[contain-intrinsic-size:auto_240px]";

const UserTurn = memo(
  ({
    item,
    threadId,
    busy,
    animateIn,
    className,
  }: {
    item: UserItem;
    threadId: string;
    busy: boolean;
    animateIn: boolean;
    className: string;
  }) => (
    <Message from="user" animateIn={animateIn} className={cn("group/turn", className)}>
      <MessageContent className="gap-1.5">
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
);

const REWIND_OPTIONS = [
  { value: "keep", label: "Rewind conversation", description: "The files stay as they are now" },
  {
    value: "files",
    label: "Rewind conversation and files",
    description: "The folder goes back to how it was when this was sent",
  },
];

/** Rewinds to before this message and puts it back in the composer to edit and resend. */
const EditFromHere = ({ item, threadId }: { item: UserItem; threadId: string }) => (
  <div className="flex justify-end opacity-0 transition-opacity group-hover/turn:opacity-100 has-[[aria-expanded=true]]:opacity-100">
    <PromptSelect
      title="Edit from here"
      icon={<Undo2 />}
      options={REWIND_OPTIONS}
      value={undefined}
      placeholder="Edit from here"
      side="bottom"
      align="end"
      width="w-72"
      className="h-6 text-[11px]"
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
  const listId = useId();
  return (
    <div
      className="shrink-0 px-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <div className="mx-auto max-w-3xl pb-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex h-7 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          {agents.length} {agents.length === 1 ? "subagent" : "subagents"} running
          <ChevronRight
            className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
          />
        </button>
        {open ? (
          <ul id={listId} className="mt-1 rounded-xl border border-border bg-background p-1">
            {agents.map((agent) => {
              const calls = agent.children ?? [];
              const last = calls.at(-1);
              const name = agent.summary || "Subagent";
              const isUnfolded = unfolded.has(agent.id);
              const earlier = calls.length - RECENT_AGENT_CALLS;
              return (
                <li key={agent.id}>
                  <div className="flex items-center gap-1 rounded-lg hover:bg-muted/60">
                    <button
                      type="button"
                      aria-expanded={isUnfolded}
                      aria-label={`${isUnfolded ? "Hide" : "Show"} what ${name} is doing`}
                      onClick={() => {
                        const next = new Set(unfolded);
                        if (!next.delete(agent.id)) next.add(agent.id);
                        setUnfolded(next);
                      }}
                      className="ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform duration-200",
                          isUnfolded && "rotate-90",
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      title="Show it in the chat"
                      onClick={() => onReveal(agent.id)}
                      className="flex min-w-0 flex-1 items-baseline gap-2 rounded-lg py-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="shrink-0 text-sm text-foreground">{name}</span>
                      <span className="truncate text-xs text-muted-foreground">
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
                      <span className="shrink-0 pr-2 text-xs text-muted-foreground/70 tabular-nums">
                        {new Intl.NumberFormat("en", { notation: "compact" }).format(agent.tokens)}{" "}
                        tokens
                        {agent.durationMs === undefined
                          ? null
                          : ` · ${agent.durationMs >= 60_000 ? `${Math.floor(agent.durationMs / 60_000)}m ` : ""}${Math.floor(agent.durationMs / 1000) % 60}s`}
                      </span>
                    )}
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
                        className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <Square className="size-2.5 fill-current" />
                      </button>
                    ) : null}
                  </div>
                  {isUnfolded ? (
                    <div className="mr-2 mb-1 ml-[18px] border-l border-border pl-3 text-sm">
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
                          .map((call) => (
                            <ToolCallRow key={call.id} call={call} live reveal={null} />
                          ))
                      ) : (
                        <p className="py-1 text-xs text-muted-foreground">No calls yet</p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
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
        {item.additions ? (
          <span className="text-emerald-600 dark:text-emerald-400">+{item.additions}</span>
        ) : null}
        {item.additions && item.deletions ? " " : null}
        {item.deletions ? (
          <span className="text-rose-600 dark:text-rose-400">−{item.deletions}</span>
        ) : null}
      </span>
    </button>
  );
};

interface AssistantTurnProps {
  items: ReadonlyArray<TranscriptItem>;
  provider: ProviderKind;
  threadId: string;
  busy: boolean;
  /** The newest turn: its last block is the one streaming. */
  last: boolean;
  className: string;
}

const AssistantTurn = memo(
  ({ items, provider, threadId, busy, last, className }: AssistantTurnProps) => {
    const ProviderLogo = PROVIDER_LOGO[provider];
    const settings = useStore((s) => s.settings);
    const blocks = useMemo(() => toBlocks(items), [items]);
    const lastItem = items.at(-1);
    const finalTextId = blocks.findLast((block) => block.kind === "assistant")?.id;
    return (
      <Message from="assistant" className={className}>
        <MessageAvatar className={harnessTint(settings, provider).avatar}>
          <ProviderLogo />
        </MessageAvatar>
        <MessageContent className="gap-3">
          <MessageHeader>
            <span>{harnessLabel(settings, provider)}</span>
          </MessageHeader>
          {blocks.map((block) => (
            <AgentBlock
              key={block.id}
              block={block}
              threadId={threadId}
              live={busy}
              streaming={busy && last && block === lastItem}
              showActions={block.id === finalTextId && !(busy && last)}
            />
          ))}
        </MessageContent>
      </Message>
    );
  },
  // `toTurns` rebuilds the turn arrays each time; the items inside keep their identity.
  (a, b) =>
    a.provider === b.provider &&
    a.threadId === b.threadId &&
    a.busy === b.busy &&
    a.last === b.last &&
    a.className === b.className &&
    sameItems(a.items, b.items),
);

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
        sameItems(a.block.calls, b.block.calls))),
);

const AgentBlockContent = ({
  block: item,
  threadId,
  live,
  streaming,
  showActions,
}: AgentBlockProps) => {
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
              showActions={showActions}
              showFeedback={false}
            >
              <Markdown streaming={streaming} className="selectable leading-relaxed">
                {item.text}
              </Markdown>
            </StreamingResponse>
          </MessageBubbleContent>
        </MessageBubble>
      );
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
            approveOptions={(["ask", "auto-edit", "auto", "full-access"] as const).map((level) => ({
              id: level,
              label: BUILD_WITH_LABEL[level],
              onSelect: () => approvePlan(threadId, item.id, level),
            }))}
            denyLabel="Reject"
            onApprove={() => approvePlan(threadId, item.id, "auto-edit")}
            onDeny={() => respondApproval(threadId, item.id, "deny")}
          >
            <div className="max-h-96 overflow-y-auto">
              <Markdown className="selectable leading-relaxed">{item.detail}</Markdown>
            </div>
          </ToolApproval>
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
