/**
 * Stands in for the `claude` or `codex` CLI at the stdio boundary the adapters talk to, so the
 * real adapters, SessionManager and SQLite run against recorded provider traffic.
 *
 * - Replay: `MASSCODE_REPLAY=<fixture.json>`. Each spawn plays the fixture's next session. Paths are
 *   relative to the folder the CLI is started in, the thread's, so each test's threads get their own.
 * - Record: `MASSCODE_REAL_BIN=<cli> MASSCODE_RECORD=<out.jsonl>` runs the real CLI and logs every frame.
 * - Convert: `bun peer.ts fixture <recording.jsonl>` prints a recording as a fixture.
 *
 * Replay appends what the adapter sent to `<fixture>.log.jsonl`, for tests to assert on.
 */
import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

/** A Claude writer call (titles, commit messages): never part of a fixture. */
const ONE_SHOT_FLAG = "--no-session-persistence";

/** One line of either protocol: Claude's stream-json, or Codex's JSON-RPC. */
export const Frame = Schema.JsonObject;
export type Frame = typeof Frame.Type;

const RpcId = Schema.Union([Schema.Number, Schema.String]);
/** From the Claude SDK; the CLI answers with a `control_response` carrying its `request_id`. */
const ControlRequest = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
  request: Schema.Struct({ subtype: Schema.String }),
});
const ControlResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.String,
    request_id: Schema.String,
    response: Schema.optional(Schema.Json),
    error: Schema.optional(Schema.String),
  }),
});
const RpcRequest = Schema.Struct({ id: RpcId, method: Schema.String });
const RpcNotification = Schema.Struct({ method: Schema.String });
const RpcResponse = Schema.Struct({
  id: RpcId,
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const Typed = Schema.Struct({ type: Schema.String });

export const Step = Schema.Union([
  /** Waits for the adapter to send a frame matching `await` (deep partial match). */
  Schema.Struct({ await: Frame, as: Schema.optional(Schema.String) }),
  /** Answers the awaited frame named `to` (the last one awaited when left out). */
  Schema.Struct({ reply: Schema.Json, to: Schema.optional(Schema.String) }),
  Schema.Struct({ replyError: Schema.String, to: Schema.optional(Schema.String) }),
  Schema.Struct({ send: Frame }),
  /** Holds the turn open a while, as a slow model would. */
  Schema.Struct({ sleepMs: Schema.Number }),
  Schema.Struct({ exit: Schema.Number }),
]);
export type Step = typeof Step.Type;

export const Fixture = Schema.Struct({ sessions: Schema.Array(Schema.Array(Step)) });
export type Fixture = typeof Fixture.Type;

/** A line of a recording; spawns of one thread share the file, so each names its process. */
const Recorded = Schema.Union([
  Schema.Struct({ pid: Schema.Number, spawn: Schema.Array(Schema.String) }),
  Schema.Struct({ pid: Schema.Number, out: Frame }),
  Schema.Struct({ pid: Schema.Number, in: Frame }),
  Schema.Struct({ pid: Schema.Number, exit: Schema.NullOr(Schema.Number) }),
]);
export type Recorded = typeof Recorded.Type;

const isObject = Schema.is(Schema.JsonObject);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
export const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Fixture));
const decodeRecorded = Schema.decodeUnknownSync(Schema.fromJsonString(Recorded));

/** Every field of `pattern` is in `value`, recursively. */
export function matches(pattern: Schema.Json, value: Schema.Json | undefined): boolean {
  if (!isObject(pattern) || Array.isArray(pattern)) return pattern === value;
  if (value === undefined || !isObject(value) || Array.isArray(value)) return false;
  return Object.entries(pattern).every(([key, expected]) => matches(expected, value[key]));
}

const isRequest = (frame: Frame) =>
  Schema.is(ControlRequest)(frame) || Schema.is(RpcRequest)(frame);

/** The response to `request` in its own protocol. */
function answer(request: Frame, outcome: { result: Schema.Json } | { error: string }): Frame {
  if (Schema.is(ControlRequest)(request))
    return {
      type: "control_response",
      response:
        "error" in outcome
          ? { subtype: "error", request_id: request.request_id, error: outcome.error }
          : { subtype: "success", request_id: request.request_id, response: outcome.result },
    };
  const id = Schema.is(RpcRequest)(request) ? request.id : null;
  return "error" in outcome
    ? { id, error: { message: outcome.error } }
    : { id, result: outcome.result };
}

function replay(fixturePath: string) {
  const log = `${fixturePath}.log.jsonl`;
  const spawnIndex = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith('{"spawn"')).length
    : 0;
  const args = process.argv.slice(2);
  if (args.includes(ONE_SHOT_FLAG)) {
    process.stderr.write("replay peer: one-shot calls aren't replayed\n");
    process.exit(1);
  }
  appendFileSync(
    log,
    `${JSON.stringify({ spawn: spawnIndex, pid: process.pid, args, mcpToken: process.env.MASSCODE_MCP_TOKEN ?? null })}\n`,
  );
  const steps = decodeFixture(readFileSync(fixturePath, "utf8")).sessions[spawnIndex];
  if (!steps) {
    process.stderr.write(`replay peer: the fixture has no session ${spawnIndex}\n`);
    process.exit(1);
  }

  const inbox: Array<Frame> = [];
  let wake: (() => void) | null = null;
  let stdinClosed = false;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = decodeFrame(line);
    appendFileSync(log, `${JSON.stringify({ session: spawnIndex, out: frame })}\n`);
    inbox.push(frame);
    wake?.();
  });
  lines.on("close", () => {
    stdinClosed = true;
    wake?.();
  });

  function write(frame: Frame) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  async function next(): Promise<Frame | null> {
    while (inbox.length === 0) {
      if (stdinClosed) return null;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
    return inbox.shift() ?? null;
  }

  void (async () => {
    const awaited = new Map<string, Frame>();
    let last: Frame | null = null;
    for (const step of steps) {
      if ("await" in step) {
        while (true) {
          const frame = await next();
          if (frame === null) process.exit(0);
          if (matches(step.await, frame)) {
            last = frame;
            if (step.as) awaited.set(step.as, frame);
            break;
          }
          if (isRequest(frame)) write(answer(frame, { result: {} }));
        }
      } else if ("reply" in step || "replyError" in step) {
        const request = step.to ? awaited.get(step.to) : last;
        if (!request) throw new Error(`replay peer: nothing awaited to answer (${step.to})`);
        write(
          answer(request, "reply" in step ? { result: step.reply } : { error: step.replyError }),
        );
      } else if ("send" in step) write(step.send);
      else if ("sleepMs" in step) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      else {
        // Let the frames written so far reach the adapter before the process goes.
        process.stdout.write("", () => process.exit(step.exit));
        return;
      }
    }
    // Out of steps: idle like a CLI waiting for its next message, until stdin closes.
    while (true) {
      const frame = await next();
      if (frame === null) process.exit(0);
      if (isRequest(frame)) write(answer(frame, { result: {} }));
    }
  })();
}

function record(realBin: string, out: string) {
  const args = process.argv.slice(2);
  const child = spawn(realBin, args, { stdio: ["pipe", "pipe", "inherit"] });
  process.stdin.pipe(child.stdin);
  // Writer calls run alongside sessions; they aren't replayed, so they aren't recorded.
  if (args.includes(ONE_SHOT_FLAG)) {
    child.stdout.pipe(process.stdout);
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  const log = (entry: Recorded) => appendFileSync(out, `${JSON.stringify(entry)}\n`);
  const pid = process.pid;
  log({ pid, spawn: args });
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) log({ pid, out: decodeFrame(line) });
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim()) log({ pid, in: decodeFrame(line) });
    process.stdout.write(`${line}\n`);
  });
  child.on("exit", (code) => {
    log({ pid, exit: code });
    process.exit(code ?? 1);
  });
}

/** What the adapter sent, as a wait for that kind of frame, named for the reply to find it by. */
function awaitFor(frame: Frame): Step {
  if (Schema.is(ControlRequest)(frame))
    return {
      await: { type: "control_request", request: { subtype: frame.request.subtype } },
      as: frame.request_id,
    };
  if (Schema.is(Typed)(frame)) return { await: { type: frame.type } };
  if (Schema.is(RpcRequest)(frame))
    return { await: { method: frame.method }, as: `rpc-${frame.id}` };
  if (Schema.is(RpcNotification)(frame)) return { await: { method: frame.method } };
  return Schema.is(RpcResponse)(frame) ? { await: { id: frame.id } } : { await: frame };
}

/** What the CLI sent: a reply to something awaited, or a frame sent as recorded. */
function replyOrSend(frame: Frame): Step {
  if (Schema.is(ControlResponse)(frame)) {
    const { request_id, response, error } = frame.response;
    return frame.response.subtype === "success"
      ? { reply: response ?? {}, to: request_id }
      : { replyError: error ?? "error", to: request_id };
  }
  // A response has an id and no method; the CLI's own requests (approvals) have both.
  if (!Schema.is(RpcNotification)(frame) && Schema.is(RpcResponse)(frame))
    return frame.error
      ? { replyError: frame.error.message, to: `rpc-${frame.id}` }
      : { reply: frame.result ?? null, to: `rpc-${frame.id}` };
  return { send: frame };
}

/** A recording as replay steps, one session per process. */
export function toFixture(recorded: ReadonlyArray<Recorded>): Fixture {
  const sessions = new Map<number, Array<Step>>();
  for (const entry of recorded) {
    if ("spawn" in entry) {
      sessions.set(entry.pid, []);
      continue;
    }
    const steps = sessions.get(entry.pid);
    if (!steps) continue;
    if ("out" in entry) steps.push(awaitFor(entry.out));
    else if ("in" in entry) steps.push(replyOrSend(entry.in));
    else if (entry.exit !== 0 && entry.exit !== null) steps.push({ exit: entry.exit });
  }
  return { sessions: [...sessions.values()] };
}

export function readRecording(path: string): ReadonlyArray<Recorded> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeRecorded(line));
}

if (import.meta.main) {
  if (process.argv[2] === "fixture" && process.argv[3])
    process.stdout.write(`${JSON.stringify(toFixture(readRecording(process.argv[3])), null, 2)}\n`);
  else if (process.env.MASSCODE_REPLAY) replay(resolve(process.env.MASSCODE_REPLAY));
  else if (process.env.MASSCODE_REAL_BIN && process.env.MASSCODE_RECORD)
    record(process.env.MASSCODE_REAL_BIN, resolve(process.env.MASSCODE_RECORD));
  else {
    process.stderr.write(
      "replay peer: set MASSCODE_REPLAY, or MASSCODE_REAL_BIN and MASSCODE_RECORD\n",
    );
    process.exit(2);
  }
}
