/** Each harness's adapter, and which harness the settings pick for what. */
import { PROVIDER_NAME, ProviderKind, type Settings } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { ClaudeAdapter } from "./providers/ClaudeAdapter.ts";
import { CodexAdapter } from "./providers/CodexAdapter.ts";
import { CursorAdapter } from "./providers/CursorAdapter.ts";
import type { ProviderAdapter } from "./providers/ProviderAdapter.ts";

export const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  cursor: CursorAdapter,
};

/** The harness's name as the user set it in Settings, else its own; the same one the app shows. */
export function getHarnessName(settings: Settings, provider: ProviderKind) {
  return settings.providers[provider].displayName?.trim() || PROVIDER_NAME[provider];
}

/**
 * Who writes thread titles and source control text at `path`: the commit model in settings,
 * else the last harness's default.
 */
export function buildWriterInput(path: string, settings: Settings, recent: ReadonlyArray<string>) {
  const split = settings.commitModel?.indexOf(":") ?? -1;
  const commitProvider = settings.commitModel?.slice(0, split);
  const isPinned = split > 0 && Schema.is(ProviderKind)(commitProvider);
  const provider = isPinned ? commitProvider : settings.lastProvider;
  const model = isPinned
    ? settings.commitModel!.slice(split + 1)
    : settings.providers[provider].defaultModel;

  return {
    cwd: path,
    provider,
    harness: settings.providers[provider],
    model: model || undefined,
    settings,
    recent,
  };
}
