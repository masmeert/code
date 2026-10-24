import { expect, test } from "bun:test";
import {
  createChannel,
  createInitiatorHandshake,
  createResponderHandshake,
  generateKeyPair,
  MAX_NOISE_MESSAGE_BYTES,
} from "../src/index.ts";

function connectedChannels() {
  const responderKeys = generateKeyPair();

  const initiator = createInitiatorHandshake({
    staticKeyPair: generateKeyPair(),
    remoteStaticPublicKey: responderKeys.publicKey,
    prologue: new Uint8Array(),
  });

  const responder = createResponderHandshake({
    staticKeyPair: responderKeys,
    prologue: new Uint8Array(),
  });

  responder.readFirstMessage(initiator.writeFirstMessage(new Uint8Array()));
  const reply = responder.writeSecondMessage(new Uint8Array());
  const { session } = initiator.readSecondMessage(reply.message);

  return { phone: createChannel(session), host: createChannel(reply.session) };
}

test("a short text arrives whole in one message", () => {
  const { phone, host } = connectedChannels();
  const messages = phone.sealText('{"_tag":"thread.seen"}');

  expect(messages).toHaveLength(1);
  expect(host.open(messages[0]!)).toEqual({ type: "text", text: '{"_tag":"thread.seen"}' });
});

test("a 10 MB text is split into Noise-sized messages and reassembled", () => {
  const { phone, host } = connectedChannels();
  const text = "é".repeat(5 * 1024 * 1024);
  const messages = phone.sealText(text);

  expect(messages.length).toBeGreaterThan(1);
  for (const message of messages)
    expect(message.length).toBeLessThanOrEqual(MAX_NOISE_MESSAGE_BYTES);

  const opened = messages.map((message) => host.open(message));

  expect(opened.slice(0, -1).every((event) => event === null)).toBe(true);
  expect(opened.at(-1)).toEqual({ type: "text", text });
});

test("a close carries its code and reason", () => {
  const { phone, host } = connectedChannels();

  expect(phone.open(host.sealClose(4001, "This phone was unpaired"))).toEqual({
    type: "close",
    code: 4001,
    reason: "This phone was unpaired",
  });
});

test("both directions work independently", () => {
  const { phone, host } = connectedChannels();

  expect(host.open(phone.sealText("ping")[0]!)).toEqual({ type: "text", text: "ping" });
  expect(phone.open(host.sealText("pong")[0]!)).toEqual({ type: "text", text: "pong" });
});

test("a message that was dropped breaks the channel instead of skipping ahead", () => {
  const { phone, host } = connectedChannels();

  phone.sealText("lost");

  expect(() => host.open(phone.sealText("next")[0]!)).toThrow();
});

test("a text past the reassembly limit is refused", () => {
  const { phone, host } = connectedChannels();
  const messages = phone.sealText("x".repeat(40 * 1024 * 1024));

  expect(() => {
    for (const message of messages) host.open(message);
  }).toThrow();
});
