import { PROTOCOL_VERSION } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, test } from "bun:test";
import { startDaemon, type Daemon } from "./replay/daemon.ts";

let daemon: Daemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

// Bun's WebSocket takes headers (the Origin the daemon checks); the global type here is Node's, which doesn't.
declare const WebSocket: new (url: string, options: Bun.WebSocketOptions) => globalThis.WebSocket;

/** Connects as the app's web view does. */
function connect(port: number, protocol: number) {
  const options: Bun.WebSocketOptions = { headers: { origin: "http://localhost:1420" } };
  return new WebSocket(`ws://127.0.0.1:${port}/?protocol=${protocol}`, options);
}

test("a client speaking another protocol is turned away, and told why", async () => {
  daemon = await startDaemon();
  const socket = connect(await daemon.listen(), PROTOCOL_VERSION + 1);
  const closed = await new Promise<CloseEvent>((resolve) => (socket.onclose = resolve));
  expect(closed.code).toBe(4426);
  expect(closed.reason).toContain("Update");
});

test("the shell tells the client which protocol the daemon speaks", async () => {
  daemon = await startDaemon();
  const socket = connect(await daemon.listen(), PROTOCOL_VERSION);
  const first = await new Promise<MessageEvent>((resolve) => (socket.onmessage = resolve));
  socket.close();
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ protocol: Schema.Number })))(
      String(first.data),
    ).protocol,
  ).toBe(PROTOCOL_VERSION);
});
