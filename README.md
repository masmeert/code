# APCode

Control plane for coding agents. It drives the CLIs you already have logged in (`claude`, `codex`), so usage runs on your own subscriptions.

```
apps/desktop   Electron shell: window, native dialogs, spawns the daemon (release builds)
apps/web       React + @apcode/ui + Tailwind UI (Vite, :1420)
apps/daemon    Bun + Effect daemon: provider adapters, sessions, WebSocket on 127.0.0.1:47821
packages/contracts   Effect Schema types shared by the apps (events, commands, frames, desktop bridge)
packages/ui    Design system: theme + tokens (globals.css), Radix primitives (components/),
               Motion components (motion/), agent chat UI (agents/), charts (charts/)
```

Import UI by path, e.g. `@apcode/ui/motion/button` or `@apcode/ui/components/dropdown-menu`. To add a shadcn component: `pnpm dlx shadcn@latest add <name> -c packages/ui`.

## Setup

Requires bun, pnpm, plus `claude auth login` and/or `codex login`.

```sh
pnpm install
pnpm dev          # daemon (bun --watch) + Vite + Electron (restarts on shell changes)
pnpm dev:daemon   # or run pieces separately; pnpm dev:web for UI in a browser
pnpm build        # compiles the daemon binary and bundles the .app, .dmg and .zip into apps/desktop/release
pnpm release      # same, then uploads a draft GitHub release that installed apps update from
```

Builds sign with the Developer ID in your keychain. To notarize, store credentials once with `xcrun notarytool store-credentials apcode --apple-id <email> --team-id <team>`, then build with `APPLE_KEYCHAIN_PROFILE=apcode`. `pnpm release` also needs `GH_TOKEN` (e.g. `GH_TOKEN=$(gh auth token)`) and a bumped `version` in `apps/desktop/package.json`.

State lives in `~/.apcode/` (`settings.json`, `projects.json`, `apcode.db` for threads and transcripts); override with `APCODE_DATA_DIR`.

Override CLI paths with `APCODE_CLAUDE_PATH` / `APCODE_CODEX_PATH`, and the port with `APCODE_PORT`.
