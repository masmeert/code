import * as Schema from "effect/Schema";

export const ProviderKind = Schema.Literals(["claude", "codex", "cursor"]);

export type ProviderKind = typeof ProviderKind.Type;

export const PROVIDER_NAME: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

/**
 * Reasoning effort; each model takes a subset. Ultracode and ultrathink are Claude modes picked
 * alongside the levels: Claude Code's xhigh with workflow orchestration, and the model's default
 * effort with the "ultrathink" keyword on every message.
 */
export const Effort = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
  "ultrathink",
]);

export type Effort = typeof Effort.Type;

export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The harness's own default pick, marked with a star in pickers. */
  recommended: Schema.optional(Schema.Boolean),
  /** Effort the harness uses for this model when none is picked; absent if it takes none or didn't say. */
  defaultEffort: Schema.optional(Effort),
  /** Efforts it takes, lowest first; absent if the harness didn't say. */
  efforts: Schema.optional(Schema.Array(Effort)),
  /** Offers fast mode. */
  fast: Schema.optional(Schema.Boolean),
});

export type ModelOption = typeof ModelOption.Type;

/** What the daemon knows about one harness CLI on this machine. */
export const ProviderStatus = Schema.Struct({
  kind: ProviderKind,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  linked: Schema.Boolean,
  /** Signed-in identity, usually an email. */
  account: Schema.NullOr(Schema.String),
  /** Subscription tier as the CLI reports it, e.g. "max", "plus". */
  plan: Schema.NullOr(Schema.String),
  models: Schema.Array(ModelOption),
  error: Schema.NullOr(Schema.String),
  /** Not checked yet, so nothing above is known: the first check after launch is still running. */
  checking: Schema.optional(Schema.Boolean),
});

export type ProviderStatus = typeof ProviderStatus.Type;

/** Progress of an interactive sign-in started from Settings. */
export const AuthFlow = Schema.Struct({
  provider: ProviderKind,
  stage: Schema.Literals(["starting", "browser", "awaiting-code", "done", "failed"]),
  url: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});

export type AuthFlow = typeof AuthFlow.Type;

/** One window of a subscription's rate limit, e.g. the 5-hour one. */
export const UsageLimit = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  /** Epoch ms; null when the window hasn't started. */
  resetsAt: Schema.NullOr(Schema.Number),
});

export type UsageLimit = typeof UsageLimit.Type;

/** A slash command the thread's harness offers. */
export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
});

export type SlashCommand = typeof SlashCommand.Type;

/** A skill the harness loads in a folder; `$name` in a message runs it. */
export const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});

export type Skill = typeof Skill.Type;
