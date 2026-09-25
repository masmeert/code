/**
 * Writes source control text with a one-shot model call: commit messages for commits made
 * without one, and pull request titles and bodies. Runs on the harness the user picked in settings.
 */
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderKind, ProviderSettings, Settings } from "@apcode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CodexNotification, connectCodex, ThreadResponse } from "./providers/codexRpc.ts";
import { claudeExtraArgs, harnessLaunch } from "./providers/launch.ts";

/** Enough of the patch to describe it; the model doesn't need every line of a big change. */
const MAX_PROMPT_PATCH = 60_000;
const TIMEOUT_MS = 120_000;

/** The writing style's rules for commits and pull requests, from Settings (wording follows t3code). */
function styleRules(settings: Settings, recent: ReadonlyArray<string>) {
  const history = recent.length
    ? `Recent commit subjects from this repository:\n${recent.map((s) => `- ${s}`).join("\n")}`
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
const clean = (text: string) =>
  text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();

const withClaude = async (
  cwd: string,
  harness: ProviderSettings,
  model: string | undefined,
  prompt: string,
) => {
  const launch = harnessLaunch("claude", harness);
  const options: Options = {
    cwd,
    // Thinking is most of the wait on a message this short.
    thinking: { type: "disabled" },
    maxTurns: 1,
    tools: [],
    settingSources: [],
    persistSession: false,
    pathToClaudeCodeExecutable: launch.bin,
    extraArgs: claudeExtraArgs(launch.args),
    env: launch.env,
  };
  if (model) options.model = model;
  const q = query({ prompt, options });
  try {
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success") throw new Error(`Claude stopped: ${msg.subtype}`);
      return msg.result;
    }
    throw new Error("Claude returned nothing");
  } finally {
    q.close();
  }
};

const withCodex = async (
  cwd: string,
  harness: ProviderSettings,
  model: string | undefined,
  prompt: string,
) => {
  let finish: (text: string) => void = () => {};
  let abort: (error: Error) => void = () => {};
  const done = new Promise<string>((resolve, reject) => ((finish = resolve), (abort = reject)));
  let text = "";
  const launch = harnessLaunch("codex", harness);
  const rpc = await connectCodex(
    cwd,
    {
      onNotification: (notification) =>
        CodexNotification.matchOrElse(
          notification,
          {
            "item/completed": ({ params }) => {
              if (params.item.type === "agentMessage") text = params.item.text;
            },
            "turn/completed": ({ params }) => {
              if (params.turn.status === "failed")
                abort(new Error(params.turn.error?.message ?? "Codex turn failed"));
              else finish(text);
            },
            error: ({ params }) => {
              if (!params.willRetry) abort(new Error(params.error.message));
            },
          },
          () => {},
        ),
      onExit: (code, stderr) => abort(new Error(`codex exited (${code}): ${stderr}`)),
    },
    launch,
  );
  try {
    const started = await rpc.request(
      "thread/start",
      {
        cwd,
        model: model || null,
        config: { model_reasoning_effort: "low" },
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      ThreadResponse,
    );
    await rpc.request(
      "turn/start",
      {
        threadId: started.thread.id,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
      Schema.Unknown,
    );
    return await done;
  } finally {
    rpc.close();
  }
};

interface WriterInput {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly harness: ProviderSettings;
  readonly model: string | undefined;
  readonly settings: Settings;
  readonly recent: ReadonlyArray<string>;
}

async function write(input: WriterInput, prompt: string) {
  const run = input.provider === "claude" ? withClaude : withCodex;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>(
    (_, reject) => (timer = setTimeout(() => reject(new Error("Timed out")), TIMEOUT_MS)),
  );
  try {
    return clean(await Promise.race([run(input.cwd, input.harness, input.model, prompt), timeout]));
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to the message, or rejects with why it couldn't be written. */
export const generateCommitMessage = async (input: WriterInput & { readonly patch: string }) => {
  const style = styleRules(input.settings, input.recent);
  const cut = input.patch.length > MAX_PROMPT_PATCH;
  const message = await write(
    input,
    [
      COMMIT_INSTRUCTIONS,
      style.commit ? `Additional instructions:\n${style.commit}` : null,
      style.history,
      `Changes to commit${cut ? " (truncated)" : ""}:\n${cut ? input.patch.slice(0, MAX_PROMPT_PATCH) : input.patch}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  if (!message) throw new Error("The model returned an empty message");
  return message;
};

const PullRequestText = Schema.Struct({ title: Schema.String, body: Schema.String });

/** Resolves to the pull request's title and body, or rejects with why they couldn't be written. */
export const generatePullRequest = async (
  input: WriterInput & {
    readonly base: string;
    readonly head: string;
    readonly commits: string;
    readonly stat: string;
    readonly patch: string;
    readonly template: string | null;
  },
) => {
  const style = styleRules(input.settings, input.recent);
  const body = input.template
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
  const text = await write(
    input,
    [
      [
        "You write pull request content.",
        "Reply with only a JSON object with keys: title, body. No code fences.",
        "Rules:",
        "- title should be concise and specific",
        ...body,
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
};
