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
  type TurnInput,
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

function elicitationResponse(params: any, decision: ApprovalDecision) {
  if (decision === "deny" || params.mode === "url") return { action: "decline" };
  const content: Record<string, unknown> = {};
  for (const [key, field] of Object.entries<any>(params.requestedSchema?.properties ?? {})) {
    const chosen = (field.enum ?? (field.oneOf ?? field.anyOf ?? []).map((option: any) => option.const)).find((value: string) =>
      decision === "allow-session" ? /session/i.test(value) : /once|accept|approve|allow|yes/i.test(value) && !/session|always|persist/i.test(value),
    );
    if (chosen !== undefined) content[key] = chosen;
    else if (field.type === "boolean") content[key] = /session|remember/i.test(`${key} ${field.title ?? ""}`) ? decision === "allow-session" : (field.default ?? true);
    else if (field.default !== undefined && field.default !== null) content[key] = field.default;
  }
  return decision === "allow-session" && [params._meta?.persist].flat().includes("session")
    ? { action: "accept", content, _meta: { persist: "session" } }
    : { action: "accept", content };
}

const start = ({ cwd, model, resumeToken, effort: initialEffort, permission: initialPermission, onResumeToken, emit, mcpServer }: StartSessionInput) =>
  Effect.gen(function* () {
    const pendingApprovals = new Map<string, { readonly rpcId: RpcId; readonly elicitation: unknown }>();
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
            emit({ _tag: "tool.started", toolId: item.id, name: `mcp__${item.server}__${item.tool}`, summary: summarizeToolInput(item.arguments) });
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
            emit({
              _tag: "tool.completed",
              toolId: item.id,
              output: item.error?.message || (item.result?.content ?? []).map((part: any) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n"),
              isError: item.status === "failed" || Boolean(item.error),
            });
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
      if (method === "mcpServer/elicitation/request") {
        const requestId = `codex-${id}`;
        pendingApprovals.set(requestId, { rpcId: id, elicitation: params });
        emit({ _tag: "thread.status", status: "awaiting-approval" });
        const tool = params._meta?.codex_approval_kind === "mcp_tool_call" ? params.message?.match(/run tool "(.+)"/)?.[1] : undefined;
        emit({
          _tag: "approval.requested",
          requestId,
          title: tool ? `mcp__${params.serverName}__${tool}` : params.serverName,
          detail: summarizeToolInput(params._meta?.tool_params ?? {}) || (params.message ?? ""),
        });
        return true;
      }
      if (!APPROVAL_METHODS.has(method)) return false;
      const requestId = `codex-${id}`;
      pendingApprovals.set(requestId, { rpcId: id, elicitation: null });
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
        connectCodex(
          cwd,
          {
            onNotification,
            onServerRequest,
            onExit: (code) => emit({ _tag: "thread.status", status: code === 0 || code === null ? "closed" : "error" }),
          },
          {
            args: ["-c", `mcp_servers.browser.url="${mcpServer.url}"`, "-c", 'mcp_servers.browser.bearer_token_env_var="APCODE_MCP_TOKEN"'],
            env: { APCODE_MCP_TOKEN: mcpServer.token },
          },
        ),
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

    const input = (turn: TurnInput) => {
      const text = textWithFiles(turn);
      return [
        ...turn.attachments.filter((a) => a.isImage).map((a) => ({ type: "localImage", path: a.path })),
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ];
    };

    const session: ProviderSession = {
      send: (turn) =>
        Effect.gen(function* () {
          emit({ _tag: "thread.status", status: "running" });
          // Overrides stick for later turns, so only send what changed (keeps config.toml's sandbox details otherwise).
          const permissionChanged = turn.permission !== permission;
          const effortChanged = turn.effort !== null && turn.effort !== effort;
          permission = turn.permission;
          if (turn.effort) effort = turn.effort;
          const res = yield* request("turn/start", {
            threadId,
            input: input(turn),
            ...(currentModel ? { model: currentModel } : {}),
            ...(effortChanged ? { effort: toCodexEffort(turn.effort!) } : {}),
            ...(permissionChanged
              ? { approvalPolicy: PERMISSION[permission].approvalPolicy, sandboxPolicy: codexSandboxPolicy(permission, cwd) }
              : {}),
          });
          activeTurnId = res.turn.id;
        }),
      // Joins the running turn; with none running (it just ended), starts one.
      steer: (turn) =>
        Effect.suspend(() =>
          activeTurnId
            ? request("turn/steer", { threadId, input: input(turn), expectedTurnId: activeTurnId }).pipe(Effect.asVoid)
            : session.send(turn),
        ),
      compact: Effect.suspend(() => {
        emit({ _tag: "thread.status", status: "running" });
        return request("thread/compact/start", { threadId }).pipe(Effect.asVoid);
      }),
      commands: Effect.succeed([]),
      interrupt: Effect.suspend(() =>
        activeTurnId ? request("turn/interrupt", { threadId, turnId: activeTurnId }).pipe(Effect.asVoid) : Effect.void,
      ),
      respondApproval: (requestId, decision) =>
        Effect.suspend(() => {
          const pending = pendingApprovals.get(requestId);
          if (pending === undefined) return Effect.fail(fail(`Unknown approval request ${requestId}`));
          pendingApprovals.delete(requestId);
          rpc.respond(pending.rpcId, pending.elicitation ? elicitationResponse(pending.elicitation, decision) : { decision: toCodexDecision(decision) });
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

/** Loads the thread in a short-lived app-server and drops its last turns. The thread id stays. */
const rewind: ProviderAdapter["rewind"] = ({ cwd, resumeToken, dropTurns }) =>
  Effect.tryPromise({
    try: async () => {
      const rpc = await connectCodex(cwd, { onNotification: () => {}, onServerRequest: () => false, onExit: () => {} });
      try {
        await rpc.request("thread/resume", { threadId: resumeToken, excludeTurns: true, cwd });
        if (dropTurns > 0) await rpc.request("thread/rollback", { threadId: resumeToken, numTurns: dropTurns });
        return resumeToken;
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(`Couldn't rewind: ${e instanceof Error ? e.message : String(e)}`),
  });

export const CodexAdapter: ProviderAdapter = { kind: "codex", start, rewind };
