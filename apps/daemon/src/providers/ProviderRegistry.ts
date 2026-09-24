/**
 * Install / sign-in / model status for each harness CLI, plus the interactive
 * link (sign-in) and unlink (sign-out) flows. Sign-in state belongs to the CLIs
 * themselves; we only drive their own commands.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Effort, type AuthFlow, type ModelOption, type ProviderKind, type ProviderStatus } from "@apcode/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { connectCodex, type CodexRpc } from "./codexRpc.ts";
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

const isEffort = Schema.is(Effort);

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- probes ------------------------------------------------------------------

const probeClaude = async (): Promise<ProviderStatus> => {
  const bin = resolveExecutable("claude", BINARIES.claude.env);
  const version = firstLine((await exec(bin, ["--version"])).stdout);
  const status = JSON.parse((await exec(bin, ["auth", "status"]).catch((e) => ({ stdout: e.stdout ?? "{}" }))).stdout || "{}");
  const linked = status.loggedIn === true;
  let models: Array<ModelOption> = [];
  if (linked) {
    // A prompt-less session answers the model catalog without starting a turn.
    const q = query({
      prompt: (async function* () {
        await new Promise(() => {});
      })(),
      options: { pathToClaudeCodeExecutable: bin },
    });
    try {
      // Drop the "Default (recommended)" alias row and star the concrete model it resolves to instead.
      const all = await q.supportedModels();
      const fallback = all.find((m) => m.value === "default")?.resolvedModel;
      const rows = all.filter((m) => m.value !== "default");
      const starred = rows.find((m) => fallback && m.resolvedModel === fallback);
      // The catalog doesn't carry default efforts; the session reports the one it would apply after each model switch.
      // `getSettings` is untyped in the SDK, so failures just leave the default unknown.
      const settings = q as unknown as { getSettings: () => Promise<{ applied?: { effort?: unknown } }> };
      for (const m of rows) {
        const effort = await q
          .setModel(m.value)
          .then(() => settings.getSettings())
          .then((s) => s.applied?.effort)
          .catch(() => undefined);
        models.push({
          id: m.value,
          label: m.displayName,
          ...(m === starred ? { recommended: true } : {}),
          ...(isEffort(effort) ? { defaultEffort: effort } : {}),
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
    const { account } = await rpc.request("account/read", {});
    const linked = account !== null;
    const models: Array<ModelOption> = linked
      ? ((await rpc.request("model/list", {})).data as Array<any>)
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            label: m.displayName,
            ...(m.isDefault ? { recommended: true } : {}),
            ...(isEffort(m.defaultReasoningEffort) ? { defaultEffort: m.defaultReasoningEffort } : {}),
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

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderStatus>>;
    readonly refresh: Effect.Effect<void>;
    readonly link: (kind: ProviderKind) => Effect.Effect<void>;
    readonly submitCode: (kind: ProviderKind, code: string) => Effect.Effect<void>;
    readonly cancelLink: (kind: ProviderKind) => Effect.Effect<void>;
    readonly unlink: (kind: ProviderKind) => Effect.Effect<void>;
    /** Single listener (the session manager) that fans changes out to clients. */
    readonly setListener: (listener: {
      readonly providers: (providers: ReadonlyArray<ProviderStatus>) => void;
      readonly flow: (flow: AuthFlow) => void;
    }) => void;
  }
>()("apcode/ProviderRegistry") {}

const make = Effect.gen(function* () {
  let providers: Array<ProviderStatus> = [unknown("claude"), unknown("codex")];
  let listener = { providers: (_: ReadonlyArray<ProviderStatus>) => {}, flow: (_: AuthFlow) => {} };
  /** In-flight sign-in per harness. */
  const flows = new Map<ProviderKind, { child?: ChildProcess; rpc?: CodexRpc; loginId?: string }>();

  const flow = (provider: ProviderKind, stage: AuthFlow["stage"], url: string | null = null, text: string | null = null) =>
    listener.flow({ provider, stage, url, message: text });

  const refreshOne = async (kind: ProviderKind) => {
    const next = await probe(kind);
    providers = providers.map((p) => (p.kind === kind ? next : p));
    listener.providers(providers);
  };
  const refreshAll = () => Promise.all([refreshOne("claude"), refreshOne("codex")]);

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
      const url = output.match(/https:\/\/[^\s\u0007\u001b]+/)?.[0];
      if (url && !announced) {
        announced = true;
        flow("claude", "awaiting-code", url);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (flows.get("claude")?.child !== child) return;
      void finish("claude", code === 0, code === 0 ? null : firstLine(output.slice(-500)) || `exited with ${code}`);
    });
  };

  const linkCodex = async () => {
    const rpc = await connectCodex(undefined, {
      onNotification: (method, params) => {
        if (method !== "account/login/completed") return;
        rpc.close();
        void finish("codex", params.success === true, params.success ? null : (params.error ?? "Sign-in failed"));
      },
    });
    flows.set("codex", { rpc });
    const res = await rpc.request("account/login/start", { type: "chatgpt" });
    flows.set("codex", { rpc, loginId: res.loginId });
    // Codex listens on a local callback, so opening the page is all that's needed.
    spawn("open", [res.authUrl], { stdio: "ignore", detached: true }).unref();
    flow("codex", "browser", res.authUrl);
  };

  const cancel = (kind: ProviderKind) => {
    const active = flows.get(kind);
    flows.delete(kind);
    active?.child?.kill();
    if (active?.rpc && active.loginId) void active.rpc.request("account/login/cancel", { loginId: active.loginId }).catch(() => {});
    active?.rpc?.close();
  };

  const background = (run: () => Promise<unknown>) =>
    Effect.sync(() => {
      void run().catch((e) => Effect.runFork(Effect.logWarning("provider task failed", message(e))));
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
