import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Noise caps every message, handshake or transport, at this many bytes. */
export const MAX_NOISE_MESSAGE_BYTES = 65_535;

const KEY_BYTES = 32;
const TAG_BYTES = 16;
/** Exactly 32 bytes, so Noise uses it as the first hash as is rather than hashing it. */
const PROTOCOL_NAME = utf8ToBytes("Noise_IK_25519_ChaChaPoly_SHA256");

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return keyPairFromSecret(x25519.utils.randomSecretKey());
}

/** The key pair a stored X25519 secret stands for. */
export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * One direction's key and counter. The counter is the nonce and only moves on success, so a
 * message that was dropped, replayed or reordered fails to open.
 */
function createCipherState(key: Uint8Array | null) {
  let nonce = 0;

  function cipherFor(associatedData: Uint8Array) {
    if (!key) return null;
    if (nonce >= Number.MAX_SAFE_INTEGER) throw new Error("Noise nonce exhausted");

    // Noise's nonce: 4 zero bytes, then the counter as 64-bit little-endian, written as two halves.
    const nonceBytes = new Uint8Array(12);
    const view = new DataView(nonceBytes.buffer);
    view.setUint32(4, nonce % 2 ** 32, true);
    view.setUint32(8, Math.floor(nonce / 2 ** 32), true);

    return chacha20poly1305(key, nonceBytes, associatedData);
  }

  return {
    encrypt(associatedData: Uint8Array, plaintext: Uint8Array) {
      const cipher = cipherFor(associatedData);

      if (!cipher) return plaintext;

      const ciphertext = cipher.encrypt(plaintext);
      nonce++;

      return ciphertext;
    },
    decrypt(associatedData: Uint8Array, ciphertext: Uint8Array) {
      const cipher = cipherFor(associatedData);

      if (!cipher) return ciphertext;

      const plaintext = cipher.decrypt(ciphertext);
      nonce++;

      return plaintext;
    },
  };
}

/** Noise's HKDF: two or three outputs chained from one HMAC-SHA256 key. */
function deriveKeys(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array) {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const first = hmac(sha256, tempKey, new Uint8Array([1]));
  const second = hmac(sha256, tempKey, concatBytes(first, new Uint8Array([2])));

  return [first, second] as const;
}

function createSymmetricState(prologue: Uint8Array) {
  let handshakeHash = PROTOCOL_NAME;
  let chainingKey = handshakeHash;
  let cipher = createCipherState(null);

  function mixHash(data: Uint8Array) {
    handshakeHash = sha256(concatBytes(handshakeHash, data));
  }

  mixHash(prologue);

  return {
    mixHash,
    mixKey(inputKeyMaterial: Uint8Array) {
      const [nextChainingKey, key] = deriveKeys(chainingKey, inputKeyMaterial);
      chainingKey = nextChainingKey;
      cipher = createCipherState(key);
    },
    encryptAndHash(plaintext: Uint8Array) {
      const ciphertext = cipher.encrypt(handshakeHash, plaintext);
      mixHash(ciphertext);

      return ciphertext;
    },
    decryptAndHash(ciphertext: Uint8Array) {
      const plaintext = cipher.decrypt(handshakeHash, ciphertext);
      mixHash(ciphertext);

      return plaintext;
    },
    /** Keys for initiator → responder and responder → initiator, in that order. */
    split() {
      const [initiatorToResponder, responderToInitiator] = deriveKeys(
        chainingKey,
        new Uint8Array(),
      );

      return { initiatorToResponder, responderToInitiator, handshakeHash };
    },
  };
}

/** The encrypted pipe a finished handshake leaves both sides with. */
export interface TransportSession {
  readonly handshakeHash: Uint8Array;
  /** Backed by a plain `ArrayBuffer`, which `WebSocket.send` requires. */
  encrypt(plaintext: Uint8Array): Uint8Array<ArrayBuffer>;
  decrypt(ciphertext: Uint8Array): Uint8Array;
}

function createTransportSession(
  sendKey: Uint8Array,
  receiveKey: Uint8Array,
  handshakeHash: Uint8Array,
) {
  const sending = createCipherState(sendKey);
  const receiving = createCipherState(receiveKey);
  const empty = new Uint8Array();

  return {
    handshakeHash,
    encrypt(plaintext: Uint8Array) {
      if (plaintext.length + TAG_BYTES > MAX_NOISE_MESSAGE_BYTES)
        throw new Error("Noise message too long");

      // A copy, typed as the plain `ArrayBuffer` the cipher always returns once keyed.
      return new Uint8Array(sending.encrypt(empty, plaintext));
    },
    decrypt: (ciphertext: Uint8Array) => receiving.decrypt(empty, ciphertext),
  } satisfies TransportSession;
}

function dh(keyPair: KeyPair, publicKey: Uint8Array) {
  return x25519.getSharedSecret(keyPair.secretKey, publicKey);
}

/** The phone's side of Noise IK: it already knows the host's static key from pairing. */
export function createInitiatorHandshake(options: {
  readonly staticKeyPair: KeyPair;
  readonly remoteStaticPublicKey: Uint8Array;
  readonly prologue: Uint8Array;
  readonly ephemeralKeyPair?: KeyPair;
}) {
  const state = createSymmetricState(options.prologue);
  const ephemeral = options.ephemeralKeyPair ?? generateKeyPair();

  state.mixHash(options.remoteStaticPublicKey);

  return {
    writeFirstMessage(payload: Uint8Array) {
      state.mixHash(ephemeral.publicKey);
      state.mixKey(dh(ephemeral, options.remoteStaticPublicKey));
      const encryptedStatic = state.encryptAndHash(options.staticKeyPair.publicKey);
      state.mixKey(dh(options.staticKeyPair, options.remoteStaticPublicKey));

      return concatBytes(ephemeral.publicKey, encryptedStatic, state.encryptAndHash(payload));
    },
    readSecondMessage(message: Uint8Array) {
      if (message.length < KEY_BYTES + TAG_BYTES)
        throw new Error("Noise handshake message too short");

      const remoteEphemeral = message.subarray(0, KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(dh(ephemeral, remoteEphemeral));
      state.mixKey(dh(options.staticKeyPair, remoteEphemeral));
      const payload = state.decryptAndHash(message.subarray(KEY_BYTES));
      const keys = state.split();

      return {
        payload,
        session: createTransportSession(
          keys.initiatorToResponder,
          keys.responderToInitiator,
          keys.handshakeHash,
        ),
      };
    },
  };
}

/** The host's side of Noise IK: it learns the phone's static key from the first message. */
export function createResponderHandshake(options: {
  readonly staticKeyPair: KeyPair;
  readonly prologue: Uint8Array;
  readonly ephemeralKeyPair?: KeyPair;
}) {
  const state = createSymmetricState(options.prologue);
  const ephemeral = options.ephemeralKeyPair ?? generateKeyPair();
  let remoteEphemeral: Uint8Array | null = null;
  let remoteStatic: Uint8Array | null = null;

  state.mixHash(options.staticKeyPair.publicKey);

  return {
    readFirstMessage(message: Uint8Array) {
      if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES)
        throw new Error("Noise handshake message too short");

      remoteEphemeral = message.slice(0, KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(dh(options.staticKeyPair, remoteEphemeral));
      remoteStatic = state.decryptAndHash(message.subarray(KEY_BYTES, KEY_BYTES * 2 + TAG_BYTES));
      state.mixKey(dh(options.staticKeyPair, remoteStatic));

      return {
        payload: state.decryptAndHash(message.subarray(KEY_BYTES * 2 + TAG_BYTES)),
        remoteStaticPublicKey: remoteStatic,
      };
    },
    writeSecondMessage(payload: Uint8Array) {
      if (!remoteEphemeral || !remoteStatic) throw new Error("Noise first message not read yet");

      state.mixHash(ephemeral.publicKey);
      state.mixKey(dh(ephemeral, remoteEphemeral));
      state.mixKey(dh(ephemeral, remoteStatic));
      const message = concatBytes(ephemeral.publicKey, state.encryptAndHash(payload));
      const keys = state.split();

      return {
        message,
        session: createTransportSession(
          keys.responderToInitiator,
          keys.initiatorToResponder,
          keys.handshakeHash,
        ),
      };
    },
  };
}
