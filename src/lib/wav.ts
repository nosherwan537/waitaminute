/**
 * Float32 PCM → a 16-bit mono WAV file.
 *
 * Whisper-compatible endpoints accept WAV directly, and encoding one is 40 lines
 * with no dependency — far less risk than shipping an encoder for a compressed
 * format whose bitstream we would then have to get right.
 *
 * Pure: bytes in, bytes out. The header offsets are the whole content of this
 * file, and a wrong one produces a file that uploads fine and transcribes as
 * silence or noise — a failure with no error message anywhere.
 */

const HEADER_BYTES = 44;

/** Pure. Clamp and convert to signed 16-bit. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    // Clamping first matters: a sample above 1.0 would wrap to a large negative
    // value, which is heard as a click rather than as clipping.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = toInt16(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;

  ascii(0, "RIFF");
  // Everything after this field, NOT the whole file. Writing the file length
  // here is the single most common WAV bug.
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");

  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // WAV is little-endian regardless of the host, so this cannot be a bulk copy
  // from the Int16Array's buffer — that would be host-endian.
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(HEADER_BYTES + i * 2, pcm[i]!, true);
  }

  return new Uint8Array(buffer);
}
