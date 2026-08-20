import { describe, it, expect } from "vitest";
import { PcmRing, resample } from "../src/lib/ring-buffer";
import { encodeWav, toInt16 } from "../src/lib/wav";

/** A ramp, so any index error shows up as a wrong value rather than plausible noise. */
function ramp(from: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => (from + i) / 100000);
}

describe("PcmRing", () => {
  it("reads back what was written before it wraps", () => {
    const ring = new PcmRing(10, 10); // 100 samples
    ring.write(ramp(0, 30));
    expect(Array.from(ring.read(0, 3))).toEqual(Array.from(ramp(0, 30)));
  });

  it("keeps the newest audio once it wraps, and drops the oldest", () => {
    // The failure this guards: reading from a fixed origin after wrapping,
    // which returns the oldest window forever while the video moves on.
    const ring = new PcmRing(10, 10); // 100 samples
    ring.write(ramp(0, 150));
    const last = ring.read(0, 10);
    expect(last).toHaveLength(100);
    expect(Array.from(last)).toEqual(Array.from(ramp(50, 100)));
  });

  it("honours the back offset, which is what the previous-60s hotkey needs", () => {
    const ring = new PcmRing(10, 10);
    ring.write(ramp(0, 100));
    // Skip the last 30 samples, take the 30 before them.
    expect(Array.from(ring.read(3, 3))).toEqual(Array.from(ramp(40, 30)));
  });

  it("clamps a window longer than the audio so far instead of failing", () => {
    // Pressing the hotkey ten seconds into a lecture is normal.
    const ring = new PcmRing(10, 60);
    ring.write(ramp(0, 25));
    expect(ring.read(0, 60)).toHaveLength(25);
  });

  it("returns nothing when the window lies entirely before the audio", () => {
    const ring = new PcmRing(10, 10);
    ring.write(ramp(0, 20));
    expect(ring.read(30, 5)).toHaveLength(0);
  });

  it("returns nothing when nothing has been written", () => {
    expect(new PcmRing(10, 10).read(0, 5)).toHaveLength(0);
  });

  it("keeps the tail when a single chunk is larger than the whole ring", () => {
    // A slow worklet callback can deliver more than the ring holds. Copying the
    // front first would overwrite the newest audio with the oldest.
    const ring = new PcmRing(10, 10);
    ring.write(ramp(0, 250));
    expect(Array.from(ring.read(0, 10))).toEqual(Array.from(ramp(150, 100)));
  });

  it("survives chunk sizes that do not divide the capacity", () => {
    const ring = new PcmRing(10, 10);
    for (let i = 0; i < 20; i += 1) ring.write(ramp(i * 7, 7));
    expect(Array.from(ring.read(0, 10))).toEqual(Array.from(ramp(40, 100)));
  });

  it("reports how much audio it holds, capped at capacity", () => {
    const ring = new PcmRing(10, 10);
    expect(ring.seconds).toBe(0);
    ring.write(ramp(0, 50));
    expect(ring.seconds).toBe(5);
    ring.write(ramp(0, 500));
    expect(ring.seconds).toBe(10);
  });

  it("clears back to empty", () => {
    const ring = new PcmRing(10, 10);
    ring.write(ramp(0, 50));
    ring.clear();
    expect(ring.available).toBe(0);
    expect(ring.read(0, 10)).toHaveLength(0);
  });
});

describe("resample", () => {
  it("returns the input untouched when the rates match", () => {
    const input = ramp(0, 10);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("shortens by the rate ratio", () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
  });

  it("preserves a constant signal exactly", () => {
    // Interpolation between equal neighbours must not drift.
    const flat = new Float32Array(4800).fill(0.5);
    const out = resample(flat, 48000, 16000);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it("never reads past the end of the input", () => {
    expect(() => resample(ramp(0, 7), 48000, 16000)).not.toThrow();
  });

  it("handles empty input", () => {
    expect(resample(new Float32Array(0), 48000, 16000)).toHaveLength(0);
  });
});

describe("toInt16", () => {
  it("clamps rather than wrapping, so a hot sample is not heard as a click", () => {
    // The failure this guards: 1.5 * 0x7fff overflows to a large negative value.
    expect(toInt16(Float32Array.from([1.5]))[0]).toBe(32767);
    expect(toInt16(Float32Array.from([-1.5]))[0]).toBe(-32768);
  });

  it("maps the full-scale endpoints correctly", () => {
    expect(Array.from(toInt16(Float32Array.from([0, 1, -1])))).toEqual([0, 32767, -32768]);
  });
});

describe("encodeWav", () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5]), 16000);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, n: number) =>
    String.fromCharCode(...Array.from(wav.subarray(at, at + n)));

  it("writes the RIFF/WAVE/fmt/data chunk markers", () => {
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
  });

  it("writes the RIFF size as everything AFTER that field, not the file length", () => {
    // The single most common WAV bug. Players read it and truncate or overrun.
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
  });

  it("declares mono 16-bit PCM at the given rate", () => {
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits
  });

  it("derives byte rate and block align from the format, not from constants", () => {
    expect(view.getUint32(28, true)).toBe(16000 * 2);
    expect(view.getUint16(32, true)).toBe(2);
  });

  it("writes the data size in bytes, not in samples", () => {
    expect(view.getUint32(40, true)).toBe(4 * 2);
    expect(wav.length).toBe(44 + 8);
  });

  it("writes samples little-endian regardless of host byte order", () => {
    // 32767 little-endian is FF 7F. Big-endian would be 7F FF and transcribe
    // as noise with no error anywhere.
    expect(wav[44 + 2]).toBe(0xff);
    expect(wav[44 + 3]).toBe(0x7f);
  });

  it("encodes an empty window as a valid, empty file", () => {
    const empty = encodeWav(new Float32Array(0), 16000);
    expect(empty.length).toBe(44);
    expect(new DataView(empty.buffer).getUint32(40, true)).toBe(0);
  });
});
