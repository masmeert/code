import { ProviderKind } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { probeHarness } from "../providers/provider-registry.ts";
import { SettingsStore, layer as SettingsStoreLayer } from "../storage/settings-store.ts";

const SETUP: Record<ProviderKind, { label: string; install: string; login: string }> = {
  claude: {
    label: "Claude Code",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    login: "claude auth login",
  },
  codex: {
    label: "Codex",
    install: "npm install -g @openai/codex",
    login: "codex login --device-auth",
  },
  cursor: {
    label: "Cursor",
    install: "curl https://cursor.com/install -fsS | bash",
    login: "cursor-agent login",
  },
};

/** Prints each agent CLI's state, with the command that fixes it; false when none is ready. */
export async function checkHarnesses() {
  const statuses = await Effect.runPromise(
    Effect.gen(function* () {
      const { providers } = yield* (yield* SettingsStore).get;

      return yield* Effect.forEach(
        ProviderKind.literals,
        (kind) => probeHarness(kind, providers[kind]),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(SettingsStoreLayer)),
  );

  for (const status of statuses) {
    const { label, install, login } = SETUP[status.kind];

    if (status.linked)
      console.log(`✓ ${label}${status.account ? `, signed in as ${status.account}` : ""}`);
    else if (status.installed) console.log(`✗ ${label} isn't signed in. Run: ${login}`);
    else console.log(`· ${label} isn't installed. To use it, run: ${install}`);
  }

  return statuses.some((status) => status.linked);
}
