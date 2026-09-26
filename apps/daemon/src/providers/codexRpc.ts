/**
 * Minimal client for `codex app-server`: newline-delimited JSON-RPC over stdio.
 * Promise-based; callers wrap it in Effect at their boundary. Incoming messages are
 * decoded here, down to the fields APCode reads.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HarnessLaunch } from "./launch.ts";

export type RpcId = number | string;

const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
});
type RpcMessage = typeof RpcMessage.Type;

const ErrorMessage = Schema.Struct({ message: Schema.String });

/** An item as `item/started` reports it, for the kinds shown as tool calls. */
export const StartedItem = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("commandExecution"),
    id: Schema.String,
    command: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("fileChange"),
    id: Schema.String,
    changes: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("mcpToolCall"),
    id: Schema.String,
    server: Schema.String,
    tool: Schema.String,
    arguments: Schema.Json,
  }),
]).pipe(Schema.toTaggedUnion("type"));

/** An item as `item/completed` reports it, for the kinds shown in the transcript. */
export const CompletedItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agentMessage"), id: Schema.String, text: Schema.String }),
  /** A subagent starting or ending; it runs as a thread of its own, `agentThreadId`. */
  Schema.Struct({
    type: Schema.Literal("subAgentActivity"),
    id: Schema.String,
    kind: Schema.Literals(["started", "interacted", "interrupted", "completed"]),
    agentThreadId: Schema.String,
    agentPath: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("commandExecution"),
    id: Schema.String,
    aggregatedOutput: Schema.NullOr(Schema.String),
    exitCode: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("fileChange"),
    id: Schema.String,
    changes: Schema.Array(Schema.Struct({ diff: Schema.String })),
    status: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("mcpToolCall"),
    id: Schema.String,
    status: Schema.String,
    result: Schema.NullOr(
      Schema.Struct({
        content: Schema.Array(
          Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
        ),
      }),
    ),
    error: Schema.NullOr(ErrorMessage),
  }),
]).pipe(Schema.toTaggedUnion("type"));

export const TokenUsage = Schema.Struct({
  /** The thread's running totals. */
  total: Schema.Struct({
    totalTokens: Schema.Number,
    /** Cached input included. */
    inputTokens: Schema.Number,
    cachedInputTokens: Schema.Number,
    /** Reasoning included. */
    outputTokens: Schema.Number,
  }),
  /** The last response: what it read and wrote is what the context holds now. */
  last: Schema.Struct({ totalTokens: Schema.Number }),
  modelContextWindow: Schema.NullOr(Schema.Number),
});
export type TokenUsage = typeof TokenUsage.Type;

/** The notifications APCode acts on; others are dropped. */
export const CodexNotification = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("turn/started"),
    params: Schema.Struct({ threadId: Schema.String, turn: Schema.Struct({ id: Schema.String }) }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/agentMessage/delta"),
    params: Schema.Struct({ threadId: Schema.String, itemId: Schema.String, delta: Schema.String }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/started"),
    params: Schema.Struct({ threadId: Schema.String, item: StartedItem }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/completed"),
    params: Schema.Struct({ threadId: Schema.String, item: CompletedItem }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/completed"),
    params: Schema.Struct({
      threadId: Schema.String,
      turn: Schema.Struct({
        status: Schema.String,
        error: Schema.NullOr(ErrorMessage),
        durationMs: Schema.NullOr(Schema.Number),
      }),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("error"),
    params: Schema.Struct({
      threadId: Schema.String,
      error: ErrorMessage,
      willRetry: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("thread/tokenUsage/updated"),
    params: Schema.Struct({
      threadId: Schema.String,
      tokenUsage: TokenUsage,
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("account/login/completed"),
    params: Schema.Struct({ success: Schema.Boolean, error: Schema.NullOr(Schema.String) }),
  }),
]).pipe(Schema.toTaggedUnion("method"));
export type CodexNotification = typeof CodexNotification.Type;

/** An MCP server asking the user for input, usually to approve one of its tool calls. */
export const CodexElicitation = Schema.Struct({
  serverName: Schema.String,
  mode: Schema.String,
  message: Schema.String,
  _meta: Schema.NullOr(
    Schema.Struct({
      codex_approval_kind: Schema.optional(Schema.String),
      tool_params: Schema.optional(Schema.Json),
      persist: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
  requestedSchema: Schema.optional(
    Schema.Struct({
      properties: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            type: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            default: Schema.optional(Schema.Json),
            enum: Schema.optional(Schema.Array(Schema.String)),
            oneOf: Schema.optional(Schema.Array(Schema.Struct({ const: Schema.String }))),
            anyOf: Schema.optional(Schema.Array(Schema.Struct({ const: Schema.String }))),
          }),
        ),
      ),
    }),
  ),
});
export type CodexElicitation = typeof CodexElicitation.Type;

const ApprovalParams = Schema.Struct({
  threadId: Schema.String,
  command: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The requests the server makes of us that APCode answers. */
export const CodexServerRequest = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("mcpServer/elicitation/request"),
    params: CodexElicitation,
  }),
  Schema.Struct({
    method: Schema.Literal("item/commandExecution/requestApproval"),
    params: ApprovalParams,
  }),
  Schema.Struct({
    method: Schema.Literal("item/fileChange/requestApproval"),
    params: ApprovalParams,
  }),
]).pipe(Schema.toTaggedUnion("method"));
export type CodexServerRequest = typeof CodexServerRequest.Type;

/** What `thread/start`, `thread/resume` and `thread/fork` answer with. */
export const ThreadResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  /** The model it runs, the configured default when none was asked for. */
  model: Schema.String,
});

const decodeRpcMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RpcMessage));
const decodeNotification = Schema.decodeUnknownOption(CodexNotification);
const decodeServerRequest = Schema.decodeUnknownOption(CodexServerRequest);

export interface CodexRpcHandlers {
  readonly onNotification?: (notification: CodexNotification) => void;
  /** Requests the server makes of us (approvals etc.). Unhandled ones get a method-not-found error. */
  readonly onServerRequest?: (id: RpcId, request: CodexServerRequest) => boolean;
  readonly onExit?: (code: number | null, stderrTail: string) => void;
}

export interface CodexRpc {
  /** Resolves to the result, decoded with `response`. */
  readonly request: <A>(
    method: string,
    params: Schema.Json,
    response: Schema.Decoder<A>,
  ) => Promise<A>;
  readonly notify: (method: string, params?: Schema.Json) => void;
  readonly respond: (id: RpcId, result: Schema.Json) => void;
  readonly close: () => void;
}

/** Spawns `codex app-server` and completes the initialize handshake. */
export async function connectCodex(
  cwd: string | undefined,
  handlers: CodexRpcHandlers = {},
  launch: HarnessLaunch,
): Promise<CodexRpc> {
  const child = spawn(launch.bin, ["app-server", ...launch.args], {
    cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 0;
  const inflight = new Map<
    RpcId,
    { readonly resolve: (reply: RpcMessage) => void; readonly reject: (error: Error) => void }
  >();
  function write(message: Schema.Json) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = Option.getOrUndefined(decodeRpcMessage(line));
    if (message === undefined) return;
    const { id, method, params } = message;
    if (method !== undefined && id !== undefined) {
      const request = decodeServerRequest({ method, params });
      const handled =
        Option.isSome(request) && (handlers.onServerRequest?.(id, request.value) ?? false);
      if (!handled)
        write({ id, error: { code: -32601, message: `APCode does not handle ${method}` } });
      return;
    }
    if (method !== undefined) {
      const notification = decodeNotification({ method, params });
      if (Option.isSome(notification)) handlers.onNotification?.(notification.value);
      return;
    }
    if (id !== undefined) {
      const waiter = inflight.get(id);
      inflight.delete(id);
      waiter?.resolve(message);
    }
  });

  let stderrTail = "";
  child.stderr.on(
    "data",
    (chunk: Buffer) => (stderrTail = (stderrTail + chunk.toString()).slice(-4000)),
  );
  const exited = new Promise<never>((_, reject) => child.on("error", (error) => reject(error)));
  child.on("exit", (code) => {
    for (const waiter of inflight.values())
      waiter.reject(new Error(`codex exited (${code}): ${stderrTail}`));
    inflight.clear();
    handlers.onExit?.(code, stderrTail);
  });

  const rpc: CodexRpc = {
    request: (method, params, response) =>
      Promise.race([
        exited,
        new Promise<RpcMessage>((resolve, reject) => {
          const id = ++nextId;
          inflight.set(id, { resolve, reject });
          write({ id, method, params });
        }),
      ]).then((reply) =>
        reply.error
          ? Promise.reject(new Error(reply.error.message))
          : Schema.decodeUnknownPromise(response)(reply.result),
      ),
    notify: (method, params) => write(params === undefined ? { method } : { method, params }),
    respond: (id, result) => write({ id, result }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };

  await rpc.request(
    "initialize",
    {
      clientInfo: { name: "apcode", title: "APCode", version: "0.0.1" },
      capabilities: null,
    },
    Schema.Unknown,
  );
  rpc.notify("initialized");
  return rpc;
}
