/**
 * Opening new threads: in the project's folder or a worktree of their own (running its setup),
 * named after their first message until the writer model titles them.
 */
import {
  type ClientCommand,
  RuntimeEvent,
  type ThreadInfo,
  WORKTREE_SETUP_TERMINAL_ID,
} from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { basename, join, relative } from "node:path";
import { CommandError } from "../errors.ts";
import { addWorktree, readBranch, readRepoRoot } from "../git.ts";
import { buildWriterInput } from "../harnesses.ts";
import { readProjectConfig } from "../projectConfig.ts";
import { DATA_DIR } from "../storage/jsonFile.ts";
import type { ProjectsStore } from "../storage/ProjectsStore.ts";
import type { SettingsStore } from "../storage/SettingsStore.ts";
import type { ThreadHome, ThreadStore } from "../storage/ThreadStore.ts";
import type { Terminals } from "../terminals.ts";
import { generateThreadTitle } from "../writer.ts";
import type { Agents } from "./agents.ts";
import { buildThreadInfo, createEntry, deriveTitle, type ThreadEntry } from "./entry.ts";
import type { ThreadRegistry } from "./registry.ts";

const WORKTREES_DIR = join(DATA_DIR, "worktrees");

export type ThreadOpener = ReturnType<typeof createThreadOpener>;

export function createThreadOpener({
  store,
  settingsStore,
  projectsStore,
  terminals,
  threads,
  publish,
  reportErrorsIn,
  setTitle,
  saveSettings,
  send,
  sendQueued,
}: Pick<ThreadRegistry, "threads" | "publish" | "reportErrorsIn" | "setTitle" | "saveSettings"> &
  Pick<Agents, "send" | "sendQueued"> & {
    readonly store: typeof ThreadStore.Service;
    readonly settingsStore: typeof SettingsStore.Service;
    readonly projectsStore: typeof ProjectsStore.Service;
    readonly terminals: Terminals;
  }) {
  /**
   * A worktree of the project's repo on a new branch named after the thread, under the
   * data dir. Resolves to the thread's folder in it (the project may be a repo subfolder).
   */
  const createWorktree = Effect.fn("createWorktree")(function* (
    projectPath: string,
    title: string,
    threadId: string,
  ) {
    const root = yield* Effect.promise(() => readRepoRoot(projectPath));
    if (!root)
      return yield* new CommandError({
        message: "New worktrees need the project to be a git repo",
      });

    const slug = `${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "thread"
    }-${threadId.slice(0, 6)}`;
    const path = join(WORKTREES_DIR, basename(root), slug);
    const { worktreeFromOrigin } = yield* settingsStore.get;
    const error = yield* Effect.promise(() =>
      addWorktree(projectPath, path, `masscode/${slug}`, worktreeFromOrigin === true),
    );
    if (error) return yield* new CommandError({ message: `Couldn't create a worktree: ${error}` });

    return join(path, relative(root, projectPath));
  });

  /**
   * Runs `masscode.toml`'s worktree setup in the thread's new worktree; unless told not to wait,
   * messages queue until it ends.
   */
  const setUpWorktree = Effect.fn("setUpWorktree")(function* (
    entry: ThreadEntry,
    projectPath: string,
  ) {
    const threadId = entry.info.id;
    const config = yield* Effect.promise(() => readProjectConfig(projectPath));
    if (config instanceof Error)
      return publish(
        RuntimeEvent.cases.error.make({
          threadId,
          message: `${config.message}. The worktree's setup didn't run; fix the file and start a new thread.`,
        }),
      );

    const command = config.worktree?.setup?.trim();
    if (!command) return;

    const setupError = terminals.run(
      threadId,
      WORKTREE_SETUP_TERMINAL_ID,
      command,
      120,
      30,
      ({ exitCode, output, wasStopped }) => {
        if (threads.get(threadId) !== entry) return;

        publish(
          RuntimeEvent.cases["worktree.setup"].make({
            threadId,
            run: { command, exitCode, output },
            stopped: wasStopped,
          }),
        );
        if (!entry.isSettingUp) return;

        entry.isSettingUp = false;
        const [next] = entry.info.queue ?? [];
        if (next && entry.info.archivedAt === null) sendQueued(entry, next);
      },
      { MASSCODE_PROJECT_ROOT: projectPath },
    );
    if (setupError)
      return publish(
        RuntimeEvent.cases.error.make({
          threadId,
          message: `Couldn't run the worktree setup: ${setupError.message}`,
        }),
      );

    entry.isSettingUp = config.worktree?.wait_for_setup !== false;
  });

  /**
   * Adds a thread and announces it; the first line of `text` names it until the writer model's
   * summary lands.
   */
  const openThread = Effect.fn("openThread")(function* (
    info: ThreadInfo,
    home: ThreadHome,
    text: string,
    requestId: string | null,
  ) {
    const entry = createEntry(info, home);
    threads.set(info.id, entry);
    store.insertThread(info, home);
    publish(RuntimeEvent.cases["thread.created"].make({ thread: info, requestId }));

    const { title } = info;
    void generateThreadTitle({
      ...buildWriterInput(info.cwd, yield* settingsStore.get, []),
      text,
    })
      .then((summary) => {
        // Unless it's been renamed meanwhile.
        if (threads.get(info.id) === entry && entry.info.title === title)
          setTitle(entry, deriveTitle(summary, title));
      })
      .catch(() => {});

    return entry;
  });

  const createThread = Effect.fn("createThread")(function* (
    command: Extract<ClientCommand, { _tag: "thread.create" }>,
  ) {
    const { project, isNew } = yield* projectsStore.ensure(command.path);
    if (isNew) publish(RuntimeEvent.cases["project.added"].make({ project }));

    const id = crypto.randomUUID();
    const title = deriveTitle(command.text, project.name);
    const cwd =
      command.workspace === "worktree"
        ? yield* createWorktree(project.path, title, id)
        : project.path;

    const entry = yield* openThread(
      buildThreadInfo({
        id,
        projectId: project.id,
        provider: command.provider,
        model: command.model,
        cwd,
        title,
        branch: yield* Effect.promise(() => readBranch(cwd)),
        worktree: command.workspace === "worktree",
      }),
      { path: cwd, isWorktree: command.workspace === "worktree" },
      command.text,
      command.requestId,
    );
    if (command.workspace === "worktree") yield* setUpWorktree(entry, project.path);

    // New chats preselect whichever harness was used last.
    const settings = yield* settingsStore.get;
    if (settings.lastProvider !== command.provider) {
      yield* saveSettings({ ...settings, lastProvider: command.provider }).pipe(
        reportErrorsIn(null),
        Effect.ignore,
      );
    }

    yield* send(entry, command.text, command.options).pipe(
      reportErrorsIn(entry.info.id),
      Effect.ignore,
    );
  });

  return { createWorktree, setUpWorktree, openThread, createThread };
}
