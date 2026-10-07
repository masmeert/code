import { ClientCommand, RuntimeEvent } from "@apcode/contracts";
import { afterEach, expect, test } from "bun:test";
import {
  fixture,
  interruptible,
  peerLog,
  project,
  replyTo,
  startDaemon,
  statusIs,
  until,
  type Daemon,
} from "./replay/daemon.ts";

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

const codex = fixture("codex-two-turns").sessions[0]!;
/** The first turn takes a moment, long enough to queue a message behind it. */
const slowFirstTurn = [
  ...until(codex, replyTo("rpc-3")),
  { sleepMs: 300 },
  ...codex.slice(until(codex, replyTo("rpc-3")).length),
];

const userMessages = (daemon: Daemon, threadId: string) =>
  daemon
    .transcript(threadId)
    .filter((event): event is Extract<RuntimeEvent, { _tag: "user.message" }> =>
      RuntimeEvent.guards["user.message"](event),
    );

const queueOf = async (daemon: Daemon, threadId: string) =>
  (await daemon.threads()).find((thread) => thread.id === threadId)?.queue ?? [];

const turnStarts = (folder: string) =>
  peerLog(folder, "codex").filter((entry) => entry.out?.method === "turn/start");

test("a message queued during a turn starts the next turn when it ends", async () => {
  daemon = await startDaemon();
  const folder = project({ codex: { sessions: [slowFirstTurn] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong", { provider: "codex" });
  await daemon.waitFor(statusIs(thread.id, "running"));
  expect(
    await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true }),
  ).toBeNull();
  expect((await queueOf(daemon, thread.id)).map((message) => message.text)).toEqual([
    "Reply with exactly: pong again",
  ]);

  await daemon.waitFor(
    () => daemon!.events.filter((e) => RuntimeEvent.guards["turn.completed"](e)).length === 2,
  );
  expect(userMessages(daemon, thread.id).map((message) => message.steer ?? false)).toEqual([
    false,
    false,
  ]);
  expect(await queueOf(daemon, thread.id)).toEqual([]);
});

test("queued messages outlive a daemon crash, held until you send them", async () => {
  daemon = await startDaemon();
  const folder = project({ codex: { sessions: [until(codex, replyTo("rpc-3"))] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong", { provider: "codex" });
  await daemon.waitFor(statusIs(thread.id, "running"));
  await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true });
  await daemon.crash();

  daemon = await startDaemon();
  expect((await queueOf(daemon, thread.id)).map((message) => message.text)).toEqual([
    "Reply with exactly: pong again",
  ]);
  expect(userMessages(daemon, thread.id)).toHaveLength(1);
});

test("Stop holds the queue instead of starting the next message", async () => {
  daemon = await startDaemon();
  const folder = project({ codex: { sessions: [interruptible(codex)] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong", { provider: "codex" });
  await daemon.waitFor(statusIs(thread.id, "running"));
  await daemon.send(thread.id, "Reply with exactly: pong again", { queue: true });
  await daemon.dispatch(ClientCommand.cases["thread.interrupt"].make({ threadId: thread.id }));
  await daemon.waitFor(statusIs(thread.id, "idle"));

  expect(await queueOf(daemon, thread.id)).toHaveLength(1);
  expect(turnStarts(folder)).toHaveLength(1);
});

test("a queued message sent now joins the running turn", async () => {
  daemon = await startDaemon();
  const folder = project({
    codex: {
      sessions: [
        [
          ...until(codex, replyTo("rpc-3")),
          { await: { method: "turn/steer" } },
          { reply: {} },
          ...codex.slice(until(codex, replyTo("rpc-3")).length),
        ],
      ],
    },
  });
  const thread = await daemon.create(folder, "Reply with exactly: pong", { provider: "codex" });
  await daemon.waitFor(statusIs(thread.id, "running"));
  await daemon.send(thread.id, "and again", { queue: true });
  const [queued] = await queueOf(daemon, thread.id);
  await daemon.dispatch(
    ClientCommand.cases["thread.sendQueued"].make({ threadId: thread.id, messageId: queued!.id }),
  );
  await daemon.waitFor(statusIs(thread.id, "idle"));

  expect(userMessages(daemon, thread.id).at(-1)).toMatchObject({ text: "and again", steer: true });
  expect(await queueOf(daemon, thread.id)).toEqual([]);
});

test("a message sent twice with the same id runs once", async () => {
  daemon = await startDaemon();
  const folder = project({ codex: { sessions: [codex] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong", { provider: "codex" });
  await daemon.waitFor(statusIs(thread.id, "idle"));
  const messageId = crypto.randomUUID();
  await daemon.send(thread.id, "Reply with exactly: pong again", { messageId });
  await daemon.send(thread.id, "Reply with exactly: pong again", { messageId });
  await daemon.waitFor(
    () => daemon!.events.filter((e) => RuntimeEvent.guards["turn.completed"](e)).length === 2,
  );

  expect(userMessages(daemon, thread.id).map((message) => message.messageId)).toEqual([
    expect.any(String),
    messageId,
  ]);
  expect(turnStarts(folder)).toHaveLength(2);
});
