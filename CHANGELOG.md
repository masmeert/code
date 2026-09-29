# Changelog

Release notes for the APCode desktop app. Before tagging `vX.Y.Z`, rename `Unreleased` to `X.Y.Z - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes and fails if it is missing.

## 0.0.14 - 2026-09-29

### Added

- Threads waiting on you sit in a "Needs you" group at the top of the sidebar, with Allow and Deny right on the row. Running threads show the tool call they're on.
- ⌘1–9 open the first nine threads in the sidebar; hold ⌘ to see which number goes where.
- Swipe a thread row sideways to shelve or unshelve it. Shelving or unshelving shows a toast with Undo.

### Changed

- Settle is now Shelve: the thread menu, row button and swipe shelve (a check) or unshelve (an X) a thread, shelved threads sit under Shelved, and Settings has "Shelve idle threads". Your idle-thread setting and shelved threads carry over.
- The Shelved section stays at the bottom of the sidebar and opens into the free space above it. Long groups show 10 threads, then 25 more at a time.
- New thread moved to the sidebar header, the view menu sits inside the search field, and the machines row is gone (Settings → Connections shows the same).
- A new thread lists your projects under a search field, most recently used first, with their paths and machines and Add project at the end. Arrow keys and Enter pick one and put you back in the prompt.
- Model and branch pickers find options by the name and description they show, not only their internal value.
- APCode asks before downloading an update instead of fetching it on its own.
- A subagent's run time ticks every second, and its progress stays in its own row instead of repeating in the chat.
- Every clickable button, link, menu item and row shows a pointer cursor.

### Fixed

- Switching the theme with the diff panel open no longer stalls for a second, and opening a thread doesn't re-render every turn.
- Question previews show their text as written and no longer flicker when you hover the options.
- The tab pill stays level while a modal resizes to fit a shorter tab.

## 0.0.13 - 2026-09-29

### Changed

- A host's projects scan looks up to three folders deep, never inside a repo, so the home folder default finds repos in ~/code and ~/code/group without setting a Projects folder.

### Fixed

- A new thread offering to clone its project onto a host switches to the host's copy as soon as a scan finds it.

## 0.0.12 - 2026-09-29

### Fixed

- Copies of a repo whose remotes name its server differently, like a LAN and a public address for one GitLab, are one project across machines instead of showing as not cloned. Project badge colors may change once.

## 0.0.11 - 2026-09-29

### Added

- Each remote host has a Projects folder in Settings → Connections (its home folder when unset). The git repos directly inside it are added as projects on that host when it connects, so projects already there no longer show as not cloned. Clones to that host and its folder browser in Add project start there too.

### Fixed

- Switching between machines in Add project no longer leaves a copy of the host's folder list behind each time.

## 0.0.10 - 2026-09-29

### Added

- Remote hosts: add a Linux machine from your ~/.ssh/config in Settings → Connections, and APCode installs itself there and connects over SSH with your keys. Its agents keep working while this Mac sleeps or goes offline, and its threads sit in the sidebar with yours.
- A new thread picks the machine it runs on, next to Local checkout (⌘⇧H). When the project isn't on that machine yet, one click clones it there.
- The same repo on several machines is one project in the sidebar and the project menu.
- Add project can browse a host's folders, or clone a repository on this Mac or a host.
- Settings → Harnesses shows the Claude and Codex accounts of each host, to link or unlink them there.
- On a host's threads, the browser panel opens the host's localhost, the terminal is a shell on the host, and attached files are sent over.

## 0.0.9 - 2026-09-28

### Changed

- Threads settle once they've been idle for a set number of days (7 by default), read or not. Settle and Unsettle from the thread menu hold until the thread's next turn starts. Settings has one "Settle idle threads" option in place of the settle delay and auto-settle switch.
- Which threads are settled or unread is kept by APCode itself, so every window shows the same lists. Existing threads start out read.

### Fixed

- The permissions and model menus in a new thread respond to clicks on every option, not only the ones below the heading.

## 0.0.8 - 2026-09-28

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
