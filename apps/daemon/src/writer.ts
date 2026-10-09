/**
 * Writes text with a one-shot model call: thread titles, commit messages for commits made
 * without one, and pull request titles and bodies. Runs on the harness the user picked in settings.
 */
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderKind, ProviderSettings, Settings } from "@masscode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { acquireCodexConnection, CodexNotification, ThreadResponse } from "./providers/codexRpc.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCursorModelFlag } from "./providers/CursorAdapter.ts";
import { acquireClaudeQuery, toClaudeExtraArgs, resolveHarnessLaunch } from "./providers/launch.ts";
import { ProviderError, tryProviderPromise } from "./providers/ProviderAdapter.ts";

/** Enough of the patch to describe it; the model doesn't need every line of a big change. */
const MAX_PROMPT_PATCH = 60_000;

const TIMEOUT_MS = 120_000;

/** The writing style's rules for commits and pull requests, from Settings (wording follows t3code). */
function getStyleRules(settings: Settings, recent: ReadonlyArray<string>) {
  const history = recent.length
    ? `Recent commit subjects from this repository:\n${recent.map((subject) => `- ${subject}`).join("\n")}`
    : null;

  switch (settings.writingStyle ?? "repo_conventions") {
    case "conventional_commits":
      return {
        commit:
          "Use Conventional Commits when generating commit subjects. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.",
        pullRequest:
          "Keep the pull request title concise. Do not force Conventional Commit syntax into the title unless the repository already uses it.",
        history,
      };
    case "custom":
      return {
        commit: settings.writingInstructions?.trim() || null,
        pullRequest: settings.writingInstructions?.trim() || null,
        history: null,
      };
    case "repo_conventions":
      return {
        commit:
          "Follow the repository's established commit message style when examples are available.",
        pullRequest:
          "Follow the repository's established pull request title and body style when examples are available.",
        history,
      };
  }
}

const COMMIT_INSTRUCTIONS = `You write git commit messages. Reply with the commit message only: no preamble, no quotes, no code fences.
Subject line: imperative mood, at most 72 characters, no trailing period. If the change needs explaining, add a blank line and a short body wrapped at 72 characters.`;

/** Models like to wrap the answer anyway; keep just the message. */
function stripCodeFences(text: string) {
  return text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();
}

const writeWithClaude = Effect.fn("writeWithClaude")(function* (
  cwd: string,
  harness: ProviderSettings,
  model: string | undefined,
  prompt: string,
) {
  const launch = yield* resolveHarnessLaunch("claude", harness);

  const options: Options = {
    cwd,
    // Thinking is most of the wait on a message this short.
    thinking: { type: "disabled" },
    maxTurns: 1,
    tools: [],
    settingSources: [],
    persistSession: false,
    pathToClaudeCodeExecutable: launch.bin,
    extraArgs: toClaudeExtraArgs(launch.args),
    env: launch.env,
  };

  if (model) options.model = model;
  const conversation = yield* acquireClaudeQuery(() => query({ prompt, options }));

  return yield* tryProviderPromise("claude", async () => {
    for await (const message of conversation) {
      if (message.type !== "result") continue;

      if (message.subtype !== "success") throw new Error(`Claude stopped: ${message.subtype}`);

      return message.result;
    }

    throw new Error("Claude returned nothing");
  });
});

const writeWithCodex = Effect.fn("writeWithCodex")(function* (
  cwd: string,
  harness: ProviderSettings,
  model: string | undefined,
  prompt: string,
) {
  const done = yield* Deferred.make<string, ProviderError>();
  let text = "";

  function fail(message: string) {
    Deferred.doneUnsafe(done, Effect.fail(new ProviderError({ provider: "codex", message })));
  }

  const launch = yield* resolveHarnessLaunch("codex", harness);

  const rpc = yield* acquireCodexConnection(launch, cwd, {
    onNotification: (notification) =>
      CodexNotification.matchOrElse(
        notification,
        {
          "item/completed": ({ params }) => {
            if (params.item.type === "agentMessage") text = params.item.text;
          },
          "turn/completed": ({ params }) => {
            if (params.turn.status === "failed")
              fail(params.turn.error?.message ?? "Codex turn failed");
            else Deferred.doneUnsafe(done, Effect.succeed(text));
          },
          error: ({ params }) => {
            if (!params.willRetry) fail(params.error.message);
          },
        },
        () => {},
      ),
    onExit: (code, stderr) => fail(`codex exited (${code}): ${stderr}`),
  });

  const started = yield* tryProviderPromise("codex", () =>
    rpc.request(
      "thread/start",
      {
        cwd,
        model: model || null,
        config: { model_reasoning_effort: "low" },
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      ThreadResponse,
    ),
  );

  yield* tryProviderPromise("codex", () =>
    rpc.request(
      "turn/start",
      {
        threadId: started.thread.id,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
      Schema.Unknown,
    ),
  );

  return yield* Deferred.await(done);
});

/** Cursor's print mode, read-only ("ask"); `--trust` skips the prompt for a folder it hasn't seen. */
const writeWithCursor = Effect.fn("writeWithCursor")(function* (
  cwd: string,
  harness: ProviderSettings,
  model: string | undefined,
  prompt: string,
) {
  const launch = yield* resolveHarnessLaunch("cursor", harness);

  // Interrupting the run (the timeout) aborts the signal, which kills the CLI.
  const { stdout } = yield* tryProviderPromise("cursor", (signal) =>
    promisify(execFile)(
      launch.bin,
      [
        ...launch.args,
        "--print",
        "--output-format",
        "text",
        "--mode",
        "ask",
        "--trust",
        ...buildCursorModelFlag(model),
        prompt,
      ],
      { cwd, env: launch.env, maxBuffer: 10 * 1024 * 1024, signal },
    ),
  );

  return stdout;
});

const WRITE: Record<ProviderKind, typeof writeWithClaude> = {
  claude: writeWithClaude,
  codex: writeWithCodex,
  cursor: writeWithCursor,
};

interface WriterInput {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly harness: ProviderSettings;
  readonly model: string | undefined;
  readonly settings: Settings;
  readonly recent: ReadonlyArray<string>;
}

/** Timing out interrupts the run, which closes the harness it started. */
function writeWithHarness(input: WriterInput, prompt: string) {
  return Effect.runPromise(
    WRITE[input.provider](input.cwd, input.harness, input.model, prompt).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new ProviderError({ provider: input.provider, message: "Timed out" })),
      }),
      Effect.map(stripCodeFences),
    ),
  );
}

/** Resolves to the message, or rejects with why it couldn't be written. */
export async function generateCommitMessage(input: WriterInput & { readonly patch: string }) {
  const style = getStyleRules(input.settings, input.recent);
  const truncated = input.patch.length > MAX_PROMPT_PATCH;

  const message = await writeWithHarness(
    input,
    [
      COMMIT_INSTRUCTIONS,
      style.commit ? `Additional instructions:\n${style.commit}` : null,
      style.history,
      `Changes to commit${truncated ? " (truncated)" : ""}:\n${truncated ? input.patch.slice(0, MAX_PROMPT_PATCH) : input.patch}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );

  if (!message) throw new Error("The model returned an empty message");

  return message;
}

/** Resolves to a short title summarizing a thread's first message, or rejects with why it couldn't be written. */
export async function generateThreadTitle(input: WriterInput & { readonly text: string }) {
  return (
    await writeWithHarness(
      input,
      `You name chat threads with a coding agent. Reply with a title of at most 6 words summarizing what the user asks for: no preamble, no quotes, no trailing period.\n\nThe user's first message:\n${input.text.slice(0, 4_000)}`,
    )
  )
    .split("\n")[0]!
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim();
}

const PullRequestText = Schema.Struct({ title: Schema.String, body: Schema.String });

/** Resolves to the pull request's title and body, or rejects with why they couldn't be written. */
export async function generatePullRequest(
  input: WriterInput & {
    readonly base: string;
    readonly head: string;
    readonly commits: string;
    readonly stat: string;
    readonly patch: string;
    readonly template: string | null;
  },
) {
  const style = getStyleRules(input.settings, input.recent);

  const bodyRules = input.template
    ? [
        "- body must be markdown and follow the repository pull request template structure",
        "- fill in the template sections appropriately for this change",
        "- drop HTML comments from the template in the generated body",
        "- keep the template's markdown structure",
      ]
    : [
        "- body must be markdown and include headings '## Summary' and '## Testing'",
        "- under Summary, provide short bullet points",
        "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      ];

  const text = await writeWithHarness(
    input,
    [
      [
        "You write pull request content.",
        "Reply with only a JSON object with keys: title, body. No code fences.",
        "Rules:",
        "- title should be concise and specific",
        ...bodyRules,
      ].join("\n"),
      style.pullRequest ? `Additional instructions:\n${style.pullRequest}` : null,
      style.history,
      input.template ? `Repository pull request template:\n${input.template}` : null,
      `Base branch: ${input.base}\nHead branch: ${input.head}`,
      `Commits:\n${input.commits}`,
      `Diff stat:\n${input.stat}`,
      `Diff patch:\n${input.patch}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );

  // The object may come with a sentence around it despite the instructions.
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequestText))(json);

  if (Option.isNone(parsed)) throw new Error("The model didn't return a title and body");

  return {
    title: parsed.value.title.split("\n")[0]!.trim() || "Update project changes",
    body: parsed.value.body.trim(),
  };
}
