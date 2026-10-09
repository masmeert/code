import * as Schema from "effect/Schema";

export const TerminalInfo = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  /** Set on a terminal running one command from an agent's reply; it shows in the transcript, not the terminal panel. */
  command: Schema.optionalKey(Schema.String),
});

export type TerminalInfo = typeof TerminalInfo.Type;

/** A command the user ran from an agent's reply, and how it ended. */
export const CommandRun = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  /** The end of what it printed, as plain text. */
  output: Schema.String,
});

export type CommandRun = typeof CommandRun.Type;

/** The terminal a new worktree's setup command from `masscode.toml` runs in. */
export const WORKTREE_SETUP_TERMINAL_ID = "worktree-setup";
