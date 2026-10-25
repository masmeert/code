# MassCode

Control plane for coding agents. It drives the CLIs you already have logged in (`claude`, `codex`), so usage runs on your own subscriptions.

```
apps/desktop   Electron shell: window, native dialogs, spawns the daemon (release builds)
apps/web       React + @masscode/ui + Tailwind UI (Vite, :1420)
apps/daemon    Bun + Effect daemon: provider adapters, sessions, WebSocket on 127.0.0.1:47821
packages/contracts   Effect Schema types shared by the apps (events, commands, frames, desktop bridge)
packages/ui    Design system: theme + tokens (globals.css), Radix primitives (components/),
               Motion components (motion/), agent chat UI (agents/), charts (charts/)
```

Import UI by path, e.g. `@masscode/ui/motion/button` or `@masscode/ui/components/dropdown-menu`. To add a shadcn component: `pnpm dlx shadcn@latest add <name> -c packages/ui`.

## Setup

Requires bun, pnpm, plus `claude auth login` and/or `codex login`.

```sh
pnpm install
pnpm dev          # daemon (bun --watch) + Vite + Electron (restarts on shell changes)
pnpm dev:daemon   # or run pieces separately; pnpm dev:web for UI in a browser
pnpm build        # compiles the daemon binary and bundles the .app, .dmg and .zip into apps/desktop/release
pnpm release      # same, then uploads a draft GitHub release that installed apps update from
pnpm test         # the daemon against recorded claude/codex traffic (apps/daemon/test)
pnpm --filter @masscode/daemon record [name]   # re-records those fixtures from the real CLIs, on your logins
```

### Dev container

`.devcontainer/` runs the daemon and web UI on Linux with Node 24, pnpm, bun, gh, `claude` and `codex`. Before opening it, run `export NODE_AUTH_TOKEN=$(gh auth token)` on the host so pnpm can install `@masmeert` packages. The token needs `read:packages`. Use `pnpm dev:daemon` and `pnpm dev:web`. Electron, release builds and the mobile app still need the Mac. Logins in the container (`claude auth login`, `codex login`) persist across rebuilds and checkouts. Daemon state stays in the checkout's gitignored `.masscode`.

Builds sign with the Developer ID in your keychain. To notarize, store credentials once with `xcrun notarytool store-credentials masscode --apple-id <email> --team-id <team>`, then build with `APPLE_KEYCHAIN_PROFILE=masscode`. `pnpm release` also needs `GH_TOKEN` (e.g. `GH_TOKEN=$(gh auth token)`) and a bumped `version` in `apps/desktop/package.json`.

## Remote machines

Agents can run on a Linux machine (a home server, a NUC, a VM) and keep working while this Mac sleeps. Two ways to add one in Settings → Connections:

- **Paired** (recommended): the machine runs MassCode on its own, as a systemd user service, and the app reaches it over Tailscale. With Tailscale up there, run:

  ```sh
  curl -fsSL https://github.com/masmeert/code/releases/latest/download/install.sh | sh
  ~/.local/bin/masscode connect
  ```

  `connect` turns on remote access, starts the service at boot, checks the agent CLIs (`claude`, `codex`, `cursor-agent`) are installed and signed in, then shows a pairing link and code to paste in Settings → Connections → Pair a machine. Each pairing gets full access (a computer: may pair others and host the browser panel) or limited access (a phone). `masscode pair` pairs another device, `masscode status` shows what's set up, `masscode update [version]` moves to a release once running agents are idle, `masscode uninstall` removes it and keeps `~/.masscode`. A paired machine's browser tabs reach its pages by Tailscale name, not `localhost`.

- **SSH**: the app uploads MassCode over SSH and tunnels to it; nothing to install, but it only restarts when the app reconnects.

## Project settings

Two places set up a project, and both save to `masscode.toml` in its folder, so committing that file shares them with the team:

- **Scripts** (a thread's ▷ menu → Edit scripts…): commands that run in a terminal tab of their own in the thread's folder (picking one again shows its tab). A preview URL opens in the Browser panel.
- **Settings → Projects**: where the project's new threads start (over General's default), and a worktree setup command that runs in each new worktree before its agent starts, with `MASSCODE_PROJECT_ROOT` set to the project's own checkout for linking ignored files like `.env`. Setup shows live in the thread; messages wait for it unless Wait for setup is off, and Stop skips it.

State lives in `~/.masscode/` (`settings.toml`, `projects.toml`, `masscode.db` for threads and transcripts; older builds' `.json` files move over on first launch); override with `MASSCODE_DATA_DIR`.

Override CLI paths with `MASSCODE_CLAUDE_PATH` / `MASSCODE_CODEX_PATH`, and the port with `MASSCODE_PORT`.
