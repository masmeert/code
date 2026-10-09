import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
} from "@masscode/ui/agents/message";
import { Markdown } from "@masscode/ui/agents/markdown";
import { Reasoning, thoughtTitle } from "@masscode/ui/agents/reasoning";
import * as Match from "effect/Match";
import { OrbFace } from "@masscode/ui/agents/orb-face";
import { PromptSelect } from "@masscode/ui/agents/prompt-input";
import { StreamingResponse } from "@masscode/ui/agents/streaming-response";
import { ApprovalCard } from "@masscode/ui/agents/approval-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@masscode/ui/components/alert-dialog";
import { ScrollArea } from "@masscode/ui/components/scroll-area";
import { ToolApproval, ToolApprovalCode } from "@masscode/ui/agents/tool-approval";
import {
  livePhrase,
  summarize,
  ToolGroup,
  type ToolCall,
  type ToolReveal,
} from "@masscode/ui/agents/tool-group";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { cn } from "@masscode/ui/lib/utils";
import {
  type Attachment,
  ClientCommand,
  type CommandRun,
  type ProviderKind,
  WORKTREE_SETUP_TERMINAL_ID,
} from "@masscode/contracts";
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  FileDiff,
  FileText,
  GitFork,
  ImageIcon,
  LoaderCircle,
  Square,
  Undo2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  lazy,
  memo,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  approvePlan,
  BUILD_WITH_LABEL,
  PERMISSIONS,
  toDraftAttachment,
  useNeedsRootConsent,
} from "../lib/composer.ts";
import { focusComposer, getDraft, setDraft } from "../lib/drafts.ts";
import { formatHarnessLabel } from "../lib/models.ts";
import {
  closeTerminal,
  dismissForkError,
  forkThread,
  fetchImageUrl,
  openSideChat,
  respondApproval,
  type RunningCommand,
  send,
  switchToThread,
  useFileRestoreBlocker,
  useStore,
  useThreadHost,
  type TranscriptItem,
} from "../lib/store.ts";
import { RootFullAccessDialog } from "./Composer.tsx";
import {
  toTurns,
  toToolGroups,
  toBlocks,
  hasNewestItem,
  hasSameItems,
  type UserItem,
  type MarkerItem,
  type Block,
} from "../lib/transcriptBlocks.ts";

const TerminalView = lazy(() =>
  import("./TerminalPanel.tsx").then((module) => ({ default: module.TerminalView })),
);

/** Opens the changes panel on one turn; provided by the thread view to the checkpoint chips deep in the transcript. */
export const TurnDiffContext = createContext<(messageId: string) => void>(() => {});
/** The tool call last picked in the running-subagents list, for its group to open and scroll to. */
export const RevealContext = createContext<ToolReveal | null>(null);
/** Hands a shell block's command to the agent as a message; provided by the thread view to its replies. */
export const RunCommandContext = createContext<((command: string) => void) | undefined>(undefined);

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.isImage ? ImageIcon : FileText;

  return (
    <span
      title={attachment.path}
      className="flex h-7 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate text-foreground">{attachment.name}</span>
    </span>
  );
}

/** Falls back to the chip when the file is gone or the host can't serve it. */
function AttachmentThumbnail({
  threadId,
  attachment,
}: {
  threadId: string;
  attachment: Attachment;
}) {
  // Undefined while signing, null once it can't be shown.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    void fetchImageUrl(threadId, attachment.path).then(
      (signed) => isCurrent && setUrl(signed),
      () => isCurrent && setUrl(null),
    );
    return () => {
      isCurrent = false;
    };
  }, [threadId, attachment.path]);

  if (url === null) return <AttachmentChip attachment={attachment} />;
  if (url === undefined) return <span className="size-20 animate-pulse rounded-lg bg-muted" />;

  return (
    <>
      <button
        type="button"
        title={attachment.path}
        onClick={() => setIsOpen(true)}
        className="cursor-zoom-in overflow-hidden rounded-lg border border-border transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <img
          src={url}
          alt={attachment.name}
          onError={() => setUrl(null)}
          className="h-20 max-w-40 object-cover"
        />
      </button>
      <MorphingModal
        viewId={isOpen ? attachment.path : null}
        onClose={() => setIsOpen(false)}
        placement="center"
        className="w-auto max-w-[90vw]"
      >
        <img
          src={url}
          alt={attachment.name}
          className="max-h-[80vh] max-w-full rounded-lg object-contain"
        />
        <p className="mt-3 truncate text-xs text-muted-foreground" title={attachment.path}>
          {attachment.name}
        </p>
      </MorphingModal>
    </>
  );
}

function AttachmentList({
  threadId,
  attachments,
}: {
  threadId: string;
  attachments: ReadonlyArray<Attachment>;
}) {
  return (
    <div className="flex flex-wrap items-end justify-end gap-1.5">
      {attachments.map((attachment) =>
        attachment.isImage ? (
          <AttachmentThumbnail key={attachment.path} threadId={threadId} attachment={attachment} />
        ) : (
          <AttachmentChip key={attachment.path} attachment={attachment} />
        ),
      )}
    </div>
  );
}

/**
 * The transcript. Every delta re-renders this, but turns and blocks whose items are
 * unchanged bail out, so only the message actually streaming does any work.
 */
export function TurnList({
  items,
  threadId,
  isBusy,
}: {
  items: ReadonlyArray<TranscriptItem>;
  threadId: string;
  isBusy: boolean;
}) {
  const turns = useMemo(() => toTurns(items), [items]);

  // Older turns skip layout and paint while off screen. Switched on after the first
  // frame with turns in it (the transcript can arrive after the view opens), so every
  // turn has been laid out once and its real height is remembered.
  const [isSettled, setIsSettled] = useState(false);
  const hasTurns = turns.length > 0;

  useEffect(() => {
    if (!hasTurns) return;
    const frame = requestAnimationFrame(() => setIsSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [hasTurns]);

  return (
    // Lighter than virtualizing (the message rail reads every turn's text from the DOM): the turns
    // stay in the document but cost nothing while scrolled away. Set here rather than on each turn,
    // so settling doesn't re-render them all. The latest exchange stays fully rendered: it's what
    // streams and what the scroller follows.
    <div
      data-settled={isSettled || undefined}
      className="contents *:[contain-intrinsic-size:auto_240px] data-settled:[&>*:nth-last-child(n+3)]:[content-visibility:auto]"
    >
      {turns.map((turn, index) => {
        if (turn.from === "marker") return <ThreadMarker key={turn.id} item={turn.item} />;
        if (turn.from === "setup") {
          return (
            <CommandRunResult
              key={turn.id}
              run={turn.item.run}
              label="Worktree setup"
              isStopped={turn.item.stopped}
            />
          );
        }
        if (turn.from === "user") {
          return (
            <UserTurn
              key={turn.id}
              item={turn.item}
              threadId={threadId}
              isBusy={isBusy}
              animateIn={isSettled}
            />
          );
        }
        return (
          <AssistantTurn
            key={turn.id}
            items={turn.items}
            threadId={threadId}
            isBusy={isBusy}
            isLast={index === turns.length - 1}
          />
        );
      })}
    </div>
  );
}

/**
 * A command from a reply, or the new worktree's setup, while it runs: its terminal, live, and a
 * way to stop it: before it reaches the agent, or to start the agent without waiting.
 */
export function RunningCommandWindow({ threadId, run }: { threadId: string; run: RunningCommand }) {
  const isSetup = run.terminalId === WORKTREE_SETUP_TERMINAL_ID;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex h-9 items-center gap-2 border-b border-border pr-1.5 pl-3 text-xs">
        <LoaderCircle className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        {isSetup ? (
          <span className="shrink-0 text-muted-foreground">Setting up worktree</span>
        ) : null}
        <code className="min-w-0 flex-1 truncate font-mono text-foreground/85">{run.command}</code>
        <button
          type="button"
          title={
            isSetup
              ? "Stop setup; queued messages go to the agent now"
              : "Stop it; the agent won't hear about this run"
          }
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
function CommandRunResult({
  run,
  label,
  isStopped = false,
}: {
  run: CommandRun;
  label?: string;
  isStopped?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-xs">
        {isStopped ? (
          <Square className="size-3 shrink-0 text-muted-foreground" />
        ) : run.exitCode === 0 ? (
          <Check className="size-3.5 shrink-0 text-success" />
        ) : (
          <X className="size-3.5 shrink-0 text-destructive" />
        )}
        {label ? <span className="shrink-0 text-muted-foreground">{label}</span> : null}
        <code className="min-w-0 flex-1 truncate font-mono text-foreground/85">{run.command}</code>
        {isStopped ? (
          <span className="shrink-0 text-muted-foreground">Stopped</span>
        ) : run.exitCode === 0 ? null : (
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
  const source = useStore((state) => state.threads[threadId]);
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
    isBusy,
    animateIn,
  }: {
    item: UserItem;
    threadId: string;
    isBusy: boolean;
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
          {item.attachments.length ? (
            <AttachmentList threadId={threadId} attachments={item.attachments} />
          ) : null}
          {item.text ? (
            <MessageBubble variant="soft">
              <MessageBubbleContent className="selectable whitespace-pre-wrap">
                {item.text}
              </MessageBubbleContent>
            </MessageBubble>
          ) : null}
          {/* A message sent mid-turn has no turn of its own to go back to. */}
          {isBusy || item.steer ? null : <EditFromHere item={item} threadId={threadId} />}
        </MessageContent>
      </Message>
    ),
  // `animateIn` is only read on mount, so it flipping once the list settles is no reason to re-render.
  (previous, next) =>
    previous.item === next.item &&
    previous.threadId === next.threadId &&
    previous.isBusy === next.isBusy,
);

/** Above a message sent right after switching harness: what the new one was told it missed. */
function HandoffNote({
  handoff,
  to,
}: {
  handoff: NonNullable<UserItem["handoff"]>;
  to: ProviderKind;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const settings = useStore((state) => state.settings);

  return (
    <div className="flex flex-col items-end gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftRight className="size-3.5 shrink-0" />
        Gave {formatHarnessLabel(settings, to)} the {handoff.messages}{" "}
        {handoff.messages === 1 ? "message" : "messages"}{" "}
        {formatHarnessLabel(settings, handoff.from)} had
        <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
      </button>
      {isOpen ? (
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
          setDraft(threadId, (draft) => ({
            text: draft.text.trim() ? `${draft.text.trimEnd()}\n\n${item.text}` : item.text,
            attachments: [...draft.attachments, ...item.attachments.map(toDraftAttachment)],
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
  const fork = useStore((state) => (state.forking?.messageId === item.id ? state.forking : null));
  const isPending = fork !== null && fork.error === null;
  const forkButton = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog
      open
      onOpenChange={(isOpen) => {
        if (isOpen || isPending) return;
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
          <AlertDialogCancel size="sm" disabled={isPending}>
            Cancel
            <kbd aria-hidden className="font-sans text-[10px] text-muted-foreground">
              esc
            </kbd>
          </AlertDialogCancel>
          <AlertDialogAction
            ref={forkButton}
            size="sm"
            disabled={isPending}
            onClick={(event) => {
              // Stays open until the fork opens, which replaces this view.
              event.preventDefault();
              forkThread(threadId, item.id);
            }}
          >
            {isPending ? "Forking…" : fork?.error ? "Try again" : "Fork"}
            {isPending ? null : (
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

/** What a turn changed on disk; opens those changes. */
function CheckpointChip({ item }: { item: Extract<TranscriptItem, { kind: "checkpoint" }> }) {
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
}

interface AssistantTurnProps {
  items: ReadonlyArray<TranscriptItem>;
  threadId: string;
  isBusy: boolean;
  /** The newest turn: its last block is the one streaming. */
  isLast: boolean;
}

const AssistantTurn = memo(
  ({ items, threadId, isBusy, isLast }: AssistantTurnProps) => {
    const lastItem = items.at(-1);
    const isLive = isBusy && isLast;
    // Until the turn ends, trailing text may be a note before the next tool call; showing it as the answer only to fold it away is noise.
    const heldAnswerId = isLive && lastItem?.kind === "assistant" ? lastItem.id : undefined;
    const blocks = useMemo(() => toBlocks(items, heldAnswerId), [items, heldAnswerId]);
    const finalTextId = blocks.findLast((block) => block.kind === "assistant")?.id;

    return (
      // The face hangs in the margin once there's room, so replies share the composer's left edge.
      // The row widens rather than the face overflowing it: older turns clip to their box.
      <Message from="assistant" className="@min-[800px]:-ml-9 @min-[800px]:w-auto">
        {/* One face, on the newest reply: repeated down the thread it reads as wallpaper. */}
        {isLast ? (
          <OrbFace
            state={
              isLive
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
              live={isBusy}
              streaming={isBusy && isLast && hasNewestItem(block, lastItem)}
              showActions={block.id === finalTextId && !(isBusy && isLast)}
            />
          ))}
        </MessageContent>
      </Message>
    );
  },
  // `toTurns` rebuilds the turn arrays each time; the items inside keep their identity.
  (previous, next) =>
    previous.threadId === next.threadId &&
    previous.isBusy === next.isBusy &&
    previous.isLast === next.isLast &&
    hasSameItems(previous.items, next.items),
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

export const AgentBlock = memo(
  (props: AgentBlockProps) => <AgentBlockContent {...props} />,
  // Tool groups are rebuilt by `toBlocks`; compare the calls they hold instead.
  (previous, next) =>
    previous.threadId === next.threadId &&
    previous.live === next.live &&
    previous.streaming === next.streaming &&
    previous.showActions === next.showActions &&
    (previous.block === next.block ||
      (previous.block.kind === "tools" &&
        next.block.kind === "tools" &&
        hasSameItems(previous.block.calls, next.block.calls)) ||
      (previous.block.kind === "work" &&
        next.block.kind === "work" &&
        hasSameItems(previous.block.items, next.block.items))),
);

function getPlanStatus(plan: Extract<TranscriptItem, { kind: "approval" }>) {
  if (plan.decision === "deny") return "denied";
  if (!plan.decision) return "pending";
  return plan.resolved ? "approved" : "approving";
}

function AgentBlockContent({ block, threadId, live, streaming, showActions }: AgentBlockProps) {
  const isForking = useStore(
    (state) => state.forking?.messageId === block.id && state.forking.error === null,
  );
  const [isConfirmingFork, setIsConfirmingFork] = useState(false);
  const host = useThreadHost(threadId);
  const needsRootConsent = useNeedsRootConsent(host);
  const [isConfirmingRoot, setIsConfirmingRoot] = useState(false);
  const runReplyCommand = use(RunCommandContext);
  const resolveImage = useCallback((src: string) => fetchImageUrl(threadId, src), [threadId]);
  const provider = useStore((state) => state.threads[threadId]?.provider);

  switch (block.kind) {
    case "user":
      return null;
    case "assistant":
      return (
        <MessageBubble variant="ghost" className="w-full">
          <MessageBubbleContent>
            <StreamingResponse
              status={streaming ? "streaming" : "complete"}
              copyText={block.text}
              onFork={live ? undefined : () => setIsConfirmingFork(true)}
              forking={isForking}
              onAskAside={() => openSideChat(threadId, block.id)}
              showActions={showActions}
              showFeedback={false}
            >
              <Markdown
                streaming={streaming}
                onRunCommand={runReplyCommand}
                resolveImage={resolveImage}
                className="selectable leading-relaxed"
              >
                {block.text}
              </Markdown>
            </StreamingResponse>
          </MessageBubbleContent>
          {isConfirmingFork ? (
            <ForkDialog
              threadId={threadId}
              item={block}
              onClose={() => setIsConfirmingFork(false)}
            />
          ) : null}
        </MessageBubble>
      );
    case "reasoning":
      return (
        <Reasoning label={thoughtTitle(block.id)} streaming={streaming}>
          <Markdown streaming={streaming} className="selectable leading-relaxed">
            {block.text}
          </Markdown>
        </Reasoning>
      );
    case "work":
      return (
        <WorkBlock items={block.items} threadId={threadId} live={live} streaming={streaming} />
      );
    case "tools":
      return (
        <ToolGroup
          calls={block.calls satisfies ReadonlyArray<ToolCall>}
          live={live}
          reveal={use(RevealContext)}
        />
      );
    case "approval":
      if (block.title === "ExitPlanMode") {
        // Interrupted before an answer: the turn ended, so there's nothing left to approve.
        if (block.resolved && !block.decision) return null;
        return (
          <>
            <ToolApproval
              title="Approve this plan?"
              description={block.decision === "deny" ? "Rejected — say what to change" : undefined}
              status={getPlanStatus(block)}
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
                              ? setIsConfirmingRoot(true)
                              : approvePlan(threadId, block.id, level),
                        },
                      ],
              )}
              denyLabel="Reject"
              onApprove={() => approvePlan(threadId, block.id, "auto-edit")}
              onDeny={() => respondApproval(threadId, block.id, "deny")}
            >
              {/* Radix wraps content in display:table, which lets wide code blocks stretch past the card. */}
              <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-96 [&>[data-slot=scroll-area-viewport]>div]:!block">
                <Markdown className="selectable pr-3 leading-relaxed">{block.detail}</Markdown>
              </ScrollArea>
            </ToolApproval>
            {isConfirmingRoot && host ? (
              <RootFullAccessDialog
                host={host}
                onAllow={() => approvePlan(threadId, block.id, "full-access")}
                onClose={() => setIsConfirmingRoot(false)}
              />
            ) : null}
          </>
        );
      }
      if (block.questions) {
        const { questions, answers } = block;
        return (
          <ApprovalCard
            autoFocus={
              !getDraft(threadId).text.trim() &&
              (document.activeElement === document.body ||
                document.activeElement?.matches("textarea[data-composer]") === true)
            }
            status={
              block.resolved
                ? answers
                  ? "answered"
                  : "skipped"
                : block.decision
                  ? "submitting"
                  : "pending"
            }
            questions={questions.map((question) => ({
              id: question.id,
              title: question.question,
              description: block.agent ? `Asked by ${block.agent}` : undefined,
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
              respondApproval(threadId, block.id, "allow", {
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
              block.resolved || block.decision
                ? undefined
                : () => respondApproval(threadId, block.id, "deny")
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
      if (block.resolved && block.decision !== "deny") return null;
      return (
        <ToolApproval
          tool={block.title}
          title={`Allow ${block.title}${block.agent ? ` for ${block.agent}` : ""}?`}
          status={block.decision === "deny" ? "denied" : block.decision ? "approving" : "pending"}
          defaultOpen
          parameters={[
            {
              id: "input",
              label: "Input",
              value: <ToolApprovalCode code={block.detail} language="bash" />,
            },
          ]}
          onApprove={() => respondApproval(threadId, block.id, "allow")}
          onAlwaysAllow={() => respondApproval(threadId, block.id, "allow-session")}
          onDeny={() => respondApproval(threadId, block.id, "deny")}
        />
      );
    case "error":
      return <div className="selectable text-xs text-destructive">{block.text}</div>;
    case "checkpoint":
      return <CheckpointChip item={block} />;
  }
}
