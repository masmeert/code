import { RuntimeEvent } from "@masscode/contracts";
import { afterEach, expect, test } from "bun:test";
import {
  matchAwait,
  getClaudeSessionId,
  getCodexThreadId,
  readFixture,
  readPeerLog,
  createProject,
  matchReplyTo,
  toResumed,
  startDaemon,
  matchStatus,
  takeUntil,
  type Daemon,
} from "./replay/daemon.ts";

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

const codex = readFixture("codex-two-turns").sessions[0]!;
const claude = readFixture("claude-two-turns").sessions[0]!;

/** Claude up to answering `initialize`: the turn has started and nothing has come back yet. */
const claudeMidTurn = takeUntil(claude, (step) => "reply" in step);

function listSpawns(folder: string, provider: "claude" | "codex") {
  return readPeerLog(folder, provider).filter((entry) => entry.spawn !== undefined);
}

function filterThreadEvents<T extends RuntimeEvent["_tag"]>(
  events: ReadonlyArray<RuntimeEvent>,
  threadId: string,
  tag: T,
) {
  return events
    .filter(RuntimeEvent.isAnyOf([tag]))
    .filter((event) => "threadId" in event && event.threadId === threadId);
}

test("codex: a crash mid-turn ends the turn, and the next message resumes the thread", async () => {
  daemon = await startDaemon();
  const folder = createProject({
    codex: {
      sessions: [[...takeUntil(codex, matchReplyTo("rpc-3")), { exit: 1 }], toResumed(codex)],
    },
  });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "error"));
  const transcript = daemon.readTranscript(thread.id);
  expect(filterThreadEvents(transcript, thread.id, "turn.completed")).toHaveLength(1);
  expect(filterThreadEvents(transcript, thread.id, "error").at(-1)?.message).toContain("exited");

  expect(await daemon.send(thread.id, "Reply with exactly: pong")).toBeNull();
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  expect(listSpawns(folder, "codex")).toHaveLength(2);
  const resume = readPeerLog(folder, "codex").find(
    (entry) => entry.session === 1 && entry.out?.method === "thread/resume",
  );
  expect(resume?.out?.params).toMatchObject({ threadId: getCodexThreadId(codex) });
});

test("claude: a crash mid-turn ends the turn, and the next message resumes the session", async () => {
  daemon = await startDaemon();
  const folder = createProject({ claude: { sessions: [[...claudeMidTurn, { exit: 1 }], claude] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "error"));
  expect(
    filterThreadEvents(daemon.readTranscript(thread.id), thread.id, "turn.completed"),
  ).toHaveLength(1);

  expect(await daemon.send(thread.id, "Reply with exactly: pong")).toBeNull();
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  const [, second] = listSpawns(folder, "claude");
  expect(second?.args).toContain(`--resume=${getClaudeSessionId(claude)}`);
});

test("codex: a turn the agent refuses to start doesn't leave the thread running", async () => {
  daemon = await startDaemon();
  const folder = createProject({
    codex: {
      sessions: [
        [
          ...takeUntil(codex, matchAwait({ method: "turn/start" })),
          { replyError: "The model gpt-404 does not exist" },
        ],
        toResumed(codex),
      ],
    },
  });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "error"));
  await daemon.waitFor(
    (event) =>
      RuntimeEvent.guards.error(event) &&
      event.threadId === thread.id &&
      event.message.includes("gpt-404"),
  );

  expect(await daemon.send(thread.id, "Reply with exactly: pong")).toBeNull();
  await daemon.waitFor(matchStatus(thread.id, "idle"));
});

test("a turn cut short by quitting the app ends in the transcript", async () => {
  daemon = await startDaemon();
  const folder = createProject({ claude: { sessions: [claudeMidTurn] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await daemon.stop();

  daemon = await startDaemon();
  const transcript = daemon.readTranscript(thread.id);
  expect(transcript.slice(-2).map((event) => event._tag)).toEqual(["turn.completed", "error"]);
  expect((await daemon.listThreads()).find((candidate) => candidate.id === thread.id)?.status).toBe(
    "idle",
  );
});

test("a turn cut short by the daemon crashing ends in the transcript on the next start", async () => {
  daemon = await startDaemon();
  const folder = createProject({ claude: { sessions: [claudeMidTurn] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await daemon.crash();

  daemon = await startDaemon();
  const transcript = daemon.readTranscript(thread.id);
  expect(transcript.slice(-2).map((event) => event._tag)).toEqual(["turn.completed", "error"]);
});
