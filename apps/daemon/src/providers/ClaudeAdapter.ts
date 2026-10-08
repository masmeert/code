/**
 * Claude Code via the official Agent SDK, driving the user's installed `claude`
 * binary so it runs on their own login (subscription or API key).
 */
import {
  forkSession,
  getSessionMessages,
  query,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeEvent,
  type Effort,
  type PermissionLevel,
  type UserQuestion,
} from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  IMAGE_TYPES,
  ProviderError,
  summarizeToolInput,
  textWithFiles,
  type ForkInput,
  type ProviderAdapter,
  type ProviderSession,
  type ProviderSkill,
  type StartSessionInput,
  type TurnInput,
} from "./ProviderAdapter.ts";
import { claudeExtraArgs, harnessLaunch, promptlessQuery } from "./launch.ts";
import { DEVICES_SUPPORTED } from "../devices.ts";
import { skillMentions } from "../skills.ts";

/** Minimal push-based async iterable used as the SDK's streaming prompt input. */
const makeInbox = <A>() => {
  const buffer: Array<A> = [];
  let wake: (() => void) | undefined;
  let done = false;
  const iterable: AsyncIterable<A> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
  return {
    iterable,
    push: (value: A) => {
      buffer.push(value);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
  };
};

interface PendingApproval {
  readonly toolName: string;
  readonly input: Parameters<CanUseTool>[1];
  readonly suggestions: Array<PermissionUpdate> | undefined;
  /** Set for AskUserQuestion, whose "approval" is the user's answers. */
  readonly questions: ReadonlyArray<UserQuestion> | undefined;
  readonly resolve: (result: PermissionResult) => void;
}

const decodeAskUserQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        question: Schema.String,
        header: Schema.String,
        multiSelect: Schema.optional(Schema.Boolean),
        options: Schema.Array(
          Schema.Struct({
            label: Schema.String,
            description: Schema.optional(Schema.String),
            preview: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
);

const fail = (message: string) => new ProviderError({ provider: "claude", message });

const PERMISSION_MODE = {
  plan: "plan",
  ask: "default",
  "auto-edit": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
} as const satisfies Record<PermissionLevel, PermissionMode>;

/** Claude has no "minimal" or "ultra", so they take the nearest level; its two modes aren't levels. */
const toEffortLevel = (effort: Effort): EffortLevel | null =>
  effort === "minimal"
    ? "low"
    : effort === "ultra"
      ? "max"
      : effort === "ultracode" || effort === "ultrathink"
        ? null
        : effort;

/** Ultrathink keeps the model's default effort (a null level resets to it) and works through the keyword. */
const effortSettings = (effort: Effort): Parameters<Query["applyFlagSettings"]>[0] =>
  effort === "ultracode"
    ? { ultracode: true }
    : { ultracode: null, effortLevel: toEffortLevel(effort) };

/** Claude Code looks for the "ultrathink" keyword in the message itself. */
const withUltrathink = (turn: TurnInput): TurnInput =>
  turn.effort === "ultrathink" ? { ...turn, text: `${turn.text}\n\nultrathink` } : turn;

/** Tool inputs come from the model as JSON; anything else gets an empty summary. */
const decodeToolInput = Schema.decodeUnknownOption(Schema.Json);

/**
 * Claude Code runs a skill only when the message's last text block starts with `/name`, taking
 * the rest of that block as its arguments; it runs one per message. So the last `$name` starts
 * that block, and earlier ones become `/name` in the text before it, which the model reads as
 * asking it to start them itself.
 */
function skillBlocks(text: string, skills: ReadonlyArray<ProviderSkill>): Array<string> {
  const mentions = skillMentions(text, skills);
  const last = mentions.at(-1);
  if (!last) return text ? [text] : [];
  const leading = mentions
    .slice(0, -1)
    .reduce(
      (result, mention) => `${result.slice(0, mention.start)}/${result.slice(mention.start + 1)}`,
      text.slice(0, last.start),
    )
    .trimEnd();
  return [...(leading ? [leading] : []), `/${text.slice(last.start + 1)}`.trimEnd()];
}

/** Images inline as base64 blocks, then the text (with other files listed as paths). */
const toContent = async (turn: TurnInput): Promise<SDKUserMessage["message"]["content"]> => {
  const texts = skillBlocks(textWithFiles(turn), turn.skills);
  const images = turn.attachments.flatMap((a) => {
    const mediaType = IMAGE_TYPES.get(extname(a.path).toLowerCase());
    return a.isImage && mediaType ? [{ path: a.path, mediaType }] : [];
  });
  if (!images.length && texts.length <= 1 && !turn.handoff) return texts[0] ?? "";
  const blocks = await Promise.all(
    images.map(async (image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: (await readFile(image.path)).toString("base64"),
      },
    })),
  );
  return [
    ...(turn.handoff ? [{ type: "text" as const, text: turn.handoff }] : []),
    ...blocks,
    ...texts.map((text) => ({ type: "text" as const, text })),
  ];
};

function contextUsage(usage: SDKControlGetContextUsageResponse) {
  return {
    usedTokens: usage.totalTokens,
    maxTokens: usage.rawMaxTokens,
    categories: usage.categories.map(({ name, tokens, kind, isDeferred }) => ({
      name,
      tokens,
      // CLIs older than the SDK leave `kind` out.
      kind: kind ?? (isDeferred ? "deferred" : "used"),
    })),
  };
}

const start = ({
  threadId,
  cwd,
  harness,
  model,
  resumeToken,
  effort: initialEffort,
  permission: initialPermission,
  onResumeToken,
  onCwd,
  emit,
  mcpServer,
}: StartSessionInput) =>
  Effect.try({
    try: () => {
      const launch = harnessLaunch("claude", harness);
      const inbox = makeInbox<SDKUserMessage>();
      const pending = new Map<string, PendingApproval>();
      let nextRequest = 0;

      const canUseTool: CanUseTool = (toolName, input, { signal, suggestions, agentID }) =>
        new Promise<PermissionResult>((resolve) => {
          const requestId = `claude-perm-${++nextRequest}`;
          const questions: ReadonlyArray<UserQuestion> | undefined =
            toolName === "AskUserQuestion"
              ? Option.getOrUndefined(decodeAskUserQuestion(input))?.questions.map(
                  // AskUserQuestion's questions carry no ids; their position is theirs.
                  (question, index) => ({
                    id: String(index),
                    header: question.header,
                    question: question.question,
                    options: question.options.map((option) => ({
                      ...option,
                      description: option.description ?? "",
                    })),
                    multiSelect: question.multiSelect === true,
                  }),
                )
              : undefined;
          pending.set(requestId, { toolName, input, suggestions, questions, resolve });
          signal.addEventListener("abort", () => {
            if (pending.delete(requestId)) {
              emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
              resolve({ behavior: "deny", message: "Aborted" });
            }
          });
          emit(
            RuntimeEvent.cases["thread.status"].make({
              threadId,
              status: questions ? "awaiting-answer" : "awaiting-approval",
            }),
          );
          emit(
            RuntimeEvent.cases["approval.requested"].make({
              threadId,
              requestId,
              title: toolName,
              detail: questions
                ? questions.map((question) => question.question).join("\n")
                : toolName === "ExitPlanMode" && Predicate.isString(input.plan)
                  ? input.plan
                  : summarizeToolInput(Option.getOrNull(decodeToolInput(input))),
              agent: agentID === undefined ? undefined : agentNames.get(agentID),
              questions,
            }),
          );
        });

      const options: Options = {
        cwd,
        permissionMode: PERMISSION_MODE[initialPermission],
        // Only lets the composer switch to "Full access" later; the mode above still applies.
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: launch.bin,
        // Thinking streams empty unless shown summarized; launch arguments can still say otherwise.
        extraArgs: { "thinking-display": "summarized", ...claudeExtraArgs(launch.args) },
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        agentProgressSummaries: true,
        canUseTool,
        env: {
          // Claude Code exits at startup when skip-permissions is allowed as root, which is how
          // many SSH hosts sign in; IS_SANDBOX is its opt-out.
          ...(process.getuid?.() === 0 && { IS_SANDBOX: "1" }),
          ...launch.env,
          ...(mcpServer && { APCODE_MCP_TOKEN: mcpServer.token }),
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        },
        mcpServers: mcpServer
          ? {
              browser: {
                type: "http",
                url: mcpServer.url,
                headers: { Authorization: "Bearer ${APCODE_MCP_TOKEN}" },
              },
              apcode: {
                type: "http",
                url: `${mcpServer.url}/apcode`,
                headers: { Authorization: "Bearer ${APCODE_MCP_TOKEN}" },
              },
              ...(DEVICES_SUPPORTED && {
                device: {
                  type: "http",
                  url: `${mcpServer.url}/device`,
                  headers: { Authorization: "Bearer ${APCODE_MCP_TOKEN}" },
                },
              }),
            }
          : {},
        allowedTools: [
          "mcp__browser__snapshot",
          "mcp__browser__console",
          "mcp__device__device_screenshot",
          "mcp__apcode__list_threads",
          "mcp__apcode__read_thread",
          "mcp__apcode__wait_for_thread",
        ],
        hooks: {
          PostToolUse: [
            {
              matcher: "EnterWorktree|ExitWorktree",
              hooks: [
                async (input) => {
                  // A subagent's worktree is its own; the session stays where it was.
                  if (input.hook_event_name === "PostToolUse" && input.agent_id === undefined)
                    onCwd(input.cwd);
                  return {};
                },
              ],
            },
          ],
        },
      };
      if (model) options.model = model;
      if (resumeToken) options.resume = resumeToken;
      const initialLevel = initialEffort && toEffortLevel(initialEffort);
      if (initialLevel) options.effort = initialLevel;
      const q: Query = query({ prompt: inbox.iterable, options });

      // Message ids that streamed partial deltas, so we don't re-emit their full text.
      const streamed = new Set<string>();
      // Text accumulated per streamed block, flushed as `assistant.completed` when the block stops.
      const blocks = new Map<string, string>();
      // The same for thinking blocks, flushed as `reasoning.completed`.
      const thoughts = new Map<string, string>();
      let currentMessageId = "";
      // Subagents launched in the background: their tool call returns a placeholder at once, and the
      // real end comes later as a task notification, so the call stays running until then.
      const agentTools = new Map<string, string>();
      // Subagents' descriptions by task id, to say which one asks for an approval.
      const agentNames = new Map<string, string>();
      const backgroundAgents = new Set<string>();
      const questionTools = new Set<string>();
      // Claude Code's own running/idle, which covers turns it starts itself and waits out background
      // agents. CLIs too old to send it get idle at the end of each turn instead.
      let reportsSessionState = false;
      let sessionId = resumeToken;
      let permission = initialPermission;
      // Ultracode and ultrathink can't be start options; the first turn applies them.
      let effort = initialLevel ? initialEffort : null;
      // Unknown until a turn sets it, so the user's own Claude Code setting can't linger unseen.
      let fast: boolean | undefined;
      // The plan's limit refused a request this turn: when it resets (epoch ms, null if unsaid),
      // undefined while it hasn't. Told only if the turn then fails, since extra usage can pay on.
      let limitResetsAt: number | null | undefined;

      /** "summary" estimates the breakdown locally; "full" would make a token-count request per category. */
      async function reportUsage(costUsd: number) {
        const context = await q
          .getContextUsage({ detail: "summary" })
          .then(contextUsage)
          .catch(() => null);
        emit(RuntimeEvent.cases["thread.usage"].make({ threadId, usage: { context, costUsd } }));
      }

      const handle = (msg: SDKMessage) => {
        if (msg.session_id !== undefined && msg.session_id !== sessionId) {
          sessionId = msg.session_id;
          onResumeToken(sessionId);
        }
        switch (msg.type) {
          case "stream_event": {
            if (msg.parent_tool_use_id) return; // subagent chatter
            const event = msg.event;
            if (event.type === "message_start") currentMessageId = event.message.id;
            const blockId = `${currentMessageId}:${"index" in event ? event.index : 0}`;
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              streamed.add(currentMessageId);
              blocks.set(blockId, (blocks.get(blockId) ?? "") + event.delta.text);
              emit(
                RuntimeEvent.cases["assistant.delta"].make({
                  threadId,
                  messageId: blockId,
                  delta: event.delta.text,
                }),
              );
            }
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "thinking_delta" &&
              event.delta.thinking
            ) {
              thoughts.set(blockId, (thoughts.get(blockId) ?? "") + event.delta.thinking);
              emit(
                RuntimeEvent.cases["reasoning.delta"].make({
                  threadId,
                  messageId: blockId,
                  delta: event.delta.thinking,
                }),
              );
            }
            if (event.type === "content_block_stop" && thoughts.has(blockId)) {
              emit(
                RuntimeEvent.cases["reasoning.completed"].make({
                  threadId,
                  messageId: blockId,
                  text: thoughts.get(blockId)!,
                }),
              );
              thoughts.delete(blockId);
            }
            if (event.type === "content_block_stop" && blocks.has(blockId)) {
              emit(
                RuntimeEvent.cases["assistant.completed"].make({
                  threadId,
                  messageId: blockId,
                  text: blocks.get(blockId)!,
                }),
              );
              blocks.delete(blockId);
            }
            return;
          }
          case "rate_limit_event": {
            const info = msg.rate_limit_info;
            limitResetsAt =
              info.status === "rejected" && !info.isUsingOverage
                ? info.resetsAt === undefined
                  ? null
                  : info.resetsAt * 1000
                : undefined;
            return;
          }
          case "assistant": {
            const parentToolId = msg.parent_tool_use_id;
            if (msg.error === "rate_limit" && !parentToolId) limitResetsAt ??= null;
            for (const block of msg.message.content) {
              if (block.type === "text" && !parentToolId && !streamed.has(msg.message.id)) {
                emit(
                  RuntimeEvent.cases["assistant.completed"].make({
                    threadId,
                    messageId: msg.message.id,
                    text: block.text,
                  }),
                );
              } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
                // Shown as its question card instead.
                questionTools.add(block.id);
              } else if (block.type === "tool_use") {
                emit(
                  RuntimeEvent.cases["tool.started"].make({
                    threadId,
                    toolId: block.id,
                    name: block.name,
                    summary: summarizeToolInput(Option.getOrNull(decodeToolInput(block.input))),
                    parentToolId: parentToolId ?? undefined,
                  }),
                );
              }
            }
            return;
          }
          case "user": {
            if (!Array.isArray(msg.message.content)) return;
            for (const block of msg.message.content) {
              if (
                block.type !== "tool_result" ||
                backgroundAgents.has(block.tool_use_id) ||
                questionTools.delete(block.tool_use_id)
              )
                continue;
              emit(
                RuntimeEvent.cases["tool.completed"].make({
                  threadId,
                  toolId: block.tool_use_id,
                  output: Array.isArray(block.content)
                    ? block.content
                        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
                        .join("\n")
                    : (block.content ?? ""),
                  isError: block.is_error === true,
                }),
              );
            }
            return;
          }
          case "system": {
            // A resumed session goes back into the worktree it was in, or not, after a rewind to before it.
            if (msg.subtype === "init") onCwd(msg.cwd);
            else if (msg.subtype === "session_state_changed") {
              reportsSessionState = true;
              if (msg.state !== "requires_action")
                emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: msg.state }));
            } else if (
              msg.subtype === "task_started" &&
              msg.task_type === "local_agent" &&
              msg.tool_use_id
            ) {
              agentTools.set(msg.task_id, msg.tool_use_id);
              agentNames.set(msg.task_id, msg.description);
              if (msg.is_backgrounded) backgroundAgents.add(msg.tool_use_id);
            } else if (msg.subtype === "task_updated" && msg.patch.is_backgrounded) {
              const toolId = agentTools.get(msg.task_id);
              if (toolId) backgroundAgents.add(toolId);
            } else if (msg.subtype === "task_progress") {
              const toolId = agentTools.get(msg.task_id);
              if (toolId)
                emit(
                  RuntimeEvent.cases["tool.progress"].make({
                    threadId,
                    toolId,
                    summary: msg.summary,
                    tokens: msg.usage.total_tokens,
                    durationMs: msg.usage.duration_ms,
                  }),
                );
            } else if (msg.subtype === "task_notification") {
              agentTools.delete(msg.task_id);
              agentNames.delete(msg.task_id);
              if (!msg.tool_use_id || !backgroundAgents.delete(msg.tool_use_id)) return;
              emit(
                RuntimeEvent.cases["tool.completed"].make({
                  threadId,
                  toolId: msg.tool_use_id,
                  output: msg.status === "stopped" ? "Stopped" : msg.summary,
                  isError: msg.status === "failed",
                }),
              );
            }
            return;
          }
          case "result": {
            if (msg.is_error && limitResetsAt !== undefined)
              emit(
                RuntimeEvent.cases["thread.limitStop"].make({
                  threadId,
                  limitStop: { provider: "claude", resetsAt: limitResetsAt, resumeAtReset: null },
                }),
              );
            limitResetsAt = undefined;
            if (msg.subtype !== "success")
              emit(
                RuntimeEvent.cases.error.make({ threadId, message: `Turn ended: ${msg.subtype}` }),
              );
            emit(
              RuntimeEvent.cases["turn.completed"].make({ threadId, durationMs: msg.duration_ms }),
            );
            if (!reportsSessionState)
              emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
            void reportUsage(msg.total_cost_usd);
            return;
          }
          default:
            return;
        }
      };

      void (async () => {
        try {
          for await (const msg of q) handle(msg);
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "closed" }));
        } catch (error) {
          emit(
            RuntimeEvent.cases.error.make({
              threadId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "error" }));
        }
      })();

      const session: ProviderSession = {
        send: (turn) =>
          Effect.tryPromise({
            try: async () => {
              emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
              if (turn.permission !== permission) {
                await q.setPermissionMode(PERMISSION_MODE[turn.permission]);
                permission = turn.permission;
              }
              if (turn.effort && turn.effort !== effort) {
                await q.applyFlagSettings(effortSettings(turn.effort));
                effort = turn.effort;
              }
              if (turn.fast !== undefined && turn.fast !== fast) {
                await q.applyFlagSettings({ fastMode: turn.fast });
                fast = turn.fast;
              }
              const content = await toContent(withUltrathink(turn));
              inbox.push({
                type: "user",
                message: { role: "user", content },
                parent_tool_use_id: null,
                uuid: turn.messageId,
              });
            },
            catch: (e) => fail(e instanceof Error ? e.message : String(e)),
          }),
        // Claude Code takes a message sent mid-turn in at its next step.
        steer: (turn) =>
          Effect.tryPromise({
            try: async () => {
              const content = await toContent(withUltrathink(turn));
              inbox.push({
                type: "user",
                message: { role: "user", content },
                parent_tool_use_id: null,
                uuid: turn.messageId,
                priority: "now",
              });
            },
            catch: (e) => fail(e instanceof Error ? e.message : String(e)),
          }),
        compact: Effect.sync(() => {
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
          inbox.push({
            type: "user",
            message: { role: "user", content: "/compact" },
            parent_tool_use_id: null,
          });
        }),
        commands: Effect.tryPromise({
          try: async () =>
            (await q.supportedCommands()).map((c) => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint,
            })),
          catch: (e) => fail(String(e)),
        }),
        interrupt: Effect.tryPromise({
          try: () =>
            Promise.all([
              q.interrupt(),
              ...[...agentTools].flatMap(([taskId, toolId]) =>
                backgroundAgents.has(toolId) ? [q.stopTask(taskId)] : [],
              ),
            ]),
          catch: (e) => fail(String(e)),
        }).pipe(Effect.asVoid),
        stopAgent: (toolId) =>
          Effect.tryPromise({
            try: async () => {
              const taskId = [...agentTools].find(([, id]) => id === toolId)?.[0];
              // Already finished: its notification is on the way.
              if (taskId) await q.stopTask(taskId);
            },
            catch: (e) => fail(`Couldn't stop the subagent: ${String(e)}`),
          }),
        respondApproval: (
          requestId,
          decision,
          { permission: buildPermission = "auto-edit", answers } = {},
        ) =>
          Effect.suspend(() => {
            const entry = pending.get(requestId);
            if (!entry) return Effect.fail(fail(`Unknown approval request ${requestId}`));
            pending.delete(requestId);
            const answered = entry.questions && decision !== "deny" ? answers : undefined;
            // Approving a plan leaves plan mode for the level picked with it; the composer follows.
            if (entry.toolName === "ExitPlanMode" && decision !== "deny") {
              permission = buildPermission;
              entry.resolve({
                behavior: "allow",
                updatedInput: entry.input,
                updatedPermissions: [
                  { type: "setMode", mode: PERMISSION_MODE[permission], destination: "session" },
                ],
              });
            } else if (entry.toolName === "ExitPlanMode")
              // Not an interrupt: that ends the turn as an error, when the user just wants a different plan.
              entry.resolve({
                behavior: "deny",
                message:
                  "The user rejected this plan and will reply with what to change. End your turn now, without calling any tools.",
              });
            else if (entry.questions && !answered)
              entry.resolve({ behavior: "deny", message: "The user chose not to answer" });
            else if (entry.questions && answered)
              // Claude reads answers keyed by question text, several choices comma-separated.
              entry.resolve({
                behavior: "allow",
                updatedInput: {
                  ...entry.input,
                  answers: Object.fromEntries(
                    entry.questions.map((question) => [
                      question.question,
                      (answered[question.id] ?? []).join(", "),
                    ]),
                  ),
                  // Tells Claude which mockup the user picked, as its own dialog does.
                  annotations: Object.fromEntries(
                    entry.questions.flatMap((question) => {
                      const preview = question.options.find((option) =>
                        answered[question.id]?.includes(option.label),
                      )?.preview;
                      return preview ? [[question.question, { preview }]] : [];
                    }),
                  ),
                },
              });
            else if (decision === "deny")
              entry.resolve({ behavior: "deny", message: "Denied by user" });
            else if (decision === "allow-session" && entry.suggestions)
              entry.resolve({
                behavior: "allow",
                updatedInput: entry.input,
                updatedPermissions: entry.suggestions,
              });
            else entry.resolve({ behavior: "allow", updatedInput: entry.input });
            emit(
              RuntimeEvent.cases["approval.resolved"].make(
                answered ? { threadId, requestId, answers: answered } : { threadId, requestId },
              ),
            );
            emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
            return Effect.void;
          }),
        setModel: (next) =>
          Effect.tryPromise({
            try: () => q.setModel(next ?? undefined),
            catch: (e) => fail(String(e)),
          }),
        close: Effect.sync(() => {
          inbox.end();
          q.close();
        }),
      };
      return session;
    },
    catch: (e) => fail(e instanceof Error ? e.message : String(e)),
  });

/** A real prompt in the session log, rather than a tool result or something injected. */
function isPrompt(entry: SessionMessage) {
  if (entry.type !== "user" || entry.parent_tool_use_id) return false;
  return Option.match(
    Schema.decodeUnknownOption(
      Schema.Struct({
        content: Schema.Union([
          Schema.String,
          Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) })),
        ]),
      }),
    )(entry.message),
    {
      onNone: () => false,
      onSome: ({ content }) =>
        Predicate.isString(content) || !content.some((block) => block.type === "tool_result"),
    },
  );
}

/**
 * Forks the session just before the message (all of it without one): the original stays
 * intact, and the fork is what later turns resume. Messages carry our id when we sent
 * them; older ones are found by counting prompts.
 */
async function forkBefore({ cwd, harness, resumeToken, messageId, keep }: ForkInput) {
  if (messageId !== null && keep === 0) return null;
  // The SDK's session-log helpers read CLAUDE_CONFIG_DIR from our own env, not from options.
  // ponytail: swaps process.env for the call; a CLI spawned meanwhile without its own config dir would see it.
  const configDir = harnessLaunch("claude", harness).env.CLAUDE_CONFIG_DIR;
  const previous = process.env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined) process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    if (messageId === null) return (await forkSession(resumeToken, { dir: cwd })).sessionId;
    const entries = await getSessionMessages(resumeToken, { dir: cwd });
    let index = entries.findIndex((entry) => entry.uuid === messageId);
    if (index === -1) {
      let prompts = 0;
      index = entries.findIndex((entry) => isPrompt(entry) && prompts++ === keep);
    }
    if (index <= 0) throw new Error("couldn't find that message in Claude's session log");
    const { sessionId } = await forkSession(resumeToken, {
      dir: cwd,
      upToMessageId: entries[index - 1]!.uuid,
    });
    return sessionId;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

const rewind: ProviderAdapter["rewind"] = (input) =>
  Effect.tryPromise({
    try: () => forkBefore(input),
    catch: (e) => fail(`Couldn't rewind: ${e instanceof Error ? e.message : String(e)}`),
  });

const fork: ProviderAdapter["fork"] = (input) =>
  Effect.tryPromise({
    try: () => forkBefore(input),
    catch: (e) => fail(`Couldn't fork: ${e instanceof Error ? e.message : String(e)}`),
  });

/** A prompt-less session resumed from the log answers as the live one would; the cost call is experimental, so it may come back empty. */
const readUsage: ProviderAdapter["readUsage"] = ({ cwd, harness, resumeToken, model }) =>
  Effect.tryPromise({
    try: async () => {
      const options: Options = { cwd, resume: resumeToken };
      if (model) options.model = model;
      const q = promptlessQuery(harnessLaunch("claude", harness), options);
      try {
        const context = contextUsage(await q.getContextUsage({ detail: "summary" }));
        const costUsd = await q
          .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
          .then(
            (usage) => usage.session.total_cost_usd,
            () => null,
          );
        return { context, costUsd };
      } finally {
        q.close();
      }
    },
    catch: (e) => fail(`Couldn't read usage: ${e instanceof Error ? e.message : String(e)}`),
  });

/** Bundled, plugin, user and project skills alike, as the session in `cwd` would load them. */
const listSkills: ProviderAdapter["listSkills"] = ({ cwd, harness }) =>
  Effect.tryPromise({
    try: async () => {
      const q = promptlessQuery(harnessLaunch("claude", harness), {
        cwd,
        settingSources: ["user", "project", "local"],
      });
      try {
        const { skills } = await q.reloadSkills();
        return skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: null,
        }));
      } finally {
        q.close();
      }
    },
    catch: (e) => fail(e instanceof Error ? e.message : String(e)),
  });

export const ClaudeAdapter: ProviderAdapter = {
  kind: "claude",
  start,
  rewind,
  fork,
  readUsage,
  listSkills,
};
