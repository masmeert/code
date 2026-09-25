/**
 * Minimal client for `codex app-server`: newline-delimited JSON-RPC over stdio.
 * Promise-based; callers wrap it in Effect at their boundary.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveExecutable } from "./resolveExecutable.ts";

export type RpcId = number | string;

interface RpcMessage {
  readonly id?: RpcId;
  readonly method?: string;
  readonly params?: any;
  readonly result?: any;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface CodexRpcHandlers {
  readonly onNotification?: (method: string, params: any) => void;
  /** Requests the server makes of us (approvals etc.). Unhandled ones get a method-not-found error. */
  readonly onServerRequest?: (id: RpcId, method: string, params: any) => boolean;
  readonly onExit?: (code: number | null, stderrTail: string) => void;
}

export interface CodexRpc {
  readonly request: (method: string, params: unknown) => Promise<any>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly respond: (id: RpcId, result: unknown) => void;
  readonly close: () => void;
}

/** Spawns `codex app-server` and completes the initialize handshake. */
export const connectCodex = async (
  cwd: string | undefined,
  handlers: CodexRpcHandlers = {},
  launch: { readonly args?: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<CodexRpc> => {
  const bin = resolveExecutable("codex", "APCODE_CODEX_PATH");
  const child = spawn(bin, ["app-server", ...(launch.args ?? [])], { cwd, env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });

  let nextId = 0;
  const inflight = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const write = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const handled = handlers.onServerRequest?.(msg.id, msg.method, msg.params) ?? false;
      if (!handled) write({ id: msg.id, error: { code: -32601, message: `APCode does not handle ${msg.method}` } });
      return;
    }
    if (msg.method !== undefined) return handlers.onNotification?.(msg.method, msg.params);
    if (msg.id !== undefined) {
      const waiter = inflight.get(msg.id);
      inflight.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(msg.error.message));
      else waiter?.resolve(msg.result);
    }
  });

  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => (stderrTail = (stderrTail + chunk.toString()).slice(-4000)));
  const exited = new Promise<never>((_, reject) =>
    child.on("error", (error) => reject(error)),
  );
  child.on("exit", (code) => {
    for (const waiter of inflight.values()) waiter.reject(new Error(`codex exited (${code}): ${stderrTail}`));
    inflight.clear();
    handlers.onExit?.(code, stderrTail);
  });

  const rpc: CodexRpc = {
    request: (method, params) =>
      Promise.race([
        exited,
        new Promise<any>((resolve, reject) => {
          const id = ++nextId;
          inflight.set(id, { resolve, reject });
          write({ id, method, params });
        }),
      ]),
    notify: (method, params) => write(params === undefined ? { method } : { method, params }),
    respond: (id, result) => write({ id, result }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };

  await rpc.request("initialize", { clientInfo: { name: "apcode", title: "APCode", version: "0.0.1" }, capabilities: null });
  rpc.notify("initialized");
  return rpc;
};
