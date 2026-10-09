import { ClientCommand, RuntimeEvent } from "@masscode/contracts";
import { afterEach, expect, test } from "bun:test";
import {
  readFixture,
  makeInterruptible,
  readPeerLog,
  createProject,
  matchReplyTo,
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

/** The first turn takes a moment, long enough to queue a message behind it. */
const slowFirstTurn = [
  ...takeUntil(codex, matchReplyTo("rpc-3")),
  { sleepMs: 300 },
  ...codex.slice(takeUntil(codex, matchReplyTo("rpc-3")).length),
];

function getUserMessages(daemon: Daemon, threadId: string) {
  return daemon.readTranscript(threadId).filter(RuntimeEvent.guards["user.message"]);
}

async function readQueue(daemon: Daemon, threadId: string) {
  return (await daemon.listThreads()).find((thread) => thread.id === threadId)?.queue ?? [];
}

function listTurnStarts(folder: string) {
  return readPeerLog(folder, "codex").filter((entry) => entry.out?.method === "turn/start");
}

test("a message queued during a turn starts the next turn when it ends", async () => {
  daemon = await startDaemon();
  const folder = createProject({ codex: { sessions: [slowFirstTurn] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "running"));
  expect(
    await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true }),
  ).toBeNull();
  expect((await readQueue(daemon, thread.id)).map((message) => message.text)).toEqual([
    "Reply with exactly: pong again",
  ]);

  await daemon.waitFor(() => daemon!.countTurnsCompleted() === 2);
  expect(getUserMessages(daemon, thread.id).map((message) => message.steer ?? false)).toEqual([
    false,
    false,
  ]);
  expect(await readQueue(daemon, thread.id)).toEqual([]);
});

test("queued messages outlive a daemon crash, held until you send them", async () => {
  daemon = await startDaemon();
  const folder = createProject({ codex: { sessions: [takeUntil(codex, matchReplyTo("rpc-3"))] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true });
  await daemon.crash();

  daemon = await startDaemon();
  expect((await readQueue(daemon, thread.id)).map((message) => message.text)).toEqual([
    "Reply with exactly: pong again",
  ]);
  expect(getUserMessages(daemon, thread.id)).toHaveLength(1);
});

test("Stop holds the queue instead of starting the next message", async () => {
  daemon = await startDaemon();
  const folder = createProject({ codex: { sessions: [makeInterruptible(codex)] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true });
  await daemon.dispatch(ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
  await daemon.waitFor(matchStatus(thread.id, "idle"));

  expect(await readQueue(daemon, thread.id)).toHaveLength(1);
  expect(listTurnStarts(folder)).toHaveLength(1);
});

test("a queued message sent now joins the running turn", async () => {
  daemon = await startDaemon();
  const folder = createProject({
    codex: {
      sessions: [
        [
          ...takeUntil(codex, matchReplyTo("rpc-3")),
          { await: { method: "turn/steer" } },
          { reply: {} },
          ...codex.slice(takeUntil(codex, matchReplyTo("rpc-3")).length),
        ],
      ],
    },
  });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "running"));
  await daemon.send(thread.id, "and again", { queue: true });
  const [queued] = await readQueue(daemon, thread.id);
  await daemon.dispatch(
    ClientCommand.cases["thread.sendQueued"].make({ threadId: thread.id, messageId: queued!.id }),
  );
  await daemon.waitFor(matchStatus(thread.id, "idle"));

  expect(getUserMessages(daemon, thread.id).at(-1)).toMatchObject({
    text: "and again",
    steer: true,
  });
  expect(await readQueue(daemon, thread.id)).toEqual([]);
});

test("a message sent twice with the same id runs once", async () => {
  daemon = await startDaemon();
  const folder = createProject({ codex: { sessions: [codex] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong", {
    provider: "codex",
  });
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  const messageId = crypto.randomUUID();
  await daemon.send(thread.id, "Reply with exactly: pong again", { messageId });
  await daemon.send(thread.id, "Reply with exactly: pong again", { messageId });
  await daemon.waitFor(() => daemon!.countTurnsCompleted() === 2);

  expect(getUserMessages(daemon, thread.id).map((message) => message.messageId)).toEqual([
    expect.any(String),
    messageId,
  ]);
  expect(listTurnStarts(folder)).toHaveLength(2);
});
