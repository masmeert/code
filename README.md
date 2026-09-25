# APCode

Control plane for coding agents. It drives the CLIs you already have logged in (`claude`, `codex`), so usage runs on your own subscriptions.

```
apps/desktop   Tauri shell + React + @apcode/ui + Tailwind (Vite, :1420)
apps/daemon    Bun + Effect daemon: provider adapters, sessions, WebSocket on 127.0.0.1:47821
packages/contracts   Effect Schema types shared by both (events, commands, frames)
packages/ui    Design system: theme + tokens (globals.css), Radix primitives (components/),
               Motion components (motion/), agent chat UI (agents/), charts (charts/)
```

Import UI by path, e.g. `@apcode/ui/motion/button` or `@apcode/ui/components/dropdown-menu`. To add a shadcn component: `pnpm dlx shadcn@latest add <name> -c packages/ui`.

## Setup

Requires bun, Rust (rustup), pnpm, plus `claude auth login` and/or `codex login`.

```sh
pnpm install
pnpm --filter @apcode/desktop tauri icon path/to/icon.png   # generates src-tauri/icons (once)
pnpm dev          # daemon (bun --watch) + tauri dev
pnpm dev:daemon   # or run pieces separately; pnpm dev:web for UI in a browser
pnpm build        # compiles daemon to a sidecar binary and bundles the .app
```

State lives in `~/.apcode/` (`settings.json`, `projects.json`, `apcode.db` for threads and transcripts); override with `APCODE_DATA_DIR`.

Override CLI paths with `APCODE_CLAUDE_PATH` / `APCODE_CODEX_PATH`, and the port with `APCODE_PORT`.
