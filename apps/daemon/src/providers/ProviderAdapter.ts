import {
  RuntimeEvent,
  type ApprovalDecision,
  type Attachment,
  type Effort,
  type PermissionLevel,
  type ProviderKind,
  type ProviderSettings,
  type Skill,
  type SlashCommand,
  type ThreadUsage,
  type UserAnswers,
  type UserQuestion,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { randomUUID, type UUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { DEVICES_SUPPORTED } from "../devices.ts";
import type { McpServerAccess } from "../mcp.ts";
import { getErrorMessage } from "../errors.ts";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/** Runs a promise as an Effect that fails with a ProviderError carrying the rejection's message. */
export function tryProviderPromise<A>(
  provider: ProviderKind,
  run: (signal: AbortSignal) => PromiseLike<A>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => new ProviderError({ provider, message: getErrorMessage(error) }),
  });
}

/** Says what was being done before the message of any ProviderError, as "context: message". */
export function prefixErrorMessage(context: string) {
  return <A, R>(self: Effect.Effect<A, ProviderError, R>) =>
    Effect.mapError(
      self,
      (error) =>
        new ProviderError({ provider: error.provider, message: `${context}: ${error.message}` }),
    );
}

export interface StartSessionInput {
  /** The thread the session belongs to; every event the adapter emits carries it. */
  readonly threadId: string;
  readonly cwd: string;
  /** The harness's Settings, for how to launch its CLI. */
  readonly harness: ProviderSettings;
  readonly model?: string | undefined;
  /** Provider-side conversation id from a previous session; the adapter resumes it instead of starting fresh. */
  readonly resumeToken?: string | undefined;
  /** Settings of the turn that starts the session; later turns change them through `send`. */
  readonly effort: Effort | null;
  readonly permission: PermissionLevel;
  /** Called whenever the provider-side conversation id becomes known (persist it to resume later). */
  readonly onResumeToken: (token: string) => void;
  /** Called with the folder the agent works in when it starts and whenever it moves (Claude switching worktrees). */
  readonly onCwd: (cwd: string) => void;
  /** Adapters push normalized events for `threadId` here. */
  readonly emit: (event: RuntimeEvent) => void;
  /** Null leaves out MassCode's browser and thread tools. */
  readonly mcpServer: McpServerAccess | null;
}

/** One user message plus the composer settings it was sent with. */
export interface TurnInput {
  /** Our id for the message; providers that take one record it, so a rewind can find it. */
  readonly messageId: UUID;
  readonly text: string;
  /** Files on disk; images go to the model as images, the rest are listed as paths. */
  readonly attachments: ReadonlyArray<Attachment>;
  /** Null leaves the harness's current effort. */
  readonly effort: Effort | null;
  /** Absent leaves fast mode as it was. */
  readonly fast?: boolean | undefined;
  readonly permission: PermissionLevel;
  /** Skills the text mentions as `$name`, in the order they appear. */
  readonly skills: ReadonlyArray<ProviderSkill>;
  /** What happened in the thread on another harness, for the agent to read before the message. */
  readonly handoff: string | null;
}

/** A skill as the harness reports it; `path` is its SKILL.md, for harnesses that say. */
export interface ProviderSkill extends Skill {
  readonly path: string | null;
}

interface ListSkillsInput {
  readonly cwd: string;
  readonly harness: ProviderSettings;
}

/** A live conversation with one agent process. */
export interface ProviderSession {
  /** Applies the turn's effort and permission level (for this and later turns), then sends it. */
  readonly send: (turn: TurnInput) => Effect.Effect<void, ProviderError>;
  /** Adds a message to the turn in progress, for the agent to take in at its next step. */
  readonly steer: (turn: TurnInput) => Effect.Effect<void, ProviderError>;
  /** Summarizes the conversation so far to free up context; runs as a turn. */
  readonly compact: Effect.Effect<void, ProviderError>;
  /** Slash commands this session accepts at the start of a message. */
  readonly commands: Effect.Effect<ReadonlyArray<SlashCommand>, ProviderError>;
  readonly interrupt: Effect.Effect<void, ProviderError>;
  /** Stops the subagent started by tool call `toolId`, for harnesses that run subagents. */
  readonly stopAgent?: (toolId: string) => Effect.Effect<void, ProviderError>;
  readonly respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
    reply?: {
      /** Approving a plan: the level to build it with. */
      readonly permission?: PermissionLevel | undefined;
      readonly answers?: UserAnswers | undefined;
    },
  ) => Effect.Effect<void, ProviderError>;
  /** Switches model for subsequent turns; null reverts to the harness default where supported. */
  readonly setModel: (model: string | null) => Effect.Effect<void, ProviderError>;
  readonly close: Effect.Effect<void>;
}

export interface ForkInput {
  readonly cwd: string;
  readonly harness: ProviderSettings;
  readonly resumeToken: string;
  /** The user message to cut before (it goes too); null keeps the whole conversation. */
  readonly messageId: string | null;
  /** User messages before it that stay. */
  readonly keep: number;
  /** Turns from it on that go (steered messages don't start one). */
  readonly dropTurns: number;
}

interface RewindInput extends ForkInput {
  readonly messageId: string;
}

interface ReadUsageInput {
  readonly cwd: string;
  readonly harness: ProviderSettings;
  readonly resumeToken: string;
  readonly model: string | undefined;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly start: (input: StartSessionInput) => Effect.Effect<ProviderSession, ProviderError>;
  /**
   * Cuts the provider-side conversation back to before a message, with no session
   * running. Resolves to the token to resume from next; null starts over.
   */
  readonly rewind: (input: RewindInput) => Effect.Effect<string | null, ProviderError>;
  /**
   * Copies the provider-side conversation, cut like `rewind` would, leaving the original
   * as it is. Resolves to the copy's token; null starts over.
   */
  readonly fork: (input: ForkInput) => Effect.Effect<string | null, ProviderError>;
  /** The conversation's usage as of its last turn, read with no session running and no turn started. */
  readonly readUsage: (input: ReadUsageInput) => Effect.Effect<ThreadUsage, ProviderError>;
  /** The skills the harness loads in `cwd`, read with no session running. */
  readonly listSkills: (
    input: ListSkillsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderSkill>, ProviderError>;
}

/** Each process numbers its requests from 0, and the transcript keeps approvals across relaunches, so ids are our own. */
const APPROVAL_ID_PREFIX = {
  claude: "claude-perm",
  codex: "codex",
  cursor: "cursor",
} as const satisfies Record<ProviderKind, string>;

interface ApprovalPrompt {
  readonly title: string;
  readonly detail: string;
  /** The subagent asking, by name. */
  readonly agent?: string | undefined;
  /** Set when the "approval" is the user's answers. */
  readonly questions?: ReadonlyArray<UserQuestion> | undefined;
}

/**
 * The approvals a session waits on, keyed by request id, and the events that show them to the
 * user. `Entry` is what the adapter needs to answer its provider.
 */
export function createApprovalBook<Entry>(
  provider: ProviderKind,
  threadId: string,
  emit: (event: RuntimeEvent) => void,
) {
  const pending = new Map<string, Entry>();

  function withdraw(requestId: string) {
    const entry = pending.get(requestId);
    if (entry === undefined) return undefined;

    pending.delete(requestId);
    emit(RuntimeEvent.cases["approval.resolved"].make({ threadId, requestId }));
    return entry;
  }

  return {
    /** Files the entry and asks the user; returns the request id their answer comes back with. */
    request: (entry: Entry, prompt: ApprovalPrompt) => {
      const requestId = `${APPROVAL_ID_PREFIX[provider]}-${randomUUID()}`;
      pending.set(requestId, entry);

      emit(
        RuntimeEvent.cases["thread.status"].make({
          threadId,
          status: prompt.questions ? "awaiting-answer" : "awaiting-approval",
        }),
      );
      emit(RuntimeEvent.cases["approval.requested"].make({ threadId, requestId, ...prompt }));

      return requestId;
    },
    /** Removes the entry the user answered, for the adapter to pass the answer on. */
    take: (requestId: string) =>
      Effect.suspend(() => {
        const entry = pending.get(requestId);
        if (entry === undefined) {
          return Effect.fail(
            new ProviderError({ provider, message: `Unknown approval request ${requestId}` }),
          );
        }

        pending.delete(requestId);
        return Effect.succeed(entry);
      }),
    /** Tells clients a taken request is answered and the agent runs on. */
    resolve: (requestId: string, answers?: UserAnswers) => {
      emit(
        RuntimeEvent.cases["approval.resolved"].make(
          answers ? { threadId, requestId, answers } : { threadId, requestId },
        ),
      );
      emit(RuntimeEvent.cases["thread.status"].make({ threadId, status: "running" }));
    },
    /** Drops a request the agent stopped waiting on; the entry, if it was still pending. */
    withdraw,
    /** Drops every pending request, returning their entries. */
    withdrawAll: () => [...pending.keys()].flatMap((requestId) => withdraw(requestId) ?? []),
  };
}

/** Image extensions models take, with their media types. */
const IMAGE_TYPES = new Map<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp">([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** The turn's attached images that models take, read as base64, in the order they were attached. */
export function readImages(turn: TurnInput) {
  return Promise.all(
    turn.attachments.flatMap((attachment) => {
      const mediaType = IMAGE_TYPES.get(extname(attachment.path).toLowerCase());
      return attachment.isImage && mediaType
        ? [readFile(attachment.path).then((data) => ({ mediaType, data: data.toString("base64") }))]
        : [];
    }),
  );
}

/** MassCode's MCP servers an agent can reach, for each adapter to hand over in its harness's format. */
export function listMcpEndpoints(mcpServer: McpServerAccess) {
  return [
    { name: "browser", url: mcpServer.url },
    { name: "masscode", url: `${mcpServer.url}/masscode` },
    ...(DEVICES_SUPPORTED ? [{ name: "device", url: `${mcpServer.url}/device` }] : []),
  ] as const;
}

/**
 * Reports a session's harness process ending, as `name` (like "Codex"): a crash says why and how
 * to recover; either way the thread's status follows.
 */
export function handleHarnessExit(
  name: string,
  threadId: string,
  emit: (event: RuntimeEvent) => void,
) {
  return (code: number | null, stderrTail: string) => {
    const hasCrashed = code !== 0 && code !== null;
    if (hasCrashed) {
      emit(
        RuntimeEvent.cases.error.make({
          threadId,
          message: `${name} exited unexpectedly (code ${code})${
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
  };
}

/** One-line human summary of a tool input, for the transcript. */
export function summarizeToolInput(input: Schema.Json): string {
  if (input === null) return "";
  if (!Predicate.isObjectOrArray(input)) return String(input);
  if (Object.keys(input).length === 0) return "";

  const summary = Schema.is(Schema.JsonObject)(input)
    ? [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
        "description",
        "target",
        "key",
        "expression",
      ]
        .map((field) => input[field])
        .find(Predicate.isString)
    : undefined;
  if (summary !== undefined) return summary;

  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/** The message text with non-image attachments listed as paths for the agent to read. */
export function formatTextWithFiles(turn: TurnInput) {
  const files = turn.attachments.filter((attachment) => !attachment.isImage);
  if (!files.length) return turn.text;

  const list = files.map((file) => `- ${file.path}`).join("\n");
  return `${turn.text}${turn.text ? "\n\n" : ""}Attached files:\n${list}`;
}
