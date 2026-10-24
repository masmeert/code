import { expect, test } from "bun:test";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  generateHostSecret,
  generateKeyPair,
  hostIdFromSecret,
  hostNoiseKeyPair,
  hostNoisePublicKey,
  signRelayChallenge,
  verifyRelayChallenge,
} from "../src/index.ts";

test("a host id is a 43-character URL-safe string", () => {
  expect(hostIdFromSecret(generateHostSecret())).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("a phone holding only the host id completes a handshake with the host", () => {
  const hostSecret = generateHostSecret();
  const hostId = hostIdFromSecret(hostSecret);

  const initiator = createInitiatorHandshake({
    staticKeyPair: generateKeyPair(),
    remoteStaticPublicKey: hostNoisePublicKey(hostId),
    prologue: new Uint8Array(),
  });

  const responder = createResponderHandshake({
    staticKeyPair: hostNoiseKeyPair(hostSecret),
    prologue: new Uint8Array(),
  });

  const received = responder.readFirstMessage(initiator.writeFirstMessage(new Uint8Array([7])));
  expect(received.payload).toEqual(new Uint8Array([7]));
});

test("a challenge signed by the host verifies against its id", () => {
  const hostSecret = generateHostSecret();
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  expect(
    verifyRelayChallenge(
      hostIdFromSecret(hostSecret),
      nonce,
      signRelayChallenge(hostSecret, nonce),
    ),
  ).toBe(true);
});

test("a challenge signed by another key, or for another nonce, does not verify", () => {
  const hostSecret = generateHostSecret();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signature = signRelayChallenge(generateHostSecret(), nonce);

  expect(verifyRelayChallenge(hostIdFromSecret(hostSecret), nonce, signature)).toBe(false);
  expect(
    verifyRelayChallenge(
      hostIdFromSecret(hostSecret),
      crypto.getRandomValues(new Uint8Array(32)),
      signRelayChallenge(hostSecret, nonce),
    ),
  ).toBe(false);
});

test("a malformed host id does not verify", () => {
  expect(verifyRelayChallenge("not-a-key", new Uint8Array(32), "AAAA")).toBe(false);
});
