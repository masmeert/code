import { expect, test } from "bun:test";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { createInitiatorHandshake, createResponderHandshake } from "../src/index.ts";
import vector from "./noise-ik-vector.json";

function keyPairFrom(secretHex: string) {
  const secretKey = hexToBytes(secretHex);

  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

test("an IK handshake and its transport messages match the cacophony vector", () => {
  const initiator = createInitiatorHandshake({
    staticKeyPair: keyPairFrom(vector.init_static),
    remoteStaticPublicKey: hexToBytes(vector.init_remote_static),
    prologue: hexToBytes(vector.init_prologue),
    ephemeralKeyPair: keyPairFrom(vector.init_ephemeral),
  });

  const responder = createResponderHandshake({
    staticKeyPair: keyPairFrom(vector.resp_static),
    prologue: hexToBytes(vector.resp_prologue),
    ephemeralKeyPair: keyPairFrom(vector.resp_ephemeral),
  });

  const [first, second, ...transport] = vector.messages;

  const firstMessage = initiator.writeFirstMessage(hexToBytes(first!.payload));
  expect(bytesToHex(firstMessage)).toBe(first!.ciphertext);

  const received = responder.readFirstMessage(firstMessage);
  expect(bytesToHex(received.payload)).toBe(first!.payload);
  expect(bytesToHex(received.remoteStaticPublicKey)).toBe(
    bytesToHex(keyPairFrom(vector.init_static).publicKey),
  );

  const reply = responder.writeSecondMessage(hexToBytes(second!.payload));
  expect(bytesToHex(reply.message)).toBe(second!.ciphertext);

  const accepted = initiator.readSecondMessage(reply.message);
  expect(bytesToHex(accepted.payload)).toBe(second!.payload);

  expect(bytesToHex(accepted.session.handshakeHash)).toBe(vector.handshake_hash);
  expect(bytesToHex(reply.session.handshakeHash)).toBe(vector.handshake_hash);

  transport.forEach((message, index) => {
    const [sender, receiver] =
      index % 2 === 0 ? [accepted.session, reply.session] : [reply.session, accepted.session];

    const ciphertext = sender.encrypt(hexToBytes(message.payload));
    expect(bytesToHex(ciphertext)).toBe(message.ciphertext);
    expect(bytesToHex(receiver.decrypt(ciphertext))).toBe(message.payload);
  });
});

test("a responder rejects a first message meant for another static key", () => {
  const responderKeys = keyPairFrom(vector.resp_static);
  const otherKeys = keyPairFrom(vector.init_ephemeral);

  const initiator = createInitiatorHandshake({
    staticKeyPair: keyPairFrom(vector.init_static),
    remoteStaticPublicKey: otherKeys.publicKey,
    prologue: new Uint8Array(),
  });

  const responder = createResponderHandshake({
    staticKeyPair: responderKeys,
    prologue: new Uint8Array(),
  });

  expect(() => responder.readFirstMessage(initiator.writeFirstMessage(new Uint8Array()))).toThrow();
});

function connectedSessions() {
  const initiator = createInitiatorHandshake({
    staticKeyPair: keyPairFrom(vector.init_static),
    remoteStaticPublicKey: keyPairFrom(vector.resp_static).publicKey,
    prologue: new Uint8Array(),
  });

  const responder = createResponderHandshake({
    staticKeyPair: keyPairFrom(vector.resp_static),
    prologue: new Uint8Array(),
  });

  responder.readFirstMessage(initiator.writeFirstMessage(new Uint8Array()));
  const reply = responder.writeSecondMessage(new Uint8Array());

  return { sender: initiator.readSecondMessage(reply.message).session, receiver: reply.session };
}

test("a transport message that was tampered with is rejected", () => {
  const { sender, receiver } = connectedSessions();
  const tampered = sender.encrypt(new TextEncoder().encode("one"));
  tampered[0]! ^= 1;

  expect(() => receiver.decrypt(tampered)).toThrow();
});

test("a transport message that was replayed is rejected", () => {
  const { sender, receiver } = connectedSessions();
  const message = sender.encrypt(new TextEncoder().encode("one"));
  receiver.decrypt(message);

  expect(() => receiver.decrypt(message)).toThrow();
});

test("a transport message that arrives out of order is rejected", () => {
  const { sender, receiver } = connectedSessions();
  sender.encrypt(new TextEncoder().encode("one"));

  expect(() => receiver.decrypt(sender.encrypt(new TextEncoder().encode("two")))).toThrow();
});

test("a handshake message that is too short is rejected", () => {
  const responder = createResponderHandshake({
    staticKeyPair: keyPairFrom(vector.resp_static),
    prologue: new Uint8Array(),
  });

  expect(() => responder.readFirstMessage(new Uint8Array(10))).toThrow();
});
