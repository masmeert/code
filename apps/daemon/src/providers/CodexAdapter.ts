/**
 * Codex via `codex app-server`. This is the same interface the official IDE
 * extension uses, so it runs on the user's ChatGPT login.
 */
import {
  RuntimeEvent,
  type ApprovalDecision,
  type Effort,
  type PermissionLevel,
  type ThreadUsage,
} from "@apcode/contracts";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CodexNotification,
  CodexServerRequest,
  CompletedItem,
  CODEX_FAST_TIER,
  connectCodex,
  StartedItem,
  ThreadResponse,
  type CodexElicitation,
  type CodexRpc,
  type RpcId,
  type TokenUsage,
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
  // The composer doesn't offer plan or auto mode for Codex; these only catch a stray one.
  plan: { approvalPolicy: "untrusted", sandbox: "read-only" },
  auto: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
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
  Match.value(PERMISSION[level].sandbox).pipe(
    Match.when("danger-full-access", () => ({ type: "dangerFullAccess" })),
    Match.when("read-only", () => ({ type: "readOnly" })),
    Match.orElse(() => ({
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })),
  );

/** Ultracode and ultrathink are Claude's; Codex keeps its default effort for them. */
const toCodexEffort = (effort: Effort) =>
  effort === "ultracode" || effort === "ultrathink" ? null : effort;

const ModelPrice = Schema.Struct({
  input_cost_per_token: Schema.Number,
  output_cost_per_token: Schema.Number,
  cache_read_input_token_cost: Schema.optional(Schema.Number),
});

/** LiteLLM's price list, the one ccusage and t3code price with; fetched once per run, again after a failure. */
let prices: Promise<ReadonlyMap<string, typeof ModelPrice.Type>> | undefined;

/** Codex doesn't say what a thread cost, so it's priced from its tokens at API list prices. */
async function apiCostUsd(
  model: string,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
) {
  prices ??= fetch(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  )
    .then((response) => response.json())
    .then(Schema.decodeUnknownPromise(Schema.Record(Schema.String, Schema.Unknown)))
    .then(
      (list) =>
        new Map(
          Object.entries(list).flatMap(([id, entry]) =>
            Option.match(Schema.decodeUnknownOption(ModelPrice)(entry), {
              onNone: () => [],
              onSome: (price) => [[id, price] as const],
            }),
          ),
        ),
    )
    .catch(() => {
      prices = undefined;
      return new Map();
    });
  const price = (await prices).get(model);
  if (!price) return null;
  // ponytail: prices the whole thread at its current model, and ignores long-context surcharges.
  return (
    (usage.inputTokens - usage.cachedInputTokens) * price.input_cost_per_token +
    usage.cachedInputTokens * (price.cache_read_input_token_cost ?? price.input_cost_per_token) +
    usage.outputTokens * price.output_cost_per_token
  );
}

async function threadUsage(
  { total, last, modelContextWindow }: TokenUsage,
  model: string,
): Promise<ThreadUsage> {
  return {
    context:
      modelContextWindow === null
        ? null
        : { usedTokens: last.totalTokens, maxTokens: modelContextWindow, categories: [] },
    costUsd: await apiCostUsd(model, total),
  };
}

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
    let startedModel = "";
    let activeTurnId: string | null = null;
    // The plan's limit refused the turn; Codex says so in an error before the turn fails.
    let limited = false;
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
          "item/reasoning/summaryTextDelta": ({ params }) => {
            if (params.threadId !== codexThreadId) return;
            emit(
              RuntimeEvent.cases["reasoning.delta"].make({
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
              reasoning: (item) =>
                subagent || !item.summary.length
                  ? null
                  : RuntimeEvent.cases["reasoning.completed"].make({
                      threadId,
                      messageId: item.id,
                      text: item.summary.join("\n\n"),
                    }),
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
            // Codex doesn't say when the limit resets; the session manager asks for the windows.
            if (
              params.turn.status === "failed" &&
              (limited || params.turn.error?.codexErrorInfo === "usageLimitExceeded")
            )
              emit(
                RuntimeEvent.cases["thread.limitStop"].make({
                  threadId,
                  limitStop: { provider: "codex", resetsAt: null, resumeAtReset: null },
                }),
              );
            limited = false;
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
            if (params.threadId === codexThreadId) {
              limited ||= params.error.codexErrorInfo === "usageLimitExceeded";
              emit(RuntimeEvent.cases.error.make({ threadId, message: params.error.message }));
            } else {
              // A subagent's error is its own: it ends its row instead of showing on the thread.
              const subagent = subagents.get(params.threadId);
              if (subagent) closeSubagent(subagent, params.error.message, true);
            }
          },
          "thread/tokenUsage/updated": ({ params }) => {
            if (params.threadId === codexThreadId) {
              void threadUsage(params.tokenUsage, currentModel ?? startedModel).then((usage) =>
                emit(RuntimeEvent.cases["thread.usage"].make({ threadId, usage })),
              );
              return;
            }
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
      // Each process numbers its requests from 0, and the transcript keeps approvals across relaunches.
      const requestId = `codex-${randomUUID()}`;
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
            onExit: (code, stderrTail) => {
              const crashed = code !== 0 && code !== null;
              if (crashed)
                emit(
                  RuntimeEvent.cases.error.make({
                    threadId,
                    message: `Codex exited unexpectedly (code ${code})${
                      stderrTail.trim() ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""
                    }. Send a message to pick the thread back up.`,
                  }),
                );
              emit(
                RuntimeEvent.cases["thread.status"].make({
                  threadId,
                  status: crashed ? "error" : "closed",
                }),
              );
            },
          },
          {
            ...launch,
            args: [
              ...launch.args,
              ...(mcpServer
                ? [
                    "-c",
                    `mcp_servers.browser.url="${mcpServer.url}"`,
                    "-c",
                    'mcp_servers.browser.bearer_token_env_var="APCODE_MCP_TOKEN"',
                    "-c",
                    `mcp_servers.apcode.url="${mcpServer.url}/apcode"`,
                    "-c",
                    'mcp_servers.apcode.bearer_token_env_var="APCODE_MCP_TOKEN"',
                    // Waiting on another thread's agent takes minutes; Codex gives up on a tool after 60 s by default.
                    "-c",
                    "mcp_servers.apcode.tool_timeout_sec=1800",
                  ]
                : []),
              // Codex leaves its thinking out of the transcript unless asked for summaries.
              "-c",
              'model_reasoning_summary="auto"',
            ],
            env: { ...launch.env, ...(mcpServer && { APCODE_MCP_TOKEN: mcpServer.token }) },
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
    const startEffort = effort && toCodexEffort(effort);
    const threadParams = {
      cwd,
      model: currentModel,
      config: startEffort ? { model_reasoning_effort: startEffort } : null,
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
    startedModel = started.model;
    onResumeToken(codexThreadId);

    const input = (turn: TurnInput) => {
      const text = textWithFiles(turn);
      return [
        ...(turn.handoff ? [{ type: "text", text: turn.handoff, text_elements: [] }] : []),
        ...turn.attachments
          .filter((a) => a.isImage)
          .map((a) => ({ type: "localImage", path: a.path })),
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
        ...turn.skills.flatMap(({ name, path }) =>
          path === null ? [] : [{ type: "skill", name, path }],
        ),
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
              serviceTierForTurn:
                turn.fast === undefined ? null : turn.fast ? CODEX_FAST_TIER : "default",
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

/** `thread/revert` cuts history before a turn id, so look up the oldest of the last `dropTurns` turns. */
async function dropLastTurns(rpc: CodexRpc, threadId: string, dropTurns: number) {
  if (dropTurns <= 0) return;
  const { data: turns } = await rpc.request(
    "thread/turns/list",
    { threadId, limit: dropTurns, sortDirection: "desc" },
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  );
  const firstDropped = turns[dropTurns - 1];
  if (firstDropped === undefined)
    throw new Error(`the thread has ${turns.length} turns, can't drop ${dropTurns}`);
  await rpc.request("thread/revert", { threadId, beforeTurnId: firstDropped.id }, Schema.Unknown);
}

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
        await dropLastTurns(rpc, resumeToken, dropTurns);
        return resumeToken;
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(`Couldn't rewind: ${e instanceof Error ? e.message : String(e)}`),
  });

/** Forks the thread in a short-lived app-server and drops the fork's last turns. */
const fork: ProviderAdapter["fork"] = ({ cwd, harness, resumeToken, dropTurns }) =>
  Effect.tryPromise({
    try: async () => {
      const rpc = await connectCodex(cwd, {}, harnessLaunch("codex", harness));
      try {
        const { thread } = await rpc.request(
          "thread/fork",
          { threadId: resumeToken, excludeTurns: true, cwd },
          ThreadResponse,
        );
        await dropLastTurns(rpc, thread.id, dropTurns);
        return thread.id;
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(`Couldn't fork: ${e instanceof Error ? e.message : String(e)}`),
  });

/** Codex reports a thread's token usage as it loads it, so a short-lived app-server resumes it and waits for that. */
const readUsage: ProviderAdapter["readUsage"] = ({ cwd, harness, resumeToken, model }) =>
  Effect.tryPromise({
    try: async () => {
      let report: (usage: TokenUsage) => void = () => {};
      const reported = new Promise<TokenUsage>((resolve) => (report = resolve));
      const rpc = await connectCodex(
        cwd,
        {
          onNotification: (notification) => {
            if (
              CodexNotification.guards["thread/tokenUsage/updated"](notification) &&
              notification.params.threadId === resumeToken
            )
              report(notification.params.tokenUsage);
          },
        },
        harnessLaunch("codex", harness),
      );
      try {
        const resumed = await rpc.request(
          "thread/resume",
          { threadId: resumeToken, excludeTurns: true, cwd },
          ThreadResponse,
        );
        const usage = await Promise.race([
          reported,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        return usage
          ? await threadUsage(usage, model ?? resumed.model)
          : { context: null, costUsd: null };
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(`Couldn't read usage: ${e instanceof Error ? e.message : String(e)}`),
  });

const listSkills: ProviderAdapter["listSkills"] = ({ cwd, harness }) =>
  Effect.tryPromise({
    try: async () => {
      const rpc = await connectCodex(cwd, {}, harnessLaunch("codex", harness));
      try {
        const { data } = await rpc.request(
          "skills/list",
          { cwds: [cwd] },
          Schema.Struct({
            data: Schema.Array(
              Schema.Struct({
                skills: Schema.Array(
                  Schema.Struct({
                    name: Schema.String,
                    description: Schema.String,
                    path: Schema.String,
                    enabled: Schema.Boolean,
                  }),
                ),
              }),
            ),
          }),
        );
        return data.flatMap((entry) =>
          entry.skills.flatMap(({ name, description, path, enabled }) =>
            enabled ? [{ name, description, path }] : [],
          ),
        );
      } finally {
        rpc.close();
      }
    },
    catch: (e) => fail(e instanceof Error ? e.message : String(e)),
  });

export const CodexAdapter: ProviderAdapter = {
  kind: "codex",
  start,
  rewind,
  fork,
  readUsage,
  listSkills,
};
