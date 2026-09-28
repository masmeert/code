# Changelog

Release notes for the APCode desktop app. Before tagging `vX.Y.Z`, rename `Unreleased` to `X.Y.Z - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes and fails if it is missing.

## Unreleased

### Added

- Queued messages sit in a card above the composer: steer one into the running turn, or take it back to edit. ⌘⇧↩ steers the oldest.
- Running subagents get their own card above the composer, with what each is doing, its tokens and time, and a stop button.
- ⌘1 to ⌘9 pick a project in the project menu.

### Changed

- The composer's text box sits in its own frame, and its pickers are rounded pills.
- A new thread asks for its project in the heading ("What should we work on in …?"), opens the project menu on its own, and starts in your latest thread's project.
- The strip under the composer shows where the thread works (local checkout or a new worktree) and the branch it starts from.
- The context meter moved into the composer, next to attach and send.
- A queued message goes out after the agent's next tool call, not only when the turn ends.

### Fixed

- The project, workspace and branch pickers stay disabled until a harness is linked, like the others.

## 0.0.7 - 2026-09-28

### Changed

- The settings scrollbar only shows while you hover or scroll, and stays clear of the panel's rounded corners.

## 0.0.6 - 2026-09-28

### Fixed

- Settings scroll again when opened over an empty thread, with a thinner, quieter scrollbar.

## 0.0.5 - 2026-09-26

### Added

- A fork ends with a "Forked from …" divider that takes you back to the original.

### Changed

- Forking asks first, in a small dialog (Enter forks, Esc cancels), and says why if it fails.

## 0.0.4 - 2026-09-26

### Added

- Plan and Auto modes in Claude's permission picker. A finished plan shows as a card to approve with the permission level to build it with, or reject with what to change.
- Claude's questions show as a card with options, previews and a free-text answer, answerable from the keyboard.
- Fork a thread from any finished reply into a new one; the original stays as it is.
- Mention project files with `@` in the composer.
- A ring in the composer shows context usage, API cost and plan limits (⌘⇧U).
- System notifications when a thread finishes, fails or needs you, and a dock badge counting threads that need you.
- Subagents show their tool calls under their Agent row, and a chip above the composer lists the running ones with progress and a stop button each. Works for Claude and Codex.

### Changed

- The Claude harness is called "Claude", not "Claude Code".
- One copy button per assistant turn, on its final message.
- A shorter composer placeholder while the agent works.
- Long branch and project names are truncated in the composer footer and thread list.

### Fixed

- Threads stay running while Claude's background subagents work.
- Harnesses no longer show as missing for a few seconds after each launch.
- New threads opened from a worktree thread start in its project instead of adding the worktree as a project.

## 0.0.3 - 2026-09-25

### Fixed

- The daemon no longer crashes a few seconds after launch, which disconnected the app over and over.
- Each Claude model's default effort is read correctly.

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
