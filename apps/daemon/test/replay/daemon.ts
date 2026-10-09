/**
 * The daemon as production runs it (SessionManager, adapters, SQLite, settings), with the
 * provider CLIs replaced by the replay peer. Only the CLI-status probes are stubbed.
 */
import {
  ClientCommand,
  ProviderKind,
  RuntimeEvent,
  type Effort,
  type PermissionLevel,
  type ProviderStatus,
  type Settings,
  type ThreadInfo,
} from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORT } from "../../src/port.ts";
import { ProviderRegistry } from "../../src/providers/ProviderRegistry.ts";
import { serve } from "../../src/server.ts";
import * as SessionManagerLive from "../../src/SessionManager.ts";
import { SessionManager } from "../../src/SessionManager.ts";
import { DATA_DIR } from "../../src/storage/jsonFile.ts";
import * as ProjectsStoreLive from "../../src/storage/ProjectsStore.ts";
import * as SettingsStoreLive from "../../src/storage/SettingsStore.ts";
import * as ThreadStoreLive from "../../src/storage/ThreadStore.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { decodeFixture, Frame, type Fixture, type Step } from "./peer.ts";

export const FAKE_CLI = join(import.meta.dir, "fake-cli");

function buildReplaySettings(kind: ProviderKind) {
  return {
    defaultModel: null,
    binaryPath: FAKE_CLI,
    env: { MASSCODE_REPLAY: `replay-${kind}.json` },
  };
}

/** Each harness runs the peer; `harness` swaps in other settings for it, like recording. */
function buildSettings(harness: Partial<Settings["providers"]>): Settings {
  return {
    theme: "system",
    lastProvider: "claude",
    // Pinned to Claude, whose one-shot calls the peer turns away, so titles never use up a fixture session.
    commitModel: "claude:haiku",
    providers: {
      claude: harness.claude ?? buildReplaySettings("claude"),
      codex: harness.codex ?? buildReplaySettings("codex"),
      cursor: { defaultModel: null },
    },
  };
}

const registry = Layer.succeed(
  ProviderRegistry,
  ProviderRegistry.of({
    list: Effect.succeed(
      ProviderKind.literals.map((kind): ProviderStatus => ({
        kind,
        installed: true,
        version: "replay",
        linked: true,
        account: null,
        plan: null,
        models: [],
        error: null,
      })),
    ),
    refresh: Effect.void,
    link: () => Effect.void,
    submitCode: () => Effect.void,
    cancelLink: () => Effect.void,
    unlink: () => Effect.void,
    readLimits: () => Effect.succeed({ limits: [], error: null }),
    setListener: () => {},
  }),
);

const layer = SessionManagerLive.layer.pipe(
  Layer.provide(Layer.mergeAll(ProjectsStoreLive.layer, ThreadStoreLive.layer, registry)),
  Layer.provideMerge(SettingsStoreLive.layer),
);

/** A project folder whose threads replay these fixtures. */
export function createProject(fixtures: Partial<Record<ProviderKind, Fixture>>) {
  const folder = mkdtempSync(join(tmpdir(), "masscode-project-"));
  for (const [kind, fixture] of Object.entries(fixtures))
    writeFileSync(join(folder, `replay-${kind}.json`), JSON.stringify(fixture));
  return folder;
}

/** A line of the peer's log: a spawn, or a frame the adapter sent. */
const Logged = Schema.Struct({
  spawn: Schema.optional(Schema.Number),
  pid: Schema.optional(Schema.Number),
  args: Schema.optional(Schema.Array(Schema.String)),
  mcpToken: Schema.optional(Schema.NullOr(Schema.String)),
  session: Schema.optional(Schema.Number),
  out: Schema.optional(Frame),
});

const decodeLogged = Schema.decodeUnknownSync(Schema.fromJsonString(Logged));

/** What the adapter did with the CLI in `folder`: each spawn, then each frame it sent. */
export function readPeerLog(folder: string, kind: ProviderKind) {
  const path = join(folder, `replay-${kind}.json.log.jsonl`);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeLogged(line));
}

/** What an orchestration tool answered: its JSON, or the error's text for the agent. */
const ToolResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  isError: Schema.optional(Schema.Boolean),
});

const decodeToolResult = Schema.decodeUnknownSync(ToolResult);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

export async function startDaemon(harness: Partial<Settings["providers"]> = {}) {
  writeFileSync(join(DATA_DIR, "settings.json"), JSON.stringify(buildSettings(harness)));
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const manager = Context.get(context, SessionManager);

  const events: Array<RuntimeEvent> = [];
  const waiters = new Set<() => void>();
  await Effect.runPromise(
    Effect.forkIn(
      Effect.scoped(
        Effect.flatMap(manager.subscribe, ({ live }) =>
          Stream.runForEach(live, ({ event }) =>
            Effect.sync(() => {
              events.push(event);
              for (const wake of waiters) wake();
            }),
          ),
        ),
      ),
      scope,
    ),
  );

  const folders = new Set<string>();

  /** Resolves with the first event, from the start of this daemon, that `test` accepts. */
  function waitFor<A extends RuntimeEvent>(
    test: (event: RuntimeEvent) => event is A,
    timeoutMs?: number,
  ): Promise<A>;
  function waitFor(
    test: (event: RuntimeEvent) => boolean,
    timeoutMs?: number,
  ): Promise<RuntimeEvent>;
  function waitFor(test: (event: RuntimeEvent) => boolean, timeoutMs = 4_000) {
    return new Promise<RuntimeEvent>((resolve, reject) => {
      function resolveIfFound() {
        const found = events.find(test);
        if (!found) return;

        stopWaiting();
        resolve(found);
      }

      function stopWaiting() {
        clearTimeout(timer);
        waiters.delete(resolveIfFound);
      }

      const timer = setTimeout(() => {
        stopWaiting();
        reject(
          new Error(
            `No matching event within ${timeoutMs} ms. Got:\n${events.map((event) => JSON.stringify(event)).join("\n")}`,
          ),
        );
      }, timeoutMs);

      waiters.add(resolveIfFound);
      resolveIfFound();
    });
  }

  return {
    manager,
    events,
    waitFor,
    /** Runs a command as a client would; resolves to its error message, if it failed. */
    dispatch: (command: ClientCommand) =>
      Effect.runPromise(
        manager.dispatch(command).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.message)),
        ),
      ),
    /** Starts a thread in `folder` and resolves to it once created. */
    async createThread(
      folder: string,
      text: string,
      {
        provider = "claude",
        permission = "ask",
        effort = null,
      }: { provider?: ProviderKind; permission?: PermissionLevel; effort?: Effort | null } = {},
    ) {
      folders.add(folder);

      const requestId = crypto.randomUUID();
      void Effect.runPromise(
        Effect.ignore(
          manager.dispatch(
            ClientCommand.cases["thread.create"].make({
              path: folder,
              provider,
              model: null,
              text,
              options: { effort, permission, attachments: [] },
              requestId,
              workspace: "local",
            }),
          ),
        ),
      );
      const created = await waitFor(
        (event): event is Extract<RuntimeEvent, { _tag: "thread.created" }> =>
          RuntimeEvent.guards["thread.created"](event) && event.requestId === requestId,
      );
      return created.thread;
    },
    /** Sends a message as the composer does; resolves to the command's error message, if any. */
    send: (
      threadId: string,
      text: string,
      extra: Partial<
        Omit<Extract<ClientCommand, { _tag: "thread.send" }>, "_tag" | "threadId" | "text">
      > = {},
    ) =>
      Effect.runPromise(
        manager
          .dispatch(
            ClientCommand.cases["thread.send"].make({
              threadId,
              text,
              options: { effort: null, permission: "ask", attachments: [] },
              ...extra,
            }),
          )
          .pipe(
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error.message)),
          ),
      ),
    /**
     * The orchestration tools as the agent holding `token` sees them. Results are JSON, or the
     * error's text when `isError`.
     */
    async connectAgentTools(token: string) {
      const client = new Client({ name: "replay-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1/mcp/masscode"),
        {
          fetch: (url, init) => manager.mcp.handleRequest(new Request(url, init)),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        },
      );
      // SAFETY: the SDK's own transport; its `sessionId?: string` only clashes with exactOptionalPropertyTypes.
      await client.connect(transport as Transport);

      return {
        async call(name: string, args: Schema.JsonObject) {
          const result = decodeToolResult(await client.callTool({ name, arguments: args }));
          const text = result.content.map((part) => part.text ?? "").join("");
          return result.isError
            ? { isError: true, text, json: {} }
            : { isError: false, text, json: decodeJson(text) };
        },
      };
    },
    /** Serves clients over WebSocket, as the app connects, on a free port; resolves to it. */
    async listen() {
      await Effect.runPromise(
        serve(0).pipe(Effect.provideService(SessionManager, manager), Scope.provide(scope)),
      );
      return PORT;
    },
    listThreads: () =>
      Effect.runPromise(Effect.scoped(Effect.map(manager.subscribe, ({ threads }) => threads))),
    /** The stored transcript, as a client loading the thread gets it. */
    readTranscript: (threadId: string) =>
      (manager.readThread(threadId, null, 10_000)?.frame.events ?? []).map(({ event }) => event),
    /** Quits like the app does. */
    async stop() {
      await Effect.runPromise(manager.shutdown);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
    /** Dies without cleaning up, like a crash or a kill -9, taking the agent processes with it. */
    async crash() {
      await Effect.runPromise(Scope.close(scope, Exit.void));

      for (const folder of folders)
        for (const kind of ProviderKind.literals)
          for (const { pid } of readPeerLog(folder, kind))
            if (pid !== undefined)
              try {
                process.kill(pid, "SIGKILL");
              } catch {}
    },
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** A recorded fixture from `test/fixtures`, to replay as is or cut into a scenario. */
export function readFixture(name: string): Fixture {
  return decodeFixture(
    readFileSync(join(import.meta.dir, "..", "fixtures", `${name}.json`), "utf8"),
  );
}

/** Steps up to and including the first one `stop` accepts. */
export function takeUntil(steps: ReadonlyArray<Step>, stop: (step: Step) => boolean): Array<Step> {
  const end = steps.findIndex(stop);
  if (end === -1) throw new Error("until: no step matched");

  return steps.slice(0, end + 1);
}

/** The step that answers the request awaited as `name`. */
export function matchReplyTo(name: string) {
  return (step: Step) => "reply" in step && step.to === name;
}

/** The first wait for a frame like `pattern`. */
export function matchAwait(pattern: Schema.JsonObject) {
  return (step: Step) => "await" in step && JSON.stringify(step.await) === JSON.stringify(pattern);
}

/** Codex picks a thread back up with `thread/resume` where a new one starts with `thread/start`. */
export function toResumed(steps: ReadonlyArray<Step>): Array<Step> {
  return steps.map((step) =>
    "await" in step && JSON.stringify(step.await) === '{"method":"thread/start"}'
      ? { ...step, await: { method: "thread/resume" } }
      : step,
  );
}

/** The thread id Codex gave the recorded thread, in its `thread/start` answer. */
export function getCodexThreadId(steps: ReadonlyArray<Step>) {
  const started = steps.find(matchReplyTo("rpc-2"));
  return Schema.decodeUnknownSync(
    Schema.Struct({ reply: Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }) }),
  )(started).reply.thread.id;
}

/** The session id Claude reported in the recording. */
export function getClaudeSessionId(steps: ReadonlyArray<Step>) {
  const WithSession = Schema.Struct({ send: Schema.Struct({ session_id: Schema.String }) });
  const step = steps.find(Schema.is(WithSession));
  if (!step || !Schema.is(WithSession)(step)) throw new Error("claudeSessionId: none in the steps");

  return step.send.session_id;
}

export function matchStatus(threadId: string, status: ThreadInfo["status"]) {
  return (event: RuntimeEvent) =>
    RuntimeEvent.guards["thread.status"](event) &&
    event.threadId === threadId &&
    event.status === status;
}

/**
 * Codex's first turn as recorded, held open until Stop interrupts it, then ending as
 * Codex reports an interrupted turn.
 */
export function makeInterruptible(steps: ReadonlyArray<Step>): Array<Step> {
  const TurnCompleted = Schema.Struct({
    send: Schema.Struct({
      method: Schema.Literal("turn/completed"),
      params: Schema.Struct({ turn: Schema.JsonObject }),
    }),
  });
  // Narrowed, not decoded: decoding would drop the fields the schema doesn't name.
  const completed = steps.find(Schema.is(TurnCompleted));
  if (!completed || !Schema.is(TurnCompleted)(completed))
    throw new Error("interruptible: no turn/completed in the steps");

  return [
    ...takeUntil(steps, matchReplyTo("rpc-3")),
    { await: { method: "turn/interrupt" } },
    { reply: {} },
    {
      send: {
        ...completed.send,
        params: {
          ...completed.send.params,
          turn: { ...completed.send.params.turn, items: [], status: "interrupted" },
        },
      },
    },
  ];
}

/** Resolves once `condition` holds, checking every few ms: for what isn't a daemon event, like the peer's log. */
export async function waitUntil(condition: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Still not true after ${timeoutMs} ms: ${condition}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
