import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageGroup,
  MessageHeader,
  MessageScroller,
} from "@/components/agents/message";
import { Markdown } from "@/components/agents/markdown";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { PromptSelect } from "@/components/agents/prompt-input";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { ToolApproval, ToolApprovalCode } from "@/components/agents/tool-approval";
import { ToolGroup, type ToolCall } from "@/components/agents/tool-group";
import { ProjectBadge } from "@/components/project-badge";
import { cn } from "@/lib/utils";
import { PROVIDER_AVATAR_CLASS, PROVIDER_LOGO } from "@/components/provider-logo";
import type { Attachment, Project, ProviderKind, TurnOptions } from "@apcode/contracts";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { ArrowUp, FileDiff, FileText, FolderTree, ImageIcon, PanelLeft, Quote, SquareTerminal, Undo2, X } from "lucide-react";
import { createContext, lazy, memo, type ReactNode, type RefObject, Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromSent } from "../lib/composer.ts";
import { appendToDraft, focusComposer, setDraft } from "../lib/drafts.ts";
import { describe, useKeybinding } from "../lib/keybindings.ts";
import { decodeChoice, defaultModel, encodeChoice, modelChoices, PROVIDER_LABEL } from "../lib/models.ts";
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
import { readWidth } from "../lib/useResizable.ts";
import { Composer, useWorkspaceChoice } from "./Composer.tsx";
import { GitMenu } from "./GitMenu.tsx";

/** Same key the panel saves its dragged width under. */
const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() => import("./DiffPanel.tsx").then((m) => ({ default: m.DiffPanel })));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx").then((m) => ({ default: m.TerminalPanel })));

/** Consecutive agent items form one turn under a single avatar. */
type UserItem = Extract<TranscriptItem, { kind: "user" }>;

type Turn = { readonly from: "user"; readonly id: string; readonly item: UserItem } | { readonly from: "assistant"; readonly id: string; readonly items: Array<TranscriptItem> };

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
type Block = { readonly kind: "tools"; readonly id: string; readonly calls: Array<ToolItem> } | Exclude<TranscriptItem, ToolItem>;

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
    <header data-tauri-drag-region className={`flex h-10 shrink-0 items-center gap-2 pr-4 pb-[3px] ${open ? "pl-5" : "pl-[86px]"}`}>
      {open ? null : (
        <AnimatedSidebarTrigger className="mr-1 size-7 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground">
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
      {actions ? <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">{actions}</span> : null}
    </header>
  );
};

/** A new chat that only exists in this window until its first message creates the thread. */
export const DraftView = ({ path, onPickProject }: { path: string | null; onPickProject: (path: string | null) => void }) => {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const project = useStore((s) => s.projects.find((p) => p.path === path));
  const choices = modelChoices(providers);
  const lastModel = defaultModel(providers, settings, settings.lastProvider);
  const preferred = lastModel ? encodeChoice(settings.lastProvider, lastModel) : undefined;
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const selected = [choice, preferred].find((c) => c && choices.some((o) => o.value === c)) ?? choices[0]?.value;
  // Shift-click adds models: the prompt then starts one thread per model, each in its own worktree.
  const [extras, setExtras] = useState<Array<string>>([]);
  const extraModels = extras.filter((c) => c !== selected && choices.some((o) => o.value === c));
  const workspace = useWorkspaceChoice();

  return (
    <>
      <Header
        project={path ? { id: project?.id ?? path, name: project?.name ?? path.split("/").at(-1) ?? path } : undefined}
        title="New thread"
      />
      <div data-tauri-drag-region className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground">
        {choices.length ? "What should we work on?" : "Link Claude Code or Codex in Settings to start."}
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
        onToggleModel={(value) => setExtras((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]))}
        workspace={workspace}
        placeholder={
          !selected
            ? "No harness linked"
            : !path
              ? "Pick a project below to start…"
              : extraModels.length
                ? `Ask ${extraModels.length + 1} models, each in its own worktree…`
                : `Ask ${PROVIDER_LABEL[decodeChoice(selected).provider]}…`
        }
        onSubmit={(text, options, how) => {
          if (!selected || !path) return;
          const all = [selected, ...extraModels];
          for (const value of all) {
            const { provider, model } = decodeChoice(value);
            // Several models, or ⌘Enter: start in the background and stay in the draft.
            const open = all.length === 1 && !how.alternate;
            createThread({ path, provider, model, text, options, workspace: all.length > 1 ? "worktree" : workspace.value, open });
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
        <IconAction label="Back to the composer" onClick={() => returnToComposer(threadId, takeFollowUps(threadId, followUp.id))}>
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
    className="grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
  >
    {props.children}
  </button>
);

/**
 * Selecting text in an agent reply offers to quote it in the composer, where you can
 * comment on it (t3code's "Cite in composer").
 */
const QuoteSelection = ({ container, threadId }: { container: RefObject<HTMLDivElement | null>; threadId: string }) => {
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const area = container.current;
    if (!area) return;
    const update = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      const node = selection?.anchorNode;
      const inReply = node && area.contains(node) && (node instanceof Element ? node : node.parentElement)?.closest('[data-from="assistant"]');
      if (!selection || selection.isCollapsed || !text || !inReply) return setQuote(null);
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const box = area.getBoundingClientRect();
      setQuote({ text, top: rect.top - box.top - 34, left: Math.min(Math.max(rect.left - box.left + rect.width / 2, 40), box.width - 40) });
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
        appendToDraft(threadId, `${quote.text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`);
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
  const choices = modelChoices(providers, provider);
  const current = info.model ?? defaultModel(providers, settings, provider);
  const busy = status === "running" || status === "awaiting-approval";
  const lastItem = items.at(-1);
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
  const diffTurnGone = diffTurn !== null && transcript?.status === "live" && !items.some((item) => item.id === diffTurn);
  useEffect(() => {
    if (diffTurnGone) setDiffTurn(null);
  }, [diffTurnGone]);
  const followUps = useStore((s) => s.followUps[threadId]) ?? NO_FOLLOW_UPS;
  const followUpMode = useStore((s) => s.settings.followUp ?? "queue");
  const history = useMemo(() => items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])), [items]);
  const scrollArea = useRef<HTMLDivElement>(null);
  // Re-read the diff whenever a tool finishes or a turn ends: either may have changed files.
  const finishedTools = items.reduce((n, item) => (item.kind === "tool" && item.output !== null ? n + 1 : n), 0);
  const diffKey = `${status}:${info.updatedAt}:${finishedTools}`;
  const activeTerminal = useStore((s) => s.activeTerminals[threadId]);
  useKeybinding("terminal.toggle", () => {
    toggleTerminalPanel(threadId);
    if (activeTerminal) focusComposer();
  });

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
      <Header
        project={project ?? { id: info.projectId, name: info.cwd.split("/").at(-1) ?? info.cwd }}
        title={info.title}
        badge={
          info.worktree ? (
            <span
              title={`Worktree: ${info.cwd}`}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              <FolderTree className="size-3" />
              {info.branch ?? "worktree"}
            </span>
          ) : null
        }
        actions={
          <>
            <GitMenu cwd={info.cwd} refreshKey={diffKey} />
            <button
              type="button"
              title={`${activeTerminal ? "Hide" : "Show"} terminal (${describe("terminal.toggle")})`}
              aria-label={activeTerminal ? "Hide terminal" : "Show terminal"}
              aria-pressed={activeTerminal !== undefined}
              onClick={() => toggleTerminalPanel(threadId)}
              className={`grid size-7 place-items-center rounded-lg outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${activeTerminal ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
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
              className={`grid size-7 place-items-center rounded-lg outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${diffOpen ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
            >
              <FileDiff className="size-4" />
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div ref={scrollArea} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                  className="mx-auto rounded-lg px-3 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  {transcript.loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              ) : null}
              <TurnDiffContext value={openTurnDiff}>
                <TurnList items={items} provider={provider} threadId={threadId} busy={busy} />
              </TurnDiffContext>

              {status === "running" && lastItem?.kind !== "assistant" && !(lastItem?.kind === "tool" && lastItem.output === null) ? (
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

          <Composer
            prefsKey={threadId}
            threadId={threadId}
            history={history}
            provider={provider}
            cwd={info.cwd}
            busy={busy}
            models={choices}
            model={current ? encodeChoice(provider, current) : undefined}
            onModelChange={(value) => send({ _tag: "thread.setModel", threadId, model: decodeChoice(value).model })}
            placeholder={
              busy
                ? followUpMode === "queue"
                  ? "Working… messages wait for the turn to end (⌘↩ to send now)"
                  : "Working… messages go in right away (⌘↩ to queue)"
                : `Ask ${PROVIDER_LABEL[provider]}…`
            }
            onSubmit={(text, options, how) => {
              // While the agent works, a message waits for the turn to end, or steers it; ⌘Enter flips that.
              const steer = (followUpMode === "steer") !== how.alternate;
              if (busy && !steer) queueFollowUp(threadId, text, options);
              else send({ _tag: "thread.send", threadId, text, options });
            }}
            onStop={() => {
              send({ _tag: "thread.interrupt", threadId });
              returnToComposer(threadId, takeFollowUps(threadId));
            }}
          />
        </div>
        {diffOpen ? (
          <Suspense fallback={<div style={{ width: readWidth(PANEL_WIDTH_KEY, Math.min(960, Math.round(window.innerWidth * 0.45))) }} className="shrink-0 border-l border-border" />}>
            <DiffPanel
              cwd={info.cwd}
              refreshKey={diffKey}
              turn={diffTurn ? { threadId, messageId: diffTurn } : null}
              onShowAll={() => setDiffTurn(null)}
              onClose={() => setDiffOpen(false)}
            />
          </Suspense>
        ) : null}
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
const sameItems = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) => a.length === b.length && a.every((item, i) => item === b[i]);

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
      <UserTurn key={turn.id} item={turn.item} threadId={threadId} busy={busy} className={className} />
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

const UserTurn = memo(({ item, threadId, busy, className }: { item: UserItem; threadId: string; busy: boolean; className: string }) => (
  <Message from="user" animateIn className={cn("group/turn", className)}>
    <MessageContent className="gap-1.5">
      {item.attachments.length ? <AttachmentList attachments={item.attachments} /> : null}
      {item.text ? (
        <MessageBubble variant="soft">
          <MessageBubbleContent className="selectable whitespace-pre-wrap">{item.text}</MessageBubbleContent>
        </MessageBubble>
      ) : null}
      {/* A message sent mid-turn has no turn of its own to go back to. */}
      {busy || item.steer ? null : <EditFromHere item={item} threadId={threadId} />}
    </MessageContent>
  </Message>
));

const REWIND_OPTIONS = [
  { value: "keep", label: "Rewind conversation", description: "The files stay as they are now" },
  { value: "files", label: "Rewind conversation and files", description: "The folder goes back to how it was when this was sent" },
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
        send({ _tag: "thread.rewind", threadId, messageId: item.id, restoreFiles: choice === "files" });
        focusComposer();
      }}
    />
  </div>
);

/** What a turn changed on disk; opens those changes. */
const CheckpointChip = ({ item }: { item: Extract<TranscriptItem, { kind: "checkpoint" }> }) => {
  const openTurnDiff = use(TurnDiffContext);
  return (
    <button
      type="button"
      onClick={() => openTurnDiff(item.messageId)}
      className="flex w-fit items-center gap-2 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileDiff className="size-3.5" />
      <span>
        {item.files} {item.files === 1 ? "file" : "files"} changed
      </span>
      <span className="font-mono tabular-nums">
        {item.additions ? <span className="text-emerald-600 dark:text-emerald-400">+{item.additions}</span> : null}
        {item.additions && item.deletions ? " " : null}
        {item.deletions ? <span className="text-rose-600 dark:text-rose-400">−{item.deletions}</span> : null}
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
    const blocks = useMemo(() => toBlocks(items), [items]);
    const lastItem = items.at(-1);
    return (
      <Message from="assistant" className={className}>
        <MessageAvatar className={PROVIDER_AVATAR_CLASS[provider]}>
          <ProviderLogo />
        </MessageAvatar>
        <MessageContent className="gap-3">
          <MessageHeader>
            <span>{PROVIDER_LABEL[provider]}</span>
          </MessageHeader>
          {blocks.map((block) => (
            <AgentBlock key={block.id} block={block} threadId={threadId} live={busy} streaming={busy && last && block === lastItem} />
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
}

const AgentBlock = memo(
  (props: AgentBlockProps) => <AgentBlockContent {...props} />,
  // Tool groups are rebuilt by `toBlocks`; compare the calls they hold instead.
  (a, b) =>
    a.threadId === b.threadId &&
    a.live === b.live &&
    a.streaming === b.streaming &&
    (a.block === b.block || (a.block.kind === "tools" && b.block.kind === "tools" && sameItems(a.block.calls, b.block.calls))),
);

const AgentBlockContent = ({ block: item, threadId, live, streaming }: AgentBlockProps) => {
  switch (item.kind) {
    case "user":
      return null;
    case "assistant":
      return (
        <MessageBubble variant="ghost" className="w-full">
          <MessageBubbleContent>
            <StreamingResponse status={streaming ? "streaming" : "complete"} copyText={item.text} showActions={!streaming} showFeedback={false}>
              <Markdown streaming={streaming} className="selectable leading-relaxed">
                {item.text}
              </Markdown>
            </StreamingResponse>
          </MessageBubbleContent>
        </MessageBubble>
      );
    case "tools":
      return <ToolGroup calls={item.calls satisfies ReadonlyArray<ToolCall>} live={live} />;
    case "approval":
      // Once approved, the tool group shows what ran; only pending and denied requests stay visible.
      if (item.resolved && item.decision !== "deny") return null;
      return (
        <ToolApproval
          tool={item.title}
          title={`Allow ${item.title}?`}
          status={item.decision === "deny" ? "denied" : item.decision ? "approving" : "pending"}
          defaultOpen
          parameters={[{ id: "input", label: "Input", value: <ToolApprovalCode code={item.detail} language="bash" /> }]}
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
