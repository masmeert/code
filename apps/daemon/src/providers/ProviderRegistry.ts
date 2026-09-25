/**
 * Install / sign-in / model status for each harness CLI, plus the interactive
 * link (sign-in) and unlink (sign-out) flows. Sign-in state belongs to the CLIs
 * themselves; we only drive their own commands.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  Effort,
  type AuthFlow,
  type ModelOption,
  type ProviderKind,
  type ProviderStatus,
} from "@apcode/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { CodexNotification, connectCodex, type CodexRpc } from "./codexRpc.ts";
import { resolveExecutable } from "./resolveExecutable.ts";

const exec = promisify(execFile);

const BINARIES: Record<ProviderKind, { name: string; env: string }> = {
  claude: { name: "claude", env: "APCODE_CLAUDE_PATH" },
  codex: { name: "codex", env: "APCODE_CODEX_PATH" },
};

const unknown = (kind: ProviderKind, error: string | null = null): ProviderStatus => ({
  kind,
  installed: false,
  version: null,
  linked: false,
  account: null,
  plan: null,
  models: [],
  error,
});

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- probes ------------------------------------------------------------------

const probeClaude = async (): Promise<ProviderStatus> => {
  const bin = resolveExecutable("claude", BINARIES.claude.env);
  const version = firstLine((await exec(bin, ["--version"])).stdout);
  const status = JSON.parse(
    (await exec(bin, ["auth", "status"]).catch((e) => ({ stdout: e.stdout ?? "{}" }))).stdout ||
      "{}",
  );
  const linked = status.loggedIn === true;
  let models: Array<ModelOption> = [];
  if (linked) {
    // A prompt-less session answers the model catalog without starting a turn.
    const q = query({
      prompt: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
      options: { pathToClaudeCodeExecutable: bin },
    });
    try {
      // Drop the "Default (recommended)" alias row and star the concrete model it resolves to instead.
      const all = await q.supportedModels();
      const fallback = all.find((m) => m.value === "default")?.resolvedModel;
      const rows = all.filter((m) => m.value !== "default");
      const starred = rows.find((m) => fallback && m.resolvedModel === fallback);
      // The catalog doesn't carry default efforts; the session reports the one it would apply after each model switch.
      // `getSettings` is untyped in the SDK, so its answer is decoded and failures just leave the default unknown.
      for (const m of rows) {
        const effort = await q
          .setModel(m.value)
          .then(() =>
            "getSettings" in q && Predicate.isFunction(q.getSettings)
              ? Schema.decodeUnknownPromise(
                  Schema.Struct({
                    applied: Schema.optional(Schema.Struct({ effort: Schema.optional(Effort) })),
                  }),
                )(q.getSettings())
              : undefined,
          )
          .then((settings) => settings?.applied?.effort)
          .catch(() => undefined);
        models.push({
          id: m.value,
          label: m.displayName,
          recommended: m === starred || undefined,
          defaultEffort: effort,
        });
      }
    } finally {
      q.close();
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
};

const probeCodex = async (): Promise<ProviderStatus> => {
  const bin = resolveExecutable("codex", BINARIES.codex.env);
  const version = firstLine((await exec(bin, ["--version"])).stdout);
  const rpc = await connectCodex(undefined);
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
                }),
              ),
            }),
          )
        ).data
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            label: m.displayName,
            recommended: m.isDefault || undefined,
            defaultEffort: Schema.is(Effort)(m.defaultReasoningEffort)
              ? m.defaultReasoningEffort
              : undefined,
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
};

const probe = (kind: ProviderKind) =>
  (kind === "claude" ? probeClaude() : probeCodex()).catch((e) => {
    const text = message(e);
    return unknown(kind, text.includes("Could not find") ? null : text);
  });

// --- service -----------------------------------------------------------------

/** Single listener (the session manager) that fans changes out to clients. */
interface ProviderListener {
  readonly providers: (providers: ReadonlyArray<ProviderStatus>) => void;
  readonly flow: (flow: AuthFlow) => void;
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
    readonly setListener: (listener: ProviderListener) => void;
  }
>()("apcode/ProviderRegistry") {}

const make = Effect.gen(function* () {
  let providers: Array<ProviderStatus> = [unknown("claude"), unknown("codex")];
  let listener: ProviderListener = { providers: () => {}, flow: () => {} };
  /** In-flight sign-in per harness. */
  const flows = new Map<ProviderKind, { child?: ChildProcess; rpc?: CodexRpc; loginId?: string }>();

  const flow = (
    provider: ProviderKind,
    stage: AuthFlow["stage"],
    url: string | null = null,
    text: string | null = null,
  ) => listener.flow({ provider, stage, url, message: text });

  const refreshOne = async (kind: ProviderKind) => {
    const next = await probe(kind);
    providers = providers.map((p) => (p.kind === kind ? next : p));
    listener.providers(providers);
  };
  async function refreshAll() {
    await Promise.all([refreshOne("claude"), refreshOne("codex")]);
  }

  const finish = async (kind: ProviderKind, ok: boolean, text: string | null) => {
    flows.delete(kind);
    await refreshOne(kind);
    flow(kind, ok ? "done" : "failed", null, text);
  };

  const linkClaude = () => {
    const bin = resolveExecutable("claude", BINARIES.claude.env);
    const child = spawn(bin, ["auth", "login", "--claudeai"], { stdio: ["pipe", "pipe", "pipe"] });
    flows.set("claude", { child });
    let output = "";
    let announced = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // The CLI opens the browser itself and prints the URL wrapped in an OSC-8 hyperlink.
      const url = output.match(new RegExp(String.raw`https://[^\s\u0007\u001b]+`))?.[0];
      if (url && !announced) {
        announced = true;
        flow("claude", "awaiting-code", url);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (flows.get("claude")?.child !== child) return;
      void finish(
        "claude",
        code === 0,
        code === 0 ? null : firstLine(output.slice(-500)) || `exited with ${code}`,
      );
    });
  };

  const linkCodex = async () => {
    const rpc = await connectCodex(undefined, {
      onNotification: (notification) => {
        if (!CodexNotification.guards["account/login/completed"](notification)) return;
        rpc.close();
        const { success, error } = notification.params;
        void finish("codex", success, success ? null : (error ?? "Sign-in failed"));
      },
    });
    flows.set("codex", { rpc });
    const res = await rpc.request(
      "account/login/start",
      { type: "chatgpt" },
      Schema.Struct({ loginId: Schema.String, authUrl: Schema.String }),
    );
    flows.set("codex", { rpc, loginId: res.loginId });
    // Codex listens on a local callback, so opening the page is all that's needed.
    spawn("open", [res.authUrl], { stdio: "ignore", detached: true }).unref();
    flow("codex", "browser", res.authUrl);
  };

  const cancel = (kind: ProviderKind) => {
    const active = flows.get(kind);
    flows.delete(kind);
    active?.child?.kill();
    if (active?.rpc && active.loginId)
      void active.rpc
        .request("account/login/cancel", { loginId: active.loginId }, Schema.Unknown)
        .catch(() => {});
    active?.rpc?.close();
  };

  const background = (run: () => Promise<void>) =>
    Effect.sync(() => {
      void run().catch((e) =>
        Effect.runFork(Effect.logWarning("provider task failed", message(e))),
      );
    });

  // Initial status, without blocking startup.
  yield* background(refreshAll);

  return ProviderRegistry.of({
    list: Effect.sync(() => providers),
    refresh: background(refreshAll),
    link: (kind) =>
      background(async () => {
        cancel(kind);
        flow(kind, "starting");
        try {
          if (kind === "claude") linkClaude();
          else await linkCodex();
        } catch (e) {
          cancel(kind);
          flow(kind, "failed", null, message(e));
        }
      }),
    submitCode: (kind, code) =>
      Effect.sync(() => {
        flows.get(kind)?.child?.stdin?.write(`${code.trim()}\n`);
      }),
    cancelLink: (kind) => Effect.sync(() => cancel(kind)),
    unlink: (kind) =>
      background(async () => {
        const bin = resolveExecutable(BINARIES[kind].name, BINARIES[kind].env);
        await exec(bin, kind === "claude" ? ["auth", "logout"] : ["logout"]).catch(() => {});
        await refreshOne(kind);
      }),
    setListener: (next) => {
      listener = next;
    },
  });
});

export const layer = Layer.effect(ProviderRegistry, make);
