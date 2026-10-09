import { ClientCommand, RuntimeEvent } from "@masscode/contracts";
import { afterEach, expect, test } from "bun:test";
import {
  readFixture,
  readPeerLog,
  createProject,
  startDaemon,
  matchStatus,
  type Daemon,
} from "./replay/daemon.ts";

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: a thread runs two turns in one agent process`, async () => {
    daemon = await startDaemon();
    const folder = createProject({ [provider]: readFixture(`${provider}-two-turns`) });
    const thread = await daemon.createThread(folder, "Reply with exactly: pong", { provider });
    await daemon.waitFor(matchStatus(thread.id, "idle"));
    await daemon.dispatch(
      ClientCommand.cases["thread.send"].make({
        threadId: thread.id,
        text: "Reply with exactly: pong again",
        options: { effort: null, permission: "ask", attachments: [] },
      }),
    );
    await daemon.waitFor(() => daemon!.countTurnsCompleted(thread.id) === 2);

    const answers = daemon
      .readTranscript(thread.id)
      .flatMap((event) => (RuntimeEvent.guards["assistant.completed"](event) ? [event.text] : []));
    expect(answers.join("\n")).toContain("pong");
    expect(answers.at(-1)).toContain("pong again");
    expect(readPeerLog(folder, provider).filter((entry) => entry.spawn !== undefined)).toHaveLength(
      1,
    );
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: the agent asks before running a command, and runs it once allowed`, async () => {
    daemon = await startDaemon();
    const folder = createProject({ [provider]: readFixture(`${provider}-approval`) });
    const thread = await daemon.createThread(folder, "Run a command", { provider });
    const request = await daemon.waitFor(
      (event): event is Extract<RuntimeEvent, { _tag: "approval.requested" }> =>
        RuntimeEvent.guards["approval.requested"](event) && event.threadId === thread.id,
    );
    await daemon.dispatch(
      ClientCommand.cases["approval.respond"].make({
        threadId: thread.id,
        requestId: request.requestId,
        decision: "allow",
      }),
    );
    await daemon.waitFor(() => daemon!.countTurnsCompleted(thread.id) === 1);

    const transcript = daemon.readTranscript(thread.id);
    expect(transcript.some((event) => RuntimeEvent.guards["tool.completed"](event))).toBe(true);
    expect(
      transcript
        .flatMap((event) => (RuntimeEvent.guards["assistant.completed"](event) ? [event.text] : []))
        .at(-1),
    ).toContain("done");
  });
}
