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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_FAST_TIER, CodexNotification, connectCodex, type CodexRpc } from "./codexRpc.ts";
import { readCursorModels } from "./CursorAdapter.ts";
import { resolveHarnessLaunch, startPromptlessQuery, type HarnessLaunch } from "./launch.ts";
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

async function probeClaude(launch: HarnessLaunch): Promise<ProviderStatus> {
  const version = getFirstLine((await exec(launch.bin, ["--version"], { env: launch.env })).stdout);
  const status = JSON.parse(
    (
      await exec(launch.bin, ["auth", "status"], { env: launch.env }).catch((error) => ({
        stdout: error.stdout ?? "{}",
      }))
    ).stdout || "{}",
  );
  const linked = status.loggedIn === true;

  let models: Array<ModelOption> = [];
  if (linked) {
    const session = startPromptlessQuery(launch);
    try {
      // Drop the "Default (recommended)" alias row and star the concrete model it resolves to instead.
      const catalog = await session.supportedModels();
      const fallback = catalog.find((model) => model.value === "default")?.resolvedModel;
      const rows = catalog.filter((model) => model.value !== "default");
      const starred = rows.find((model) => fallback && model.resolvedModel === fallback);

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
    } finally {
      session.close();
    }
  }

  return {
    kind: "claude",
    installed: true,
    version,
    linked,
    account: status.email ?? null,
    plan: status.subscriptionType ?? null,
    models,
    error: null,
  };
}

async function probeCodex(launch: HarnessLaunch): Promise<ProviderStatus> {
  const version = getFirstLine((await exec(launch.bin, ["--version"], { env: launch.env })).stdout);
  const rpc = await connectCodex(undefined, {}, launch);
  try {
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
  } finally {
    rpc.close();
  }
}

async function probeCursor(launch: HarnessLaunch): Promise<ProviderStatus> {
  const version = getFirstLine((await exec(launch.bin, ["--version"], { env: launch.env })).stdout);
  const { stdout } = await exec(launch.bin, ["status"], { env: launch.env }).catch((error) => ({
    stdout: String(error.stdout ?? ""),
  }));
  const account = stdout.match(new RegExp(String.raw`Logged in as ([^\s\u001b]+)`))?.[1] ?? null;

  return {
    kind: "cursor",
    installed: true,
    version,
    linked: account !== null,
    account,
    plan: null,
    models: account === null ? [] : await readCursorModels(launch),
    error: null,
  };
}

const PROBE: Record<ProviderKind, (launch: HarnessLaunch) => Promise<ProviderStatus>> = {
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
async function readClaudeLimits(launch: HarnessLaunch): Promise<Array<UsageLimit>> {
  const session = startPromptlessQuery(launch);
  try {
    const { rate_limits: limits } = await session
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then(Schema.decodeUnknownPromise(ClaudeUsage));
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
    ).flatMap(([label, window]) =>
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
  } finally {
    session.close();
  }
}

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

async function readCodexLimits(launch: HarnessLaunch): Promise<Array<UsageLimit>> {
  const rpc = await connectCodex(undefined, {}, launch);
  try {
    const { rateLimits } = await rpc.request(
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      Schema.Struct({
        rateLimits: Schema.Struct({ primary: CodexWindow, secondary: CodexWindow }),
      }),
    );

    return [rateLimits.primary, rateLimits.secondary].flatMap((window) =>
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
  } finally {
    rpc.close();
  }
}

// Cursor's CLI doesn't report its plan's limits.
const READ_LIMITS: Record<ProviderKind, (launch: HarnessLaunch) => Promise<Array<UsageLimit>>> = {
  claude: readClaudeLimits,
  codex: readCodexLimits,
  cursor: async () => [],
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

  /** Rejects when the CLI can't be found, like the spawns it feeds. */
  function resolveLaunch(kind: ProviderKind) {
    return Effect.runPromise(
      Effect.flatMap(settingsStore.get, (settings) =>
        resolveHarnessLaunch(kind, settings.providers[kind]),
      ),
    );
  }

  function probeHarness(kind: ProviderKind) {
    return resolveLaunch(kind)
      .then((launch) => PROBE[kind](launch))
      .catch((error) => {
        const text = getErrorMessage(error);
        return buildUnknownStatus(kind, text.includes("Could not find") ? null : text);
      });
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
  /** In-flight sign-in per harness. */
  const flows = new Map<ProviderKind, { child?: ChildProcess; rpc?: CodexRpc; loginId?: string }>();

  function reportLinkFlow(
    provider: ProviderKind,
    stage: AuthFlow["stage"],
    url: string | null = null,
    text: string | null = null,
  ) {
    listener.onFlow({ provider, stage, url, message: text });
  }

  async function refreshProvider(kind: ProviderKind) {
    const next = await probeHarness(kind);
    providers = providers.map((provider) => (provider.kind === kind ? next : provider));
    listener.onProviders(providers);
    await Effect.runPromise(lastChecked.set(providers));
  }

  async function refreshProviders() {
    await Promise.all(ProviderKind.literals.map(refreshProvider));
  }

  async function finishLink(kind: ProviderKind, isSuccess: boolean, text: string | null) {
    flows.delete(kind);
    await refreshProvider(kind);
    reportLinkFlow(kind, isSuccess ? "done" : "failed", null, text);
  }

  async function linkClaude() {
    const launch = await resolveLaunch("claude");
    const child = spawn(launch.bin, ["auth", "login", "--claudeai"], {
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    flows.set("claude", { child });

    let output = "";
    let hasAnnouncedUrl = false;
    function onData(chunk: Buffer) {
      output += chunk.toString();
      // The CLI opens the browser itself and prints the URL wrapped in an OSC-8 hyperlink.
      const url = output.match(new RegExp(String.raw`https://[^\s\u0007\u001b]+`))?.[0];
      if (url && !hasAnnouncedUrl) {
        hasAnnouncedUrl = true;
        reportLinkFlow("claude", "awaiting-code", url);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (flows.get("claude")?.child !== child) return;
      void finishLink(
        "claude",
        code === 0,
        code === 0 ? null : getFirstLine(output.slice(-500)) || `exited with ${code}`,
      );
    });
  }

  async function linkCodex() {
    const rpc = await connectCodex(
      undefined,
      {
        onNotification: (notification) => {
          if (!CodexNotification.guards["account/login/completed"](notification)) return;
          rpc.close();
          const { success, error } = notification.params;
          void finishLink("codex", success, success ? null : (error ?? "Sign-in failed"));
        },
      },
      await resolveLaunch("codex"),
    );
    flows.set("codex", { rpc });

    const login = await rpc.request(
      "account/login/start",
      { type: "chatgpt" },
      Schema.Struct({ loginId: Schema.String, authUrl: Schema.String }),
    );
    flows.set("codex", { rpc, loginId: login.loginId });

    // Codex listens on a local callback, so opening the page is all that's needed. Elsewhere (a
    // remote host) the app opens it, and the callback only lands when the browser runs there too.
    if (process.platform === "darwin")
      spawn("open", [login.authUrl], { stdio: "ignore", detached: true }).unref();
    reportLinkFlow("codex", "browser", login.authUrl);
  }

  /** Cursor's login opens the browser itself and finishes when the page does. */
  async function linkCursor() {
    const launch = await resolveLaunch("cursor");
    const child = spawn(launch.bin, ["login"], {
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    flows.set("cursor", { child });

    let output = "";
    let hasAnnouncedUrl = false;
    function onData(chunk: Buffer) {
      output += chunk.toString();
      const url = output.match(new RegExp(String.raw`https://[^\s\u0007\u001b]+`))?.[0];
      if (url && !hasAnnouncedUrl) {
        hasAnnouncedUrl = true;
        reportLinkFlow("cursor", "browser", url);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (flows.get("cursor")?.child !== child) return;
      void finishLink(
        "cursor",
        code === 0,
        code === 0 ? null : getFirstLine(output.slice(-500)) || `exited with ${code}`,
      );
    });
  }

  const LINK: Record<ProviderKind, () => Promise<void>> = {
    claude: linkClaude,
    codex: linkCodex,
    cursor: linkCursor,
  };

  function cancelLinkFlow(kind: ProviderKind) {
    const active = flows.get(kind);
    flows.delete(kind);
    active?.child?.kill();
    if (active?.rpc && active.loginId) {
      void active.rpc
        .request("account/login/cancel", { loginId: active.loginId }, Schema.Unknown)
        .catch(() => {});
    }
    active?.rpc?.close();
  }

  function runInBackground(run: () => Promise<void>) {
    return Effect.sync(() => {
      void run().catch((error) =>
        Effect.runFork(Effect.logWarning("provider task failed", getErrorMessage(error))),
      );
    });
  }

  // Initial status, without blocking startup.
  yield* runInBackground(refreshProviders);

  return ProviderRegistry.of({
    list: Effect.sync(() => providers),
    refresh: runInBackground(refreshProviders),
    link: (kind) =>
      runInBackground(async () => {
        cancelLinkFlow(kind);
        reportLinkFlow(kind, "starting");
        try {
          await LINK[kind]();
        } catch (error) {
          cancelLinkFlow(kind);
          reportLinkFlow(kind, "failed", null, getErrorMessage(error));
        }
      }),
    submitCode: (kind, code) =>
      Effect.sync(() => {
        flows.get(kind)?.child?.stdin?.write(`${code.trim()}\n`);
      }),
    cancelLink: (kind) => Effect.sync(() => cancelLinkFlow(kind)),
    unlink: (kind) =>
      runInBackground(async () => {
        const launch = await resolveLaunch(kind);
        await exec(launch.bin, [...LOGOUT_ARGS[kind]], {
          env: launch.env,
        }).catch(() => {});
        await refreshProvider(kind);
      }),
    readLimits: (kind) =>
      Effect.promise(() =>
        resolveLaunch(kind)
          .then((launch) => READ_LIMITS[kind](launch))
          .then(
            (limits) => ({ limits, error: null }),
            (error) => ({
              limits: [],
              error: `Couldn't read usage limits: ${getErrorMessage(error)}`,
            }),
          ),
      ),
    setListener: (next) => {
      listener = next;
    },
  });
});

export const layer = Layer.effect(ProviderRegistry, make);
