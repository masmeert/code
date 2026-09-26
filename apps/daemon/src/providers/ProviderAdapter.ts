import type {
  ApprovalDecision,
  Attachment,
  Effort,
  PermissionLevel,
  ProviderKind,
  ProviderSettings,
  RuntimeEvent,
  SlashCommand,
  ThreadUsage,
} from "@apcode/contracts";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { UUID } from "node:crypto";
import type { McpServerAccess } from "../mcp.ts";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

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
  /** Adapters push normalized events for `threadId` here. */
  readonly emit: (event: RuntimeEvent) => void;
  readonly mcpServer: McpServerAccess;
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
  readonly permission: PermissionLevel;
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
  ) => Effect.Effect<void, ProviderError>;
  /** Switches model for subsequent turns; null reverts to the harness default where supported. */
  readonly setModel: (model: string | null) => Effect.Effect<void, ProviderError>;
  readonly close: Effect.Effect<void>;
}

export interface RewindInput {
  readonly cwd: string;
  readonly harness: ProviderSettings;
  readonly resumeToken: string;
  /** The user message to rewind to before (it goes too). */
  readonly messageId: string;
  /** User messages before it that stay. */
  readonly keep: number;
  /** Turns from it on that go (steered messages don't start one). */
  readonly dropTurns: number;
}

export interface ReadUsageInput {
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
  /** The conversation's usage as of its last turn, read with no session running and no turn started. */
  readonly readUsage: (input: ReadUsageInput) => Effect.Effect<ThreadUsage, ProviderError>;
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
export const textWithFiles = (turn: TurnInput) => {
  const files = turn.attachments.filter((a) => !a.isImage);
  if (!files.length) return turn.text;
  const list = files.map((a) => `- ${a.path}`).join("\n");
  return `${turn.text}${turn.text ? "\n\n" : ""}Attached files:\n${list}`;
};
