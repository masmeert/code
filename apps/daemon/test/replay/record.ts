/**
 * Records fixtures from the real CLIs, on your own logins: `bun test/replay/record.ts`.
 * Each scenario runs a real thread through the daemon with the peer recording in between,
 * then writes `test/fixtures/<name>.json`. Rerun after a CLI or SDK upgrade changes the protocol.
 */
import "./setup.ts";
import { ClientCommand, RuntimeEvent, type ProviderKind } from "@masscode/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "../../src/providers/resolveExecutable.ts";
import { FAKE_CLI, project, startDaemon } from "./daemon.ts";
import { readRecording, toFixture, type Recorded } from "./peer.ts";

interface Scenario {
  readonly name: string;
  readonly provider: ProviderKind;
  /** Null runs the CLI's own default. */
  readonly model: string | null;
  readonly messages: ReadonlyArray<string>;
  /** Approves every request the agent makes. */
  readonly approve?: boolean;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "claude-two-turns",
    provider: "claude",
    model: "haiku",
    messages: ["Reply with exactly: pong", "Reply with exactly: pong again"],
  },
  {
    name: "claude-approval",
    provider: "claude",
    model: "haiku",
    approve: true,
    messages: ["Use the Bash tool to run `touch hi.txt`, then reply with exactly: done"],
  },
  {
    name: "codex-two-turns",
    provider: "codex",
    model: null,
    messages: ["Reply with exactly: pong", "Reply with exactly: pong again"],
  },
  {
    name: "codex-approval",
    provider: "codex",
    model: null,
    approve: true,
    messages: ["Run the shell command `echo hi > hi.txt`, then reply with exactly: done"],
  },
];

/** Your own setup (account, skills, agents, plugins, memory files, hook output), which the adapters don't read. */
const PERSONAL = new Set([
  "account",
  "gridRows",
  "commands",
  "agents",
  "skills",
  "slash_commands",
  "plugins",
  "tools",
  "mcp_servers",
  "output_styles",
  "memoryFiles",
  "mcpTools",
  "slashCommands",
  "systemTools",
  "systemPromptSections",
  "messageBreakdown",
]);

const isObject = Schema.is(Schema.JsonObject);

/** Fixtures are committed: no email addresses, home folder or personal setup in them. */
function scrub(value: Schema.Json): Schema.Json {
  if (Predicate.isString(value))
    return value
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "user@example.com")
      .replaceAll(homedir(), "/home/user");
  if (Array.isArray(value)) return value.map(scrub);
  if (!isObject(value)) return value;
  // Your own hooks' output (SessionStart and the like).
  const hook = Predicate.isString(value.subtype) && value.subtype.startsWith("hook_");
  return Object.fromEntries(
    Object.entries(value).map(([key, field]): [string, Schema.Json] => {
      if (hook && ["stdout", "stderr", "output"].includes(key)) return [key, ""];
      if (!PERSONAL.has(key)) return [key, scrub(field)];
      if (Array.isArray(field)) return [key, []];
      return [key, isObject(field) ? {} : Predicate.isString(field) ? "" : field];
    }),
  );
}

/** Frames scrubbed, and your hooks' runs and MCP servers' startup dropped: nothing an adapter reads. */
function scrubbed(entry: Recorded): ReadonlyArray<Recorded> {
  if ("out" in entry)
    return [{ pid: entry.pid, out: Schema.decodeUnknownSync(Schema.JsonObject)(scrub(entry.out)) }];
  if (!("in" in entry)) return [entry];
  if (
    Predicate.isString(entry.in.method) &&
    /^(hook\/|mcpServer\/startupStatus)/.test(entry.in.method)
  )
    return [];
  return [{ pid: entry.pid, in: Schema.decodeUnknownSync(Schema.JsonObject)(scrub(entry.in)) }];
}

const only = process.argv[2];
for (const scenario of SCENARIOS.filter((s) => !only || s.name === only)) {
  const folder = project({});
  const daemon = await startDaemon({
    [scenario.provider]: {
      defaultModel: scenario.model,
      binaryPath: FAKE_CLI,
      env: {
        MASSCODE_REAL_BIN: resolveExecutable(
          scenario.provider,
          scenario.provider === "claude" ? "MASSCODE_CLAUDE_PATH" : "MASSCODE_CODEX_PATH",
        ),
        MASSCODE_RECORD: "recording.jsonl",
      },
    },
  });
  const [first, ...rest] = scenario.messages;
  const effort = scenario.provider === "codex" ? "low" : null;
  const thread = await daemon.create(folder, first!, { provider: scenario.provider, effort });
  for (const text of [null, ...rest]) {
    if (text !== null)
      await daemon.dispatch(
        ClientCommand.cases["thread.send"].make({
          threadId: thread.id,
          text,
          options: { effort, permission: "ask", attachments: [] },
        }),
      );
    const turns = daemon.events.filter((e) => RuntimeEvent.guards["turn.completed"](e)).length;
    while (daemon.events.filter((e) => RuntimeEvent.guards["turn.completed"](e)).length === turns) {
      const request = daemon.events.find(
        (e): e is Extract<RuntimeEvent, { _tag: "approval.requested" }> =>
          RuntimeEvent.guards["approval.requested"](e) &&
          !daemon.events.some(
            (r) => RuntimeEvent.guards["approval.resolved"](r) && r.requestId === e.requestId,
          ),
      );
      if (request && scenario.approve)
        await daemon.dispatch(
          ClientCommand.cases["approval.respond"].make({
            threadId: thread.id,
            requestId: request.requestId,
            decision: "allow",
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await daemon.waitFor(
      (e) => RuntimeEvent.guards["thread.status"](e) && e.status === "idle",
      60_000,
    );
  }
  await daemon.stop();
  const recorded = readRecording(join(folder, "recording.jsonl")).flatMap(scrubbed);
  const out = join(import.meta.dir, "..", "fixtures", `${scenario.name}.json`);
  writeFileSync(out, `${JSON.stringify(toFixture(recorded), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
process.exit(0);
