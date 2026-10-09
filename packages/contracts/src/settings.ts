import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MergeMethod } from "./git.ts";
import { Effort, ProviderKind } from "./providers.ts";
import { PermissionLevel, Workspace } from "./threads.ts";

export const Theme = Schema.Literals(["system", "light", "dark"]);

export type Theme = typeof Theme.Type;

/** Tint a harness wears in the app; "brand" keeps its own colours. */
export const HarnessColor = Schema.Literals([
  "brand",
  "orange",
  "amber",
  "emerald",
  "sky",
  "violet",
  "pink",
]);

export type HarnessColor = typeof HarnessColor.Type;

/** How commit messages and pull requests get written: like the repo's history, as Conventional Commits, or by the user's own rules. */
export const WritingStyle = Schema.Literals(["repo_conventions", "conventional_commits", "custom"]);

export type WritingStyle = typeof WritingStyle.Type;

export const ProviderSettings = Schema.Struct({
  /** Model for new threads; null uses the harness's own default. */
  defaultModel: Schema.NullOr(Schema.String),
  /** Shown in place of the harness's own name. The fields below are optional so older settings files still load. */
  displayName: Schema.optional(Schema.String),
  color: Schema.optional(HarnessColor),
  /** CLI to run instead of the one found on PATH. */
  binaryPath: Schema.optional(Schema.String),
  /** CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex, CURSOR_CONFIG_DIR for Cursor. */
  configDir: Schema.optional(Schema.String),
  launchArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Model ids in picker order; models missing from it follow in the harness's own order. */
  modelOrder: Schema.optional(Schema.Array(Schema.String)),
  hiddenModels: Schema.optional(Schema.Array(Schema.String)),
  favoriteModels: Schema.optional(Schema.Array(Schema.String)),
});

export type ProviderSettings = typeof ProviderSettings.Type;

export const Settings = Schema.Struct({
  theme: Theme,
  /** Harness preselected in new chats; follows the last one used. */
  lastProvider: ProviderKind,
  providers: Schema.Struct({
    claude: ProviderSettings,
    codex: ProviderSettings,
    // Settings files from before Cursor have no entry for it.
    cursor: ProviderSettings.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ defaultModel: null })),
    ),
  }),
  /** A message sent while the agent works: held until the turn ends ("queue"), or sent into it right away ("steer"). */
  followUp: Schema.optional(Schema.Literals(["queue", "steer"])),
  /** Model new threads start with, as `provider:model`; null/absent follows the last harness used. */
  newThreadModel: Schema.optional(Schema.NullOr(Schema.String)),
  /** Effort new threads start with; null/absent uses the model's own. */
  newThreadEffort: Schema.optional(Schema.NullOr(Effort)),
  newThreadPermission: Schema.optional(PermissionLevel),
  /** Where new threads start. */
  workspace: Schema.optional(Workspace),
  /** Shelves threads with no activity for `autoShelveDays`, read or not. Absent counts as on. */
  autoShelve: Schema.optional(Schema.Boolean),
  autoShelveDays: Schema.optional(Schema.Number),
  diffLayout: Schema.optional(Schema.Literals(["unified", "split"])),
  /** New worktrees branch from origin's copy of the current branch (fetched first) instead of the local one. */
  worktreeFromOrigin: Schema.optional(Schema.Boolean),
  /** Folder the Add Project picker opens in; absent opens the home folder. */
  addProjectFolder: Schema.optional(Schema.String),
  /** Per remote host alias: the folder whose git repos are added as projects on connect, and new clones go into. */
  hostProjectFolders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  confirmArchive: Schema.optional(Schema.Boolean),
  confirmDelete: Schema.optional(Schema.Boolean),
  /** Names new threads and writes commit messages left empty and pull request text, as `provider:model`; null/absent uses the last harness's default model. */
  commitModel: Schema.optional(Schema.NullOr(Schema.String)),
  /** Fast-forwards a checkout on its default branch when it has no changes or commits of its own. */
  autoPull: Schema.optional(Schema.Boolean),
  /** Method pull requests merge with first; null/absent reuses the last one picked on this device. */
  mergeMethod: Schema.optional(Schema.NullOr(MergeMethod)),
  writingStyle: Schema.optional(WritingStyle),
  /** Used when `writingStyle` is "custom". */
  writingInstructions: Schema.optional(Schema.String),
  /** Pull request bodies follow the repo's template when it has one. Absent counts as on. */
  followTemplates: Schema.optional(Schema.Boolean),
  /** System notifications when a thread finishes or needs you, while MassCode is in the background. Absent counts as on. */
  notifications: Schema.optional(Schema.Boolean),
});

export type Settings = typeof Settings.Type;

export const DEFAULT_AUTO_SHELVE_DAYS = 7;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  lastProvider: "claude",
  providers: {
    claude: { defaultModel: null },
    codex: { defaultModel: null },
    cursor: { defaultModel: null },
  },
};
