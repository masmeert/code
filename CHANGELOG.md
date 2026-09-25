# Changelog

Release notes for the APCode desktop app. Before tagging `vX.Y.Z`, rename `Unreleased` to `X.Y.Z - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes and fails if it is missing.

## Unreleased

### Added

- Settings live in a sidebar, with per-harness settings.
- New-thread defaults and more options in General settings.
- Update status in Settings, with a restart button once an update is downloaded.
- The app version is shown on the update button alongside its state.

### Fixed

- The title bar only insets for traffic lights on macOS.

## 0.0.1 - 2026-09-25

First release.

### Added

- Threads for Claude and Codex with a composer, command palette, and turn rewind.
- Checkpoints, worktrees, steering, and search.
- Git operations: commit, push, and status.
- In-app terminal and diff view per thread.
- In-app browser that Claude and Codex can drive over MCP.
- Signed, notarized macOS builds with auto-update from GitHub releases.
