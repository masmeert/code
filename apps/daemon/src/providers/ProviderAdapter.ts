import type { ApprovalDecision, Attachment, Effort, PermissionLevel, ProviderEvent, ProviderKind } from "@apcode/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

export interface StartSessionInput {
  readonly cwd: string;
  readonly model?: string | undefined;
  /** Provider-side conversation id from a previous session; the adapter resumes it instead of starting fresh. */
  readonly resumeToken?: string | undefined;
  /** Settings of the turn that starts the session; later turns change them through `send`. */
  readonly effort: Effort | null;
  readonly permission: PermissionLevel;
  /** Called whenever the provider-side conversation id becomes known (persist it to resume later). */
  readonly onResumeToken: (token: string) => void;
  /** Adapters push normalized events here; the session manager stamps the thread id. */
  readonly emit: (event: ProviderEvent) => void;
}

/** One user message plus the composer settings it was sent with. */
export interface TurnInput {
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
  readonly interrupt: Effect.Effect<void, ProviderError>;
  readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void, ProviderError>;
  /** Switches model for subsequent turns; null reverts to the harness default where supported. */
  readonly setModel: (model: string | null) => Effect.Effect<void, ProviderError>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly start: (input: StartSessionInput) => Effect.Effect<ProviderSession, ProviderError>;
}

/** One-line human summary of a tool input, for the transcript. */
export const summarizeToolInput = (input: unknown): string => {
  if (input === null || typeof input !== "object") return String(input ?? "");
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
};

/** The message text with non-image attachments listed as paths for the agent to read. */
export const textWithFiles = (turn: TurnInput) => {
  const files = turn.attachments.filter((a) => !a.isImage);
  if (!files.length) return turn.text;
  const list = files.map((a) => `- ${a.path}`).join("\n");
  return `${turn.text}${turn.text ? "\n\n" : ""}Attached files:\n${list}`;
};
