#!/usr/bin/env bash
# Toolchain only; dependency installs live in update-content.sh so Codespaces prebuilds can refresh them.
set -euo pipefail

sudo corepack enable
installer=$(mktemp)
curl -fsSL https://bun.sh/install -o "$installer"
sudo BUN_INSTALL=/usr/local bash "$installer" bun-v1.4.2
rm -f "$installer"
npm install --global @anthropic-ai/claude-code @openai/codex

sudo mkdir -p /usr/local/etc/vscode-dev-containers
sudo tee /usr/local/etc/vscode-dev-containers/first-run-notice.txt >/dev/null <<'NOTICE'
masscode dev container

  pnpm dev:daemon   daemon on :47821
  pnpm dev:web      UI on :1420
  pnpm test         daemon tests against recorded traffic
  claude auth login / codex login   once; logins persist across rebuilds

Electron, release builds and the mobile app need the Mac.
NOTICE
