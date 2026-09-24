/**
 * Codex via `codex app-server`. This is the same interface the official IDE
 * extension uses, so it runs on the user's ChatGPT login.
 */
import type { ApprovalDecision, Effort, PermissionLevel } from "@apcode/contracts";
import * as Effect from "effect/Effect";
import { connectCodex, type RpcId } from "./codexRpc.ts";
import {
  ProviderError,
  summarizeToolInput,
  textWithFiles,
  type ProviderAdapter,
  type ProviderSession,
  type StartSessionInput,
} from "./ProviderAdapter.ts";

const fail = (message: string) => new ProviderError({ provider: "codex", message });

const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/** Codex's own presets: untrusted asks before most commands, on-request is "Auto", never + full access is "Full access". */
const PERMISSION = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
} as const satisfies Record<PermissionLevel, unknown>;

/** The per-turn form of `PERMISSION[level].sandbox`. */
const codexSandboxPolicy = (level: PermissionLevel, cwd: string) =>
  PERMISSION[level].sandbox === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

/** Codex has no "max"; its top level is xhigh. */
const toCodexEffort = (effort: Effort) => (effort === "max" ? "xhigh" : effort);

const toCodexDecision = (decision: ApprovalDecision) =>
  decision === "allow" ? "accept" : decision === "allow-session" ? "acceptForSession" : "decline";

const start = ({ cwd, model, resumeToken, effort: initialEffort, permission: initialPermission, onResumeToken, emit }: StartSessionInput) =>
  Effect.gen(function* () {
    const pendingApprovals = new Map<string, RpcId>();
    let threadId = "";
    let activeTurnId: string | null = null;
    let currentModel = model ?? null;
    let permission = initialPermission;
    let effort = initialEffort;

    const onNotification = (method: string, params: any) => {
      switch (method) {
        case "turn/started":
          activeTurnId = params.turn.id;
          return;
        case "item/agentMessage/delta":
          return emit({ _tag: "assistant.delta", messageId: params.itemId, delta: params.delta });
        case "item/started": {
          const item = params.item;
          if (item.type === "commandExecution") {
            emit({ _tag: "tool.started", toolId: item.id, name: "shell", summary: item.command });
          } else if (item.type === "fileChange") {
            emit({ _tag: "tool.started", toolId: item.id, name: "edit", summary: item.changes.map((c: any) => c.path).join(", ") });
          } else if (item.type === "mcpToolCall") {
            emit({ _tag: "tool.started", toolId: item.id, name: `${item.server}/${item.tool}`, summary: summarizeToolInput(item.arguments) });
          }
          return;
        }
        case "item/completed": {
          const item = params.item;
          if (item.type === "agentMessage") {
            emit({ _tag: "assistant.completed", messageId: item.id, text: item.text });
          } else if (item.type === "commandExecution") {
            emit({ _tag: "tool.completed", toolId: item.id, output: item.aggregatedOutput ?? "", isError: (item.exitCode ?? 0) !== 0 });
          } else if (item.type === "fileChange") {
            emit({ _tag: "tool.completed", toolId: item.id, output: item.changes.map((c: any) => c.diff).join("\n"), isError: item.status === "failed" });
          } else if (item.type === "mcpToolCall") {
            emit({ _tag: "tool.completed", toolId: item.id, output: "", isError: item.status === "failed" });
          }
          return;
        }
        case "turn/completed": {
          activeTurnId = null;
          const turn = params.turn;
          if (turn.status === "failed") emit({ _tag: "error", message: turn.error?.message ?? "Turn failed" });
          emit({ _tag: "turn.completed", durationMs: turn.durationMs ?? null });
          emit({ _tag: "thread.status", status: "idle" });
          return;
        }
        case "error":
          if (!params.willRetry) emit({ _tag: "error", message: params.error?.message ?? "Codex error" });
          return;
        default:
          return;
      }
    };

    const onServerRequest = (id: RpcId, method: string, params: any) => {
      if (!APPROVAL_METHODS.has(method)) return false;
      const requestId = `codex-${id}`;
      pendingApprovals.set(requestId, id);
      const isCommand = method === "item/commandExecution/requestApproval";
      emit({ _tag: "thread.status", status: "awaiting-approval" });
      emit({
        _tag: "approval.requested",
        requestId,
        title: isCommand ? "Run command" : "Apply file changes",
        detail: (isCommand ? params.command : params.reason) ?? params.reason ?? "",
      });
      return true;
    };

    const rpc = yield* Effect.tryPromise({
      try: () =>
        connectCodex(cwd, {
          onNotification,
          onServerRequest,
          onExit: (code) => emit({ _tag: "thread.status", status: code === 0 || code === null ? "closed" : "error" }),
        }),
      catch: (e) => fail(e instanceof Error ? e.message : String(e)),
    });
    const request = (method: string, params: unknown) =>
      Effect.tryPromise({
        try: () => rpc.request(method, params),
        catch: (e) => fail(`${method}: ${e instanceof Error ? e.message : String(e)}`),
      });

    const { approvalPolicy, sandbox } = PERMISSION[permission];
    const threadParams = {
      cwd,
      ...(currentModel ? { model: currentModel } : {}),
      ...(effort ? { config: { model_reasoning_effort: toCodexEffort(effort) } } : {}),
      approvalPolicy,
      sandbox,
    };
    const started = resumeToken
      ? yield* request("thread/resume", { threadId: resumeToken, excludeTurns: true, ...threadParams })
      : yield* request("thread/start", threadParams);
    threadId = started.thread.id;
    onResumeToken(threadId);

    const session: ProviderSession = {
      send: (turn) =>
        Effect.gen(function* () {
          emit({ _tag: "thread.status", status: "running" });
          // Overrides stick for later turns, so only send what changed (keeps config.toml's sandbox details otherwise).
          const permissionChanged = turn.permission !== permission;
          const effortChanged = turn.effort !== null && turn.effort !== effort;
          permission = turn.permission;
          if (turn.effort) effort = turn.effort;
          const text = textWithFiles(turn);
          const res = yield* request("turn/start", {
            threadId,
            input: [
              ...turn.attachments.filter((a) => a.isImage).map((a) => ({ type: "localImage", path: a.path })),
              ...(text ? [{ type: "text", text, text_elements: [] }] : []),
            ],
            ...(currentModel ? { model: currentModel } : {}),
            ...(effortChanged ? { effort: toCodexEffort(turn.effort!) } : {}),
            ...(permissionChanged
              ? { approvalPolicy: PERMISSION[permission].approvalPolicy, sandboxPolicy: codexSandboxPolicy(permission, cwd) }
              : {}),
          });
          activeTurnId = res.turn.id;
        }),
      interrupt: Effect.suspend(() =>
        activeTurnId ? request("turn/interrupt", { threadId, turnId: activeTurnId }).pipe(Effect.asVoid) : Effect.void,
      ),
      respondApproval: (requestId, decision) =>
        Effect.suspend(() => {
          const rpcId = pendingApprovals.get(requestId);
          if (rpcId === undefined) return Effect.fail(fail(`Unknown approval request ${requestId}`));
          pendingApprovals.delete(requestId);
          rpc.respond(rpcId, { decision: toCodexDecision(decision) });
          emit({ _tag: "approval.resolved", requestId });
          emit({ _tag: "thread.status", status: "running" });
          return Effect.void;
        }),
      // A turn's model override sticks for later turns, so "null" keeps the last one.
      setModel: (next) => Effect.sync(() => void (currentModel = next ?? currentModel)),
      close: Effect.sync(() => rpc.close()),
    };
    return session;
  });

export const CodexAdapter: ProviderAdapter = { kind: "codex", start };
