/**
 * Between the relay and a host, phone traffic is binary envelopes: a 4-byte channel id, then the
 * phone's bytes untouched. Control messages are JSON text (`RelayControl` in contracts).
 */
export function sealEnvelope(channel: number, payload: Uint8Array) {
  const envelope = new Uint8Array(4 + payload.length);
  new DataView(envelope.buffer).setUint32(0, channel);
  envelope.set(payload, 4);

  return envelope;
}

/** Null for bytes too short to carry a channel id. */
export function openEnvelope(envelope: Uint8Array) {
  if (envelope.length < 4) return null;

  return {
    channel: new DataView(envelope.buffer, envelope.byteOffset).getUint32(0),
    payload: envelope.subarray(4),
  };
}
