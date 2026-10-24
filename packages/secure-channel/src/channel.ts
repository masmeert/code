import { concatBytes } from "@noble/hashes/utils.js";
import { MAX_NOISE_MESSAGE_BYTES, type TransportSession } from "./noise.ts";

const TEXT_CONTINUES = 1;
const TEXT_ENDS = 2;
const CLOSE = 3;

/** Room for a record's type byte and Noise's 16-byte tag inside one Noise message. */
const CHUNK_BYTES = MAX_NOISE_MESSAGE_BYTES - 16 - 1;

/** Bigger than any frame MassCode sends (10 MB attachments as base64), small enough not to exhaust a phone. */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

export type ChannelEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

/**
 * Text frames and closes over a Noise session, split to fit Noise's message limit. Any message
 * that fails to open throws, and the channel can't be used after that.
 */
export function createChannel(session: TransportSession) {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  function seal(type: number, body: Uint8Array) {
    return session.encrypt(concatBytes(new Uint8Array([type]), body));
  }

  return {
    sealText(text: string) {
      const bytes = new TextEncoder().encode(text);
      const messages: Array<Uint8Array<ArrayBuffer>> = [];
      let start = 0;

      for (; bytes.length - start > CHUNK_BYTES; start += CHUNK_BYTES)
        messages.push(seal(TEXT_CONTINUES, bytes.subarray(start, start + CHUNK_BYTES)));

      messages.push(seal(TEXT_ENDS, bytes.subarray(start)));

      return messages;
    },
    sealClose(code: number, reason: string) {
      const body = new Uint8Array(2 + reason.length * 3);
      new DataView(body.buffer).setUint16(0, code);
      const { written } = new TextEncoder().encodeInto(reason, body.subarray(2));

      return seal(CLOSE, body.subarray(0, 2 + written));
    },
    /** The event a message completes, or null while a long text is still arriving. */
    open(message: Uint8Array): ChannelEvent | null {
      const record = session.decrypt(message);
      const body = record.subarray(1);

      if (record[0] === CLOSE) {
        if (body.length < 2) throw new Error("Malformed close record");

        return {
          type: "close",
          code: new DataView(body.buffer, body.byteOffset).getUint16(0),
          reason: new TextDecoder().decode(body.subarray(2)),
        };
      }

      if (record[0] !== TEXT_CONTINUES && record[0] !== TEXT_ENDS)
        throw new Error("Unknown record type");

      pendingBytes += body.length;

      if (pendingBytes > MAX_TEXT_BYTES) throw new Error("Text frame too large");

      pending.push(body);

      if (record[0] === TEXT_CONTINUES) return null;

      const text = new TextDecoder().decode(concatBytes(...pending));
      pending = [];
      pendingBytes = 0;

      return { type: "text", text };
    },
  };
}

export type Channel = ReturnType<typeof createChannel>;
