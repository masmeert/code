import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
} from "@masscode/ui/agents/message";
import { Markdown } from "@masscode/ui/agents/markdown";
import { Reasoning } from "@masscode/ui/agents/reasoning";
import { OrbFace } from "@masscode/ui/agents/orb-face";
import { PromptSelect } from "@masscode/ui/agents/prompt-input";
import { StreamingResponse } from "@masscode/ui/agents/streaming-response";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@masmeert/ui/alert-dialog";
import { ToolCallRow, ToolGroup, type ToolReveal } from "@masscode/ui/agents/tool-group";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { cn } from "@masscode/ui/lib/utils";
import {
  type Attachment,
  ClientCommand,
  type CommandRun,
  MessageSender,
  parseThreadLink,
  type ProviderKind,
  WORKTREE_SETUP_TERMINAL_ID,
} from "@masscode/contracts";
import {
  IconAlertCircle,
  IconArrowBackUp,
  IconArrowsLeftRight,
  IconArrowsMinimize,
  IconCheck,
  IconChevronRight,
  IconFileDiff,
  IconFileText,
  IconGitFork,
  IconGitPullRequest,
  IconMessage,
  IconLoader2,
  IconPhoto,
  IconPlayerStop,
  IconRotate,
  IconSitemap,
  IconX,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import {
  createContext,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { focusComposer, setDraft, toDraftAttachment } from "@/widgets/composer";
import { formatHarnessLabel } from "@/entities/provider";
import { useSettings } from "@/entities/settings";
import { closeTerminal, type RunningCommand } from "@/entities/terminal";
import {
  dismissForkError,
  fetchImageUrl,
  forkThread,
  switchToThread,
  useFileRestoreBlocker,
  useThreadStore,
  useTranscript,
} from "@/entities/thread";
import { openSideChat } from "@/features/side-chat";
import { send } from "@/shared/api";
import { showToast } from "@/shared/ui";
import { PlanApproval, QuestionsApproval, ToolApprovalRequest } from "./approval-blocks.tsx";
import {
  PLAN_APPROVAL_TITLE,
  toTurns,
  toToolGroups,
  toBlocks,
  hasNewestItem,
  hasSameItems,
  type UserItem,
  type MarkerItem,
  type Block,
  type ToolItem,
  describeThought,
  livePhrase,
  summarize,
  type ToolCall,
  type TranscriptItem,
} from "@masscode/client";
import { typeClass } from "@masmeert/ui/lib/type-scale";

const TerminalView = lazy(() =>
  import("./terminal-panel.tsx").then((module) => ({ default: module.TerminalView })),
);

/** Opens the changes panel on one turn; provided by the thread view to the checkpoint chips deep in the transcript. */
export const TurnDiffContext = createContext<(messageId: string) => void>(() => {});

/** The tool call last picked in the running-subagents list, for its group to open and scroll to. */
export const RevealContext = createContext<ToolReveal | null>(null);

/** Hands a shell block's command to the agent as a message; provided by the thread view to its replies. */
export const RunCommandContext = createContext<((command: string) => void) | undefined>(undefined);

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.isImage ? IconPhoto : IconFileText;

  return (
    <span
      title={attachment.path}
      className={cn(
        typeClass("caption"),
        "flex h-7 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-muted-foreground",
      )}
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
        <p
          className={cn(typeClass("caption"), "mt-3 truncate text-muted-foreground")}
          title={attachment.path}
        >
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
  const transcript = useTranscript(threadId);
  // A brand-new thread is live before its first event arrives; only a caught-up one is truly empty.
  const isLoaded = transcript?.status === "live" && transcript.cursor > 0;

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

  if (!hasTurns && isLoaded && !isBusy)
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <IconMessage className="size-5" />
        <p className={typeClass("body")}>No messages in this thread</p>
        <p className={typeClass("caption")}>Write a message below to start the conversation.</p>
      </div>
    );

  // Prompts that can be rewound to, newest last: rewinding to one also removes those after it.
  const prompts = turns.filter((turn) => turn.from === "user" && !turn.item.steer);

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
              laterPrompts={Math.max(0, prompts.length - 1 - prompts.indexOf(turn))}
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
      <div
        className={cn(
          typeClass("caption"),
          "flex h-9 items-center gap-2 border-b border-border pr-1.5 pl-3",
        )}
      >
        <IconLoader2 className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        {isSetup ? (
          <span className="shrink-0 text-muted-foreground">Setting up worktree</span>
        ) : null}
        <code className="min-w-0 flex-1 truncate font-mono text-foreground">{run.command}</code>
        <button
          type="button"
          title={
            isSetup
              ? "Stop setup; queued messages go to the agent now"
              : "Stop it; the agent won't hear about this run"
          }
          onClick={() => closeTerminal(threadId, run.terminalId)}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconPlayerStop className="size-3" />
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
      <div
        className={cn(
          typeClass("caption"),
          "flex h-9 items-center gap-2 border-b border-border px-3",
        )}
      >
        {isStopped ? (
          <IconPlayerStop className="size-3 shrink-0 text-muted-foreground" />
        ) : run.exitCode === 0 ? (
          <IconCheck className="size-3.5 shrink-0 text-success" />
        ) : (
          <IconX className="size-3.5 shrink-0 text-destructive" />
        )}
        {label ? <span className="shrink-0 text-muted-foreground">{label}</span> : null}
        <code className="min-w-0 flex-1 truncate font-mono text-foreground">{run.command}</code>
        {isStopped ? (
          <span className="shrink-0 text-muted-foreground">Stopped</span>
        ) : run.exitCode === 0 ? null : (
          <span className="shrink-0 text-destructive">Exit code {run.exitCode}</span>
        )}
      </div>
      {run.output ? (
        // Reversed, so it opens scrolled to the end, where results and errors are.
        <div className="flex max-h-48 flex-col-reverse overflow-auto">
          <pre
            className={cn(
              typeClass("caption"),
              "m-0 selectable px-3 py-2 font-mono leading-5 whitespace-pre text-foreground",
            )}
          >
            {run.output}
          </pre>
        </div>
      ) : (
        <p className={cn(typeClass("caption"), "px-3 py-2 text-muted-foreground")}>No output</p>
      )}
    </div>
  );
}

const MARKERS: Record<MarkerItem["kind"], { readonly icon: TablerIcon; readonly label: string }> = {
  forked: { icon: IconGitFork, label: "Forked from" },
  startedBy: { icon: IconSitemap, label: "Started by" },
};

/** Where a thread's own conversation starts, with the way to the thread it came from. */
function ThreadMarker({ item }: { item: MarkerItem }) {
  const [threadId, title] =
    item.kind === "forked" ? [item.fromThreadId, item.fromTitle] : [item.byThreadId, item.byTitle];

  const source = useThreadStore((state) => state.threads[threadId]);
  const { icon: Icon, label } = MARKERS[item.kind];

  return (
    <div className={cn(typeClass("caption"), "flex items-center gap-3 py-2 text-muted-foreground")}>
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
    laterPrompts,
  }: {
    item: UserItem;
    threadId: string;
    isBusy: boolean;
    animateIn: boolean;
    laterPrompts: number;
  }) =>
    item.run ? (
      <CommandRunResult run={item.run} />
    ) : (
      <Message from="user" animateIn={animateIn} className="group/turn">
        <MessageContent className="gap-1.5">
          {item.from ? <SenderNote from={item.from} /> : null}
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
          {isBusy || item.steer ? null : (
            <EditFromHere item={item} threadId={threadId} laterPrompts={laterPrompts} />
          )}
        </MessageContent>
      </Message>
    ),
  // `animateIn` is only read on mount, so it flipping once the list settles is no reason to re-render.
  (previous, next) =>
    previous.item === next.item &&
    previous.threadId === next.threadId &&
    previous.isBusy === next.isBusy &&
    previous.laterPrompts === next.laterPrompts,
);

/** An agent's link to a thread, as a way to it under the thread's current title. */
function renderThreadLink(href: string, children: ReactNode) {
  const threadId = parseThreadLink(href);

  return threadId ? <ThreadLink threadId={threadId}>{children}</ThreadLink> : null;
}

function ThreadLink({ threadId, children }: { threadId: string; children: ReactNode }) {
  const thread = useThreadStore((state) => state.threads[threadId]);

  if (!thread) return <span className="text-muted-foreground">{children} (deleted)</span>;

  return (
    <button
      type="button"
      onClick={() => switchToThread(threadId)}
      className="inline-flex items-baseline gap-1 rounded font-medium text-brand underline decoration-brand/40 underline-offset-4 transition-colors outline-none hover:decoration-brand focus-visible:ring-2 focus-visible:ring-ring"
    >
      <IconSitemap className="size-3.5 shrink-0 self-center" />
      {thread.title}
    </button>
  );
}

/** Above a message the user didn't write: who or what sent it. */
function SenderNote({ from }: { from: MessageSender }) {
  return MessageSender.match(from, {
    agent: ({ threadId, title }) => (
      <ThreadSenderNote threadId={threadId} title={title} label="From" />
    ),
    report: ({ threadId, title }) => (
      <ThreadSenderNote threadId={threadId} title={title} label="Report from" />
    ),
    restart: () => (
      <div
        className={cn(
          typeClass("caption"),
          "flex items-center justify-end gap-1.5 text-muted-foreground",
        )}
      >
        <IconRotate className="size-3.5 shrink-0" />
        Sent by MassCode to pick up a turn it cut short
      </div>
    ),
    pullRequest: ({ number, url }) => (
      <div className={cn(typeClass("caption"), "flex justify-end text-muted-foreground")}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconGitPullRequest className="size-3.5 shrink-0" />
          News from pull request #{number}
        </a>
      </div>
    ),
  });
}

/** The thread a message came from, to go to. */
function ThreadSenderNote({
  threadId,
  title,
  label,
}: {
  threadId: string;
  title: string;
  label: string;
}) {
  const source = useThreadStore((state) => state.threads[threadId]);

  return (
    <div className={cn(typeClass("caption"), "flex justify-end text-muted-foreground")}>
      {source ? (
        <button
          type="button"
          onClick={() => switchToThread(threadId)}
          className="flex max-w-full items-center gap-1.5 rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconSitemap className="size-3.5 shrink-0" />
          <span className="truncate">
            {label} {source.title}
          </span>
        </button>
      ) : (
        <span className="flex max-w-full items-center gap-1.5">
          <IconSitemap className="size-3.5 shrink-0" />
          <span className="truncate">
            {label} {title} (deleted)
          </span>
        </span>
      )}
    </div>
  );
}

/** Above a message sent right after switching harness: what the new one was told it missed. */
function HandoffNote({
  handoff,
  to,
}: {
  handoff: NonNullable<UserItem["handoff"]>;
  to: ProviderKind;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const settings = useSettings();

  return (
    <div
      className={cn(typeClass("caption"), "flex flex-col items-end gap-1.5 text-muted-foreground")}
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconArrowsLeftRight className="size-3.5 shrink-0" />
        Gave {formatHarnessLabel(settings, to)} the {handoff.messages}{" "}
        {handoff.messages === 1 ? "message" : "messages"}{" "}
        {formatHarnessLabel(settings, handoff.from)} had
        <IconChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
      </button>
      {isOpen ? (
        <pre
          className={cn(
            typeClass("caption", "compact"),
            "max-h-72 w-full selectable overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono whitespace-pre-wrap",
          )}
        >
          {handoff.text}
        </pre>
      ) : null}
    </div>
  );
}

/** Rewinds to before this message, once confirmed, and puts it back in the composer to edit and resend. */
function EditFromHere({
  item,
  threadId,
  laterPrompts,
}: {
  item: UserItem;
  threadId: string;
  laterPrompts: number;
}) {
  const restoreBlocker = useFileRestoreBlocker(threadId);
  const [choice, setChoice] = useState<"keep" | "files" | null>(null);

  return (
    // Floats below the message, in the gap before the reply, rather than holding a row of its own.
    <div className="relative h-0 w-full">
      <div className="absolute top-0 right-0 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        <PromptSelect
          title="Edit from here"
          icon={<IconArrowBackUp />}
          options={[
            {
              value: "keep",
              label: "Rewind conversation",
              description: "The files stay as they are now",
            },
            {
              value: "files",
              label: "Rewind conversation and files",
              description:
                restoreBlocker ?? "The folder goes back to how it was when this was sent",
              disabled: restoreBlocker !== null,
            },
          ]}
          value={undefined}
          placeholder="Edit from here"
          side="bottom"
          align="end"
          width="w-72"
          variant="plain"
          onChange={(value) => setChoice(value === "files" ? "files" : "keep")}
        />
      </div>
      {choice ? (
        <RewindDialog
          item={item}
          threadId={threadId}
          laterPrompts={laterPrompts}
          restoreFiles={choice === "files"}
          onClose={() => setChoice(null)}
        />
      ) : null}
    </div>
  );
}

/** Says what a rewind removes before it does: there's no undoing it. */
function RewindDialog({
  item,
  threadId,
  laterPrompts,
  restoreFiles,
  onClose,
}: {
  item: UserItem;
  threadId: string;
  laterPrompts: number;
  restoreFiles: boolean;
  onClose: () => void;
}) {
  const rewindButton = useRef<HTMLButtonElement>(null);

  const removed = laterPrompts
    ? `This message, the ${laterPrompts === 1 ? "one" : laterPrompts} after it and every reply`
    : "This message and its replies";

  return (
    <AlertDialog open onOpenChange={(isOpen) => isOpen || onClose()}>
      <AlertDialogContent
        className="gap-4 bg-popover p-4 data-[size=default]:sm:max-w-sm"
        initialFocus={rewindButton}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg",
              restoreFiles
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            <IconArrowBackUp className="size-4" />
          </span>
          <AlertDialogTitle className={typeClass("body")}>
            {restoreFiles ? "Rewind conversation and files?" : "Rewind conversation?"}
          </AlertDialogTitle>
        </div>
        <AlertDialogDescription className={typeClass("caption")}>
          {removed} will be removed from the conversation; the message goes back in the composer to
          edit.{" "}
          {restoreFiles
            ? "The folder goes back to how it was when it was sent: changes made to files since then are lost."
            : "Files stay as they are now."}{" "}
          This can't be undone.
        </AlertDialogDescription>
        <AlertDialogFooter className="flex-row justify-end">
          <AlertDialogCancel size="compact">
            Cancel
            <kbd aria-hidden className={cn(typeClass("micro"), "font-sans text-muted-foreground")}>
              esc
            </kbd>
          </AlertDialogCancel>
          <AlertDialogAction
            ref={rewindButton}
            size="compact"
            onClick={() => {
              // An unsent draft stays, above the restored prompt.
              setDraft(threadId, (draft) => ({
                text: draft.text.trim() ? `${draft.text.trimEnd()}\n\n${item.text}` : item.text,
                attachments: [...draft.attachments, ...item.attachments.map(toDraftAttachment)],
              }));
              send(
                ClientCommand.cases["thread.rewind"].make({
                  threadId,
                  messageId: item.id,
                  restoreFiles,
                }),
              );
              focusComposer();
            }}
          >
            {restoreFiles ? "Rewind and restore files" : "Rewind"}
            <kbd
              aria-hidden
              className={cn(typeClass("micro"), "font-sans text-primary-foreground")}
            >
              ↵
            </kbd>
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
      className={cn(
        typeClass("caption"),
        "flex w-fit items-center gap-2 rounded-lg border border-border px-2.5 py-1 text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <IconFileDiff className="size-3.5" />
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
    const blocks = useMemo(() => toBlocks(items), [items]);
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

/** The work between two messages, folded like thinking: what it's doing now while it streams, what it did once done. */
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
  const folder = useThreadStore((state) => state.threads[threadId]?.cwd);
  const blocks = useMemo(() => toToolGroups(items), [items]);
  const newest = items.at(-1);
  const calls = items.filter((item) => item.kind === "tool");

  // Unknown as soon as one of the thoughts wasn't timed.
  const thoughtMs = items.reduce<number | undefined>(
    (total, item) =>
      item.kind !== "reasoning"
        ? total
        : total === undefined || item.durationMs === undefined
          ? undefined
          : total + item.durationMs,
    0,
  );

  return (
    <Reasoning
      label={calls.length ? summarize(calls) : describeThought(thoughtMs)}
      streaming={streaming}
      live={newest?.kind === "tool" && newest.output === null ? livePhrase(newest) : undefined}
      reveal={calls.some((call) => call.id === reveal?.toolId) ? reveal : null}
    >
      <div className="flex flex-col gap-1">
        {/* A lone tool group would repeat this block's own summary as a second header. */}
        {blocks.length === 1 && blocks[0]!.kind === "tools"
          ? blocks[0]!.calls.map((call) => (
              <ToolCallRow key={call.id} call={call} live={live} reveal={reveal} folder={folder} />
            ))
          : blocks.map((block) => (
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
  function AgentBlock({ block, threadId, live, streaming, showActions }: AgentBlockProps) {
    switch (block.kind) {
      case "user":
        return null;
      case "assistant":
        return (
          <AssistantReply
            item={block}
            threadId={threadId}
            live={live}
            streaming={streaming}
            showActions={showActions}
          />
        );
      case "reasoning":
        return (
          <Reasoning label={describeThought(block.durationMs)} streaming={streaming}>
            <Markdown
              streaming={streaming}
              renderLink={renderThreadLink}
              className="selectable leading-relaxed"
            >
              {block.text}
            </Markdown>
          </Reasoning>
        );
      case "work":
        return (
          <WorkBlock items={block.items} threadId={threadId} live={live} streaming={streaming} />
        );
      case "tools":
        return <RevealableToolGroup calls={block.calls} live={live} threadId={threadId} />;
      case "approval":
        if (block.title === PLAN_APPROVAL_TITLE)
          return <PlanApproval threadId={threadId} item={block} />;

        if (block.questions) {
          return <QuestionsApproval threadId={threadId} item={block} questions={block.questions} />;
        }

        return <ToolApprovalRequest threadId={threadId} item={block} />;
      case "error":
        return <AgentError item={block} />;
      case "stopped":
        return (
          <div
            className={cn(typeClass("caption"), "flex items-center gap-1.5 text-muted-foreground")}
          >
            <IconPlayerStop className="size-3.5 shrink-0" />
            Stopped
          </div>
        );
      case "checkpoint":
        return <CheckpointChip item={block} />;
      case "compacted":
        return (
          <div
            className={cn(typeClass("caption"), "flex items-center gap-1.5 text-muted-foreground")}
          >
            <IconArrowsMinimize className="size-3.5 shrink-0" />
            Compacted while idle, before the prompt cache expired ({Math.round(block.tokens / 1000)}
            K tokens)
          </div>
        );
    }
  },
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

/** Opens and scrolls to the call last picked in the running-subagents list. */
function RevealableToolGroup({
  calls,
  live,
  threadId,
}: {
  calls: ReadonlyArray<ToolItem>;
  live: boolean;
  threadId: string;
}) {
  return (
    <ToolGroup
      calls={calls satisfies ReadonlyArray<ToolCall>}
      live={live}
      reveal={use(RevealContext)}
      folder={useThreadStore((state) => state.threads[threadId]?.cwd)}
    />
  );
}

/** What went wrong, in words, with the raw error a click away. */
function AgentError({ item }: { item: Extract<TranscriptItem, { kind: "error" }> }) {
  const [isShowingDetail, setIsShowingDetail] = useState(false);

  return (
    <div
      className={cn(
        typeClass("body"),
        "flex w-full gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5",
      )}
    >
      <IconAlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="selectable text-foreground">{item.text}</p>
        {item.detail ? (
          <>
            <button
              type="button"
              aria-expanded={isShowingDetail}
              onClick={() => setIsShowingDetail(!isShowingDetail)}
              className={cn(
                typeClass("caption"),
                "mt-1 inline-flex items-center gap-1 rounded text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              Details
              <IconChevronRight
                className={cn("size-3.5 transition-transform", isShowingDetail && "rotate-90")}
              />
            </button>
            {isShowingDetail ? (
              <pre
                className={cn(
                  typeClass("caption"),
                  "mt-1.5 max-h-48 selectable overflow-auto rounded-lg bg-muted/60 p-2 font-mono whitespace-pre-wrap text-muted-foreground",
                )}
              >
                {item.detail}
              </pre>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The agent's text, with copy, fork and side-question actions once it's done. */
function AssistantReply({
  item,
  threadId,
  live,
  streaming,
  showActions,
}: {
  item: Extract<TranscriptItem, { kind: "assistant" }>;
  threadId: string;
  live: boolean;
  streaming: boolean;
  showActions: boolean;
}) {
  const fork = useThreadStore((state) =>
    state.forking?.messageId === item.id ? state.forking : null,
  );

  const forkError = fork?.error ?? null;
  const runReplyCommand = use(RunCommandContext);

  // The fork opens in place of this view; when it can't, the reason shows here instead.
  useEffect(() => {
    if (!forkError) return;
    showToast({ title: "Couldn't fork this thread", description: forkError, status: "error" });
    dismissForkError();
  }, [forkError]);

  const resolveImage = useCallback((src: string) => fetchImageUrl(threadId, src), [threadId]);

  return (
    <MessageBubble variant="ghost" className="w-full">
      <MessageBubbleContent>
        <StreamingResponse
          status={streaming ? "streaming" : "complete"}
          copyText={item.text}
          onFork={live ? undefined : () => forkThread(threadId, item.id)}
          forking={fork !== null && fork.error === null}
          onAskAside={() => openSideChat(threadId, item.id)}
          showActions={showActions}
          showFeedback={false}
        >
          <Markdown
            streaming={streaming}
            onRunCommand={runReplyCommand}
            resolveImage={resolveImage}
            renderLink={renderThreadLink}
            className="selectable leading-relaxed"
          >
            {item.text}
          </Markdown>
        </StreamingResponse>
      </MessageBubbleContent>
    </MessageBubble>
  );
}
