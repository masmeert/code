import { getRandomValues, randomUUID } from "expo-crypto";

// Hermes has no Web Crypto: message ids and the shared transcript reducer use randomUUID, and the
// relay's encryption draws its keys from getRandomValues.
if (!globalThis.crypto?.randomUUID || !globalThis.crypto?.getRandomValues)
  Object.assign(globalThis, { crypto: { ...globalThis.crypto, randomUUID, getRandomValues } });

// React Native has EventTarget and Event but no MessageEvent, which partysocket passes messages in.
if (!globalThis.MessageEvent)
  Object.assign(globalThis, {
    MessageEvent: class MessageEvent extends Event {
      readonly data: string;

      constructor(type: string, init: { data: string }) {
        super(type);
        this.data = init.data;
      }
    },
  });
