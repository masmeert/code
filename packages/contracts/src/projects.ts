import * as Schema from "effect/Schema";

export const Project = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  addedAt: Schema.Number,
  /** The git origin's URL, which tells the same repo apart on each machine; null outside a repo or without one. Absent on projects added before it was read. */
  remote: Schema.optional(Schema.NullOr(Schema.String)),
  /** Where the project sits in its repo, like "apps/web"; "" at the top. Null outside a repo. */
  folder: Schema.optional(Schema.NullOr(Schema.String)),
});

export type Project = typeof Project.Type;

/** A command anyone working in the project can run from a thread's Scripts menu. */
export const ProjectScript = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  command: Schema.String.check(Schema.isNonEmpty()),
  /** Opened in the Browser panel when the script runs, like a dev server's address. */
  preview_url: Schema.optionalKey(Schema.String),
});

export type ProjectScript = typeof ProjectScript.Type;

/** A project's `masscode.toml`, keyed as written in the file. */
export const ProjectConfig = Schema.Struct({
  worktree: Schema.optionalKey(
    Schema.Struct({
      /** New threads in the project start in a worktree of their own (true) or the project folder (false). */
      default: Schema.optionalKey(Schema.Boolean),
      /** Runs in each new worktree's folder, with MASSCODE_PROJECT_ROOT pointing at the project's own checkout. */
      setup: Schema.optionalKey(Schema.String),
      /** Holds the first message until setup ends; on by default. */
      wait_for_setup: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** Commands anyone working in the project can run from a thread's Scripts menu. */
  scripts: Schema.optionalKey(Schema.Array(ProjectScript)),
});

export type ProjectConfig = typeof ProjectConfig.Type;
