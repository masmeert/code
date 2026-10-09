import { Fold } from "@masscode/ui/motion/fold";
import { livePhrase, summarize, ToolCallRow } from "@masscode/ui/agents/tool-group";
import { cn } from "@masscode/ui/lib/utils";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@masscode/ui/components/dropdown-menu";
import {
  ClientCommand,
  type LimitStop,
  type ProviderKind,
  type ProviderStatus,
  type QueuedMessage,
  type Settings,
  type TurnOptions,
} from "@masscode/contracts";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownRight,
  Gauge,
  MessageSquare,
  Play,
  Pencil,
  Square,
  X,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { appendToDraft, focusComposer } from "../lib/drafts.ts";
import { formatKeybinding } from "../lib/keybindings.ts";
import { describeRange, removeReviewComment, type ReviewComment } from "../lib/reviewComments.ts";
import { useNow } from "../lib/time.ts";
import { formatResetLabel } from "./UsageMeter.tsx";
import { formatHarnessLabel } from "../lib/models.ts";
import { send, sendQueuedNow, takeQueued } from "../lib/store.ts";
import { type ToolItem } from "../lib/transcriptBlocks.ts";

/** Held messages go back into the composer, after whatever is there. */
export function returnToComposer(threadId: string, queued: ReadonlyArray<QueuedMessage>) {
  if (!queued.length) return;
  appendToDraft(threadId, queued.map((message) => message.text).join("\n\n"));
  focusComposer();
}

/** A message waiting for the turn to end: sends by itself then, or steers it now, or goes back to the composer. */
export function QueuedFollowUp({
  threadId,
  followUp,
  isNext,
}: {
  threadId: string;
  followUp: QueuedMessage;
  /** First in line: it goes out at the next boundary, and the steer shortcut sends it. */
  isNext: boolean;
}) {
  return (
    <div
      className="flex h-8 items-center gap-2 pl-1.5"
      title={
        isNext
          ? "Sends after the next tool call, or when the turn ends"
          : "Sends after the messages above it"
      }
    >
      <CornerDownRight className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
        {followUp.text}
      </span>
      {followUp.attachments.length ? (
        <span className="shrink-0">
          {followUp.attachments.length} file
          {followUp.attachments.length === 1 ? "" : "s"}
        </span>
      ) : null}
      <button
        type="button"
        title={`Send now, into the running turn${isNext ? ` (${formatKeybinding("composer.steerQueued")})` : ""}`}
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
}

/** A usage limit stopped the thread and holds its queue: when it resets, and the ways to carry on. */
export function LimitStopNotice({
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
  const isWaitingForReset = stop.resetsAt !== null && stop.resetsAt > now;
  const others = providers.filter(
    (other) => other.linked && other.kind !== stop.provider && other.kind !== provider,
  );

  return (
    <div role="status" className="pb-1.5">
      <div className="flex h-8 items-center gap-2 pl-1.5">
        <Gauge className="size-3.5 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
          {formatHarnessLabel(settings, stop.provider)} hit its usage limit
          {stop.resetsAt === null ? null : (
            <span className="ml-1 text-muted-foreground">
              {" "}
              {isWaitingForReset ? formatResetLabel(stop.resetsAt, now) : "It has reset"}
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
          title={`Continue with ${formatHarnessLabel(settings, provider)} now`}
          onClick={() =>
            send(ClientCommand.cases["thread.resumeAfterLimit"].make({ threadId, options }))
          }
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Play className="size-3.5" />
          Resume
        </button>
        {isWaitingForReset ? (
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
                    {formatHarnessLabel(settings, other.kind)}
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
export function ReviewCommentRow({
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

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** Latest calls a subagent row unfolds to; older ones are a jump to the chat away. */
const RECENT_AGENT_CALLS = 5;

/** Subagents still at work, above the composer: what each is doing, its latest calls, a jump to its row, and a stop button. */
export function RunningAgents({
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
  const [isOpen, setIsOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(1000);
  const listId = useId();
  // Beyond two, the rows fold into one summary so the tray stays short.
  const isGrouped = agents.length > 2;

  function describeAgentActivity(agent: ToolItem) {
    if (stopping.has(agent.id)) return "Stopping…";
    if (agent.progress !== undefined) return agent.progress;
    const last = agent.children?.at(-1);
    if (!last) return "Starting…";
    return last.output === null ? livePhrase(last) : summarize([last]);
  }

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !isOpen) return;
        event.stopPropagation();
        setIsOpen(false);
      }}
    >
      {isGrouped ? (
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={listId}
          onClick={() => setIsOpen(!isOpen)}
          className="flex h-8 w-full items-center gap-2 rounded-md pl-1.5 text-left transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
          </span>
          <span className="flex-1 text-[13px] text-foreground/80">
            {agents.length} subagents running
          </span>
          <ChevronRight
            className={cn("mr-2 size-3.5 transition-transform duration-200", isOpen && "rotate-90")}
          />
        </button>
      ) : null}
      <Fold open={!isGrouped || isOpen}>
        <ul id={listId}>
          {agents.map((agent) => {
            const calls = agent.children ?? [];
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
                    <span className="truncate">{describeAgentActivity(agent)}</span>
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
