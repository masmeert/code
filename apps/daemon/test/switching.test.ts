import { ClientCommand, RuntimeEvent } from "@masscode/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { afterEach, expect, test } from "bun:test";
import {
  getClaudeSessionId,
  readFixture,
  readPeerLog,
  createProject,
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

const claude = readFixture("claude-two-turns").sessions[0]!;

const codex = readFixture("codex-two-turns").sessions[0]!;

function switchTo(threadId: string, provider: "claude" | "codex") {
  return daemon!.dispatch(
    ClientCommand.cases["thread.setModel"].make({ threadId, provider, model: null }),
  );
}

async function runTurn(threadId: string, text: string) {
  const before = daemon!.countTurnsCompleted();
  expect(await daemon!.send(threadId, text)).toBeNull();
  await daemon!.waitFor(() => daemon!.countTurnsCompleted() > before);
  await daemon!.waitFor(matchStatus(threadId, "idle"));
}

const TextItems = Schema.Array(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
);

/** The text of each `turn/start` Codex got, its input items joined. */
function getCodexTurnTexts(folder: string) {
  return readPeerLog(folder, "codex").flatMap(({ out }) =>
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
function getClaudeTurnTexts(folder: string) {
  return readPeerLog(folder, "claude").flatMap(({ out }) => {
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
  const folder = createProject({ claude: { sessions: [claude] }, codex: { sessions: [codex] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  expect(await switchTo(thread.id, "codex")).toBeNull();
  expect(
    (await daemon.listThreads()).find((candidate) => candidate.id === thread.id)?.provider,
  ).toBe("codex");

  await runTurn(thread.id, "Now say hi");
  const [items] = getCodexTurnTexts(folder);
  expect(items).toHaveLength(2);
  expect(items![0]).toContain("Reply with exactly: pong");
  expect(items![0]).toContain("Claude");
  expect(items![1]).toBe("Now say hi");

  const [first, second] = daemon
    .readTranscript(thread.id)
    .filter(RuntimeEvent.guards["user.message"]);

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

  const folder = createProject({
    claude: { sessions: [claude, claude] },
    codex: { sessions: [codex] },
  });

  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await runTurn(thread.id, "Codex, say hi");
  await switchTo(thread.id, "claude");
  await runTurn(thread.id, "Claude, say bye");

  const spawns = readPeerLog(folder, "claude").filter((entry) => entry.spawn !== undefined);
  expect(spawns[1]?.args).toContain(`--resume=${getClaudeSessionId(claude)}`);
  const [, back] = getClaudeTurnTexts(folder);
  expect(back).toHaveLength(2);
  expect(back![0]).toContain("Codex, say hi");
  expect(back![0]).not.toContain("Reply with exactly: pong");
  expect(back![1]).toBe("Claude, say bye");
});

test("switching harness back and forth without a turn hands nothing over", async () => {
  daemon = await startDaemon();
  const folder = createProject({ claude: { sessions: [claude, claude] } });
  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await switchTo(thread.id, "claude");
  await runTurn(thread.id, "Reply with exactly: pong again");

  expect(getClaudeTurnTexts(folder).at(-1)).toEqual(["Reply with exactly: pong again"]);
  expect(
    daemon
      .readTranscript(thread.id)
      .filter(RuntimeEvent.guards["user.message"])
      .some((message) => message.handoff),
  ).toBe(false);
});

test("the harness can't be switched mid-turn", async () => {
  daemon = await startDaemon();

  const folder = createProject({
    claude: { sessions: [takeUntil(claude, (step) => "reply" in step)] },
  });

  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "running"));
  expect(await switchTo(thread.id, "codex")).toContain("Stop");
  expect(
    (await daemon.listThreads()).find((candidate) => candidate.id === thread.id)?.provider,
  ).toBe("claude");
});

test("rewinding a thread that switched harness starts its agent afresh with the conversation kept", async () => {
  daemon = await startDaemon();

  const folder = createProject({
    claude: { sessions: [claude] },
    codex: { sessions: [codex, codex] },
  });

  const thread = await daemon.createThread(folder, "Reply with exactly: pong");
  await daemon.waitFor(matchStatus(thread.id, "idle"));
  await switchTo(thread.id, "codex");
  await runTurn(thread.id, "Codex, say hi");

  const codexMessage = daemon
    .readTranscript(thread.id)
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
  await runTurn(thread.id, "Codex, say bye");

  const starts = readPeerLog(folder, "codex").filter(
    (entry) => entry.out?.method === "thread/start",
  );

  expect(starts).toHaveLength(2);
  const [, afresh] = getCodexTurnTexts(folder);
  expect(afresh![0]).toContain("Reply with exactly: pong");
  expect(afresh![0]).not.toContain("Codex, say hi");
});
