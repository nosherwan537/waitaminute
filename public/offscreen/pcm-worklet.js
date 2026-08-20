/**
 * AudioWorklet processor: hands raw mono PCM back to the offscreen document.
 *
 * Runs on the audio thread, so it must do almost nothing. Two rules:
 *
 *   1. Return true, always. Returning false tears the node down permanently and
 *      the tab goes quiet with no error anywhere.
 *   2. Batch before posting. `process` is called every 128 frames — 375 times a
 *      second at 48 kHz. Posting each one floods the message port and shows up
 *      as audio glitching, which is the exact failure this feature must not have.
 *
 * Not bundled: AudioWorklet code is loaded by URL into a separate global scope
 * and cannot be an ES module import.
 */
const BATCH = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const room = BATCH - this.filled;
      const take = Math.min(room, channel.length - offset);
      this.batch.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === BATCH) {
        // Transfer rather than copy: this runs on the audio thread and a
        // structured clone of 16KB, 12 times a second, is not free.
        const out = this.batch;
        this.port.postMessage(out, [out.buffer]);
        this.batch = new Float32Array(BATCH);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
