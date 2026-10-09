import {
  ClientCommand,
  ProviderKind,
  RuntimeEvent,
  ServerFrame,
  type SearchHit,
  type Settings,
} from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkoutBranch, createBranch, listFiles, readCheckpointDiff } from "./git.ts";
import { expandHome, listFolders } from "./folders.ts";
import { ProviderError } from "./providers/ProviderAdapter.ts";
import { ProviderRegistry } from "./providers/ProviderRegistry.ts";
import * as ProjectsStoreLive from "./storage/ProjectsStore.ts";
import * as SettingsStoreLive from "./storage/SettingsStore.ts";
import * as ThreadStoreLive from "./storage/ThreadStore.ts";
import { type ProjectNotFound, ProjectsStore } from "./storage/ProjectsStore.ts";
import { SettingsStore } from "./storage/SettingsStore.ts";
import { ThreadStore } from "./storage/ThreadStore.ts";
import { type Browsers, createBrowsers } from "./browsers.ts";
import { createDevices, type Devices } from "./devices.ts";
import { createMcp, type Mcp } from "./mcp.ts";
import { createTerminals, type Terminals } from "./terminals.ts";
import { createSkillCatalog } from "./skills.ts";
import { createRepoPanel } from "./repoPanel.ts";
import { createAgents, formatCommandRun } from "./threads/agents.ts";
import { createHistory } from "./threads/history.ts";
import { createSideChats } from "./threads/sideChats.ts";
import { createThreadOpener } from "./threads/opening.ts";
import { createOrchestration } from "./threads/orchestration.ts";
import { createThreadRegistry, type SequencedEvent, type ThreadRead } from "./threads/registry.ts";
import { CommandError } from "./errors.ts";
import { coalesceLoads } from "./coalesceLoads.ts";
import { ADAPTERS } from "./harnesses.ts";
import { deriveTitle, isBusy } from "./threads/entry.ts";

/** Harnesses can still refuse right at the reset (MonoCode waits this long too). */
const LIMIT_RESET_GRACE_MS = 30_000;

const REAP_INTERVAL_MS = 5 * 60 * 1000;

export class SessionManager extends Context.Service<
  SessionManager,
  {
    readonly dispatch: (
      command: ClientCommand,
    ) => Effect.Effect<void, CommandError | ProviderError | ProjectNotFound>;
    /** Subscribes, then snapshots the shell synchronously, so the stream continues exactly where it ends. */
    readonly subscribe: Effect.Effect<
      Omit<Extract<ServerFrame, { _tag: "shell" }>, "_tag" | "root" | "protocol"> & {
        readonly live: Stream.Stream<SequencedEvent>;
      },
      never,
      Scope.Scope
    >;
    readonly terminals: Terminals;
    readonly browsers: Browsers;
    readonly devices: Devices;
    readonly mcp: Mcp;
    /**
     * A thread's transcript: what was missed since `after`, or the latest `turnLimit` turns.
     * Synchronous, so live events with a `seq` above the read's are exactly the ones it lacks.
     */
    readonly readThread: (
      threadId: string,
      after: number | null,
      turnLimit: number,
    ) => ThreadRead | null;
    readonly readOlder: (
      threadId: string,
      before: number,
      turnLimit: number,
    ) => Omit<Extract<ServerFrame, { _tag: "thread.page" }>, "_tag" | "threadId"> | null;
    /** Messages matching `query`, newest first, in threads that still exist. */
    readonly search: (query: string) => ReadonlyArray<SearchHit>;
    readonly shutdown: Effect.Effect<void>;
    /** Some thread's turn is going, the agent working or waiting on the user. */
    readonly hasActiveTurns: () => boolean;
  }
>()("masscode/SessionManager") {}

const make = Effect.gen(function* () {
  // Every effect started from a callback runs here, so closing the daemon's scope interrupts it.
  const runFork = yield* FiberSet.makeRuntime();

  const settingsStore = yield* SettingsStore;
  const projectsStore = yield* ProjectsStore;
  const store = yield* ThreadStore;
  const providerRegistry = yield* ProviderRegistry;
  const {
    threads,
    getEntry,
    publish,
    publishSideChat,
    flushDeltas,
    reportErrorsIn,
    refreshMeta,
    setTitle,
    followAgentCwd,
    markUpdated,
    refreshShelved,
    setShelveOverride,
    setResumeTokens,
    setCoverage,
    setQueue,
    setLimitStop,
    saveSettings,
    subscribe,
    forgetStreaming,
    readThread,
    readOlder,
    search,
  } = yield* createThreadRegistry({
    store,
    settingsStore,
    onShelve: (entry) => {
      terminals.closeIdle(entry.info.id);
      // Shelved threads never have a turn going; like the idle reaper, the next message resumes from the token.
      if (entry.session) runFork(dropSession(entry, null));
    },
  });

  providerRegistry.setListener({
    onProviders: (providers) =>
      publish(RuntimeEvent.cases["providers.updated"].make({ providers: [...providers] })),
    onFlow: (flow) => publish(RuntimeEvent.cases["auth.flow"].make({ flow })),
  });

  const terminals = createTerminals({
    findFolder: (threadId) => threads.get(threadId)?.info.cwd ?? null,
    onOpened: (terminal) => publish(RuntimeEvent.cases["terminal.opened"].make(terminal)),
    onClosed: (terminal) => publish(RuntimeEvent.cases["terminal.closed"].make(terminal)),
  });
  const browsers = createBrowsers();
  const devices = createDevices((threadId, deviceId) =>
    publish(RuntimeEvent.cases["thread.device"].make({ threadId, deviceId })),
  );
  const skills = yield* createSkillCatalog({
    readSkills: (provider, cwd) =>
      Effect.flatMap(settingsStore.get, (settings) =>
        ADAPTERS[provider].listSkills({ cwd, harness: settings.providers[provider] }),
      ),
    onListed: (provider, path, listing) =>
      publish(
        RuntimeEvent.cases["skills.listed"].make({
          provider,
          path,
          skills: listing.skills.map(({ name, description }) => ({ name, description })),
          error: listing.error,
        }),
      ),
  });

  const {
    dropSession,
    interrupt,
    runOnLiveSession,
    removeThread,
    setArchived,
    send,
    sendQueued,
    ensureHarnessReady,
    compact,
    listCommands,
    readUsage,
    reapIdleSessions,
    setModel,
    resumeAfterLimit,
  } = yield* createAgents({
    runFork,
    store,
    settingsStore,
    providerRegistry,
    skills,
    terminals,
    devices,
    // The agents' MCP servers serve the orchestration tools, which need the agents: bound late.
    mcp: {
      issue: (threadId) => mcp.issue(threadId),
      revoke: (threadId) => mcp.revoke(threadId),
    },
    threads,
    getEntry,
    publish,
    reportErrorsIn,
    followAgentCwd,
    setResumeTokens,
    setCoverage,
    setQueue,
    setLimitStop,
    forgetStreaming,
  });

  const history = createHistory({
    store,
    settingsStore,
    threads,
    getEntry,
    publish,
    markUpdated,
    setResumeTokens,
    setCoverage,
    dropSession,
  });

  const sideChats = createSideChats({
    runFork,
    store,
    settingsStore,
    getEntry,
    publishSideChat,
    reportErrorsIn,
    ensureHarnessReady,
  });

  // Idle threads shelve with time alone; the threshold is in days, so a check a minute is plenty.
  // Resuming at a usage limit's reset rides along: a minute late is fine, and it survives sleep.
  yield* Effect.forkScoped(
    Effect.schedule(
      Effect.sync(() => {
        for (const entry of threads.values()) {
          refreshShelved(entry);
          const stop = entry.info.limitStop;
          if (
            stop?.resumeAtReset &&
            stop.resetsAt !== null &&
            Date.now() >= stop.resetsAt + LIMIT_RESET_GRACE_MS
          )
            runFork(
              resumeAfterLimit(entry, stop.resumeAtReset).pipe(
                reportErrorsIn(entry.info.id),
                Effect.ignore,
              ),
            );
        }
      }),
      Schedule.spaced("1 minute"),
    ),
  );

  yield* Effect.forkScoped(Effect.schedule(reapIdleSessions, Schedule.spaced(REAP_INTERVAL_MS)));

  const repoPanel = yield* createRepoPanel({ settingsStore, publish, threads, refreshMeta });

  const readLimits = yield* coalesceLoads(
    Effect.fn("readLimits")(function* (provider: string) {
      if (!Schema.is(ProviderKind)(provider)) return;

      const { limits, error } = yield* providerRegistry.readLimits(provider);
      publish(RuntimeEvent.cases["provider.limits"].make({ provider, limits: [...limits], error }));
    }),
  );

  const { createWorktree, setUpWorktree, openThread, createThread } = createThreadOpener({
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
  });

  const orchestration = createOrchestration({
    store,
    projectsStore,
    threads,
    getEntry,
    publish,
    reportErrorsIn,
    send,
    interrupt,
    ensureHarnessReady,
    createWorktree,
    setUpWorktree,
    openThread,
  });

  const mcp = createMcp(
    (threadId, action) => browsers.request(threadId, action),
    orchestration,
    devices,
  );

  function dispatch(command: ClientCommand) {
    return ClientCommand.match<Effect.Effect<void, CommandError | ProviderError | ProjectNotFound>>(
      command,
      {
        "thread.create": createThread,
        "thread.send": (command) =>
          Effect.flatMap(getEntry(command.threadId), (entry) =>
            send(entry, command.text, command.options, command),
          ),
        "thread.sendQueued": ({ threadId, messageId }) =>
          Effect.map(getEntry(threadId), (entry) => {
            const message = (entry.info.queue ?? []).find((queued) => queued.id === messageId);
            if (message) sendQueued(entry, message);
          }),
        "thread.unqueue": ({ threadId, messageIds }) =>
          Effect.map(getEntry(threadId), (entry) =>
            setQueue(
              entry,
              (entry.info.queue ?? []).filter((queued) => !messageIds.includes(queued.id)),
            ),
          ),
        "thread.resumeAfterLimit": ({ threadId, options, provider }) =>
          Effect.flatMap(getEntry(threadId), (entry) => resumeAfterLimit(entry, options, provider)),
        "thread.resumeAtReset": ({ threadId, options }) =>
          Effect.map(getEntry(threadId), (entry) => {
            const stop = entry.info.limitStop;
            if (stop) setLimitStop(entry, { ...stop, resumeAtReset: options });
          }),
        "thread.dismissLimitStop": ({ threadId }) =>
          Effect.map(getEntry(threadId), (entry) => {
            if (entry.info.limitStop) setLimitStop(entry, null);
          }),
        "thread.rewind": history.rewind,
        "thread.fork": history.fork,
        "sideChat.ask": sideChats.ask,
        "sideChat.close": ({ sideChatId }) => sideChats.close(sideChatId),
        "thread.compact": (command) => compact(command.threadId),
        "thread.listCommands": (command) => listCommands(command.threadId),
        "skills.list": (command) =>
          Effect.sync(() => skills.requestListing(command.provider, command.path)),
        "thread.readUsage": (command) => readUsage(command.threadId),
        "checkpoint.diff": (command) =>
          Effect.gen(function* () {
            const entry = yield* getEntry(command.threadId);
            const diff = yield* Effect.promise(() =>
              readCheckpointDiff(entry.info.cwd, command.threadId, command.messageId),
            );
            publish(
              RuntimeEvent.cases["checkpoint.diff"].make({
                threadId: command.threadId,
                messageId: command.messageId,
                ...diff,
              }),
            );
          }),
        "git.listBranches": (command) => repoPanel.publishBranches(command.path),
        "git.listFiles": ({ path }) =>
          Effect.promise(() => listFiles(path)).pipe(
            Effect.map((files) => publish(RuntimeEvent.cases["git.files"].make({ path, files }))),
          ),
        "git.diff": (command) => repoPanel.refreshDiff(command.path),
        "git.checkout": ({ path, branch }) =>
          repoPanel.changeBranch(path, () => checkoutBranch(path, branch)),
        "git.createBranch": ({ path, branch }) =>
          repoPanel.changeBranch(path, () => createBranch(path, branch)),
        "git.status": (command) => repoPanel.refreshStatus(command.path),
        "git.commit": ({ path, message, push }) => repoPanel.commit(path, message, push),
        "git.push": ({ path }) => repoPanel.push(path),
        "git.createPullRequest": ({ path }) => repoPanel.createPullRequest(path),
        "git.mergePullRequest": ({ path, method }) => repoPanel.mergePullRequest(path, method),
        "git.mergeIntoBase": ({ path }) => repoPanel.mergeIntoBase(path),
        "sourceControl.refresh": () => repoPanel.refreshSourceControl,
        "thread.setModel": setModel,
        "project.add": (command) =>
          projectsStore
            .ensure(command.path)
            .pipe(
              Effect.map(({ project, isNew }) =>
                isNew ? publish(RuntimeEvent.cases["project.added"].make({ project })) : undefined,
              ),
            ),
        "project.scan": (command) =>
          Effect.gen(function* () {
            async function findRepos(folder: string, levels: number): Promise<Array<string>> {
              if (existsSync(join(folder, ".git"))) return [folder];
              if (levels === 0) return [];
              const { path, folders } = await listFolders(folder);
              return (
                await Promise.all(folders.map((name) => findRepos(join(path, name), levels - 1)))
              ).flat();
            }

            // Three levels, never inside a repo: the home folder's default still finds ~/code/group/repo,
            // without walking dependency and cache trees.
            const repos = yield* Effect.promise(() =>
              findRepos(resolve(expandHome(command.path)), 3),
            );
            yield* Effect.forEach(repos, (folder) =>
              projectsStore.ensure(folder).pipe(
                Effect.map(({ project, isNew }) =>
                  isNew
                    ? publish(RuntimeEvent.cases["project.added"].make({ project }))
                    : undefined,
                ),
                Effect.ignore,
              ),
            );
          }),
        "providers.refresh": () => providerRegistry.refresh,
        "provider.link": (command) => providerRegistry.link(command.provider),
        "provider.linkCode": (command) =>
          providerRegistry.submitCode(command.provider, command.code),
        "provider.linkCancel": (command) => providerRegistry.cancelLink(command.provider),
        "provider.unlink": (command) => providerRegistry.unlink(command.provider),
        "provider.readLimits": (command) => readLimits(command.provider),
        "thread.interrupt": (command) => Effect.flatMap(getEntry(command.threadId), interrupt),
        "thread.stopAgent": (command) =>
          runOnLiveSession(
            command.threadId,
            (session) => session.stopAgent?.(command.toolId) ?? Effect.void,
          ),
        "approval.respond": (command) =>
          runOnLiveSession(command.threadId, (session) =>
            session.respondApproval(command.requestId, command.decision, command),
          ),
        "thread.close": (command) => removeThread(command.threadId),
        "thread.archive": (command) =>
          Effect.flatMap(getEntry(command.threadId), (entry) =>
            setArchived(entry, command.archived),
          ),
        // A window showing an older update than another already marked can't take the mark back.
        "thread.seen": ({ threadId, rev }) =>
          Effect.map(getEntry(threadId), (entry) => {
            if (rev <= entry.info.seenRev) return;

            entry.info = { ...entry.info, seenRev: rev };
            store.setSeenRev(threadId, rev);
            publish(RuntimeEvent.cases["thread.seen"].make({ threadId, seenRev: rev }));
          }),
        "thread.rename": ({ threadId, title }) =>
          Effect.map(getEntry(threadId), (entry) =>
            setTitle(entry, deriveTitle(title, entry.info.title)),
          ),
        "thread.shelve": ({ threadId, shelved }) =>
          Effect.map(getEntry(threadId), (entry) => {
            setShelveOverride(entry, shelved ? "shelved" : "active");
            refreshShelved(entry);
          }),
        "project.remove": (command) =>
          Effect.gen(function* () {
            if (!(yield* projectsStore.remove(command.projectId))) return;

            const owned = [...threads.values()].filter(
              (entry) => entry.info.projectId === command.projectId,
            );
            yield* Effect.forEach(owned, (entry) => removeThread(entry.info.id), { discard: true });
            publish(RuntimeEvent.cases["project.removed"].make({ projectId: command.projectId }));
          }),
        "terminal.write": (command) =>
          Effect.sync(() => terminals.write(command.threadId, command.terminalId, command.data)),
        "terminal.resize": (command) =>
          Effect.sync(() =>
            terminals.resize(command.threadId, command.terminalId, command.columns, command.rows),
          ),
        "terminal.close": (command) =>
          Effect.sync(() => terminals.close(command.threadId, command.terminalId)),
        "terminal.run": ({ threadId, terminalId, command, columns, rows, options }) =>
          Effect.flatMap(getEntry(threadId), (entry) => {
            const runError = terminals.run(threadId, terminalId, command, columns, rows, (exit) => {
              if (exit.wasStopped) return;
              const run = { command, exitCode: exit.exitCode, output: exit.output };
              runFork(
                send(entry, formatCommandRun(run), options, { run }).pipe(
                  reportErrorsIn(threadId),
                  Effect.ignore,
                ),
              );
            });
            return runError
              ? Effect.fail(
                  new CommandError({ message: `Couldn't run the command: ${runError.message}` }),
                )
              : Effect.void;
          }),
        // Per connection; the server answers these.
        "thread.subscribe": () => Effect.void,
        "thread.unsubscribe": () => Effect.void,
        "thread.loadOlder": () => Effect.void,
        search: () => Effect.void,
        "folder.list": () => Effect.void,
        "project.config": () => Effect.void,
        "project.saveConfig": () => Effect.void,
        "image.sign": () => Effect.void,
        "project.clone": () => Effect.void,
        "terminal.open": () => Effect.void,
        "terminal.detach": () => Effect.void,
        "terminal.acknowledge": () => Effect.void,
        "browser.host": () => Effect.void,
        "browser.respond": () => Effect.void,
        "device.list": () => Effect.void,
        "device.attach": () => Effect.void,
        "settings.update": (command) =>
          Effect.gen(function* () {
            // A different binary, config dir or env can mean another version or account.
            function serializeLaunchSettings(value: Settings) {
              return JSON.stringify(
                ProviderKind.literals.map((kind) => {
                  const { binaryPath, configDir, env, launchArgs } = value.providers[kind];
                  return [binaryPath, configDir, env, launchArgs];
                }),
              );
            }

            const before = yield* settingsStore.get;
            // The settings apply even when they can't be saved, so the harnesses follow them either way.
            yield* saveSettings(command.settings).pipe(
              Effect.ensuring(
                serializeLaunchSettings(before) === serializeLaunchSettings(command.settings)
                  ? Effect.void
                  : providerRegistry.refresh,
              ),
            );
          }),
      },
    );
  }

  return SessionManager.of({
    dispatch: (command) =>
      dispatch(command).pipe(reportErrorsIn("threadId" in command ? command.threadId : null)),
    subscribe: Effect.gen(function* () {
      const live = yield* subscribe;

      return {
        dataId: store.dataId,
        settings: yield* settingsStore.get,
        projects: yield* projectsStore.list,
        providers: yield* providerRegistry.list,
        threads: [...threads.values()].map((entry) => entry.info),
        terminals: terminals.list(),
        live,
      };
    }),
    terminals,
    browsers,
    devices,
    mcp,
    readThread,
    readOlder,
    search,
    hasActiveTurns: () => [...threads.values()].some(isBusy),
    shutdown: Effect.gen(function* () {
      flushDeltas();
      terminals.closeAll();

      yield* Effect.promise(() => devices.close());
      yield* sideChats.closeAll;
      yield* Effect.forEach(
        [...threads.values()],
        (entry) =>
          dropSession(
            entry,
            "MassCode quit while this turn was running. Send a message to pick up where it left off.",
          ),
        { discard: true },
      );
    }),
  });
});

export const layer = Layer.effect(SessionManager, make);

/** The manager on its stores, with `registry` for the harnesses: the daemon's, or the tests' stub. */
export function composeLayer<E, R>(registry: Layer.Layer<ProviderRegistry, E, R>) {
  return layer.pipe(
    Layer.provide(Layer.mergeAll(ProjectsStoreLive.layer, ThreadStoreLive.layer, registry)),
    Layer.provideMerge(SettingsStoreLive.layer),
  );
}
