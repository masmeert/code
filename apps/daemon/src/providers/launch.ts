import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderKind, ProviderSettings } from "@apcode/contracts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveExecutable } from "./resolveExecutable.ts";

/** How to run one harness CLI, from its Settings. */
export interface HarnessLaunch {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}

const CLI: Record<ProviderKind, { name: string; pathEnv: string; configEnv: string }> = {
  claude: { name: "claude", pathEnv: "APCODE_CLAUDE_PATH", configEnv: "CLAUDE_CONFIG_DIR" },
  codex: { name: "codex", pathEnv: "APCODE_CODEX_PATH", configEnv: "CODEX_HOME" },
};

function expandHome(path: string) {
  return path.trim().replace(/^~(?=\/|$)/, homedir());
}

export function harnessLaunch(kind: ProviderKind, settings: ProviderSettings): HarnessLaunch {
  const cli = CLI[kind];
  const bin = settings.binaryPath?.trim()
    ? expandHome(settings.binaryPath)
    : resolveExecutable(cli.name, cli.pathEnv);
  if (!existsSync(bin))
    throw new Error(`No file at ${bin}. Fix the binary path in Settings → Harnesses.`);
  const env = { ...process.env, ...settings.env };
  if (settings.configDir?.trim()) env[cli.configEnv] = expandHome(settings.configDir);
  return { bin, args: settings.launchArgs ?? [], env };
}

/**
 * The Claude SDK takes extra CLI flags as a record: `--flag value`, `--flag=value`, or a bare `--flag`.
 * ponytail: short flags, positionals and repeated flags are dropped; pass them through a wrapper binary if needed.
 */
export function claudeExtraArgs(args: ReadonlyArray<string>) {
  const flags: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    const [flag, inline] = arg.slice(2).split(/=(.*)/s);
    const next = args[index + 1];
    if (inline !== undefined) flags[flag!] = inline;
    else if (next !== undefined && !next.startsWith("-")) {
      flags[flag!] = next;
      index++;
    } else flags[flag!] = null;
  }
  return flags;
}

/** A Claude session with no prompt: it answers control requests without ever starting a turn. Close it when done. */
export function promptlessQuery(launch: HarnessLaunch, options: Options = {}) {
  return query({
    prompt: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
    options: {
      ...options,
      pathToClaudeCodeExecutable: launch.bin,
      extraArgs: claudeExtraArgs(launch.args),
      env: launch.env,
    },
  });
}
