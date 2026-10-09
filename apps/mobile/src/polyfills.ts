import { randomUUID } from "expo-crypto";

// Hermes has no Web Crypto; message ids and the shared transcript reducer use randomUUID.
if (!globalThis.crypto?.randomUUID)
  Object.assign(globalThis, { crypto: { ...globalThis.crypto, randomUUID } });
