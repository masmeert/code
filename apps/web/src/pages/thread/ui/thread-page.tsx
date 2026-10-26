import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageScroller,
} from "@masscode/ui/agents/message";
import { ReasoningText } from "@masscode/ui/agents/loading-states/reasoning-text";
import { OrbFace } from "@masscode/ui/agents/orb-face";
import { PromptInputTray } from "@masscode/ui/agents/prompt-input";
import { categoryOf } from "@masscode/client";
import { type ToolReveal } from "@masscode/ui/agents/tool-group";
import {
  ClientCommand,
  isTurnActive,
  type QueuedMessage,
  type ThreadInfo,
} from "@masscode/contracts";
import { IconBinaryTree, IconEye, IconFileDiff } from "@tabler/icons-react";
import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toggleBrowser, useBrowser } from "@/entities/browser";
import { toggleSimulator, useSimulator } from "@/entities/simulator";
import { Composer, focusComposer, toTurnOptions, useTurnPrefs } from "@/widgets/composer";
import { formatKeybinding, useKeybinding } from "@/shared/lib/keybindings";
import { TranscriptFind } from "./transcript-find.tsx";
import {
  type ReviewComment,
  takeReviewComments,
  useReviewComments,
  buildReviewMessage,
} from "../model/review-comments.ts";
import { holdMessage, isThreadHostConnected, useHeldMessages } from "../model/held-messages.ts";
import { findDefaultModel } from "@masscode/client";
import {
  buildModelChoices,
  decodeChoice,
  encodeChoice,
  findCatalogModel,
  formatHarnessLabel,
  useProviders,
} from "@/entities/provider";
import { buildFallbackProject, useProjectStore } from "@/entities/project";
import { useIsHostConnected } from "@/entities/host";
import { useSetting, useSettings } from "@/entities/settings";
import {
  runCommand,
  type RunningCommand,
  toggleTerminalPanel,
  useTerminalStore,
} from "@/entities/terminal";
import {
  loadOlder,
  markSeen,
  queueMessage,
  sendQueuedNow,
  takeQueued,
  useThreadHost,
  useThreadStore,
  useTranscript,
} from "@/entities/thread";
import { askSideChat, openSideChat } from "@/features/side-chat";
import { send } from "@/shared/api";
import { readWidth } from "@masmeert/ui/hooks/use-resizable";
import { DIFF_PANEL_WIDTH_KEY, getDefaultDiffPanelWidth } from "../lib/diff-panel-width.ts";
import { BrowserPanel } from "./browser-panel.tsx";
import { SimulatorPanel } from "./simulator-panel.tsx";
import { GitMenu } from "./git-menu.tsx";
import { NO_ITEMS, isShowingWork, type ToolItem } from "@masscode/client";
import { PanelsMenu, ScriptsMenu, ThreadHeader } from "@/widgets/thread-header";
import {
  TurnDiffContext,
  RevealContext,
  RunCommandContext,
  TurnList,
  RunningCommandWindow,
} from "./transcript.tsx";
import {
  returnToComposer,
  HeldMessageRow,
  QueuedFollowUp,
  LimitStopNotice,
  ReviewCommentRow,
  RunningAgents,
} from "./composer-tray.tsx";
import { SideChatDrawer } from "./side-chat-drawer.tsx";
import { QuoteSelection } from "./quote-selection.tsx";
import { ErrorBoundary, IconButton } from "@/shared/ui";
import { ErrorDetails, PanelAction, PanelMessage } from "./panel-message.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() =>
  import("./diff-panel.tsx").then((module) => ({ default: module.DiffPanel })),
);

const TerminalPanel = lazy(() =>
  import("./terminal-panel.tsx").then((module) => ({
    default: module.TerminalPanel,
  })),
);

const NO_QUEUE: ReadonlyArray<QueuedMessage> = [];

const NO_RUNS: ReadonlyArray<RunningCommand> = [];

/** Renders nothing once the thread is gone, say deleted while on screen. */
export const ThreadPage = memo(function ThreadPage({ threadId }: { threadId: string }) {
  const info = useThreadStore((state) => state.threads[threadId]);

  return info ? <ThreadView threadId={threadId} info={info} /> : null;
});

/** The changes panel's room before it has loaded, or after it failed: the width it last had. */
function DiffPanelFrame({ children }: { children?: ReactNode }) {
  return (
    <aside
      aria-label="Changes"
      style={{ width: readWidth(DIFF_PANEL_WIDTH_KEY, getDefaultDiffPanelWidth()) }}
      className="flex max-w-[max(calc(100%_-_380px),50%)] min-w-[min(320px,50%)] shrink flex-col border-l border-border bg-background"
    >
      {children}
    </aside>
  );
}

function ThreadView({ threadId, info }: { threadId: string; info: ThreadInfo }) {
  // Loaded on open: from the local cache first, then caught up by the daemon.
  const transcript = useTranscript(threadId);
  const items = transcript?.items ?? NO_ITEMS;
  const host = useThreadHost(threadId);
  const providers = useProviders(host);
  const settings = useSettings();
  const { status, provider } = info;
  const isBusy = isTurnActive(status);
  // Another harness's model switches the thread to it, which waits for the turn to end.
  const choices = buildModelChoices(providers, settings, isBusy ? provider : undefined);
  const current = info.model ?? findDefaultModel(providers, settings, provider);
  const modelChoice = current ? encodeChoice(provider, current) : undefined;
  const catalog = findCatalogModel(providers, modelChoice);
  const lastItem = items.at(-1);

  // `/btw` asks about the newest reply whose turn is over.
  const runningTurnStart = isBusy
    ? items.findLastIndex((item) => item.kind === "user" && !item.steer)
    : items.length;

  const asideReplyId = items.findLast(
    (item, index) => index < runningTurnStart && item.kind === "assistant",
  )?.id;

  const [reveal, setReveal] = useState<ToolReveal | null>(null);

  const runningAgents = isBusy
    ? items.filter(
        (item): item is ToolItem =>
          item.kind === "tool" && categoryOf(item.name) === "agent" && item.output === null,
      )
    : [];

  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === info.projectId),
  );

  // Per thread: each thread has its own view, kept while you switch away and back.
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  // Null shows all uncommitted changes; a message id shows just what that turn changed.
  const [diffTurn, setDiffTurn] = useState<string | null>(null);

  const openTurnDiff = useCallback((messageId: string) => {
    setDiffTurn(messageId);
    setIsDiffOpen(true);
  }, []);

  // A rewind can take the turn on show with it.
  const isDiffTurnGone =
    diffTurn !== null &&
    transcript?.status === "live" &&
    !items.some((item) => item.id === diffTurn);

  useEffect(() => {
    if (isDiffTurnGone) setDiffTurn(null);
  }, [isDiffTurnGone]);

  const reviewComments = useReviewComments(threadId);
  const [revealedComment, setRevealedComment] = useState<ReviewComment | null>(null);
  const clearRevealedComment = useCallback(() => setRevealedComment(null), []);

  const scrollArea = useRef<HTMLDivElement>(null);

  // Set on the element rather than through state, so typing that grows the composer doesn't re-render the thread.
  const observeComposer = useCallback((node: HTMLDivElement) => {
    const observer = new ResizeObserver(() =>
      scrollArea.current?.style.setProperty("--composer-height", `${node.offsetHeight}px`),
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  const isHostConnected = useIsHostConnected(host);
  const heldMessages = useHeldMessages(threadId);

  const followUps = useThreadStore((state) => state.threads[threadId]?.queue) ?? NO_QUEUE;
  const followUpMode = useSetting((settings) => settings.followUp ?? "queue");
  const [{ effort, fast, permission }] = useTurnPrefs(threadId, provider, host);

  // The turn its output starts runs at the composer's effort and permission level.
  const runReplyCommand = useCallback(
    (command: string) =>
      runCommand(threadId, command, toTurnOptions({ effort, fast, permission }, catalog, [])),
    [threadId, effort, fast, permission, catalog],
  );

  const runs = useTerminalStore((state) => state.runs[threadId]) ?? NO_RUNS;

  // Leaves the draft alone, and waits while the agent needs an approval or an answer.
  useKeybinding(
    followUps[0] && status === "running" ? "composer.steerQueued" : undefined,
    () => followUps[0] && sendQueuedNow(threadId, followUps[0].id),
  );

  const history = useMemo(
    () => items.flatMap((item) => (item.kind === "user" && item.text ? [item.text] : [])),
    [items],
  );

  const transcriptViewport = useRef<HTMLElement>(null);

  // Re-read the diff whenever a tool finishes or a turn ends: either may have changed files.
  const finishedTools = items.reduce(
    (count, item) => (item.kind === "tool" && item.output !== null ? count + 1 : count),
    0,
  );

  const diffKey = `${status}:${info.updatedAt}:${finishedTools}`;

  const activeTerminal = useTerminalStore((state) => state.activeTerminals[threadId]);
  useKeybinding("terminal.toggle", () => {
    toggleTerminalPanel(threadId);

    if (activeTerminal) focusComposer();
  });

  function toggleDiff() {
    if (isDiffOpen) focusComposer();
    setIsDiffOpen(!isDiffOpen);
    setDiffTurn(null);
  }

  useKeybinding("diff.toggle", toggleDiff);

  const isBrowserOpen = useBrowser((state) => state.threads[threadId]?.open ?? false);
  useKeybinding(window.desktop ? "browser.toggle" : undefined, () => toggleBrowser(threadId));

  // Simulators run on this Mac only; a remote thread's agent couldn't reach them.
  const isSimulatorAvailable =
    window.desktop !== undefined && host === null && navigator.userAgent.includes("Mac");

  const isSimulatorOpen = useSimulator(threadId).open;
  useKeybinding(isSimulatorAvailable ? "simulator.toggle" : undefined, () =>
    toggleSimulator(threadId),
  );

  // Looking at a thread marks whatever it did since you last saw it as seen.
  const { updatedAt } = info;
  useEffect(() => {
    function markSeenIfFocused() {
      if (document.hasFocus()) markSeen(threadId);
    }

    markSeenIfFocused();
    window.addEventListener("focus", markSeenIfFocused);

    return () => window.removeEventListener("focus", markSeenIfFocused);
  }, [threadId, updatedAt]);

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollArea}
          className="relative flex min-h-0 min-w-[min(380px,50%)] flex-1 flex-col"
        >
          <ThreadHeader
            project={project ?? buildFallbackProject(info.projectId, info.cwd)}
            title={info.title}
            badge={
              <>
                {info.worktree ? (
                  <span
                    title={`Worktree: ${info.cwd}`}
                    className="flex max-w-40 min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground [-webkit-app-region:no-drag]"
                  >
                    <IconBinaryTree className="size-3 shrink-0" />
                    <span className="truncate">{info.branch ?? "worktree"}</span>
                  </span>
                ) : null}
                {info.pullRequest ? (
                  <a
                    href={info.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Watching #${info.pullRequest.number} "${info.pullRequest.title}": new reviews, comments and failing checks wake the agent`}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:text-foreground"
                  >
                    <IconEye className="size-3 shrink-0" />#{info.pullRequest.number}
                  </a>
                ) : null}
              </>
            }
            actions={
              <>
                <GitMenu
                  cwd={info.cwd}
                  refreshKey={diffKey}
                  threadId={threadId}
                  isWorktree={info.worktree}
                />
                <span className="flex items-center gap-0.5">
                  {project ? (
                    <ScriptsMenu threadId={threadId} host={host} path={project.path} />
                  ) : null}
                  <IconButton
                    label={`${isDiffOpen ? "Hide" : "Show"} changes (${formatKeybinding("diff.toggle")})`}
                    isActive={isDiffOpen}
                    onClick={toggleDiff}
                  >
                    <IconFileDiff className="size-4" />
                  </IconButton>
                  <PanelsMenu threadId={threadId} isSimulatorAvailable={isSimulatorAvailable} />
                </span>
              </>
            }
          />
          <QuoteSelection container={scrollArea} threadId={threadId} />
          <SideChatDrawer threadId={threadId} provider={provider} />
          <TranscriptFind scope={transcriptViewport} />
          <MessageScroller
            busy={isBusy}
            navigation="rail"
            viewportRef={transcriptViewport}
            className="min-h-0 flex-1"
            viewportClassName="@container px-3 py-5 sm:px-5 [&_*::highlight(find)]:bg-brand/25 [&_*::highlight(find-active)]:bg-primary [&_*::highlight(find-active)]:text-primary-foreground"
            contentClassName="mx-auto min-h-full w-full max-w-3xl"
          >
            <MessageGroup spacing="default">
              {transcript?.page?.hasMore ? (
                <button
                  type="button"
                  onClick={() => loadOlder(threadId)}
                  disabled={transcript.loadingOlder}
                  className={cn(
                    typeClass("caption"),
                    "mx-auto rounded-lg px-3 py-1 text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  )}
                >
                  {transcript.loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              ) : null}
              <TurnDiffContext value={openTurnDiff}>
                <RevealContext value={reveal}>
                  <RunCommandContext value={runReplyCommand}>
                    <TurnList items={items} threadId={threadId} isBusy={isBusy} />
                  </RunCommandContext>
                  {runs.map((run) => (
                    <RunningCommandWindow key={run.terminalId} threadId={threadId} run={run} />
                  ))}
                </RevealContext>
              </TurnDiffContext>

              {status === "running" && !isShowingWork(items) ? (
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
                    {/* Styled like a streaming work row, which takes its place once the agent's first output arrives. */}
                    <div className={cn(typeClass("body"), "flex h-7 items-center")}>
                      <ReasoningText variant="swap" className="min-w-0 font-normal" />
                    </div>
                  </MessageContent>
                </Message>
              ) : null}
            </MessageGroup>
            {/* The composer floats over the transcript's end; this keeps the last message clear of it. */}
            <div aria-hidden className="h-(--composer-height)" />
          </MessageScroller>

          <div ref={observeComposer} className="pointer-events-none absolute inset-x-0 bottom-0">
            <Composer
              prefsKey={threadId}
              threadId={threadId}
              history={history}
              provider={provider}
              cwd={info.cwd}
              isBusy={isBusy}
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
                        options={toTurnOptions({ effort, fast, permission }, catalog, [])}
                      />
                    ) : null}
                  </PromptInputTray>
                  <PromptInputTray
                    open={
                      followUps.length > 0 || reviewComments.length > 0 || heldMessages.length > 0
                    }
                  >
                    {reviewComments.map((comment) => (
                      <ReviewCommentRow
                        key={comment.id}
                        threadId={threadId}
                        comment={comment}
                        onReveal={() => {
                          setIsDiffOpen(true);
                          setRevealedComment(comment);
                        }}
                      />
                    ))}
                    {followUps.map((followUp, index) => (
                      <QueuedFollowUp
                        key={followUp.id}
                        threadId={threadId}
                        followUp={followUp}
                        isNext={index === 0}
                      />
                    ))}
                    {heldMessages.map((message) => (
                      <HeldMessageRow key={message.id} threadId={threadId} message={message} />
                    ))}
                  </PromptInputTray>
                </>
              }
              models={choices}
              model={modelChoice}
              onModelChange={(value) =>
                send(
                  ClientCommand.cases["thread.setModel"].make({
                    threadId,
                    ...decodeChoice(value),
                  }),
                )
              }
              placeholder={
                !isHostConnected
                  ? "Reconnecting… messages send once MassCode is back"
                  : isBusy
                    ? followUpMode === "queue"
                      ? "Queue a follow-up (⌘↩ to send now)"
                      : `Steer ${formatHarnessLabel(settings, provider)} (⌘↩ to queue)`
                    : `Ask ${formatHarnessLabel(settings, provider)}…`
              }
              hasPendingContent={reviewComments.length > 0}
              onSubmit={(typed, options, how) => {
                const text = buildReviewMessage(takeReviewComments(threadId), typed);
                // While the agent works, a message waits for the turn to end, or steers it; ⌘Enter flips that.
                const steer = (followUpMode === "steer") !== how.alternate;

                if (!isThreadHostConnected(threadId))
                  holdMessage({ threadId, text, options, queue: isBusy && !steer });
                else if (isBusy && !steer) queueMessage(threadId, text, options);
                else
                  send(
                    ClientCommand.cases["thread.send"].make({
                      threadId,
                      text,
                      options,
                    }),
                  );
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
        </div>
        {isDiffOpen ? (
          <ErrorBoundary
            fallback={(error, retry) => (
              <DiffPanelFrame>
                <PanelMessage>
                  <span>
                    Something went wrong showing the changes. Try again, or close the panel.
                  </span>
                  <span className="flex gap-2">
                    <PanelAction onClick={retry}>Try again</PanelAction>
                    <PanelAction onClick={() => setIsDiffOpen(false)}>Close</PanelAction>
                  </span>
                  <ErrorDetails>{error.message}</ErrorDetails>
                </PanelMessage>
              </DiffPanelFrame>
            )}
          >
            <Suspense fallback={<DiffPanelFrame />}>
              <DiffPanel
                threadId={threadId}
                cwd={info.cwd}
                refreshKey={diffKey}
                turn={diffTurn ? { threadId, messageId: diffTurn } : null}
                reveal={revealedComment}
                onRevealed={clearRevealedComment}
                onShowAll={() => setDiffTurn(null)}
                onClose={() => setIsDiffOpen(false)}
              />
            </Suspense>
          </ErrorBoundary>
        ) : null}
        {isBrowserOpen && window.desktop ? <BrowserPanel threadId={threadId} /> : null}
        {isSimulatorOpen && isSimulatorAvailable ? <SimulatorPanel threadId={threadId} /> : null}
      </div>
      {activeTerminal ? (
        <Suspense fallback={null}>
          <TerminalPanel threadId={threadId} activeTerminal={activeTerminal} />
        </Suspense>
      ) : null}
    </>
  );
}
