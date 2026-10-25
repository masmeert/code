#!/usr/bin/env bash
set -euo pipefail

# Docker creates volume mount points root-owned.
for dir in node_modules "$HOME/.cache" "$HOME/.cache/pnpm-store" "$HOME/.claude" "$HOME/.codex"; do
  if [ "$(stat -c %U "$dir")" != "$(id -un)" ]; then
    sudo chown "$(id -un):$(id -gn)" "$dir"
  fi
done

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "NODE_AUTH_TOKEN is empty, so pnpm can't install @masmeert packages from GitHub Packages." >&2
  echo "On the host run: export NODE_AUTH_TOKEN=\$(gh auth token)  (the token needs read:packages), then rebuild the container." >&2
  exit 1
fi
# Single quotes on purpose: pnpm expands the variable at install time, so the token never lands on disk.
echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > ~/.npmrc
# Explicit, or pnpm, seeing node_modules on another filesystem than its default store, creates .pnpm-store in the checkout.
pnpm config set --location=global store-dir "$HOME/.cache/pnpm-store"
CI=true pnpm install --frozen-lockfile
