import { ClientCommand } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, test } from "bun:test";
import {
  eventually,
  fixture,
  interruptible,
  peerLog,
  project,
  startDaemon,
  statusIs,
  until,
  type Daemon,
} from "./replay/daemon.ts";

/** Which thread a tool's answer is about. */
function threadIdOf(json: Schema.JsonObject) {
  return Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }))(json).threadId;
}

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

const codex = fixture("codex-two-turns").sessions[0]!;
const claude = fixture("claude-two-turns").sessions[0]!;

/** The orchestrating agent's turn stays open while it uses the tools. */
const claudeWorking = until(claude, (step) => "reply" in step);

/** A Claude thread mid-turn, and the tools its agent has. */
async function orchestrator(
  daemon: Daemon,
  child: { codex?: ReturnType<typeof fixture> },
  permission: "ask" | "full-access" = "ask",
) {
  const folder = project({ claude: { sessions: [claudeWorking] }, ...child });
  const thread = await daemon.create(folder, "Coordinate the work", { permission });
  await daemon.waitFor(statusIs(thread.id, "running"));
  await eventually(() => peerLog(folder, "claude").some((entry) => entry.mcpToken));

  const token = peerLog(folder, "claude").find((entry) => entry.mcpToken)!.mcpToken!;
  return { folder, thread, tools: await daemon.agentTools(token) };
}

test("an agent starts a thread on the other harness and waits for its answer", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await orchestrator(daemon, { codex: { sessions: [codex] } });
  const result = await tools.call("start_thread", {
    prompt: "Reply with exactly: pong",
    provider: "codex",
    wait: true,
  });
  expect(result.isError).toBe(false);
  expect(result.json).toMatchObject({ status: "idle", answer: "pong" });

  const child = (await daemon.threads()).find(
    (candidate) => candidate.id === threadIdOf(result.json),
  );
  expect(child).toMatchObject({
    provider: "codex",
    projectId: thread.projectId,
    startedBy: thread.id,
  });
});

test("an agent can't start a thread with more access than its own", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await orchestrator(daemon, { codex: { sessions: [codex] } });
  const result = await tools.call("start_thread", {
    prompt: "Reply with exactly: pong",
    provider: "codex",
    permission: "full-access",
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("full-access");
  expect(
    (await daemon.threads()).filter((candidate) => candidate.startedBy === thread.id),
  ).toHaveLength(0);
});

test("retrying start_thread with the same requestId returns the same thread", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await orchestrator(daemon, { codex: { sessions: [codex] } });
  const args = { prompt: "Reply with exactly: pong", provider: "codex", requestId: "review-1" };
  const first = await tools.call("start_thread", args);
  const second = await tools.call("start_thread", args);
  expect(threadIdOf(second.json)).toBe(threadIdOf(first.json));
  expect(
    (await daemon.threads()).filter((candidate) => candidate.startedBy === thread.id),
  ).toHaveLength(1);
});

test("an agent follows up with a thread it started, then reads it", async () => {
  daemon = await startDaemon();
  const { tools } = await orchestrator(daemon, { codex: { sessions: [codex] } });
  const threadId = threadIdOf(
    (
      await tools.call("start_thread", {
        prompt: "Reply with exactly: pong",
        provider: "codex",
        wait: true,
      })
    ).json,
  );
  await tools.call("send_message", { threadId, text: "Reply with exactly: pong again" });
  const waited = await tools.call("wait_for_thread", { threadId });
  expect(waited.json).toMatchObject({ status: "idle", answer: "pong again" });

  const read = await tools.call("read_thread", { threadId });
  expect(read.json).toMatchObject({
    messages: [{ from: "user" }, { from: "assistant" }, { from: "user" }, { from: "assistant" }],
  });
  const listed = await tools.call("list_threads", {});
  expect(listed.json).toMatchObject({
    threads: expect.arrayContaining([expect.objectContaining({ threadId })]),
  });
});

test("stopping a thread stops the threads its agent started", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await orchestrator(daemon, {
    codex: { sessions: [interruptible(codex)] },
  });
  const started = threadIdOf(
    (await tools.call("start_thread", { prompt: "Reply with exactly: pong", provider: "codex" }))
      .json,
  );
  await daemon.waitFor(statusIs(started, "running"));
  await daemon.dispatch(ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
  await daemon.waitFor(statusIs(started, "idle"));
});
