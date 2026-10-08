/**
 * Newline-delimited JSON-RPC over a child's stdio, as `codex app-server` and ACP agents speak it.
 * Promise-based; callers wrap it in Effect at their boundary and decode what they read.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HarnessLaunch } from "./launch.ts";

export type RpcId = number | string;

const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        message: Schema.String,
        data: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});
type RpcMessage = typeof RpcMessage.Type;

const decodeRpcMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RpcMessage));

export interface JsonRpcHandlers {
  readonly onNotification?: (method: string, params: Schema.Json | undefined) => void;
  /** Requests the child makes of us. Unhandled ones (false) get a method-not-found error. */
  readonly onRequest?:
    | ((id: RpcId, method: string, params: Schema.Json | undefined) => boolean)
    | undefined;
  readonly onExit?: ((code: number | null, stderrTail: string) => void) | undefined;
}

export interface JsonRpc {
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

/**
 * Spawns `launch` with `args` and talks JSON-RPC to it; `name` labels its errors. Codex leaves out
 * the `"jsonrpc": "2.0"` member, ACP requires it.
 */
export function connectJsonRpc(
  name: string,
  launch: HarnessLaunch,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  handlers: JsonRpcHandlers,
  { versioned = false } = {},
): JsonRpc {
  const child = spawn(launch.bin, args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });

  let nextId = 0;
  const inflight = new Map<
    RpcId,
    { readonly resolve: (reply: RpcMessage) => void; readonly reject: (error: Error) => void }
  >();
  function write(message: Schema.JsonObject) {
    child.stdin.write(`${JSON.stringify(versioned ? { jsonrpc: "2.0", ...message } : message)}\n`);
  }

  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = Option.getOrUndefined(decodeRpcMessage(line));
    if (message === undefined) return;
    const { id, method, params } = message;
    if (method !== undefined && id !== undefined && id !== null) {
      if (!(handlers.onRequest?.(id, method, params) ?? false))
        write({ id, error: { code: -32601, message: `MassCode does not handle ${method}` } });
      return;
    }
    if (method !== undefined) {
      handlers.onNotification?.(method, params);
      return;
    }
    if (id !== undefined && id !== null) {
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
  let reportExit: (error: Error) => void = () => {};
  const exited = new Promise<never>((_, reject) => (reportExit = reject));
  // Settled with nothing awaiting it yet; requests race it.
  exited.catch(() => {});
  child.on("error", (error) => reportExit(error));
  // A write racing the exit fails with EPIPE; the exit itself is what's reported.
  child.stdin.on("error", () => {});
  child.on("exit", (code) => {
    const error = new Error(`${name} exited (code ${code}): ${stderrTail.trim() || "no output"}`);
    reportExit(error);
    for (const waiter of inflight.values()) waiter.reject(error);
    inflight.clear();
    handlers.onExit?.(code, stderrTail);
  });

  return {
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
          ? Promise.reject(new Error(reply.error.data?.message ?? reply.error.message))
          : Schema.decodeUnknownPromise(response)(reply.result),
      ),
    notify: (method, params) => write(params === undefined ? { method } : { method, params }),
    respond: (id, result) => write({ id, result }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}
