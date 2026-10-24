import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";
import type { KeyPair } from "./noise.ts";

const CHALLENGE_CONTEXT = utf8ToBytes("masscode-relay-host:v1:");

/** A host's one long-term secret: an Ed25519 key that signs relay challenges and, converted, keys Noise. */
export function generateHostSecret() {
  return ed25519.utils.randomSecretKey();
}

/** What phones and the relay call a host: its Ed25519 public key, base64url. */
export function hostIdFromSecret(hostSecret: Uint8Array) {
  return encodeBase64Url(ed25519.getPublicKey(hostSecret));
}

export function hostNoiseKeyPair(hostSecret: Uint8Array): KeyPair {
  const secretKey = ed25519.utils.toMontgomerySecret(hostSecret);

  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The Noise key a phone pins for a host, derived from the id it scanned. Throws for a malformed id. */
export function hostNoisePublicKey(hostId: string) {
  const publicKey = decodeBase64Url(hostId);

  if (!publicKey || publicKey.length !== 32) throw new Error("Malformed host id");

  return ed25519.utils.toMontgomery(publicKey);
}

export function signRelayChallenge(hostSecret: Uint8Array, nonce: Uint8Array) {
  return encodeBase64Url(ed25519.sign(concatBytes(CHALLENGE_CONTEXT, nonce), hostSecret));
}

/** Whether the host that owns `hostId` signed this nonce; false for anything malformed. */
export function verifyRelayChallenge(hostId: string, nonce: Uint8Array, signature: string) {
  const publicKey = decodeBase64Url(hostId);
  const signatureBytes = decodeBase64Url(signature);

  if (publicKey?.length !== 32 || signatureBytes?.length !== 64) return false;

  try {
    return ed25519.verify(signatureBytes, concatBytes(CHALLENGE_CONTEXT, nonce), publicKey);
  } catch {
    return false;
  }
}
