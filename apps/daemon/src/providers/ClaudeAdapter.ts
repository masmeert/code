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
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { RuntimeEvent, type Effort, type PermissionLevel } from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  ProviderError,
  summarizeToolInput,
  textWithFiles,
  type ProviderAdapter,
  type ProviderSession,
  type StartSessionInput,
  type TurnInput,
} from "./ProviderAdapter.ts";
import { resolveExecutable } from "./resolveExecutable.ts";

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
  readonly input: Parameters<CanUseTool>[1];
  readonly suggestions: Array<PermissionUpdate> | undefined;
  readonly resolve: (result: PermissionResult) => void;
}

const fail = (message: string) => new ProviderError({ provider: "claude", message });

const PERMISSION_MODE = {
  ask: "default",
  "auto-edit": "acceptEdits",
  "full-access": "bypassPermissions",
} as const satisfies Record<PermissionLevel, PermissionMode>;

/** Claude has no "minimal"; everything else maps one to one. */
const toEffortLevel = (effort: Effort): EffortLevel => (effort === "minimal" ? "low" : effort);

const IMAGE_TYPES = new Map<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp">([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** Tool inputs come from the model as JSON; anything else gets an empty summary. */
const decodeToolInput = Schema.decodeUnknownOption(Schema.Json);

/** Images inline as base64 blocks, then the text (with other files listed as paths). */
const toContent = async (turn: TurnInput): Promise<SDKUserMessage["message"]["content"]> => {
  const text = textWithFiles(turn);
  const images = turn.attachments.flatMap((a) => {
    const mediaType = IMAGE_TYPES.get(extname(a.path).toLowerCase());
    return a.isImage && mediaType ? [{ path: a.path, mediaType }] : [];
  });
  if (!images.length) return text;
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
  return [...blocks, ...(text ? [{ type: "text" as const, text }] : [])];
};

const start = ({
  threadId,
  cwd,
  model,
  resumeToken,
  effort: initialEffort,
  permission: initialPermission,
  onResumeToken,
  emit,
  mcpServer,
}: StartSessionInput) =>
  Effect.try({
    try: () => {
      const inbox = makeInbox<SDKUserMessage>();
      const pending = new Map<string, PendingApproval>();
      let nextRequest = 0;

      const canUseTool: CanUseTool = (toolName, input, { signal, suggestions }) =>
        new Promise<PermissionResult>((resolve) => {
          const requestId = `claude-perm-${++nextRequest}`;
          pending.set(requestId, { input, suggestions, resolve });
          signal.addEventListener("abort", () => {
            if (pending.delete(requestId)) {
              emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
              resolve({ behavior: "deny", message: "Aborted" });
            }
          });
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "awaiting-approval" }));
          emit(
            RuntimeEvent.cases["approval.requested"].make({
              threadId,
              requestId,
              title: toolName,
              detail: summarizeToolInput(Option.getOrNull(decodeToolInput(input))),
            }),
          );
        });

      const options: Options = {
        cwd,
        permissionMode: PERMISSION_MODE[initialPermission],
        // Only lets the composer switch to "Full access" later; the mode above still applies.
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: resolveExecutable("claude", "APCODE_CLAUDE_PATH"),
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        canUseTool,
        env: { ...process.env, APCODE_MCP_TOKEN: mcpServer.token },
        mcpServers: {
          browser: {
            type: "http",
            url: mcpServer.url,
            headers: { Authorization: "Bearer ${APCODE_MCP_TOKEN}" },
          },
        },
        allowedTools: ["mcp__browser__snapshot", "mcp__browser__console"],
      };
      if (model) options.model = model;
      if (resumeToken) options.resume = resumeToken;
      if (initialEffort) options.effort = toEffortLevel(initialEffort);
      const q: Query = query({ prompt: inbox.iterable, options });

      // Message ids that streamed partial deltas, so we don't re-emit their full text.
      const streamed = new Set<string>();
      // Text accumulated per streamed block, flushed as `assistant.completed` when the block stops.
      const blocks = new Map<string, string>();
      let currentMessageId = "";
      let sessionId = resumeToken;
      let permission = initialPermission;
      let effort = initialEffort;

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
          case "assistant": {
            if (msg.parent_tool_use_id) return;
            for (const block of msg.message.content) {
              if (block.type === "text" && !streamed.has(msg.message.id)) {
                emit(
                  RuntimeEvent.cases["assistant.completed"].make({
                    threadId,
                    messageId: msg.message.id,
                    text: block.text,
                  }),
                );
              } else if (block.type === "tool_use") {
                emit(
                  RuntimeEvent.cases["tool.started"].make({
                    threadId,
                    toolId: block.id,
                    name: block.name,
                    summary: summarizeToolInput(Option.getOrNull(decodeToolInput(block.input))),
                  }),
                );
              }
            }
            return;
          }
          case "user": {
            if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) return;
            for (const block of msg.message.content) {
              if (block.type !== "tool_result") continue;
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
          case "result": {
            if (msg.subtype !== "success")
              emit(
                RuntimeEvent.cases.error.make({ threadId, message: `Turn ended: ${msg.subtype}` }),
              );
            emit(
              RuntimeEvent.cases["turn.completed"].make({ threadId, durationMs: msg.duration_ms }),
            );
            emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
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
                await q.applyFlagSettings({ effortLevel: toEffortLevel(turn.effort) });
                effort = turn.effort;
              }
              const content = await toContent(turn);
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
              const content = await toContent(turn);
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
          try: () => q.interrupt(),
          catch: (e) => fail(String(e)),
        }).pipe(Effect.asVoid),
        respondApproval: (requestId, decision) =>
          Effect.suspend(() => {
            const entry = pending.get(requestId);
            if (!entry) return Effect.fail(fail(`Unknown approval request ${requestId}`));
            pending.delete(requestId);
            if (decision === "deny") entry.resolve({ behavior: "deny", message: "Denied by user" });
            else if (decision === "allow-session" && entry.suggestions)
              entry.resolve({
                behavior: "allow",
                updatedInput: entry.input,
                updatedPermissions: entry.suggestions,
              });
            else entry.resolve({ behavior: "allow", updatedInput: entry.input });
            emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
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
 * Forks the session just before the message: the original stays intact, and the fork
 * is what later turns resume. Messages carry our id when we sent them; older ones are
 * found by counting prompts.
 */
const rewind: ProviderAdapter["rewind"] = ({ cwd, resumeToken, messageId, keep }) =>
  Effect.tryPromise({
    try: async () => {
      if (keep === 0) return null;
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
    },
    catch: (e) => fail(`Couldn't rewind: ${e instanceof Error ? e.message : String(e)}`),
  });

export const ClaudeAdapter: ProviderAdapter = { kind: "claude", start, rewind };
