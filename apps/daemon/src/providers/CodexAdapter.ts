/**
 * Codex via `codex app-server`. This is the same interface the official IDE
 * extension uses, so it runs on the user's ChatGPT login.
 */
import {
  RuntimeEvent,
  type ApprovalDecision,
  type Effort,
  type PermissionLevel,
} from "@apcode/contracts";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  CodexNotification,
  CodexServerRequest,
  CompletedItem,
  connectCodex,
  StartedItem,
  ThreadResponse,
  type CodexElicitation,
  type RpcId,
} from "./codexRpc.ts";
import { harnessLaunch } from "./launch.ts";
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

/** Codex's own presets: untrusted asks before most commands, on-request is "Auto", never + full access is "Full access". */
const PERMISSION = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
} as const satisfies Record<PermissionLevel, { approvalPolicy: string; sandbox: string }>;

const CODEX_DECISION = {
  allow: "accept",
  "allow-session": "acceptForSession",
  deny: "decline",
} as const satisfies Record<ApprovalDecision, string>;

/** The per-turn form of `PERMISSION[level].sandbox`. */
const codexSandboxPolicy = (level: PermissionLevel, cwd: string) =>
  PERMISSION[level].sandbox === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };

/** Codex has no "max"; its top level is xhigh. */
const toCodexEffort = (effort: Effort) => (effort === "max" ? "xhigh" : effort);

function elicitationResponse(elicitation: CodexElicitation, decision: ApprovalDecision) {
  if (decision === "deny" || elicitation.mode === "url") return { action: "decline" };
  const content = Object.fromEntries(
    Object.entries(elicitation.requestedSchema?.properties ?? {}).flatMap(([key, field]) => {
      const chosen = (
        field.enum ?? (field.oneOf ?? field.anyOf ?? []).map((option) => option.const)
      ).find((value) =>
        decision === "allow-session"
          ? /session/i.test(value)
          : /once|accept|approve|allow|yes/i.test(value) && !/session|always|persist/i.test(value),
      );
      if (chosen !== undefined) return [[key, chosen] as const];
      if (field.type === "boolean")
        return [
          [
            key,
            /session|remember/i.test(`${key} ${field.title ?? ""}`)
              ? decision === "allow-session"
              : (field.default ?? true),
          ] as const,
        ];
      if (field.default !== undefined && field.default !== null)
        return [[key, field.default] as const];
      return [];
    }),
  );
  return decision === "allow-session" && [elicitation._meta?.persist].flat().includes("session")
    ? { action: "accept", content, _meta: { persist: "session" } }
    : { action: "accept", content };
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
  emit,
  mcpServer,
}: StartSessionInput) =>
  Effect.gen(function* () {
    const pendingApprovals = new Map<
      string,
      { readonly rpcId: RpcId; readonly elicitation: CodexElicitation | null }
    >();
    let codexThreadId = "";
    let activeTurnId: string | null = null;
    // Subagents run as Codex threads of their own, and their notifications arrive here tagged with
    // that thread's id. Each maps to the Agent row it shows under, `open` until it ends; a subagent's
    // own subagents are `nested` and fold into the same row.
    const subagents = new Map<
      string,
      {
        readonly toolId: string;
        readonly name: string;
        readonly nested: boolean;
        open: boolean;
        lastMessage: string;
      }
    >();
    // Live turns of every thread but this one, even those not yet known as subagents: a subagent's
    // traffic can come before the activity announcing it, and Stop has to reach it either way.
    const childTurns = new Map<string, string>();

    /** Ends a subagent's row, once: its turn ending, an error, or Codex's own report can each do it. */
    function closeSubagent(
      subagent: { readonly toolId: string; readonly nested: boolean; open: boolean },
      output: string,
      isError: boolean,
    ) {
      if (subagent.nested || !subagent.open) return;
      subagent.open = false;
      emit(
        RuntimeEvent.cases["tool.completed"].make({
          threadId,
          toolId: subagent.toolId,
          output,
          isError,
        }),
      );
      if (activeTurnId === null && !subagentsRunning())
        emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
    }

    /** The main agent can end its turn while subagents it started keep working; the thread isn't idle until they're done. */
    function subagentsRunning() {
      return [...subagents.values()].some((subagent) => !subagent.nested && subagent.open);
    }
    let currentModel = model ?? null;
    let permission = initialPermission;
    let effort = initialEffort;

    function onNotification(notification: CodexNotification) {
      CodexNotification.matchOrElse(
        notification,
        {
          "turn/started": ({ params }) => {
            if (params.threadId === codexThreadId) activeTurnId = params.turn.id;
            else childTurns.set(params.threadId, params.turn.id);
          },
          "item/agentMessage/delta": ({ params }) => {
            if (params.threadId !== codexThreadId) return;
            emit(
              RuntimeEvent.cases["assistant.delta"].make({
                threadId,
                messageId: params.itemId,
                delta: params.delta,
              }),
            );
          },
          "item/started": ({ params }) => {
            const subagent = subagents.get(params.threadId);
            if (params.threadId !== codexThreadId && !subagent) return;
            emit(
              RuntimeEvent.cases["tool.started"].make({
                ...StartedItem.match(params.item, {
                  commandExecution: (item) => ({
                    threadId,
                    toolId: item.id,
                    name: "shell",
                    summary: item.command,
                  }),
                  fileChange: (item) => ({
                    threadId,
                    toolId: item.id,
                    name: "edit",
                    summary: item.changes.map((change) => change.path).join(", "),
                  }),
                  mcpToolCall: (item) => ({
                    threadId,
                    toolId: item.id,
                    name: `mcp__${item.server}__${item.tool}`,
                    summary: summarizeToolInput(item.arguments),
                  }),
                }),
                parentToolId: subagent?.toolId,
              }),
            );
          },
          "item/completed": ({ params }) => {
            const subagent = subagents.get(params.threadId);
            if (params.threadId !== codexThreadId && !subagent) return;
            const event = CompletedItem.match(params.item, {
              agentMessage: (item) => {
                // A subagent's messages are its report, not the thread's.
                if (subagent) {
                  subagent.lastMessage = item.text;
                  return null;
                }
                return RuntimeEvent.cases["assistant.completed"].make({
                  threadId,
                  messageId: item.id,
                  text: item.text,
                });
              },
              subAgentActivity: (item) => {
                // Subagents also report on the main thread ("/root"); taking it for one of them
                // would swallow the main agent's answer as a subagent's report.
                if (item.agentThreadId === codexThreadId) return null;
                const known = subagents.get(item.agentThreadId);
                if (item.kind === "started" && !known) {
                  const leaf = item.agentPath.split("/").at(-1)?.replaceAll("_", " ") ?? "";
                  const name = subagent?.name ?? leaf.charAt(0).toUpperCase() + leaf.slice(1);
                  subagents.set(item.agentThreadId, {
                    toolId: subagent?.toolId ?? item.id,
                    name,
                    nested: subagent !== undefined,
                    open: true,
                    lastMessage: "",
                  });
                  if (subagent) return null;
                  return RuntimeEvent.cases["tool.started"].make({
                    threadId,
                    toolId: item.id,
                    name: "Agent",
                    summary: name,
                  });
                }
                if (known && (item.kind === "completed" || item.kind === "interrupted"))
                  closeSubagent(
                    known,
                    item.kind === "interrupted" ? "Stopped" : known.lastMessage || "Finished",
                    false,
                  );
                return null;
              },
              commandExecution: (item) =>
                RuntimeEvent.cases["tool.completed"].make({
                  threadId,
                  toolId: item.id,
                  output: item.aggregatedOutput ?? "",
                  isError: (item.exitCode ?? 0) !== 0,
                }),
              fileChange: (item) =>
                RuntimeEvent.cases["tool.completed"].make({
                  threadId,
                  toolId: item.id,
                  output: item.changes.map((change) => change.diff).join("\n"),
                  isError: item.status === "failed",
                }),
              mcpToolCall: (item) =>
                RuntimeEvent.cases["tool.completed"].make({
                  threadId,
                  toolId: item.id,
                  output:
                    item.error?.message ||
                    (item.result?.content ?? [])
                      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
                      .join("\n"),
                  isError: item.status === "failed" || item.error !== null,
                }),
            });
            if (event) emit(event);
          },
          "turn/completed": ({ params }) => {
            if (params.threadId !== codexThreadId) {
              childTurns.delete(params.threadId);
              // A subagent's turn ending is its end: Codex doesn't always report it on the main
              // thread, and says nothing there when Stop interrupts it.
              const subagent = subagents.get(params.threadId);
              if (subagent)
                closeSubagent(
                  subagent,
                  Match.value(params.turn.status).pipe(
                    Match.when("interrupted", () => "Stopped"),
                    Match.when("failed", () => params.turn.error?.message ?? "Failed"),
                    Match.orElse(() => subagent.lastMessage || "Finished"),
                  ),
                  params.turn.status === "failed",
                );
              return;
            }
            activeTurnId = null;
            if (params.turn.status === "failed")
              emit(
                RuntimeEvent.cases.error.make({
                  threadId,
                  message: params.turn.error?.message ?? "Turn failed",
                }),
              );
            emit(
              RuntimeEvent.cases["turn.completed"].make({
                threadId,
                durationMs: params.turn.durationMs,
              }),
            );
            if (!subagentsRunning())
              emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
          },
          error: ({ params }) => {
            if (params.willRetry) return;
            if (params.threadId === codexThreadId)
              emit(RuntimeEvent.cases.error.make({ threadId, message: params.error.message }));
            else {
              // A subagent's error is its own: it ends its row instead of showing on the thread.
              const subagent = subagents.get(params.threadId);
              if (subagent) closeSubagent(subagent, params.error.message, true);
            }
          },
          "thread/tokenUsage/updated": ({ params }) => {
            const subagent = subagents.get(params.threadId);
            if (!subagent || subagent.nested) return;
            emit(
              RuntimeEvent.cases["tool.progress"].make({
                threadId,
                toolId: subagent.toolId,
                tokens: params.tokenUsage.total.totalTokens,
              }),
            );
          },
        },
        () => {},
      );
    }

    function requestApproval(
      rpcId: RpcId,
      elicitation: CodexElicitation | null,
      title: string,
      detail: string,
      fromThreadId?: string,
    ) {
      const requestId = `codex-${rpcId}`;
      pendingApprovals.set(requestId, { rpcId, elicitation });
      emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "awaiting-approval" }));
      emit(
        RuntimeEvent.cases["approval.requested"].make({
          threadId,
          requestId,
          title,
          detail,
          agent: subagents.get(fromThreadId ?? "")?.name,
        }),
      );
      return true;
    }

    function onServerRequest(id: RpcId, request: CodexServerRequest) {
      return CodexServerRequest.match(request, {
        "mcpServer/elicitation/request": ({ params }) => {
          const tool =
            params._meta?.codex_approval_kind === "mcp_tool_call"
              ? params.message.match(/run tool "(.+)"/)?.[1]
              : undefined;
          return requestApproval(
            id,
            params,
            tool ? `mcp__${params.serverName}__${tool}` : params.serverName,
            summarizeToolInput(params._meta?.tool_params ?? {}) || params.message,
          );
        },
        "item/commandExecution/requestApproval": ({ params }) =>
          requestApproval(
            id,
            null,
            "Run command",
            params.command ?? params.reason ?? "",
            params.threadId,
          ),
        "item/fileChange/requestApproval": ({ params }) =>
          requestApproval(id, null, "Apply file changes", params.reason ?? "", params.threadId),
      });
    }

    const rpc = yield* Effect.tryPromise({
      try: () => {
        const launch = harnessLaunch("codex", harness);
        return connectCodex(
          cwd,
          {
            onNotification,
            onServerRequest,
            onExit: (code) =>
              emit(
                RuntimeEvent.cases["thread.status"].make({
                  threadId,
                  status: code === 0 || code === null ? "closed" : "error",
                }),
              ),
          },
          {
            ...launch,
            args: [
              ...launch.args,
              "-c",
              `mcp_servers.browser.url="${mcpServer.url}"`,
              "-c",
              'mcp_servers.browser.bearer_token_env_var="APCODE_MCP_TOKEN"',
            ],
            env: { ...launch.env, APCODE_MCP_TOKEN: mcpServer.token },
          },
        );
      },
      catch: (e) => fail(e instanceof Error ? e.message : String(e)),
    });
    function request<A>(method: string, params: Schema.Json, response: Schema.Decoder<A>) {
      return Effect.tryPromise({
        try: () => rpc.request(method, params, response),
        catch: (e) => fail(`${method}: ${e instanceof Error ? e.message : String(e)}`),
      });
    }

    // Null leaves a setting to the config (and, for turns, to the last override).
    const { approvalPolicy, sandbox } = PERMISSION[permission];
    const threadParams = {
      cwd,
      model: currentModel,
      config: effort ? { model_reasoning_effort: toCodexEffort(effort) } : null,
      approvalPolicy,
      sandbox,
    };
    const started = resumeToken
      ? yield* request(
          "thread/resume",
          { threadId: resumeToken, excludeTurns: true, ...threadParams },
          ThreadResponse,
        )
      : yield* request("thread/start", threadParams, ThreadResponse);
    codexThreadId = started.thread.id;
    onResumeToken(codexThreadId);

    const input = (turn: TurnInput) => {
      const text = textWithFiles(turn);
      return [
        ...turn.attachments
          .filter((a) => a.isImage)
          .map((a) => ({ type: "localImage", path: a.path })),
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ];
    };

    const session: ProviderSession = {
      send: (turn) =>
        Effect.gen(function* () {
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
          // Overrides stick for later turns, so only send what changed (keeps config.toml's sandbox details otherwise).
          const permissionChanged = turn.permission !== permission;
          const effortOverride =
            turn.effort !== null && turn.effort !== effort ? toCodexEffort(turn.effort) : null;
          permission = turn.permission;
          if (turn.effort) effort = turn.effort;
          const res = yield* request(
            "turn/start",
            {
              threadId: codexThreadId,
              input: input(turn),
              model: currentModel,
              effort: effortOverride,
              approvalPolicy: permissionChanged ? PERMISSION[permission].approvalPolicy : null,
              sandboxPolicy: permissionChanged ? codexSandboxPolicy(permission, cwd) : null,
            },
            Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) }),
          );
          activeTurnId = res.turn.id;
        }),
      // Joins the running turn; with none running (it just ended), starts one.
      steer: (turn) =>
        Effect.suspend(() =>
          activeTurnId
            ? request(
                "turn/steer",
                { threadId: codexThreadId, input: input(turn), expectedTurnId: activeTurnId },
                Schema.Unknown,
              ).pipe(Effect.asVoid)
            : session.send(turn),
        ),
      compact: Effect.suspend(() => {
        emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
        return request("thread/compact/start", { threadId: codexThreadId }, Schema.Unknown).pipe(
          Effect.asVoid,
        );
      }),
      commands: Effect.succeed([]),
      // Subagents are threads with turns of their own: interrupting only the parent would leave them
      // running. Best effort per subagent, so one that won't stop can't block the rest.
      interrupt: Effect.suspend(() =>
        Effect.forEach(
          [...childTurns].map(([childThreadId, turnId]) => ({ threadId: childThreadId, turnId })),
          (turn) => request("turn/interrupt", turn, Schema.Unknown).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.andThen(
            activeTurnId
              ? request(
                  "turn/interrupt",
                  { threadId: codexThreadId, turnId: activeTurnId },
                  Schema.Unknown,
                ).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
      respondApproval: (requestId, decision) =>
        Effect.suspend(() => {
          const pending = pendingApprovals.get(requestId);
          if (pending === undefined)
            return Effect.fail(fail(`Unknown approval request ${requestId}`));
          pendingApprovals.delete(requestId);
          rpc.respond(
            pending.rpcId,
            pending.elicitation
              ? elicitationResponse(pending.elicitation, decision)
              : { decision: CODEX_DECISION[decision] },
          );
          emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
          return Effect.void;
        }),
      // A turn's model override sticks for later turns, so "null" keeps the last one.
      setModel: (next) => Effect.sync(() => void (currentModel = next ?? currentModel)),
      close: Effect.sync(() => rpc.close()),
    };
    return session;
  });

/** Loads the thread in a short-lived app-server and drops its last turns. The thread id stays. */
const rewind: ProviderAdapter["rewind"] = ({ cwd, harness, resumeToken, dropTurns }) =>
  Effect.tryPromise({
    try: async () => {
      const rpc = await connectCodex(cwd, {}, harnessLaunch("codex", harness));
      try {
        await rpc.request(
          "thread/resume",
          { threadId: resumeToken, excludeTurns: true, cwd },
          Schema.Unknown,
        );
        if (dropTurns > 0)
          await rpc.request(
            "thread/rollback",
            { threadId: resumeToken, numTurns: dropTurns },
            Schema.Unknown,
          );
        return resumeToken;
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(`Couldn't rewind: ${e instanceof Error ? e.message : String(e)}`),
  });

export const CodexAdapter: ProviderAdapter = { kind: "codex", start, rewind };
