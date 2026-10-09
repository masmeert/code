import { ClientCommand } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, test } from "bun:test";
import {
  waitUntil,
  readFixture,
  makeInterruptible,
  readPeerLog,
  createProject,
  startDaemon,
  matchStatus,
  takeUntil,
  type Daemon,
} from "./replay/daemon.ts";

/** Which thread a tool's answer is about. */
function getThreadId(json: Schema.JsonObject) {
  return Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }))(json).threadId;
}

let daemon: Daemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

const codex = readFixture("codex-two-turns").sessions[0]!;

const claude = readFixture("claude-two-turns").sessions[0]!;

/** The orchestrating agent's turn stays open while it uses the tools. */
const claudeWorking = takeUntil(claude, (step) => "reply" in step);

/** A Claude thread mid-turn, and the tools its agent has. */
async function startOrchestrator(
  daemon: Daemon,
  child: { codex?: ReturnType<typeof readFixture> },
  permission: "ask" | "full-access" = "ask",
) {
  const folder = createProject({ claude: { sessions: [claudeWorking] }, ...child });
  const thread = await daemon.createThread(folder, "Coordinate the work", { permission });
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await waitUntil(() => readPeerLog(folder, "claude").some((entry) => entry.mcpToken));

  const token = readPeerLog(folder, "claude").find((entry) => entry.mcpToken)!.mcpToken!;

  return { folder, thread, tools: await daemon.connectAgentTools(token) };
}

test("an agent starts a thread on the other harness and waits for its answer", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await startOrchestrator(daemon, { codex: { sessions: [codex] } });

  const result = await tools.call("start_thread", {
    prompt: "Reply with exactly: pong",
    provider: "codex",
    wait: true,
  });

  expect(result.isError).toBe(false);
  expect(result.json).toMatchObject({ status: "idle", answer: "pong" });

  const child = (await daemon.listThreads()).find(
    (candidate) => candidate.id === getThreadId(result.json),
  );

  expect(child).toMatchObject({
    provider: "codex",
    projectId: thread.projectId,
    startedBy: thread.id,
  });
});

test("an agent can't start a thread with more access than its own", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await startOrchestrator(daemon, { codex: { sessions: [codex] } });

  const result = await tools.call("start_thread", {
    prompt: "Reply with exactly: pong",
    provider: "codex",
    permission: "full-access",
  });

  expect(result.isError).toBe(true);
  expect(result.text).toContain("full-access");
  expect(
    (await daemon.listThreads()).filter((candidate) => candidate.startedBy === thread.id),
  ).toHaveLength(0);
});

test("retrying start_thread with the same requestId returns the same thread", async () => {
  daemon = await startDaemon();
  const { thread, tools } = await startOrchestrator(daemon, { codex: { sessions: [codex] } });
  const args = { prompt: "Reply with exactly: pong", provider: "codex", requestId: "review-1" };
  const first = await tools.call("start_thread", args);
  const second = await tools.call("start_thread", args);
  expect(getThreadId(second.json)).toBe(getThreadId(first.json));
  expect(
    (await daemon.listThreads()).filter((candidate) => candidate.startedBy === thread.id),
  ).toHaveLength(1);
});

test("an agent follows up with a thread it started, then reads it", async () => {
  daemon = await startDaemon();
  const { tools } = await startOrchestrator(daemon, { codex: { sessions: [codex] } });

  const threadId = getThreadId(
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

  const { thread, tools } = await startOrchestrator(daemon, {
    codex: { sessions: [makeInterruptible(codex)] },
  });

  const started = getThreadId(
    (await tools.call("start_thread", { prompt: "Reply with exactly: pong", provider: "codex" }))
      .json,
  );

  await daemon.waitFor(matchStatus(started, "running"));
  await daemon.dispatch(ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
  await daemon.waitFor(matchStatus(started, "idle"));
});
