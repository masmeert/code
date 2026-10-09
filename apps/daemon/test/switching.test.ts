import { ClientCommand, RuntimeEvent } from "@masscode/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { afterEach, expect, test } from "bun:test";
import {
  claudeSessionId,
  fixture,
  peerLog,
  project,
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

const claude = fixture("claude-two-turns").sessions[0]!;
const codex = fixture("codex-two-turns").sessions[0]!;

function switchTo(threadId: string, provider: "claude" | "codex") {
  return daemon!.dispatch(
    ClientCommand.cases["thread.setModel"].make({ threadId, provider, model: null }),
  );
}

async function turn(threadId: string, text: string) {
  const before = daemon!.events.filter(RuntimeEvent.guards["turn.completed"]).length;
  expect(await daemon!.send(threadId, text)).toBeNull();
  await daemon!.waitFor(
    () => daemon!.events.filter(RuntimeEvent.guards["turn.completed"]).length > before,
  );
  await daemon!.waitFor(statusIs(threadId, "idle"));
}

const TextItems = Schema.Array(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
);

/** The text of each `turn/start` Codex got, its input items joined. */
function codexTurnTexts(folder: string) {
  return peerLog(folder, "codex").flatMap(({ out }) =>
    out?.method === "turn/start"
      ? [
          Schema.decodeUnknownSync(Schema.Struct({ params: Schema.Struct({ input: TextItems }) }))(
            out,
          ).params.input.map((item) => item.text ?? ""),
        ]
      : [],
  );
}

/** The text blocks of each user message Claude got. */
function claudeTurnTexts(folder: string) {
  return peerLog(folder, "claude").flatMap(({ out }) => {
    if (out?.type !== "user") return [];
    const { content } = Schema.decodeUnknownSync(
      Schema.Struct({
        message: Schema.Struct({ content: Schema.Union([Schema.String, TextItems]) }),
      }),
    )(out).message;
    return [Predicate.isString(content) ? [content] : content.map((block) => block.text ?? "")];
  });
}

test("switching harness hands the new one the conversation so far", async () => {
  daemon = await startDaemon();
  const folder = project({ claude: { sessions: [claude] }, codex: { sessions: [codex] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong");
  await daemon.waitFor(statusIs(thread.id, "idle"));
  expect(await switchTo(thread.id, "codex")).toBeNull();
  expect((await daemon.threads()).find((candidate) => candidate.id === thread.id)?.provider).toBe(
    "codex",
  );

  await turn(thread.id, "Now say hi");
  const [items] = codexTurnTexts(folder);
  expect(items).toHaveLength(2);
  expect(items![0]).toContain("Reply with exactly: pong");
  expect(items![0]).toContain("Claude");
  expect(items![1]).toBe("Now say hi");

  const [first, second] = daemon.transcript(thread.id).filter(RuntimeEvent.guards["user.message"]);
  expect(first).toMatchObject({ provider: "claude" });
  expect(first?.handoff).toBeUndefined();
  expect(second).toMatchObject({
    text: "Now say hi",
    provider: "codex",
    handoff: { from: "claude", messages: 2, text: items![0] },
  });
});

test("switching back resumes the old session and hands over only what it missed", async () => {
  daemon = await startDaemon();
  const folder = project({ claude: { sessions: [claude, claude] }, codex: { sessions: [codex] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong");
  await daemon.waitFor(statusIs(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await turn(thread.id, "Codex, say hi");
  await switchTo(thread.id, "claude");
  await turn(thread.id, "Claude, say bye");

  const spawns = peerLog(folder, "claude").filter((entry) => entry.spawn !== undefined);
  expect(spawns[1]?.args).toContain(`--resume=${claudeSessionId(claude)}`);
  const [, back] = claudeTurnTexts(folder);
  expect(back).toHaveLength(2);
  expect(back![0]).toContain("Codex, say hi");
  expect(back![0]).not.toContain("Reply with exactly: pong");
  expect(back![1]).toBe("Claude, say bye");
});

test("switching harness back and forth without a turn hands nothing over", async () => {
  daemon = await startDaemon();
  const folder = project({ claude: { sessions: [claude, claude] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong");
  await daemon.waitFor(statusIs(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await switchTo(thread.id, "claude");
  await turn(thread.id, "Reply with exactly: pong again");

  expect(claudeTurnTexts(folder).at(-1)).toEqual(["Reply with exactly: pong again"]);
  expect(
    daemon
      .transcript(thread.id)
      .filter(RuntimeEvent.guards["user.message"])
      .some((message) => message.handoff),
  ).toBe(false);
});

test("the harness can't be switched mid-turn", async () => {
  daemon = await startDaemon();
  const folder = project({ claude: { sessions: [until(claude, (step) => "reply" in step)] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong");
  await daemon.waitFor(statusIs(thread.id, "running"));
  expect(await switchTo(thread.id, "codex")).toContain("Stop");
  expect((await daemon.threads()).find((candidate) => candidate.id === thread.id)?.provider).toBe(
    "claude",
  );
});

test("rewinding a thread that switched harness starts its agent afresh with the conversation kept", async () => {
  daemon = await startDaemon();
  const folder = project({ claude: { sessions: [claude] }, codex: { sessions: [codex, codex] } });
  const thread = await daemon.create(folder, "Reply with exactly: pong");
  await daemon.waitFor(statusIs(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await turn(thread.id, "Codex, say hi");
  const codexMessage = daemon
    .transcript(thread.id)
    .filter(RuntimeEvent.guards["user.message"])
    .at(-1)!;
  expect(
    await daemon.dispatch(
      ClientCommand.cases["thread.rewind"].make({
        threadId: thread.id,
        messageId: codexMessage.messageId,
        restoreFiles: false,
      }),
    ),
  ).toBeNull();
  await turn(thread.id, "Codex, say bye");

  const starts = peerLog(folder, "codex").filter((entry) => entry.out?.method === "thread/start");
  expect(starts).toHaveLength(2);
  const [, afresh] = codexTurnTexts(folder);
  expect(afresh![0]).toContain("Reply with exactly: pong");
  expect(afresh![0]).not.toContain("Codex, say hi");
});
