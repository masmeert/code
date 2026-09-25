/**
 * Writes a commit message for the working tree with a one-shot model call, for
 * commits made without one. Runs on the harness the user picked in settings.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderKind } from "@apcode/contracts";
import { connectCodex } from "./providers/codexRpc.ts";
import { resolveExecutable } from "./providers/resolveExecutable.ts";

/** Enough of the patch to describe it; the model doesn't need every line of a big change. */
const MAX_PROMPT_PATCH = 60_000;
const TIMEOUT_MS = 120_000;

const INSTRUCTIONS = `You write git commit messages. Reply with the commit message only: no preamble, no quotes, no code fences.
Subject line: imperative mood, at most 72 characters, no trailing period. If the change needs explaining, add a blank line and a short body wrapped at 72 characters. Match the style of the recent commits when there are some.`;

const promptFor = (patch: string, recent: ReadonlyArray<string>) => {
  const cut = patch.length > MAX_PROMPT_PATCH;
  return [
    INSTRUCTIONS,
    recent.length ? `Recent commits:\n${recent.map((s) => `- ${s}`).join("\n")}` : null,
    `Changes to commit${cut ? " (truncated)" : ""}:\n${cut ? patch.slice(0, MAX_PROMPT_PATCH) : patch}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Models like to wrap the answer anyway; keep just the message. */
const clean = (text: string) =>
  text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();

const withClaude = async (cwd: string, model: string | undefined, prompt: string) => {
  const q = query({
    prompt,
    options: {
      cwd,
      ...(model ? { model } : {}),
      // Thinking is most of the wait on a message this short.
      thinking: { type: "disabled" },
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      pathToClaudeCodeExecutable: resolveExecutable("claude", "APCODE_CLAUDE_PATH"),
    },
  });
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

const withCodex = async (cwd: string, model: string | undefined, prompt: string) => {
  let finish: (text: string) => void = () => {};
  let abort: (error: Error) => void = () => {};
  const done = new Promise<string>((resolve, reject) => ((finish = resolve), (abort = reject)));
  let text = "";
  const rpc = await connectCodex(cwd, {
    onNotification: (method, params) => {
      if (method === "item/completed" && params.item?.type === "agentMessage")
        text = params.item.text;
      else if (method === "turn/completed")
        params.turn?.status === "failed"
          ? abort(new Error(params.turn.error?.message ?? "Codex turn failed"))
          : finish(text);
      else if (method === "error" && !params.willRetry)
        abort(new Error(params.error?.message ?? "Codex error"));
    },
    onExit: (code, stderr) => abort(new Error(`codex exited (${code}): ${stderr}`)),
  });
  try {
    const started = await rpc.request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      config: { model_reasoning_effort: "low" },
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    return await done;
  } finally {
    rpc.close();
  }
};

/** Resolves to the message, or rejects with why it couldn't be written. */
export const generateCommitMessage = async (input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly model: string | undefined;
  readonly patch: string;
  readonly recent: ReadonlyArray<string>;
}) => {
  const prompt = promptFor(input.patch, input.recent);
  const run = input.provider === "claude" ? withClaude : withCodex;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>(
    (_, reject) => (timer = setTimeout(() => reject(new Error("Timed out")), TIMEOUT_MS)),
  );
  try {
    const message = clean(await Promise.race([run(input.cwd, input.model, prompt), timeout]));
    if (!message) throw new Error("The model returned an empty message");
    return message;
  } finally {
    clearTimeout(timer);
  }
};
