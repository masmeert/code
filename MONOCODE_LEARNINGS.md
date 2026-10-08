# Learnings from MonoCode

Source: https://github.com/hardbeat920/monocode at commit `9a7b6a2` (v0.9.0).
Local clone: `/tmp/monocode-review/monocode`. If it's gone, run `git clone https://github.com/hardbeat920/monocode /tmp/monocode-review/monocode`.

Links below are pinned to that commit (`MC = https://github.com/hardbeat920/monocode/blob/9a7b6a2`).
MonoCode is Tauri + React, and its harness layer runs in the frontend. APCode's runs in the Bun/Effect daemon, so port the ideas, not the code.

---

## 1. One generic ACP adapter (more harnesses for little code)

Cursor, Grok Build, Hermes, Antigravity and fx all speak the Agent Client Protocol over stdio JSON-RPC. MonoCode has one shared core and a thin wrapper per provider.

**MonoCode**

- `src/integrations/harness/core/acp.ts`: ACP session lifecycle and event mapping
- `src/integrations/harness/core/jsonRpc.ts`: stdio JSON-RPC client (`initialize`, `session/prompt`, …)
- `src/integrations/harness/core/acpSubagents.ts`: subagent rows from ACP events
- `src/integrations/harness/core/child.ts`: process spawn and recovery
- `src/integrations/harness/core/registry.ts`, `register.ts`, `types.ts`: provider registration
- `src/integrations/harness/providers/cursor/cursor.ts`: reference consumer (`initialize` at ~L315, `session/prompt` at ~L461)
- Thinner examples: `providers/grok/`, `providers/hermes/`, `providers/fx/`, `providers/antigravity/`

**APCode touchpoints**

- `apps/daemon/src/providers/ProviderAdapter.ts`: `ProviderAdapter` interface (start, rewind, fork, readUsage, listSkills)
- `apps/daemon/src/providers/ProviderRegistry.ts`: registration, availability, usage
- `apps/daemon/src/providers/codexRpc.ts`: existing JSON-RPC client; check whether it can be reused
- `apps/daemon/src/providers/launch.ts`, `resolveExecutable.ts`: CLI resolution
- `packages/contracts/src`: `ProviderKind` and the event schemas

**Prompt**

> Add a generic ACP provider adapter to the daemon in `apps/daemon/src/providers/`, implementing `ProviderAdapter`. Reuse `codexRpc.ts` for JSON-RPC if it fits. Reference: MonoCode's `src/integrations/harness/core/acp.ts` and `jsonRpc.ts`, and `providers/cursor/cursor.ts` as a consumer (clone at `/tmp/monocode-review/monocode`). Start with Cursor (`agent acp`) as the first concrete provider. Rewind and fork can fail with a clear error where ACP doesn't support them.

---

## 2. Recovering from usage limits

When a limit hits: show the reset countdown, pause the queue, and offer to resume manually or automatically at reset, or to switch model, provider or account. When switching, the incoming provider gets the saved recap and the exhausted one is never called.

**MonoCode**

- `src/features/sessions/model/usageLimit.ts`: detection and reset-time parsing
- `src/features/sessions/ui/UsageLimitNotice.tsx`: notice UI (countdown, resume, switch)
- `src/features/sessions/model/messageQueue.ts`: queue pausing
- `src/features/sessions/model/handoff.ts`: switching provider using the recap

**APCode touchpoints**

- `apps/daemon/src/providers/ClaudeAdapter.ts`, `CodexAdapter.ts`: where limit errors surface
- `apps/daemon/src/SessionManager.ts`: queue (`setQueue` ~L750, `queue` ~L181) and the existing "stop pauses queue" flag (~L184)
- `apps/daemon/src/handoff.ts`: `handoffText`, already used for harness switches
- `apps/daemon/src/providers/ProviderRegistry.ts` ~L189: usage-limit windows (has reset times)
- `apps/web/src/views/ThreadView.tsx`, `apps/web/src/views/UsageMeter.tsx`

**Prompt**

> When a Claude or Codex turn fails on a usage limit, add a thread event carrying the reset time. The daemon pauses that thread's queue. ThreadView shows a notice with a countdown and three actions: resume now, resume automatically at reset, and switch harness (reuse `handoff.ts`). Reference: MonoCode's `src/features/sessions/model/usageLimit.ts` and `ui/UsageLimitNotice.tsx`. First find which error shapes each CLI emits for limits.

---

## 3. Multiple accounts per provider

Named Claude/Codex accounts, each project remembers its choice, threads stay on the account that started them, and the app suggests switching to an account with more headroom.

**MonoCode**

- `src/features/providers/model/providerAccounts.ts`: account model and selection
- `src/features/providers/model/providerAccountCredentials.ts`: per-account credential dirs
- `src/features/providers/model/providerAccountIdentity.ts`, `src-tauri/src/account_identity.rs`: plan, email, org
- `src/features/providers/model/rateLimitsFetch.ts`, `rateLimitsCache.ts`, `src-tauri/src/rate_limits.rs`: per-account usage
- `src/app/shell/UsageFooter.tsx`, `UsageProviderChip.tsx`: picker and headroom suggestion

**APCode touchpoints**

- `apps/daemon/src/providers/ProviderRegistry.ts` (~L38, ~L113, ~L124): single `account` today
- `apps/daemon/src/providers/launch.ts`: where to inject the per-account config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`)
- `apps/daemon/src/storage/`: thread → account pinning
- Settings → Harnesses UI in `apps/web`

**Prompt**

> Support several named accounts per harness. Each account is its own config dir passed through `launch.ts` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Threads store the account they started with, and projects remember a default. Reference: MonoCode's `src/features/providers/model/providerAccounts.ts` and `providerAccountCredentials.ts`. Before designing it, check how MonoCode isolates credentials.

---

## 4. Send failed CI checks to an agent

PR checks show the failing GitHub Actions job and step, with an action that sends the failure log to a thread for repair and tracks progress.

**MonoCode**

- `src-tauri/src/fs.rs` ~L1540 `git_github_pr_checks`, ~L3659 `github_pr_checks_args`, ~L3706 `parse_github_pr_checks`: the `gh` calls and parsing
- `src/features/inbox/model/githubPrChecks.ts`, `hooks/useGithubPrChecks.ts`: data and polling (only while the Checks tab is visible)
- `src/features/inbox/model/ciRepair.ts`, `ciRepairTracking.ts`: building the repair prompt and tracking it
- `src/features/inbox/ui/InboxPrChecks.tsx`, `CheckEvidence.tsx`, `CheckRepairForm.tsx`, `CheckRepairProgress.tsx`

**APCode touchpoints**

- `apps/daemon/src/sourceControl.ts`: `readPullRequest` (~L190); add a checks read next to it
- `apps/web/src/views/GitMenu.tsx`: PR view
- `apps/web/src/lib/composer.ts`: inserting the failure context into the composer

**Prompt**

> In the PR view from the git menu, list the PR's checks (`gh pr checks --json` / `glab ci status`). For a failed check, fetch the failing job log tail and add a "Fix with agent" action that drafts a message with the log into the thread's composer. Reference: MonoCode's `src-tauri/src/fs.rs` (`git_github_pr_checks*`) and `src/features/inbox/model/ciRepair.ts`. Poll only while the view is open.

---

## 5. BTW side conversation

Ask a read-only question about a finished reply without touching the main thread or the thread list.

**MonoCode**

- `src/features/sessions/model/btw.ts`: side session model
- `src/features/sessions/ui/BtwSheet.tsx`: sheet UI
- `src/features/sessions/ui/BtwQuestionBurst.tsx`, `modeCommands.tsx` (`/btw`)

**APCode touchpoints**

- `apps/daemon/src/SessionManager.ts` `fork` (~L1036): reuse the provider fork with a read-only permission mode and don't persist it as a thread
- `apps/web/src/views/ThreadView.tsx`: `AssistantTurn` (~L1870) actions and `ForkDialog` (~L1522)

**Prompt**

> Add "BTW" on finished assistant turns. It opens a sheet with an ephemeral, read-only side conversation forked at that turn (reuse `fork` in `SessionManager.ts`, plan/read-only permissions). It is not listed in the sidebar and is discarded on close. Reference: MonoCode's `src/features/sessions/model/btw.ts` and `ui/BtwSheet.tsx`.

---

## 6. Tools for long transcripts: find and prompt outline

⌘F inside a transcript with highlights and next/previous, plus an outline of prompts down the side for jumping between turns.

**MonoCode**

- `src/features/sessions/ui/TranscriptFind.tsx` (+ `TranscriptFind.test.ts`)
- `src/features/sessions/ui/PromptOutline.tsx`

**APCode touchpoints**

- `apps/web/src/views/ThreadView.tsx`: `UserTurn` (~L1405), `AssistantTurn` (~L1870)
- `apps/web/src/lib/keybindings.ts`, `useShortcut.ts`

**Prompt**

> Add in-thread find to ThreadView: ⌘F opens a bar, matches are highlighted, Enter / ⇧Enter or ⌘G move between them, and Esc closes it. Add a thin outline on the right with one marker per user turn that scrolls to that turn and shows the prompt on hover. Reference: MonoCode's `src/features/sessions/ui/TranscriptFind.tsx` and `PromptOutline.tsx`.

---

## 7. Treat git paths literally (small bug fix)

`git restore -- <paths>` still interprets `*`, `?` and `:(…)` in paths as patterns, so a filename containing one could restore other files.

**MonoCode**

- `host/workspace.ts` ~L788 and `src-tauri/src/fs.rs` ~L2426 / ~L2504: `--literal-pathspecs`

**APCode touchpoints**

- `apps/daemon/src/git.ts`: `execGit` (~L37) and `gitLong` (~L190); `restoreCheckpoint` (~L634, restore at ~L656)

**Prompt**

> Set `GIT_LITERAL_PATHSPECS=1` in the env used by `execGit` and `gitLong` in `apps/daemon/src/git.ts`, so file paths are never read as patterns. Check that no call relies on pattern matching (e.g. `add -A` is fine).

---

## 8. Slower updates for background threads (low priority)

APCode already re-renders at most once per frame (`apps/web/src/lib/store.ts` ~L738) and memoizes turns. MonoCode goes one step further: threads that aren't visible flush on a 100 ms timer instead of every frame, and approvals and questions are still shown immediately.

**MonoCode**

- `src/app/model/harnessFlush.ts`: `scheduleHarnessFlush`, `HarnessEventQueue`
- `src/features/sessions/ui/TranscriptPool.tsx`: reuses mounted transcripts across tab switches

**APCode touchpoints**

- `apps/web/src/lib/store.ts` `setState` / `notify` (~L725) and `ws.onmessage` (~L1225)

**Prompt**

> Only if profiling shows several streaming threads cost frames: in `apps/web/src/lib/store.ts`, batch deltas for threads that aren't visible on a ~100 ms timer, keeping the per-frame path for the visible thread. Approvals and questions always flush immediately. Reference: MonoCode's `src/app/model/harnessFlush.ts`.

---

## Skipped on purpose

Monos (persistent agents with soul, memory and habits), mascots and empty-pane games, background effects, Jira/Linear/Azure DevOps inbox, the notes app, a full code editor, and the extra Linux packaging targets. These are features that pile up from shipping daily; they're out of APCode's scope.
