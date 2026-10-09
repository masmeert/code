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
import { categoryOf, type ToolReveal } from "@masscode/ui/agents/tool-group";
import { ClientCommand, isTurnActive, type QueuedMessage } from "@masscode/contracts";
import { FileDiff, FolderTree } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toggleBrowser, useBrowser } from "../lib/browser.ts";
import { toggleSimulator, useSimulator } from "../lib/simulator.ts";
import { toTurnOptions, useTurnPrefs } from "../lib/composer.ts";
import { focusComposer } from "../lib/drafts.ts";
import { useKeybinding } from "../lib/keybindings.ts";
import { TranscriptFind } from "./TranscriptFind.tsx";
import {
  type ReviewComment,
  takeReviewComments,
  useReviewComments,
  buildReviewMessage,
} from "../lib/reviewComments.ts";
import {
  findCatalogModel,
  decodeChoice,
  findDefaultModel,
  encodeChoice,
  formatHarnessLabel,
  buildModelChoices,
} from "../lib/models.ts";
import {
  openSideChat,
  askSideChat,
  loadOlder,
  markSeen,
  queueMessage,
  runCommand,
  type RunningCommand,
  send,
  sendQueuedNow,
  takeQueued,
  toggleTerminalPanel,
  useProviders,
  useStore,
  useThreadHost,
  useTranscript,
} from "../lib/store.ts";
import { readWidth } from "@masscode/ui/hooks/use-resizable";
import { DIFF_PANEL_WIDTH_KEY, getDefaultDiffPanelWidth } from "../lib/diffPanel.ts";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { SimulatorPanel } from "./SimulatorPanel.tsx";
import { Composer } from "./Composer.tsx";
import { GitMenu } from "./GitMenu.tsx";
import { NO_ITEMS, isShowingWork, type ToolItem } from "../lib/transcriptBlocks.ts";
import { PanelsMenu, ScriptsMenu, ThreadHeader } from "./ThreadHeader.tsx";
import {
  TurnDiffContext,
  RevealContext,
  RunCommandContext,
  TurnList,
  RunningCommandWindow,
} from "./Transcript.tsx";
import {
  returnToComposer,
  QueuedFollowUp,
  LimitStopNotice,
  ReviewCommentRow,
  RunningAgents,
} from "./ComposerTray.tsx";
import { SideChatDrawer } from "./SideChatDrawer.tsx";
import { QuoteSelection } from "./QuoteSelection.tsx";

// Loaded on first open, keeping the diff renderer out of startup.
const DiffPanel = lazy(() =>
  import("./DiffPanel.tsx").then((module) => ({ default: module.DiffPanel })),
);
const TerminalPanel = lazy(() =>
  import("./TerminalPanel.tsx").then((module) => ({ default: module.TerminalPanel })),
);
const NO_QUEUE: ReadonlyArray<QueuedMessage> = [];
const NO_RUNS: ReadonlyArray<RunningCommand> = [];

export const ThreadView = memo(function ThreadView({ threadId }: { threadId: string }) {
  const info = useStore((state) => state.threads[threadId])!;
  // Loaded on open: from the local cache first, then caught up by the daemon.
  const transcript = useTranscript(threadId);
  const items = transcript?.items ?? NO_ITEMS;
  const host = useThreadHost(threadId);
  const providers = useProviders(host);
  const settings = useStore((state) => state.settings);
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
  const project = useStore((state) =>
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

  const followUps = useStore((state) => state.threads[threadId]?.queue) ?? NO_QUEUE;
  const followUpMode = useStore((state) => state.settings.followUp ?? "queue");
  const [{ effort, fast, permission }] = useTurnPrefs(threadId, provider, host);
  // The turn its output starts runs at the composer's effort and permission level.
  const runReplyCommand = useCallback(
    (command: string) =>
      runCommand(threadId, command, toTurnOptions({ effort, fast, permission }, catalog, [])),
    [threadId, effort, fast, permission, catalog],
  );

  const runs = useStore((state) => state.runs[threadId]) ?? NO_RUNS;

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
    (count, item) => (item.kind === "tool" && item.output !== null ? count + 1 : count),
    0,
  );
  const diffKey = `${status}:${info.updatedAt}:${finishedTools}`;

  const activeTerminal = useStore((state) => state.activeTerminals[threadId]);
  useKeybinding("terminal.toggle", () => {
    toggleTerminalPanel(threadId);
    if (activeTerminal) focusComposer();
  });

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
        <div ref={scrollArea} className="relative flex min-h-0 min-w-95 flex-1 flex-col">
          <ThreadHeader
            project={
              project ?? { id: info.projectId, name: info.cwd.split("/").at(-1) ?? info.cwd }
            }
            title={info.title}
            badge={
              info.worktree ? (
                <span
                  title={`Worktree: ${info.cwd}`}
                  className="flex max-w-40 min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground [-webkit-app-region:no-drag]"
                >
                  <FolderTree className="size-3 shrink-0" />
                  <span className="truncate">{info.branch ?? "worktree"}</span>
                </span>
              ) : null
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
                  <button
                    type="button"
                    title={isDiffOpen ? "Hide changes" : "Show changes"}
                    aria-label={isDiffOpen ? "Hide changes" : "Show changes"}
                    aria-pressed={isDiffOpen}
                    onClick={() => {
                      setIsDiffOpen(!isDiffOpen);
                      setDiffTurn(null);
                    }}
                    className={`grid size-7 place-items-center rounded-lg transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${isDiffOpen ? "bg-muted/60 text-foreground" : "text-muted-foreground"}`}
                  >
                    <FileDiff className="size-4" />
                  </button>
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
                    <div className="flex h-7 items-center text-sm">
                      <ReasoningText variant="scramble" className="min-w-0 font-mono font-normal" />
                    </div>
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
                <PromptInputTray open={followUps.length > 0 || reviewComments.length > 0}>
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
                </PromptInputTray>
              </>
            }
            models={choices}
            model={modelChoice}
            onModelChange={(value) =>
              send(
                ClientCommand.cases["thread.setModel"].make({ threadId, ...decodeChoice(value) }),
              )
            }
            placeholder={
              isBusy
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
              if (isBusy && !steer) queueMessage(threadId, text, options);
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
        {isDiffOpen ? (
          <Suspense
            fallback={
              <div
                style={{
                  width: readWidth(DIFF_PANEL_WIDTH_KEY, getDefaultDiffPanelWidth()),
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
              onClose={() => setIsDiffOpen(false)}
            />
          </Suspense>
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
});
