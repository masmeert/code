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
import { PromptInput, PromptSelect } from "@/components/agents/prompt-input";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { ToolApproval, ToolApprovalCode } from "@/components/agents/tool-approval";
import { ToolGroup, type ToolCall } from "@/components/agents/tool-group";
import { ProjectBadge } from "@/components/project-badge";
import { PROVIDER_AVATAR_CLASS, PROVIDER_LOGO } from "@/components/provider-logo";
import type { Attachment, PermissionLevel, Project, ProviderKind, TurnOptions } from "@apcode/contracts";
import { AnimatedSidebarTrigger, useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { FilePen, FileText, Folder, FolderPlus, GitBranch, ImageIcon, LockOpen, PanelLeft, PanelRight, ShieldCheck } from "lucide-react";
import { lazy, memo, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import {
  EFFORT_LABEL,
  EFFORTS,
  PERMISSION_DESCRIPTION,
  PERMISSION_LABEL,
  toTurnOptions,
  useAttachments,
  useTurnPrefs,
} from "../lib/composer.ts";
import { decodeChoice, defaultEffort, defaultModel, encodeChoice, modelChoices, PROVIDER_LABEL, recommendedBadge } from "../lib/models.ts";
import { createThread, loadOlder, markSeen, respondApproval, send, useStore, useTranscript, type TranscriptItem } from "../lib/store.ts";
import { readWidth } from "../lib/useResizable.ts";
import { addProject } from "../lib/projects.ts";
import { GitMenu } from "./GitMenu.tsx";

/** Same key the panel saves its dragged width under. */
const PANEL_WIDTH_KEY = "apcode.diffPanelWidth";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() => import("./DiffPanel.tsx").then((m) => ({ default: m.DiffPanel })));

/** Consecutive agent items form one turn under a single avatar. */
type Turn =
  | { readonly from: "user"; readonly id: string; readonly text: string; readonly attachments: ReadonlyArray<Attachment> }
  | { readonly from: "assistant"; readonly id: string; readonly items: Array<TranscriptItem> };

const toTurns = (items: ReadonlyArray<TranscriptItem>): Array<Turn> => {
  const turns: Array<Turn> = [];
  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ from: "user", id: item.id, text: item.text, attachments: item.attachments });
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
const Header = ({ project, title, actions }: { project?: Pick<Project, "id" | "name"> | undefined; title: string; actions?: ReactNode }) => {
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
        onModelChange={setChoice}
        placeholder={
          !selected
            ? "No harness linked"
            : !path
              ? "Pick a project below to start…"
              : `Ask ${PROVIDER_LABEL[decodeChoice(selected).provider]}…`
        }
        onSubmit={(text, options) => {
          if (!selected || !path) return;
          const { provider, model } = decodeChoice(selected);
          createThread({ path, provider, model, text, options });
        }}
      />
    </>
  );
};

const PERMISSION_ICON: Record<PermissionLevel, typeof ShieldCheck> = {
  ask: ShieldCheck,
  "auto-edit": FilePen,
  "full-access": LockOpen,
};

const PERMISSION_OPTIONS = (Object.keys(PERMISSION_LABEL) as Array<PermissionLevel>).map((level) => {
  const Icon = PERMISSION_ICON[level];
  return { value: level, label: PERMISSION_LABEL[level], description: PERMISSION_DESCRIPTION[level], icon: <Icon /> };
});

const Composer = (props: {
  /** Whose effort/permission picks these are: a thread, or a draft. */
  prefsKey: string;
  provider: ProviderKind;
  /** Project folder; null in a draft whose project isn't picked yet. */
  cwd: string | null;
  /** Drafts only: turns the folder chip into a project picker. */
  onPickProject?: (path: string | null) => void;
  busy?: boolean;
  disabled?: boolean;
  /** Keeps the composer usable but blocks sending (e.g. no project picked yet). */
  sendDisabled?: boolean;
  models: ReturnType<typeof modelChoices>;
  model: string | undefined;
  onModelChange: (value: string) => void;
  placeholder: string;
  onSubmit: (text: string, options: TurnOptions) => void;
  onStop?: () => void;
}) => {
  const [prefs, setPrefs] = useTurnPrefs(props.prefsKey, props.provider);
  const files = useAttachments({ acceptDrops: !props.disabled });
  const providers = useStore((s) => s.providers);
  // No pick means the model's own default, which the menu stars; picking the starred level keeps following it.
  const fallbackEffort = defaultEffort(providers, props.model);
  const effortOptions = EFFORTS[props.provider].map((effort) => ({
    value: effort,
    label: EFFORT_LABEL[effort],
    badge: effort === fallbackEffort ? recommendedBadge() : undefined,
  }));

  return (
    <div className="shrink-0 px-3 pb-3">
      <div className="mx-auto max-w-3xl">
        <PromptInput
          loading={props.busy ?? false}
          disabled={props.disabled ?? false}
          submitDisabled={props.sendDisabled ?? false}
          models={props.models}
          model={props.model}
          onModelChange={props.onModelChange}
          controls={[
            <PromptSelect
              key="effort"
              title="Reasoning effort"
              options={effortOptions}
              value={prefs.effort ?? fallbackEffort}
              onChange={(value) => setPrefs({ effort: value === fallbackEffort ? null : (value as NonNullable<typeof prefs.effort>) })}
              placeholder="Default effort"
              disabled={props.disabled}
              width="w-52"
            />,
            <PromptSelect
              key="permission"
              title="Permissions"
              options={PERMISSION_OPTIONS}
              value={prefs.permission}
              onChange={(value) => setPrefs({ permission: value as PermissionLevel })}
              disabled={props.disabled}
              showOptionIcon
              width="w-72"
              className={prefs.permission === "full-access" ? "text-warning hover:text-warning" : undefined}
            />,
          ]}
          attachments={[...files.attachments]}
          onAttach={() => void files.pick()}
          onRemoveAttachment={files.remove}
          onPasteFiles={(pasted) => void files.addFiles(pasted)}
          onSubmit={(text) => props.onSubmit(text, toTurnOptions(prefs, files.take()))}
          onStop={props.onStop}
          minRows={2}
          maxRows={10}
          placeholder={props.placeholder}
          footer={
            <>
              {props.onPickProject ? (
                <ProjectSelect cwd={props.cwd} onPick={props.onPickProject} />
              ) : (
                <span className="flex min-w-0 items-center gap-1.5 px-1.5">
                  <Folder className="size-3.5 shrink-0" />
                  <span className="truncate">{props.cwd?.split("/").at(-1) ?? props.cwd}</span>
                </span>
              )}
              {props.cwd ? <BranchPicker cwd={props.cwd} disabled={props.busy ?? false} /> : <span />}
            </>
          }
          autoFocus
        />
      </div>
    </div>
  );
};

const ADD_PROJECT = "\u0000add-project";

/** Which project a draft starts in; also the way to add one. */
const ProjectSelect = ({ cwd, onPick }: { cwd: string | null; onPick: (path: string | null) => void }) => {
  const projects = useStore((s) => s.projects);
  const options = [
    ...[...projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ value: project.path, label: project.name, icon: <ProjectBadge project={project} /> })),
    { value: ADD_PROJECT, label: "Add project…", icon: <FolderPlus /> },
  ];
  return (
    <PromptSelect
      title="Project"
      icon={<Folder />}
      options={options}
      value={cwd ?? undefined}
      placeholder="Pick a project"
      onChange={(value) => (value === ADD_PROJECT ? void addProject().then((path) => path && onPick(path)) : onPick(value))}
      width="w-64"
      className={cwd ? "h-6 text-[11px]" : "h-6 text-[11px] text-foreground"}
    />
  );
};

/** Current branch of the project folder; picking another checks it out. */
const BranchPicker = ({ cwd, disabled }: { cwd: string; disabled: boolean }) => {
  const list = useStore((s) => s.branches[cwd]);
  useEffect(() => send({ _tag: "git.listBranches", path: cwd }), [cwd]);

  if (!list) return null;
  if (!list.current && !list.branches.length) return <span className="px-1.5 text-muted-foreground/70">Not a git repo</span>;
  return (
    <PromptSelect
      title="Switch branch"
      icon={<GitBranch />}
      searchPlaceholder="Find or create a branch…"
      onCreate={(branch) => send({ _tag: "git.createBranch", path: cwd, branch })}
      createLabel={(branch) => (
        <>
          Create <span className="font-mono">{branch}</span>
        </>
      )}
      options={list.branches.map((branch) => ({ value: branch, label: branch }))}
      value={list.current ?? undefined}
      placeholder="Detached"
      onChange={(branch) => branch !== list.current && send({ _tag: "git.checkout", path: cwd, branch })}
      onOpenChange={(open) => open && send({ _tag: "git.listBranches", path: cwd })}
      disabled={disabled}
      note={list.error ? <span className="whitespace-pre-wrap text-destructive">{list.error}</span> : undefined}
      align="end"
      width="w-72"
      className="h-6 font-mono text-[11px]"
    />
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
  // Re-read the diff whenever a tool finishes or a turn ends: either may have changed files.
  const finishedTools = items.reduce((n, item) => (item.kind === "tool" && item.output !== null ? n + 1 : n), 0);
  const diffKey = `${status}:${info.updatedAt}:${finishedTools}`;

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
        actions={
          <>
            <GitMenu cwd={info.cwd} refreshKey={diffKey} />
            <button
              type="button"
              title={diffOpen ? "Hide changes" : "Show changes"}
              aria-label={diffOpen ? "Hide changes" : "Show changes"}
              aria-pressed={diffOpen}
              onClick={() => setDiffOpen(!diffOpen)}
              className={`grid size-7 place-items-center rounded-lg outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${diffOpen ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
            >
              <PanelRight className="size-4" />
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              <TurnList items={items} provider={provider} threadId={threadId} busy={busy} />

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
            </MessageGroup>
          </MessageScroller>

          <Composer
            prefsKey={threadId}
            provider={provider}
            cwd={info.cwd}
            busy={busy}
            models={choices}
            model={current ? encodeChoice(provider, current) : undefined}
            onModelChange={(value) => send({ _tag: "thread.setModel", threadId, model: decodeChoice(value).model })}
            placeholder={busy ? "Working…" : `Ask ${PROVIDER_LABEL[provider]}…`}
            onSubmit={(text, options) => send({ _tag: "thread.send", threadId, text, options })}
            onStop={() => send({ _tag: "thread.interrupt", threadId })}
          />
        </div>
        {diffOpen ? (
          <Suspense fallback={<div style={{ width: readWidth(PANEL_WIDTH_KEY, Math.min(960, Math.round(window.innerWidth * 0.45))) }} className="shrink-0 border-l border-border" />}>
            <DiffPanel cwd={info.cwd} refreshKey={diffKey} onClose={() => setDiffOpen(false)} />
          </Suspense>
        ) : null}
      </div>
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
  return turns.map((turn, index) =>
    turn.from === "user" ? (
      <UserTurn key={turn.id} text={turn.text} attachments={turn.attachments} />
    ) : (
      <AssistantTurn key={turn.id} items={turn.items} provider={provider} threadId={threadId} busy={busy} last={index === turns.length - 1} />
    ),
  );
};

const UserTurn = memo(({ text, attachments }: { text: string; attachments: ReadonlyArray<Attachment> }) => (
  <Message from="user" animateIn>
    <MessageContent className="gap-1.5">
      {attachments.length ? <AttachmentList attachments={attachments} /> : null}
      {text ? (
        <MessageBubble variant="soft">
          <MessageBubbleContent className="selectable whitespace-pre-wrap">{text}</MessageBubbleContent>
        </MessageBubble>
      ) : null}
    </MessageContent>
  </Message>
));

interface AssistantTurnProps {
  items: ReadonlyArray<TranscriptItem>;
  provider: ProviderKind;
  threadId: string;
  busy: boolean;
  /** The newest turn: its last block is the one streaming. */
  last: boolean;
}

const AssistantTurn = memo(
  ({ items, provider, threadId, busy, last }: AssistantTurnProps) => {
    const ProviderLogo = PROVIDER_LOGO[provider];
    const blocks = useMemo(() => toBlocks(items), [items]);
    const lastItem = items.at(-1);
    return (
      <Message from="assistant">
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
    a.provider === b.provider && a.threadId === b.threadId && a.busy === b.busy && a.last === b.last && sameItems(a.items, b.items),
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
  }
};
