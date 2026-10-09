import * as Schema from "effect/Schema";

export function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A command that can't be carried out; `message` tells the user why and what to do. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  message: Schema.String,
}) {}
