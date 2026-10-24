import { expect, test } from "bun:test";
import { openEnvelope, sealEnvelope } from "../src/index.ts";

test("an envelope round-trips its channel and payload", () => {
  const payload = new Uint8Array([1, 2, 3]);

  expect(openEnvelope(sealEnvelope(4_000_000_000, payload))).toEqual({
    channel: 4_000_000_000,
    payload,
  });
});

test("an envelope shorter than its channel header is refused", () => {
  expect(openEnvelope(new Uint8Array([0, 1]))).toBeNull();
});
