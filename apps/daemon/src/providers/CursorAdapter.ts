/**
 * Cursor via `cursor-agent acp`, the Agent Client Protocol server in Cursor's CLI. It runs on the
 * user's Cursor login.
 */
import {
  Effort,
  RuntimeEvent,
  type ModelOption,
  type SlashCommand,
  type UserQuestion,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  ConfigOption,
  connectAcp,
  getContentText,
  PermissionRequest,
  PromptResponse,
  SessionSetup,
  SessionUpdate,
  type RpcId,
  type ToolContent,
} from "./acp.ts";
import type { JsonRpc } from "./jsonRpc.ts";
import { resolveHarnessLaunch, type HarnessLaunch } from "./launch.ts";
import {
  IMAGE_TYPES,
  ProviderError,
  formatTextWithFiles,
  type ProviderAdapter,
  type ProviderSession,
  type StartSessionInput,
  type TurnInput,
} from "./ProviderAdapter.ts";
import { DEVICES_SUPPORTED } from "../devices.ts";
import { findSkillMentions } from "../skills.ts";

function createError(message: string) {
  return new ProviderError({ provider: "cursor", message });
}

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Cursor's id for its Auto model; its CLI calls it `auto`. */
const AUTO = "default";

/**
 * Model is only picked at launch: switching it over ACP is accepted and then ignored, which also
 * leaves the model's effort and fast settings unknown to the session.
 */
function buildAcpArgs(launch: HarnessLaunch, model: string | null) {
  return [...launch.args, ...buildCursorModelFlag(model), "acp"];
}

/** The CLI flag that picks `model`; none leaves the CLI's own default. */
export function buildCursorModelFlag(model: string | null | undefined) {
  return model ? ["--model", model === AUTO ? "auto" : model] : [];
}

/** Effort as MassCode names it; some models spell xhigh "extra-high". */
function toEffort(value: string) {
  const effort = value === "extra-high" ? "xhigh" : value;
  return Schema.is(Effort)(effort) ? effort : undefined;
}

/** The setting a model takes its effort from: `effort`, `reasoning` or `reasoning_effort`, by model. */
function findEffortOption(options: ReadonlyArray<ConfigOption>) {
  return options.find((option) => option.category === "thought_level" && option.id !== "thinking");
}

const ListedModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      name: Schema.String,
      configOptions: Schema.Array(ConfigOption),
    }),
  ),
});

/** The models the account can use, with each one's efforts and fast mode. */
export async function readCursorModels(launch: HarnessLaunch): Promise<Array<ModelOption>> {
  const rpc = await connectAcp("Cursor", launch, buildAcpArgs(launch, null), undefined);
  try {
    const { models } = await rpc.request("cursor/list_available_models", {}, ListedModels);

    return models.map((model) => {
      const effort = findEffortOption(model.configOptions);
      return {
        id: model.value,
        label: model.name,
        recommended: model.value === AUTO || undefined,
        defaultEffort: Predicate.isString(effort?.currentValue)
          ? toEffort(effort.currentValue)
          : undefined,
        efforts: (effort?.options ?? []).flatMap((option) => toEffort(option.value) ?? []),
        fast: model.configOptions.some((option) => option.id === "fast") || undefined,
      };
    });
  } finally {
    rpc.close();
  }
}

const CreatePlan = Schema.Struct({ plan: Schema.String });

const AskQuestion = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  ),
});

/** Turn endings that aren't the agent finishing or the user stopping it. */
const STOPPED_EARLY = new Map([
  ["max_tokens", "Cursor stopped: the reply hit the model's output limit."],
  [
    "max_turn_requests",
    "Cursor stopped: the turn hit its limit of model requests. Send a message to carry on.",
  ],
  ["refusal", "Cursor's model refused to continue."],
]);

/** Transcript names for ACP's tool kinds, the ones Claude's tools show under. */
const TOOL_NAME = new Map([
  ["execute", "Bash"],
  ["edit", "Edit"],
  ["read", "Read"],
  ["search", "Grep"],
  ["fetch", "WebFetch"],
  ["delete", "Delete"],
  ["move", "Move"],
]);

/** The fields of a tool's raw input and output that the transcript shows. */
const ToolRaw = Schema.Struct({
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  /** A read file's text. */
  content: Schema.optional(Schema.String),
});

function decodeToolRaw(raw: Schema.Json | undefined): typeof ToolRaw.Type {
  return Option.getOrElse(Schema.decodeUnknownOption(ToolRaw)(raw), () => ({}));
}

/** What a finished tool printed or changed. */
function formatToolOutput(update: {
  readonly content?: ReadonlyArray<ToolContent> | null | undefined;
  readonly rawOutput?: Schema.Json | undefined;
}) {
  const text = getContentText(update.content);
  if (text) return text;
  if (update.rawOutput === undefined || update.rawOutput === null) return "";
  if (Predicate.isString(update.rawOutput)) return update.rawOutput;

  const { stdout, stderr, content } = decodeToolRaw(update.rawOutput);
  return (
    [stdout, stderr].filter(Boolean).join("\n").trim() ||
    content ||
    JSON.stringify(update.rawOutput)
  );
}

type Pending =
  | {
      readonly kind: "permission";
      readonly rpcId: RpcId;
      readonly request: PermissionRequest;
      /** What "allow for this session" remembers it by. */
      readonly key: string;
    }
  | { readonly kind: "plan"; readonly rpcId: RpcId }
  | {
      readonly kind: "question";
      readonly rpcId: RpcId;
      readonly questions: typeof AskQuestion.Type.questions;
    };

function start({
  threadId,
  cwd,
  harness,
  model: initialModel,
  resumeToken,
  permission: initialPermission,
  onResumeToken,
  emit,
  mcpServer,
}: StartSessionInput) {
  return Effect.gen(function* () {
    const launch = yield* Effect.try({
      try: () => resolveHarnessLaunch("cursor", harness),
      catch: (error) => createError(getErrorMessage(error)),
    });

    let rpc: JsonRpc | undefined;
    // Bumped on each launch, so a process closed for a relaunch doesn't report its exit.
    let generation = 0;
    let sessionId = resumeToken ?? "";
    let model = initialModel ?? null;
    let launchedModel: string | null = null;
    let permission = initialPermission;
    let configOptions: ReadonlyArray<ConfigOption> = [];
    let commands: ReadonlyArray<SlashCommand> = [];
    /** Set while `session/load` replays the conversation, which the transcript already has. */
    let isReplaying = false;
    let reply: { readonly id: string; text: string } | null = null;
    let thought: { readonly id: string; text: string } | null = null;
    const runningTools = new Set<string>();
    /** Edits started without saying which file, by tool id, with their transcript name. */
    const unnamedEdits = new Map<string, string>();
    const commandOf = new Map<string, string>();
    const pending = new Map<string, Pending>();
    const allowedForSession = new Set<string>();
    let isPrompting = false;
    /** Messages sent while a turn runs: ACP can't add to a turn, so each starts the next one. */
    const steered: Array<TurnInput> = [];
    /** Runs once the turn ends, in place of going idle: building an approved plan. */
    let afterTurn: (() => void) | null = null;

    const mcpServers = mcpServer
      ? [
          { name: "browser", url: mcpServer.url },
          { name: "masscode", url: `${mcpServer.url}/masscode` },
          ...(DEVICES_SUPPORTED ? [{ name: "device", url: `${mcpServer.url}/device` }] : []),
        ].map((server) => ({
          type: "http",
          ...server,
          headers: [{ name: "Authorization", value: `Bearer ${mcpServer.token}` }],
        }))
      : [];

    function finishThought() {
      if (thought?.text) {
        emit(
          RuntimeEvent.cases["reasoning.completed"].make({
            threadId,
            messageId: thought.id,
            text: thought.text,
          }),
        );
      }
      thought = null;
    }

    /** Ends the reply and thought in progress: a tool call or the turn's end closes both. */
    function finishText() {
      finishThought();
      if (reply?.text) {
        emit(
          RuntimeEvent.cases["assistant.completed"].make({
            threadId,
            messageId: reply.id,
            text: reply.text,
          }),
        );
      }
      reply = null;
    }

    function startTool(toolId: string, name: string, summary: string) {
      runningTools.add(toolId);
      emit(RuntimeEvent.cases["tool.started"].make({ threadId, toolId, name, summary }));
    }

    // The process holds one session. What `session/load` replays is in the transcript already;
    // the commands and options it reports alongside aren't.
    function onUpdate(update: SessionUpdate) {
      if (
        isReplaying &&
        !SessionUpdate.isAnyOf(["available_commands_update", "config_option_update"])(update)
      ) {
        return;
      }

      SessionUpdate.match(update, {
        agent_thought_chunk: ({ content }) => {
          if (!content.text) return;

          if (reply) finishText();
          thought ??= { id: randomUUID(), text: "" };
          thought.text += content.text;
          emit(
            RuntimeEvent.cases["reasoning.delta"].make({
              threadId,
              messageId: thought.id,
              delta: content.text,
            }),
          );
        },
        agent_message_chunk: ({ content }) => {
          if (!content.text) return;

          finishThought();
          reply ??= { id: randomUUID(), text: "" };
          reply.text += content.text;
          emit(
            RuntimeEvent.cases["assistant.delta"].make({
              threadId,
              messageId: reply.id,
              delta: content.text,
            }),
          );
        },
        tool_call: (call) => {
          finishText();
          if (runningTools.has(call.toolCallId) || unnamedEdits.has(call.toolCallId)) return;

          const { command, path } = decodeToolRaw(call.rawInput);
          if (command) commandOf.set(call.toolCallId, command);
          const name = TOOL_NAME.get(call.kind ?? "") ?? call.title ?? "Tool";
          const summary = command ?? path ?? call.locations?.[0]?.path;
          if (summary === undefined && call.kind === "edit") {
            // Cursor names an edit's file only once it's made; the row waits for it.
            unnamedEdits.set(call.toolCallId, name);
          } else {
            startTool(call.toolCallId, name, summary ?? call.title ?? "");
          }
        },
        tool_call_update: (update) => {
          const isDone = update.status === "completed" || update.status === "failed";
          const unnamed = unnamedEdits.get(update.toolCallId);
          const path =
            update.locations?.[0]?.path ??
            update.content?.flatMap((part) => (part.type === "diff" ? [part.path] : []))[0];
          if (unnamed !== undefined && (path !== undefined || isDone)) {
            unnamedEdits.delete(update.toolCallId);
            startTool(update.toolCallId, unnamed, path ?? update.title ?? "");
          }

          if (!isDone || !runningTools.delete(update.toolCallId)) return;

          emit(
            RuntimeEvent.cases["tool.completed"].make({
              threadId,
              toolId: update.toolCallId,
              output: formatToolOutput(update),
              isError: update.status === "failed",
            }),
          );
        },
        available_commands_update: ({ availableCommands }) => {
          commands = availableCommands.map((command) => ({
            name: command.name,
            description: command.description,
            argumentHint: command.input?.hint ?? "",
          }));
        },
        config_option_update: (update) => {
          configOptions = update.configOptions;
        },
      });
    }

    function requestApproval(
      rpcId: RpcId,
      entry: Pending,
      title: string,
      detail: string,
      questions?: ReadonlyArray<UserQuestion>,
    ) {
      // Each process numbers its requests from 0, and the transcript keeps approvals across relaunches.
      const requestId = `cursor-${randomUUID()}`;
      pending.set(requestId, entry);

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
          title,
          detail,
          questions,
        }),
      );
    }

    function onRequest(rpcId: RpcId, method: string, params: Schema.Json | undefined) {
      if (method === "session/request_permission") {
        const request = Option.getOrUndefined(
          Schema.decodeUnknownOption(PermissionRequest)(params),
        );
        if (!request) return false;

        const { toolCall } = request;
        const command = commandOf.get(toolCall.toolCallId);
        const key = `${toolCall.kind}:${command ?? toolCall.title}`;
        if (permission === "full-access" || allowedForSession.has(key)) {
          answerPermission(rpcId, request, "allow_once");
          return true;
        }

        requestApproval(
          rpcId,
          { kind: "permission", rpcId, request, key },
          toolCall.kind === "execute" ? "Run command" : (toolCall.title ?? "Allow this?"),
          command ?? getContentText(toolCall.content),
        );
        return true;
      }

      if (method === "cursor/create_plan") {
        const plan = Option.getOrUndefined(Schema.decodeUnknownOption(CreatePlan)(params));
        if (!plan) return false;

        // Outside plan mode a plan is the agent's own outline: nothing to approve.
        if (permission !== "plan") rpc?.respond(rpcId, { outcome: { outcome: "accepted" } });
        else requestApproval(rpcId, { kind: "plan", rpcId }, "ExitPlanMode", plan.plan);
        return true;
      }

      if (method === "cursor/ask_question") {
        const asked = Option.getOrUndefined(Schema.decodeUnknownOption(AskQuestion)(params));
        if (!asked) return false;

        requestApproval(
          rpcId,
          { kind: "question", rpcId, questions: asked.questions },
          "AskUserQuestion",
          asked.questions.map((question) => question.prompt).join("\n"),
          asked.questions.map((question) => ({
            id: question.id,
            header: asked.title ?? "Question",
            question: question.prompt,
            options: question.options.map((option) => ({ label: option.label, description: "" })),
            multiSelect: question.allowMultiple ?? false,
          })),
        );
        return true;
      }

      return false;
    }

    function answerPermission(rpcId: RpcId, request: PermissionRequest, kind: string) {
      const option = request.options.find((candidate) => candidate.kind === kind);
      rpc?.respond(
        rpcId,
        option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
    }

    async function launchAgent() {
      const launched = ++generation;
      rpc?.close();
      launchedModel = model;
      rpc = await connectAcp("Cursor", launch, buildAcpArgs(launch, model), cwd, {
        onUpdate,
        onRequest,
        onExit: (code, stderrTail) => {
          if (launched !== generation) return;

          const hasCrashed = code !== 0 && code !== null;
          if (hasCrashed) {
            emit(
              RuntimeEvent.cases.error.make({
                threadId,
                message: `Cursor exited unexpectedly (code ${code})${
                  stderrTail.trim() ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""
                }. Send a message to pick the thread back up.`,
              }),
            );
          }
          emit(
            RuntimeEvent.cases["thread.status"].make({
              threadId,
              status: hasCrashed ? "error" : "closed",
            }),
          );
        },
      });

      const resumed = sessionId
        ? await (async () => {
            isReplaying = true;
            try {
              return await rpc.request(
                "session/load",
                { sessionId, cwd, mcpServers },
                SessionSetup,
              );
            } catch {
              // Gone from Cursor's store (or another machine's): carry on in a new conversation.
              return null;
            } finally {
              isReplaying = false;
            }
          })()
        : null;

      const setup =
        resumed ?? (await rpc.request("session/new", { cwd, mcpServers }, SessionSetup));
      if (!resumed && setup.sessionId) {
        sessionId = setup.sessionId;
        onResumeToken(sessionId);
      }
      configOptions = setup.configOptions ?? configOptions;
    }

    async function setConfigOption(configId: string, value: string) {
      const current = configOptions.find((option) => option.id === configId);
      if (!current || current.currentValue === value) return;

      const result = await rpc!.request(
        "session/set_config_option",
        { sessionId, configId, value },
        SessionSetup,
      );
      configOptions = result.configOptions ?? configOptions;
    }

    async function buildPromptBlocks(turn: TurnInput) {
      const images = await Promise.all(
        turn.attachments.flatMap((attachment) => {
          const mimeType = IMAGE_TYPES.get(extname(attachment.path).toLowerCase());
          return attachment.isImage && mimeType
            ? [
                readFile(attachment.path).then((data) => ({
                  type: "image",
                  mimeType,
                  data: data.toString("base64"),
                })),
              ]
            : [];
        }),
      );

      const written = formatTextWithFiles(turn);
      // Cursor takes a `/name` anywhere in the message as the skill to load.
      const text = findSkillMentions(written, turn.skills).reduce(
        (result, mention) => `${result.slice(0, mention.start)}/${result.slice(mention.start + 1)}`,
        written,
      );

      return [
        ...(turn.handoff ? [{ type: "text", text: turn.handoff }] : []),
        ...images,
        ...(text ? [{ type: "text", text }] : []),
      ];
    }

    /** Applies the turn's settings and starts it; resolves once Cursor has it, not when it ends. */
    async function beginTurn(turn: TurnInput) {
      emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
      permission = turn.permission;
      if (!rpc || model !== launchedModel) await launchAgent();

      await setConfigOption("mode", permission === "plan" ? "plan" : "agent");
      const effort = findEffortOption(configOptions);
      const effortValue = effort?.options?.find(
        (option) => turn.effort !== null && toEffort(option.value) === turn.effort,
      )?.value;
      if (effort && effortValue) await setConfigOption(effort.id, effortValue);
      if (turn.fast !== undefined) await setConfigOption("fast", String(turn.fast));

      const blocks = await buildPromptBlocks(turn);
      const startedAt = Date.now();
      const launched = generation;
      isPrompting = true;
      void rpc!
        .request("session/prompt", { sessionId, prompt: blocks }, PromptResponse)
        .then(
          ({ stopReason }) => {
            finishText();
            const stopMessage = STOPPED_EARLY.get(stopReason);
            if (stopMessage)
              emit(RuntimeEvent.cases.error.make({ threadId, message: stopMessage }));
          },
          (error) => {
            finishText();
            // A process that exited has said so already.
            if (launched === generation && !getErrorMessage(error).startsWith("Cursor exited")) {
              emit(RuntimeEvent.cases.error.make({ threadId, message: getErrorMessage(error) }));
            }
          },
        )
        .then(() => {
          isPrompting = false;
          // Tools still open when the turn ends were cut off: stopped, or the process went.
          for (const toolId of runningTools) {
            emit(
              RuntimeEvent.cases["tool.completed"].make({
                threadId,
                toolId,
                output: "Stopped",
                isError: false,
              }),
            );
          }
          runningTools.clear();
          unnamedEdits.clear();
          emit(
            RuntimeEvent.cases["turn.completed"].make({
              threadId,
              durationMs: Date.now() - startedAt,
            }),
          );

          const next = afterTurn ?? (steered.length ? () => void runTurn(steered.shift()!) : null);
          afterTurn = null;
          if (next) next();
          else emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
        });
    }

    function runTurn(turn: TurnInput) {
      beginTurn(turn).catch((error) => {
        emit(RuntimeEvent.cases.error.make({ threadId, message: getErrorMessage(error) }));
        emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "idle" }));
      });
    }

    yield* Effect.tryPromise({
      try: launchAgent,
      catch: (error) => createError(getErrorMessage(error)),
    });

    const session: ProviderSession = {
      send: (turn) =>
        Effect.tryPromise({
          try: () => beginTurn(turn),
          catch: (error) => createError(getErrorMessage(error)),
        }),
      steer: (turn) =>
        Effect.suspend(() => {
          if (!isPrompting) return session.send(turn);

          steered.push(turn);
          return Effect.void;
        }),
      compact: Effect.fail(
        createError("Cursor can't compact a conversation. Start a new thread to free up context."),
      ),
      commands: Effect.sync(() => commands),
      interrupt: Effect.sync(() => {
        steered.length = 0;
        afterTurn = null;
        for (const [requestId, entry] of pending) {
          rpc?.respond(entry.rpcId, { outcome: { outcome: "cancelled" } });
          emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
        }
        pending.clear();
        rpc?.notify("session/cancel", { sessionId });
      }),
      respondApproval: (requestId, decision, { permission: buildPermission, answers } = {}) =>
        Effect.suspend(() => {
          const entry = pending.get(requestId);
          if (!entry) return Effect.fail(createError(`Unknown approval request ${requestId}`));

          pending.delete(requestId);
          switch (entry.kind) {
            case "permission":
              if (decision === "allow-session") allowedForSession.add(entry.key);
              answerPermission(
                entry.rpcId,
                entry.request,
                decision === "deny" ? "reject_once" : "allow_once",
              );
              break;
            case "plan":
              rpc?.respond(entry.rpcId, {
                outcome: { outcome: decision === "deny" ? "rejected" : "accepted" },
              });
              // Cursor ends its turn with the plan; building it is the next one.
              if (decision !== "deny") {
                permission = buildPermission ?? "auto-edit";
                afterTurn = () =>
                  runTurn({
                    messageId: randomUUID(),
                    text: "The user approved the plan. Implement it now.",
                    attachments: [],
                    effort: null,
                    permission,
                    skills: [],
                    handoff: null,
                  });
              }
              break;
            case "question":
              rpc?.respond(
                entry.rpcId,
                decision === "deny" || !answers
                  ? { outcome: { outcome: "skipped", reason: "The user chose not to answer" } }
                  : {
                      outcome: {
                        outcome: "answered",
                        answers: entry.questions.map((question) => ({
                          questionId: question.id,
                          selectedOptionIds: question.options
                            .filter((option) => answers[question.id]?.includes(option.label))
                            .map((option) => option.id),
                        })),
                      },
                    },
              );
          }

          emit(
            RuntimeEvent.cases["approval.resolved"].make({
              threadId,
              requestId,
              answers: entry.kind === "question" && decision !== "deny" ? answers : undefined,
            }),
          );
          emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));

          return Effect.void;
        }),
      // Cursor only takes a model at launch, so the next turn relaunches it.
      setModel: (next) => Effect.sync(() => void (model = next)),
      close: Effect.sync(() => rpc?.close()),
    };

    return session;
  });
}

/** Cursor lists skills among its slash commands, telling them apart by a note on the description. */
const SKILL_NOTE = /\s*\((?:(?:builtin|user|project) )?skill\)$/;

/** The skills Cursor reports in `cwd`, read from the commands a new session announces. */
const listSkills: ProviderAdapter["listSkills"] = ({ cwd, harness }) =>
  Effect.tryPromise({
    try: async () => {
      let report: (
        commands: ReadonlyArray<{ name: string; description: string }>,
      ) => void = () => {};
      const reported = new Promise<ReadonlyArray<{ name: string; description: string }>>(
        (resolve) => (report = resolve),
      );
      const launch = resolveHarnessLaunch("cursor", harness);
      const rpc = await connectAcp("Cursor", launch, buildAcpArgs(launch, null), cwd, {
        onUpdate: (update) => {
          if (SessionUpdate.guards.available_commands_update(update)) {
            report(update.availableCommands);
          }
        },
      });
      try {
        await rpc.request("session/new", { cwd, mcpServers: [] }, SessionSetup);
        const commands = await Promise.race([
          reported,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
        ]);
        if (commands === null) throw new Error("Cursor didn't list its skills within 15 s");

        return commands.flatMap(({ name, description }) =>
          SKILL_NOTE.test(description)
            ? [{ name, description: description.replace(SKILL_NOTE, ""), path: null }]
            : [],
        );
      } finally {
        rpc.close();
      }
    },
    catch: (error) => createError(getErrorMessage(error)),
  });

function failUnsupported(action: string) {
  return () => Effect.fail(createError(`Cursor can't ${action} a conversation yet.`));
}

export const CursorAdapter: ProviderAdapter = {
  kind: "cursor",
  start,
  rewind: failUnsupported("rewind"),
  fork: failUnsupported("fork"),
  readUsage: () => Effect.succeed({ context: null, costUsd: null }),
  listSkills,
};
