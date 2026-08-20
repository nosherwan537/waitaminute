/**
 * A fixed-capacity ring of mono PCM samples.
 *
 * WHY a PCM ring and not MediaRecorder: `MediaRecorder` with a timeslice writes
 * the WebM header into chunk 0 only. A naive rolling buffer of those chunks
 * therefore yields an undecodable file the moment chunk 0 falls off the back —
 * which is exactly what a rolling window does. It works perfectly in testing,
 * for as long as the recording is shorter than the buffer, and then breaks in
 * real use. Raw samples have no header, so any slice of them is valid.
 *
 * It also gives an exact window rather than chunk-aligned approximation, and it
 * is what a local Whisper would want later (PLAN.md's deferred list).
 *
 * Pure and DOM-free so the index arithmetic — the part that is easy to get
 * wrong and silent when wrong — can be tested directly.
 */
export class PcmRing {
  private readonly buffer: Float32Array;
  /** Total samples ever written. Never wraps; the read positions derive from it. */
  private written = 0;

  constructor(
    readonly sampleRate: number,
    readonly capacitySeconds: number,
  ) {
    this.buffer = new Float32Array(Math.max(1, Math.floor(sampleRate * capacitySeconds)));
  }

  get capacitySamples(): number {
    return this.buffer.length;
  }

  /** Samples currently readable — less than capacity until the ring first fills. */
  get available(): number {
    return Math.min(this.written, this.buffer.length);
  }

  get seconds(): number {
    return this.available / this.sampleRate;
  }

  write(chunk: Float32Array): void {
    const capacity = this.buffer.length;

    // A chunk bigger than the whole ring can only leave its tail behind. The
    // dropped samples still have to advance the write position, or the tail
    // lands where the reader does not expect it — the ring and the read origin
    // disagree, and every read after the first oversized chunk is garbage.
    const dropped = Math.max(0, chunk.length - capacity);
    const data = dropped > 0 ? chunk.subarray(dropped) : chunk;

    const start = (this.written + dropped) % capacity;
    const firstPart = Math.min(data.length, capacity - start);
    this.buffer.set(data.subarray(0, firstPart), start);
    if (firstPart < data.length) this.buffer.set(data.subarray(firstPart), 0);
    this.written += chunk.length;
  }

  /**
   * The most recent `length` seconds, ending `back` seconds ago — the same
   * window shape the caption path uses, so the two sources stay interchangeable.
   *
   * Clamps rather than throwing: pressing the hotkey ten seconds into a video is
   * a normal thing to do, and it should yield ten seconds, not an error.
   */
  read(back: number, length: number): Float32Array {
    const total = this.available;
    const endOffset = Math.max(0, Math.floor(back * this.sampleRate));
    const wanted = Math.max(0, Math.floor(length * this.sampleRate));

    const end = total - endOffset;
    const start = Math.max(0, end - wanted);
    if (end <= 0 || end <= start) return new Float32Array(0);

    const out = new Float32Array(end - start);
    // Where sample 0 of the readable region sits in the ring.
    const base = this.written <= this.buffer.length ? 0 : this.written % this.buffer.length;
    for (let i = 0; i < out.length; i += 1) {
      out[i] = this.buffer[(base + start + i) % this.buffer.length]!;
    }
    return out;
  }

  clear(): void {
    this.buffer.fill(0);
    this.written = 0;
  }
}

/**
 * Pure. Cheap linear-interpolation resample.
 *
 * Whisper wants 16 kHz; a tab's AudioContext runs at 44.1 or 48 kHz. Sending the
 * native rate would trip the API's upload limit on a 3-minute window for no
 * benefit — speech recognition gains nothing above 16 kHz.
 *
 * Linear interpolation aliases slightly compared to a windowed-sinc filter. That
 * is inaudible to a speech model and costs a fraction of the code.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    out[i] = input[left]! * (1 - fraction) + input[right]! * fraction;
  }
  return out;
}
