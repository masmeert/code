# Changelog

Release notes for the APCode desktop app. Before tagging `vX.Y.Z`, rename `Unreleased` to `X.Y.Z - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes and fails if it is missing.

## 0.0.2 - 2026-09-25

### Added

- Settings live in a sidebar, with per-harness settings.
- New-thread defaults and more options in General settings.
- Update status in Settings, with a restart button once an update is downloaded.
- The app version is shown on the update button alongside its state.
- Pull requests from the git menu: create one with a written title and body, view it, and merge it, through `gh` or `glab`.
- Git settings: auto-pull of the default branch, a default merge method, GitHub and GitLab status, and a writing style for commit messages and pull requests.

### Changed

- The changes and browser panels run to the top of the window, beside the thread header.

### Fixed

- The title bar only insets for traffic lights on macOS.
- The app no longer hangs on "Reconnecting to daemon" at launch: the daemon starts on a free port, restarts if it exits, and quits when the app does.

## 0.0.1 - 2026-09-25

First release.

### Added

- Threads for Claude and Codex with a composer, command palette, and turn rewind.
- Checkpoints, worktrees, steering, and search.
- Git operations: commit, push, and status.
- In-app terminal and diff view per thread.
- In-app browser that Claude and Codex can drive over MCP.
- Signed, notarized macOS builds with auto-update from GitHub releases.
