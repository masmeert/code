/**
 * serve-sim encodes without frame reordering, but its fallback encoder leaves the SPS VUI out.
 * Chromium's hardware decoder then assumes a large reorder queue and holds frames back for
 * seconds, `optimizeForLatency` or not. Ported from t3code's avcConfig.ts (MIT).
 */

function encodeExpGolomb(value: number) {
  const bits = (value + 1).toString(2);

  return "0".repeat(bits.length - 1) + bits;
}

/** The SPS with VUI defaults and `max_num_reorder_frames = 0`, or unchanged if its layout is unexpected. */
function addReorderLimits(sequenceParameterSet: Uint8Array): Uint8Array {
  if (
    sequenceParameterSet.length < 4 ||
    sequenceParameterSet.length > 4096 ||
    ((sequenceParameterSet[0] ?? 0) & 0x9f) !== 7
  )
    return sequenceParameterSet;

  const payload: number[] = [];
  let zeroRun = 0;

  for (let index = 1; index < sequenceParameterSet.length; index++) {
    const byte = sequenceParameterSet[index] ?? 0;

    if (zeroRun >= 2 && byte === 3) {
      if (index + 1 >= sequenceParameterSet.length || (sequenceParameterSet[index + 1] ?? 0) > 3)
        return sequenceParameterSet;

      zeroRun = 0;
      continue;
    }

    payload.push(byte);
    zeroRun = byte === 0 ? zeroRun + 1 : 0;
  }

  const bits = payload.map((byte) => byte.toString(2).padStart(8, "0")).join("");
  let position = 0;

  function readBits(count: number) {
    if (position + count > bits.length) throw new Error("Truncated H.264 SPS");

    const value = Number.parseInt(bits.slice(position, position + count), 2);
    position += count;

    return value;
  }

  function readExpGolomb() {
    let leadingZeros = 0;

    while (readBits(1) === 0) {
      if (++leadingZeros > 31) throw new Error("Invalid H.264 Exp-Golomb value");
    }

    return 2 ** leadingZeros - 1 + (leadingZeros === 0 ? 0 : readBits(leadingZeros));
  }

  try {
    // Only the hub's 8-bit 4:2:0 High profile without scaling lists; other layouts pass through.
    if (readBits(8) !== 100) return sequenceParameterSet;

    readBits(16);

    if (readExpGolomb() > 31 || readExpGolomb() !== 1) return sequenceParameterSet;

    if (readExpGolomb() !== 0 || readExpGolomb() !== 0) return sequenceParameterSet;

    readBits(1);

    if (readBits(1) !== 0) return sequenceParameterSet;

    if (readExpGolomb() > 12) return sequenceParameterSet;

    const pictureOrderCountType = readExpGolomb();

    if (pictureOrderCountType === 0) {
      if (readExpGolomb() > 12) return sequenceParameterSet;
    } else if (pictureOrderCountType === 1) {
      readBits(1);
      readExpGolomb();
      readExpGolomb();

      const cycleLength = readExpGolomb();

      if (cycleLength > 255) return sequenceParameterSet;

      for (let index = 0; index < cycleLength; index++) readExpGolomb();
    } else if (pictureOrderCountType !== 2) return sequenceParameterSet;

    const maxReferenceFrames = readExpGolomb();

    if (maxReferenceFrames > 16) return sequenceParameterSet;

    readBits(1);

    if (readExpGolomb() > 65535 || readExpGolomb() > 65535) return sequenceParameterSet;

    if (readBits(1) === 0) readBits(1);

    readBits(1);

    if (readBits(1) !== 0) {
      for (let index = 0; index < 4; index++) readExpGolomb();
    }

    const vuiPosition = position;

    if (readBits(1) !== 0) return sequenceParameterSet;

    // With no VUI, only rbsp_stop_one_bit and byte padding may follow.
    if (!/^10{0,7}$/.test(bits.slice(position))) return sequenceParameterSet;

    // The flag bits enable VUI, omit its eight optional sections, and enable bitstream
    // restrictions and motion_vectors_over_pic_boundaries_flag.
    const restricted =
      bits.slice(0, vuiPosition) +
      "10000000011" +
      [2, 1, 16, 16, 0, maxReferenceFrames].map(encodeExpGolomb).join("") +
      "1";

    const padded = restricted.padEnd(Math.ceil(restricted.length / 8) * 8, "0");
    const output = [sequenceParameterSet[0] ?? 0];
    zeroRun = 0;

    for (let index = 0; index < padded.length; index += 8) {
      const byte = Number.parseInt(padded.slice(index, index + 8), 2);

      if (zeroRun >= 2 && byte <= 3) {
        output.push(3);
        zeroRun = 0;
      }

      output.push(byte);
      zeroRun = byte === 0 ? zeroRun + 1 : 0;
    }

    return Uint8Array.from(output);
  } catch {
    return sequenceParameterSet;
  }
}

/** The avcC decoder config with reorder limits added to its SPS, or unchanged if it needs none. */
export function addSimulatorReorderLimits(description: Uint8Array): Uint8Array {
  if (description.length < 7 || description.length > 64 * 1024 || description[0] !== 1)
    return description;

  const sequenceParameterSetCount = (description[5] ?? 0) & 0x1f;

  if (sequenceParameterSetCount === 0) return description;

  const parts: Uint8Array[] = [description.subarray(0, 6)];
  let position = 6;
  let isChanged = false;

  for (let index = 0; index < sequenceParameterSetCount; index++) {
    if (position + 2 > description.length) return description;

    const length = (description[position] ?? 0) * 256 + (description[position + 1] ?? 0);
    position += 2;

    if (length === 0 || position + length > description.length) return description;

    const sequenceParameterSet = description.subarray(position, position + length);
    const repaired = addReorderLimits(sequenceParameterSet);
    isChanged ||= repaired !== sequenceParameterSet;
    parts.push(Uint8Array.of(repaired.length >>> 8, repaired.length & 0xff), repaired);
    position += length;
  }

  const pictureParameterSetsStart = position;

  if (position >= description.length) return description;

  const pictureParameterSetCount = description[position++] ?? 0;

  for (let index = 0; index < pictureParameterSetCount; index++) {
    if (position + 2 > description.length) return description;

    const length = (description[position] ?? 0) * 256 + (description[position + 1] ?? 0);
    position += 2;

    if (length === 0 || position + length > description.length) return description;

    position += length;
  }

  if (!isChanged) return description;

  parts.push(description.subarray(pictureParameterSetsStart));

  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  position = 0;

  for (const part of parts) {
    output.set(part, position);
    position += part.length;
  }

  return output;
}
