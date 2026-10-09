# Changelog

Release notes for the MassCode desktop app. release-please writes each section from the `feat`, `fix` and `perf` commits since the last release, so write commit subjects for the people using the app.

## [0.1.7](https://github.com/masmeert/code/compare/v0.1.6...v0.1.7) (2026-10-09)


### Fixed

* close the harness when writing a title, commit or pull request times out ([2d30bae](https://github.com/masmeert/code/commit/2d30baead7cb0798594eac6443c761533e23a165))
* **daemon:** type dispatch's command match with its full error union ([dc2fe06](https://github.com/masmeert/code/commit/dc2fe06fad3e5f3d7adaa1cc9ad3c70c09a05828))
* fail a host install when the daemon archive can't be read instead of hanging ([6694935](https://github.com/masmeert/code/commit/669493579c7ff1e1b90c4fb16f78db6879e44857))
* forget a script terminal's script when it's closed ([daf4f3e](https://github.com/masmeert/code/commit/daf4f3e34d3a10e00506fc38ff0a5bd6874e171d))
* ignore an unreadable ssh config when suggesting hosts ([c76812f](https://github.com/masmeert/code/commit/c76812fdcadd2a6d4f048e5ec673f7b8abef6a7a))
* keep cursor's resume token and catch-up point across restarts ([efc9bdc](https://github.com/masmeert/code/commit/efc9bdcae552943b57c266cd5fe80a7272697287))
* keep Settings open when a harness has every model hidden ([e29a24b](https://github.com/masmeert/code/commit/e29a24b51bd01b33cdc333cc561ef49e65f5343d))
* name a script's terminal tab by its script for screen readers ([86e9d92](https://github.com/masmeert/code/commit/86e9d92a2a689c688e4ee40ca8a9a4adec251800))
* retry reading skills after the harness crashes while listing them ([96ed74b](https://github.com/masmeert/code/commit/96ed74bb81638fbe267b7fd29c9de3657327332c))
* say when a host's CPU architecture couldn't be detected ([6fe34c7](https://github.com/masmeert/code/commit/6fe34c7626b1b6071426d050d7f4b2277db3832c))
* send replies and limit resumes only with an effort and fast mode the model takes ([8c1a586](https://github.com/masmeert/code/commit/8c1a5864348efc3f5aad6f2cc164eac3ded188c6))
* send the pasted sign-in code without surrounding spaces ([d38581e](https://github.com/masmeert/code/commit/d38581eae799bc3d869b44055ec15c29e0877a36))
* show an attachment's name when its image can't be loaded ([ab2ca60](https://github.com/masmeert/code/commit/ab2ca602f558cdbd51e36c67a2b2a560514a122c))
* show only the commit's own progress on the commit button ([be8e057](https://github.com/masmeert/code/commit/be8e05796d1005b40369fff5d357175f49f8bdff))
* still shut an idle simulator down after opening it again fails ([7fb2889](https://github.com/masmeert/code/commit/7fb28896733df18941577d7d2069e52ac320ad0c))
* stop blaming the writer when opening a pull request fails ([f9b993c](https://github.com/masmeert/code/commit/f9b993c9c00905dad35153814f63081508c2db71))
* stop browser actions from piling up page-load listeners when a page keeps loading ([091641e](https://github.com/masmeert/code/commit/091641eef12ce5c43c7572b70a8c3d28b3c5bac8))
* stop claude approvals from answering another thread's request ([5872930](https://github.com/masmeert/code/commit/58729304736a36fa31d61b9368f18a65fe44da20))
* stop reconnecting to a remote host after it's removed ([80daf5f](https://github.com/masmeert/code/commit/80daf5f11bd0e19a523bee0b15af1aae6620de5d))
* stop showing a side chat as working after it's closed while starting ([294cfd8](https://github.com/masmeert/code/commit/294cfd8ac14425214a4ae4d38504e2718b6a4b63))
* tell the user when settings couldn't be saved ([21f7333](https://github.com/masmeert/code/commit/21f733382431f4132cb313b8de44e6bd4c2b9fa4))
* treat an unreadable claude limit reset time as unknown ([d1e4859](https://github.com/masmeert/code/commit/d1e4859e7a6472ca9b86ef469773e7af1133f74c))

## [0.1.6](https://github.com/masmeert/code/compare/v0.1.5...v0.1.6) (2026-10-09)


### Added

* project scripts, worktree setup and per-project settings in masscode.toml ([39556d9](https://github.com/masmeert/code/commit/39556d95166c7a3f9d28537bb3d2b5b434080692))


### Changed

* make switching threads near-instant ([6b6e9fa](https://github.com/masmeert/code/commit/6b6e9fabe3bf7f69a2e31dfcc240e6da05eb348d))
* rest the orb at 20fps and probe its colours once ([17758f1](https://github.com/masmeert/code/commit/17758f1ead9ed315b99b706fcab56e84a732d853))


### Fixed

* match the pending thinking row to the streaming work row ([e044f68](https://github.com/masmeert/code/commit/e044f683d7aea07dc7d3982015aed06cbbe26dba))
* read git paths literally, never as patterns ([5905f0a](https://github.com/masmeert/code/commit/5905f0ae2f6184f6f493622f31c8a1f50e9806eb))

## [0.1.5](https://github.com/masmeert/code/compare/v0.1.4...v0.1.5) (2026-10-09)


### Added

* shelving a thread stops its agent and closes its idle terminals ([2af5782](https://github.com/masmeert/code/commit/2af5782586368593d8fd19bd02cdefd392b8b81b))


### Changed

* keep the app responsive with many threads ([5f11105](https://github.com/masmeert/code/commit/5f11105b08d4f2b7db624fffb364360655816f45))
* unload browser tabs of shelved and archived threads ([02b8445](https://github.com/masmeert/code/commit/02b8445fa2b8c4c4693480de1732ae14ea2729f1))


### Fixed

* keep menu shadows in step with the open animation ([20c218d](https://github.com/masmeert/code/commit/20c218d0d2294fec3050644a491434d798b8ed57))
* keep the agent's notes between tool calls folded until the turn ends ([dbc0fb3](https://github.com/masmeert/code/commit/dbc0fb373a56962c834f55853ffe8f879a22e9ac))

## [0.1.4](https://github.com/masmeert/code/compare/v0.1.3...v0.1.4) (2026-10-08)


### Added

* Android emulators, H.264 streaming and rotation in the Simulator panel ([bca7f01](https://github.com/masmeert/code/commit/bca7f0157801099cac00d7d2634cea22aef673ba))
* move the terminal, browser and simulator toggles into a menu ([25df14c](https://github.com/masmeert/code/commit/25df14c6ad99c107995145e3b75ff278a018025a))
* show an iOS Simulator panel agents can drive ([d23ac50](https://github.com/masmeert/code/commit/d23ac502a8eea2afb683f134beedef6a1e2dc6eb))
* shrink the orb inside the app icon ([d469567](https://github.com/masmeert/code/commit/d469567f71152790d48698c7cd0c09cd6eb051eb))
* use the overlay scrollbar for plan approval details ([ae272c2](https://github.com/masmeert/code/commit/ae272c278e5d20e8c20045d0357aa490fa918bbc))


### Fixed

* cancel a device's idle shutdown before reattaching it ([4f3164a](https://github.com/masmeert/code/commit/4f3164ae602887dc73b92eb056800997c3cc4682))
* enlarge the app icon avatar ([02f7c64](https://github.com/masmeert/code/commit/02f7c646229e33a2293d36ccd8b8895d40df6617))
* hide the file tree and fall back to stacked diffs in a narrow changes panel ([4a51f1e](https://github.com/masmeert/code/commit/4a51f1e74a57290ede35dbe305c7c32de23024c0))
* keep the thread header's actions visible in a narrow pane ([5061401](https://github.com/masmeert/code/commit/50614011471bb7b3393566a7ea9b8cf84858c7fa))
* list and boot simulators through simctl so never-booted ones show ([0f6b9bf](https://github.com/masmeert/code/commit/0f6b9bfd4fd607200a45e872d2e2a721e67f8642))
* stop doubling the live thinking row and keep its chevron beside the text ([d4a15eb](https://github.com/masmeert/code/commit/d4a15eb4692637b109ca9b939319fcdcf267746a))
* **ui:** portal MorphingModal to body so it paints above the composer ([627c693](https://github.com/masmeert/code/commit/627c6933f4003b02b7b72ebf49b9f978b0d22ee1))

## [0.1.3](https://github.com/masmeert/code/compare/v0.1.2...v0.1.3) (2026-10-08)

### Added

- add native light/dark app icon ([432c660](https://github.com/masmeert/code/commit/432c660e5bffd0af206c7a0e8b1aee1579201833))
- drop the dock badge ([22fdf13](https://github.com/masmeert/code/commit/22fdf13e00504ba9e367f3c9c9c03d0ec8318043))
- give the app icon macOS's native background ([c1275aa](https://github.com/masmeert/code/commit/c1275aa60516ccc166c84761bb0ca04e403d27b0))
- scramble through whimsical phrases while thinking, and title finished thoughts with one ([05d2f1b](https://github.com/masmeert/code/commit/05d2f1b9cdcf45b6f571cd90f820777d5d1a6108))
- show a lone tool call as one row instead of a group ([e9fb074](https://github.com/masmeert/code/commit/e9fb074f227a64c0b8f4de37e8c3049fa9603cbc))
- show local images in agent replies through signed daemon URLs ([e242c82](https://github.com/masmeert/code/commit/e242c82dfa640082dff64886ee07377774f1e3bc))
- show sent image attachments as thumbnails that open full size ([49eb541](https://github.com/masmeert/code/commit/49eb5418a104e13baf7cd927c212e767c020d459))

### Fixed

- close modals on Escape even when the terminal had focus ([cdeff4d](https://github.com/masmeert/code/commit/cdeff4d091f8702f5a924f02c74a14615bb50d59))
- rewind and fork Codex threads with thread/revert ([557e9c5](https://github.com/masmeert/code/commit/557e9c51fa3ddb6a04f90a97c050068af971f0c8))

## [0.1.2](https://github.com/masmeert/code/compare/v0.1.1...v0.1.2) (2026-10-08)

### Added

- a new app icon ([7a2ade8](https://github.com/masmeert/code/commit/7a2ade83a5ad2897352fcccf8764a98f102518fa))
- an orb face on the newest reply that shows what the agent is doing ([a68dfe6](https://github.com/masmeert/code/commit/a68dfe6702a3b4137bb28fd2e3f5719671661307))
- pick settings models from the composer's tabbed, searchable list ([7d2301e](https://github.com/masmeert/code/commit/7d2301e4d6be1d5a7f49a67e7a94a0a76e4a25c7))

### Fixed

- draw the orb shader after a remount on the same canvas ([046b8fa](https://github.com/masmeert/code/commit/046b8fa1422b2f87510495404479dcb8c4a5afc9))

## [0.1.1](https://github.com/masmeert/code/compare/v0.1.0...v0.1.1) (2026-10-08)

### Added

- find in a thread with ⌘F, and an outline of its prompts ([27bd1d3](https://github.com/masmeert/code/commit/27bd1d36b38aa5f66281b34e5cdb40d2ca40a706))
- fold the steps before an answer into one thinking row ([2b52b95](https://github.com/masmeert/code/commit/2b52b95c3c5b790b1a650c603762141c1f472b92))

## [0.1.0](https://github.com/masmeert/code/compare/v0.0.18...v0.1.0) (2026-10-07)

### ⚠ BREAKING CHANGES

- remove peer review

### Added

- add Cursor as a harness over the Agent Client Protocol ([858c89d](https://github.com/masmeert/code/commit/858c89d0e6481011e78d38e99710e7a726867816))
- ask read-only side questions about a reply with BTW or /btw ([a1eaacf](https://github.com/masmeert/code/commit/a1eaacf9ad9cc382673e44bfaa10fe9227793501))
- collapse composer pickers to icons in narrow panes ([c529133](https://github.com/masmeert/code/commit/c5291338da2cafaa63aba1d359c63f4930b649be))
- one model menu with effort, fast mode and a harness rail ([c5f26c6](https://github.com/masmeert/code/commit/c5f26c6d6d5028d9adb9ad2a4459774ed7ea07b6))
- pause on usage limits, and resume or hand off from a notice ([ab8a8e2](https://github.com/masmeert/code/commit/ab8a8e2e4f108710a0a7a6216bd7fc9d7dd89db6))
- recover from dead agents, queue in the daemon, let agents run threads, switch harness ([aa38a5a](https://github.com/masmeert/code/commit/aa38a5a1abf52d2e14a67820096922157edef769))
- remove peer review ([eb2f207](https://github.com/masmeert/code/commit/eb2f207026d4be5b93dbf5ff05f9d04c3ee15dc1))
- show agents' thinking, and Cursor's skills under $ ([4344c6d](https://github.com/masmeert/code/commit/4344c6d7e73da2e2bd2e344bbba98af51e002ebe))

## [0.0.18](https://github.com/masmeert/code/compare/v0.0.17...v0.0.18) (2026-10-07)

### Added

- borrow Vesper's orange for "needs you" ([c967574](https://github.com/masmeert/code/commit/c967574c1ab38bd2c4e18095770a6b30601704d1))
- give light mode its own Vesper, with peach keys and copper accents ([1c9e20f](https://github.com/masmeert/code/commit/1c9e20f098e4926757b79a13a989bf5a40d570a9))
- give status colours one meaning each, with mint for success ([a5b4c81](https://github.com/masmeert/code/commit/a5b4c81a946ccbd2952bbb33adcd254053b6e8a6))
- mark links, inline code and finished threads with brand ([2337df3](https://github.com/masmeert/code/commit/2337df3fb6b723797742ed3bd8b44e5e624463b0))
- name threads with the writer model and let you rename them ([e9f7389](https://github.com/masmeert/code/commit/e9f7389165f970996462a1555b423781b66da262))
- tighten the peer review dialog ([534ed5b](https://github.com/masmeert/code/commit/534ed5b941bc959c468a43a63e1b1a9d96096be5))

### Fixed

- wrap long unbroken text inside message bubbles ([d8ccf3b](https://github.com/masmeert/code/commit/d8ccf3bacb0495c9b970a2c85d03e4e3d569822c))

## [0.0.17](https://github.com/masmeert/code/compare/v0.0.16...v0.0.17) (2026-09-29)

### Added

- ask the other agent to peer review a thread's work ([b3bf34c](https://github.com/masmeert/code/commit/b3bf34c60bd0f122f0934e3999cd67594024e083))
- comment on lines in the diff and send the comments with your next message ([e27e874](https://github.com/masmeert/code/commit/e27e874f804988adc19a49b10be64d013fafdbde))
- dress dark mode in Vesper, with a peach accent in light ([1daf51f](https://github.com/masmeert/code/commit/1daf51fd13315f93aedddfb268fdbac1a9fe3f20))
- merge a worktree thread's branch into its base from the git menu ([9f92b73](https://github.com/masmeert/code/commit/9f92b739d33deb850fa14cc722f8a3e0ffd088d3))
- run shell commands from agent replies ([1f98ad9](https://github.com/masmeert/code/commit/1f98ad98e1daa1b6ee651273fa0d0dd3d41278b7))
- run skills with $name from the composer ([e160eaa](https://github.com/masmeert/code/commit/e160eaa803e8fd954a530285f1db059cbf9936ef))

### Fixed

- follow the agent into a worktree it switches to mid-thread ([9960006](https://github.com/masmeert/code/commit/9960006996c0db6b44e73f634054bdc1bca0352e))
- only restore files in a worktree no other thread shares ([2383ab2](https://github.com/masmeert/code/commit/2383ab265bc225b19875f2cfb84d5b8fc2f8bf66))

## [0.0.16](https://github.com/masmeert/code/compare/v0.0.15...v0.0.16) (2026-09-29)

### Fixed

- darken and blur the backdrop behind every modal ([9bc21d0](https://github.com/masmeert/code/commit/9bc21d0bca3414247233e7c0aee743b96e33a5fd))
- run Claude on hosts signed in as root, asking once before Full access there ([bb971be](https://github.com/masmeert/code/commit/bb971be9bc635a8e8ed48eba43919372c74b218b))

## [0.0.15](https://github.com/masmeert/code/compare/v0.0.14...v0.0.15) (2026-09-29)

### Fixed

- stop showing a toast when shelving or unshelving a thread ([8689f19](https://github.com/masmeert/code/commit/8689f191bb1bd33299de248ca055ec5a7342ee19))

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
- MassCode asks before downloading an update instead of fetching it on its own.
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

- Remote hosts: add a Linux machine from your ~/.ssh/config in Settings → Connections, and MassCode installs itself there and connects over SSH with your keys. Its agents keep working while this Mac sleeps or goes offline, and its threads sit in the sidebar with yours.
- A new thread picks the machine it runs on, next to Local checkout (⌘⇧H). When the project isn't on that machine yet, one click clones it there.
- The same repo on several machines is one project in the sidebar and the project menu.
- Add project can browse a host's folders, or clone a repository on this Mac or a host.
- Settings → Harnesses shows the Claude and Codex accounts of each host, to link or unlink them there.
- On a host's threads, the browser panel opens the host's localhost, the terminal is a shell on the host, and attached files are sent over.

## 0.0.9 - 2026-09-28

### Changed

- Threads settle once they've been idle for a set number of days (7 by default), read or not. Settle and Unsettle from the thread menu hold until the thread's next turn starts. Settings has one "Settle idle threads" option in place of the settle delay and auto-settle switch.
- Which threads are settled or unread is kept by MassCode itself, so every window shows the same lists. Existing threads start out read.

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
