/**
 * Install / sign-in / model status for each harness CLI, plus the interactive
 * link (sign-in) and unlink (sign-out) flows. Sign-in state belongs to the CLIs
 * themselves; we only drive their own commands.
 */
import {
  Effort,
  type AuthFlow,
  type ModelOption,
  ProviderKind,
  ProviderStatus,
  type UsageLimit,
} from "@masscode/contracts";
import { openJsonFile } from "../storage/jsonFile.ts";
import { SettingsStore } from "../storage/SettingsStore.ts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import { execFile, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import { acquireCodexConnection, CODEX_FAST_TIER, CodexNotification } from "./codexRpc.ts";
import { readCursorModels } from "./CursorAdapter.ts";
import {
  acquireClaudeQuery,
  resolveHarnessLaunch,
  startPromptlessQuery,
  type HarnessLaunch,
} from "./launch.ts";
import { ProviderError, tryProviderPromise } from "./ProviderAdapter.ts";
import { getErrorMessage } from "../errors.ts";

const exec = promisify(execFile);

function buildUnknownStatus(kind: ProviderKind, error: string | null = null): ProviderStatus {
  return {
    kind,
    installed: false,
    version: null,
    linked: false,
    account: null,
    plan: null,
    models: [],
    error,
  };
}

function getFirstLine(text: string) {
  return text.trim().split("\n")[0] ?? "";
}

// --- probes ------------------------------------------------------------------

function readVersion(kind: ProviderKind, launch: HarnessLaunch) {
  return tryProviderPromise(kind, async () =>
    getFirstLine((await exec(launch.bin, ["--version"], { env: launch.env })).stdout),
  );
}

const readClaudeModels = Effect.fn("readClaudeModels")(function* (launch: HarnessLaunch) {
  const session = yield* acquireClaudeQuery(() => startPromptlessQuery(launch));

  return yield* tryProviderPromise("claude", async () => {
    // Drop the "Default (recommended)" alias row and star the concrete model it resolves to instead.
    const catalog = await session.supportedModels();
    const fallback = catalog.find((model) => model.value === "default")?.resolvedModel;
    const rows = catalog.filter((model) => model.value !== "default");
    const starred = rows.find((model) => fallback && model.resolvedModel === fallback);

    const models: Array<ModelOption> = [];

    // The catalog doesn't carry default efforts; the session reports the one it would apply after each model switch.
    // `getSettings` is untyped in the SDK, so its answer is decoded and failures just leave the default unknown.
    for (const model of rows) {
      const effort = await session
        .setModel(model.value)
        .then(() =>
          "getSettings" in session && Predicate.isFunction(session.getSettings)
            ? // Awaited before decoding: a request left pending rejects unhandled on close() and kills the daemon.
              Promise.resolve(session.getSettings()).then(
                Schema.decodeUnknownPromise(
                  Schema.Struct({
                    applied: Schema.optional(Schema.Struct({ effort: Schema.optional(Effort) })),
                  }),
                ),
              )
            : undefined,
        )
        .then((settings) => settings?.applied?.effort)
        .catch(() => undefined);

      const levels = model.supportedEffortLevels ?? [];
      models.push({
        id: model.value,
        label: model.displayName,
        recommended: model === starred || undefined,
        defaultEffort: effort,
        efforts: [
          ...levels,
          // Ultracode runs at xhigh, so only models with it can take it.
          ...(levels.includes("xhigh") ? (["ultracode"] as const) : []),
          ...(model.supportsAdaptiveThinking ? (["ultrathink"] as const) : []),
        ],
        fast: model.supportsFastMode || undefined,
      });
    }

    return models;
  });
}, Effect.scoped);

const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.optional(Schema.Boolean),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  subscriptionType: Schema.optional(Schema.NullOr(Schema.String)),
});

const probeClaude = Effect.fn("probeClaude")(function* (launch: HarnessLaunch) {
  const version = yield* readVersion("claude", launch);

  // Signed out, it exits non-zero with the status still on stdout.
  const { stdout } = yield* tryProviderPromise("claude", () =>
    exec(launch.bin, ["auth", "status"], { env: launch.env }).catch((error) => ({
      stdout: String(error.stdout ?? "{}"),
    })),
  );

  const status = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeAuthStatus))(
    stdout || "{}",
  ).pipe(
    Effect.mapError((error) => new ProviderError({ provider: "claude", message: error.message })),
  );

  const linked = status.loggedIn === true;

  return {
    kind: "claude",
    installed: true,
    version,
    linked,
    account: status.email ?? null,
    plan: status.subscriptionType ?? null,
    models: linked ? yield* readClaudeModels(launch) : [],
    error: null,
  } satisfies ProviderStatus;
});

const probeCodex = Effect.fn("probeCodex")(function* (launch: HarnessLaunch) {
  const version = yield* readVersion("codex", launch);
  const rpc = yield* acquireCodexConnection(launch, undefined);

  return yield* tryProviderPromise("codex", async (): Promise<ProviderStatus> => {
    const { account } = await rpc.request(
      "account/read",
      {},
      Schema.Struct({
        account: Schema.NullOr(
          Schema.Struct({
            type: Schema.String,
            email: Schema.optional(Schema.NullOr(Schema.String)),
            planType: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    );

    const linked = account !== null;

    const models: Array<ModelOption> = linked
      ? (
          await rpc.request(
            "model/list",
            {},
            Schema.Struct({
              data: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  displayName: Schema.String,
                  hidden: Schema.Boolean,
                  isDefault: Schema.Boolean,
                  defaultReasoningEffort: Schema.String,
                  supportedReasoningEfforts: Schema.Array(
                    Schema.Struct({ reasoningEffort: Schema.String }),
                  ),
                  serviceTiers: Schema.Array(Schema.Struct({ id: Schema.String })),
                }),
              ),
            }),
          )
        ).data
          .filter((model) => !model.hidden)
          .map((model) => ({
            id: model.id,
            label: model.displayName,
            recommended: model.isDefault || undefined,
            defaultEffort: Schema.is(Effort)(model.defaultReasoningEffort)
              ? model.defaultReasoningEffort
              : undefined,
            efforts: model.supportedReasoningEfforts
              .map((level) => level.reasoningEffort)
              .filter(Schema.is(Effort)),
            fast: model.serviceTiers.some((tier) => tier.id === CODEX_FAST_TIER) || undefined,
          }))
      : [];

    return {
      kind: "codex",
      installed: true,
      version,
      linked,
      account: account ? (account.email ?? account.type) : null,
      plan: account?.planType ?? null,
      models,
      error: null,
    };
  });
}, Effect.scoped);

const probeCursor = Effect.fn("probeCursor")(function* (launch: HarnessLaunch) {
  const version = yield* readVersion("cursor", launch);

  const { stdout } = yield* tryProviderPromise("cursor", () =>
    exec(launch.bin, ["status"], { env: launch.env }).catch((error) => ({
      stdout: String(error.stdout ?? ""),
    })),
  );

  const account = stdout.match(new RegExp(String.raw`Logged in as ([^\s\u001b]+)`))?.[1] ?? null;

  return {
    kind: "cursor",
    installed: true,
    version,
    linked: account !== null,
    account,
    plan: null,
    models: account === null ? [] : yield* readCursorModels(launch),
    error: null,
  } satisfies ProviderStatus;
});

const PROBE: Record<
  ProviderKind,
  (launch: HarnessLaunch) => Effect.Effect<ProviderStatus, ProviderError>
> = {
  claude: probeClaude,
  codex: probeCodex,
  cursor: probeCursor,
};

// --- usage limits --------------------------------------------------------------

const ClaudeWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
});

const ClaudeUsage = Schema.Struct({
  rate_limits: Schema.NullOr(
    Schema.Struct({
      five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
      seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
      seven_day_opus: Schema.optional(Schema.NullOr(ClaudeWindow)),
      seven_day_sonnet: Schema.optional(Schema.NullOr(ClaudeWindow)),
      model_scoped: Schema.optional(
        Schema.Array(Schema.Struct({ display_name: Schema.String, ...ClaudeWindow.fields })),
      ),
    }),
  ),
});

/** The plan's windows as `/usage` shows them; none for API-key logins. Decoded, since the SDK marks this call experimental. */
const readClaudeLimits = Effect.fn("readClaudeLimits")(function* (launch: HarnessLaunch) {
  const session = yield* acquireClaudeQuery(() => startPromptlessQuery(launch));

  const { rate_limits: limits } = yield* tryProviderPromise("claude", () =>
    session
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then(Schema.decodeUnknownPromise(ClaudeUsage)),
  );

  if (!limits) return [];

  return (
    [
      ["5-hour limit", limits.five_hour],
      ["Weekly, all models", limits.seven_day],
      ["Weekly, Opus", limits.seven_day_opus],
      ["Weekly, Sonnet", limits.seven_day_sonnet],
      ...(limits.model_scoped ?? []).map(
        (window) => [`Weekly, ${window.display_name}`, window] as const,
      ),
    ] as const
  ).flatMap(([label, window]): Array<UsageLimit> =>
    window && window.utilization !== null
      ? [
          {
            label,
            usedPercent: window.utilization,
            resetsAt: Date.parse(window.resets_at ?? "") || null,
          },
        ]
      : [],
  );
}, Effect.scoped);

const CodexWindow = Schema.NullOr(
  Schema.Struct({
    usedPercent: Schema.Number,
    windowDurationMins: Schema.NullOr(Schema.Number),
    resetsAt: Schema.NullOr(Schema.Number),
  }),
);

function formatCodexWindowLabel(minutes: number | null) {
  if (minutes === null) return "Usage limit";

  if (minutes === 7 * 24 * 60) return "Weekly limit";

  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day limit`;

  return `${Math.round(minutes / 60)}-hour limit`;
}

const readCodexLimits = Effect.fn("readCodexLimits")(function* (launch: HarnessLaunch) {
  const rpc = yield* acquireCodexConnection(launch, undefined);

  const { rateLimits } = yield* tryProviderPromise("codex", () =>
    rpc.request(
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      Schema.Struct({
        rateLimits: Schema.Struct({ primary: CodexWindow, secondary: CodexWindow }),
      }),
    ),
  );

  return [rateLimits.primary, rateLimits.secondary].flatMap((window): Array<UsageLimit> =>
    window
      ? [
          {
            label: formatCodexWindowLabel(window.windowDurationMins),
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
          },
        ]
      : [],
  );
}, Effect.scoped);

// Cursor's CLI doesn't report its plan's limits.
const READ_LIMITS: Record<
  ProviderKind,
  (launch: HarnessLaunch) => Effect.Effect<ReadonlyArray<UsageLimit>, ProviderError>
> = {
  claude: readClaudeLimits,
  codex: readCodexLimits,
  cursor: () => Effect.succeed([]),
};

const LOGOUT_ARGS: Record<ProviderKind, ReadonlyArray<string>> = {
  claude: ["auth", "logout"],
  codex: ["logout"],
  cursor: ["logout"],
};

// --- service -----------------------------------------------------------------

/** Single listener (the session manager) that fans changes out to clients. */
interface ProviderListener {
  readonly onProviders: (providers: ReadonlyArray<ProviderStatus>) => void;
  readonly onFlow: (flow: AuthFlow) => void;
}

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderStatus>>;
    readonly refresh: Effect.Effect<void>;
    readonly link: (kind: ProviderKind) => Effect.Effect<void>;
    readonly submitCode: (kind: ProviderKind, code: string) => Effect.Effect<void>;
    readonly cancelLink: (kind: ProviderKind) => Effect.Effect<void>;
    readonly unlink: (kind: ProviderKind) => Effect.Effect<void>;
    readonly readLimits: (kind: ProviderKind) => Effect.Effect<{
      readonly limits: ReadonlyArray<UsageLimit>;
      readonly error: string | null;
    }>;
    readonly setListener: (listener: ProviderListener) => void;
  }
>()("masscode/ProviderRegistry") {}

const make = Effect.gen(function* () {
  const settingsStore = yield* SettingsStore;
  const scope = yield* Effect.scope;

  const resolveLaunch = Effect.fn("ProviderRegistry.resolveLaunch")(function* (kind: ProviderKind) {
    const settings = yield* settingsStore.get;

    return yield* resolveHarnessLaunch(kind, settings.providers[kind]);
  });

  function probeHarness(kind: ProviderKind) {
    return resolveLaunch(kind).pipe(
      Effect.flatMap((launch) => PROBE[kind](launch)),
      Effect.catch((error) =>
        Effect.succeed(
          buildUnknownStatus(kind, error.message.includes("Could not find") ? null : error.message),
        ),
      ),
    );
  }

  // Checking the CLIs takes seconds; until it's done, clients get what the last check found rather
  // than "not installed", which hid every model picker and disabled sending on each launch.
  const lastChecked = yield* openJsonFile("providers.json", Schema.Array(ProviderStatus), []);
  const checked = yield* lastChecked.get;

  let providers = ProviderKind.literals.map(
    (kind) =>
      checked.find((provider) => provider.kind === kind) ?? {
        ...buildUnknownStatus(kind),
        checking: true,
      },
  );

  let listener: ProviderListener = { onProviders: () => {}, onFlow: () => {} };
  /** In-flight sign-in per harness: starting another or cancelling interrupts it, closing what it opened. */
  const linkFlows = yield* FiberMap.make<ProviderKind>();
  /** Where a code the user types in MassCode goes, while a sign-in waits for one. */
  const codeInputs = new Map<ProviderKind, Writable>();

  function reportLinkFlow(
    provider: ProviderKind,
    stage: AuthFlow["stage"],
    url: string | null = null,
    text: string | null = null,
  ) {
    listener.onFlow({ provider, stage, url, message: text });
  }

  /** Runs `task` past the request that started it, for as long as the registry lives; failures are only logged. */
  function runInBackground<E>(task: Effect.Effect<void, E>) {
    return task.pipe(
      Effect.catch((error) => Effect.logWarning("provider task failed", getErrorMessage(error))),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  }

  const refreshProvider = Effect.fn("ProviderRegistry.refreshProvider")(function* (
    kind: ProviderKind,
  ) {
    const next = yield* probeHarness(kind);
    providers = providers.map((provider) => (provider.kind === kind ? next : provider));
    listener.onProviders(providers);
    yield* lastChecked.set(providers);
  });

  const refreshProviders = Effect.forEach(ProviderKind.literals, refreshProvider, {
    concurrency: "unbounded",
    discard: true,
  });

  /**
   * Signs in with the CLI's own login command, which prints the page to open and exits once
   * signed in. At "awaiting-code" the page shows a code for the user to paste back into it.
   * Resolves to why it failed, null once signed in.
   */
  const linkCli = Effect.fn("ProviderRegistry.linkCli")(function* (
    kind: ProviderKind,
    args: ReadonlyArray<string>,
    stage: "awaiting-code" | "browser",
  ) {
    const launch = yield* resolveLaunch(kind);
    const exited = yield* Deferred.make<number | null>();

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const spawned = spawn(launch.bin, args, {
            env: launch.env,
            stdio: ["pipe", "pipe", "pipe"],
          });

          spawned.on("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)));

          return spawned;
        },
        catch: (error) => new ProviderError({ provider: kind, message: getErrorMessage(error) }),
      }),
      (child) =>
        Effect.sync(() => {
          if (codeInputs.get(kind) === child.stdin) codeInputs.delete(kind);
          child.kill();
        }),
    );

    // Nothing to type in: the CLI reads end-of-input, as it would from /dev/null.
    if (stage === "browser") child.stdin.end();
    else codeInputs.set(kind, child.stdin);

    let output = "";
    let hasAnnouncedUrl = false;

    function onData(chunk: Buffer) {
      output += chunk.toString();
      // Claude's CLI prints the URL wrapped in an OSC-8 hyperlink.
      const url = output.match(new RegExp(String.raw`https://[^\s\u0007\u001b]+`))?.[0];

      if (url && !hasAnnouncedUrl) {
        hasAnnouncedUrl = true;
        reportLinkFlow(kind, stage, url);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const code = yield* Deferred.await(exited);

    return code === 0 ? null : getFirstLine(output.slice(-500)) || `exited with ${code}`;
  });

  /** Codex's ChatGPT sign-in, finished through a local callback it listens on. Resolves like `linkCli`. */
  const linkCodex = Effect.fn("ProviderRegistry.linkCodex")(function* () {
    const launch = yield* resolveLaunch("codex");
    const completed = yield* Deferred.make<string | null>();

    const rpc = yield* acquireCodexConnection(launch, undefined, {
      onNotification: (notification) => {
        if (!CodexNotification.guards["account/login/completed"](notification)) return;

        const { success, error } = notification.params;
        Deferred.doneUnsafe(
          completed,
          Effect.succeed(success ? null : (error ?? "Sign-in failed")),
        );
      },
    });

    const login = yield* tryProviderPromise("codex", () =>
      rpc.request(
        "account/login/start",
        { type: "chatgpt" },
        Schema.Struct({ loginId: Schema.String, authUrl: Schema.String }),
      ),
    );

    // Elsewhere (a remote host) the app opens the page, and the callback only lands when the
    // browser runs there too.
    if (process.platform === "darwin")
      spawn("open", [login.authUrl], { stdio: "ignore", detached: true }).unref();
    reportLinkFlow("codex", "browser", login.authUrl);

    return yield* Deferred.await(completed).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          void rpc
            .request("account/login/cancel", { loginId: login.loginId }, Schema.Unknown)
            .catch(() => {});
        }),
      ),
    );
  });

  const LINK: Record<ProviderKind, () => Effect.Effect<string | null, ProviderError, Scope.Scope>> =
    {
      claude: () => linkCli("claude", ["auth", "login", "--claudeai"], "awaiting-code"),
      codex: linkCodex,
      // Cursor's login opens the browser itself and finishes when the page does.
      cursor: () => linkCli("cursor", ["login"], "browser"),
    };

  const runLinkFlow = Effect.fn("ProviderRegistry.runLinkFlow")(
    function* (kind: ProviderKind) {
      reportLinkFlow(kind, "starting");
      const failure = yield* Effect.scoped(LINK[kind]());

      // Outlives the flow, so cancelling or linking again meanwhile doesn't swallow the outcome.
      yield* runInBackground(
        Effect.gen(function* () {
          yield* refreshProvider(kind);
          reportLinkFlow(kind, failure === null ? "done" : "failed", null, failure);
        }),
      );
    },
    (flow, kind) =>
      Effect.catch(flow, (error) =>
        Effect.sync(() => reportLinkFlow(kind, "failed", null, error.message)),
      ),
  );

  // Initial status, without blocking startup.
  yield* runInBackground(refreshProviders);

  return ProviderRegistry.of({
    list: Effect.sync(() => providers),
    refresh: runInBackground(refreshProviders),
    link: (kind) => FiberMap.run(linkFlows, kind, runLinkFlow(kind)).pipe(Effect.asVoid),
    submitCode: (kind, code) =>
      Effect.sync(() => {
        codeInputs.get(kind)?.write(`${code.trim()}\n`);
      }),
    cancelLink: (kind) => FiberMap.remove(linkFlows, kind),
    unlink: (kind) =>
      runInBackground(
        Effect.gen(function* () {
          const launch = yield* resolveLaunch(kind);
          yield* Effect.promise(() =>
            exec(launch.bin, [...LOGOUT_ARGS[kind]], { env: launch.env }).catch(() => {}),
          );
          yield* refreshProvider(kind);
        }),
      ),
    readLimits: (kind) =>
      resolveLaunch(kind).pipe(
        Effect.flatMap((launch) => READ_LIMITS[kind](launch)),
        Effect.map((limits) => ({ limits, error: null })),
        Effect.catch((error) =>
          Effect.succeed({
            limits: [],
            error: `Couldn't read usage limits: ${error.message}`,
          }),
        ),
      ),
    setListener: (next) => {
      listener = next;
    },
  });
});

export const layer = Layer.effect(ProviderRegistry, make);
