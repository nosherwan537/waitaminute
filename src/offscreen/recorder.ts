import { PcmRing, resample } from "../lib/ring-buffer";
import { encodeWav } from "../lib/wav";

/**
 * Offscreen document: captures tab audio into a rolling PCM ring.
 *
 * This is where all of premise 6's pain lives, isolated on purpose.
 *
 * THE P0 BUG THIS FILE EXISTS TO AVOID: capturing a tab's audio MUTES the tab.
 * The user is watching a lecture; silencing it is the single worst thing this
 * extension could do. The fix is to re-pipe the captured stream back to the
 * context's destination — and it is wired FIRST, before anything else touches
 * the stream, so no error path can leave the tab silent.
 *
 * Also note `chrome.tabCapture.capture()` is NOT available to offscreen
 * documents. The service worker calls `getMediaStreamId()` and this document
 * turns that ID into a stream via `getUserMedia`. Chrome 116+.
 */

/** Whisper wants 16 kHz. Anything above it costs upload size for no accuracy. */
const TARGET_RATE = 16000;

/**
 * 5 minutes. The longest window a hotkey asks for is 3 minutes, and the extra
 * covers `capture-previous` plus the seconds the user takes to react.
 * 5 min × 16 kHz × 4 bytes = 19 MB, which is affordable in a document that
 * exists only while recording.
 */
const CAPACITY_SECONDS = 300;

let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let ring: PcmRing | undefined;

async function start(streamId: string): Promise<void> {
  await stop();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  } as MediaStreamConstraints);

  context = new AudioContext();
  const source = context.createMediaStreamSource(stream);

  // ── FIRST, ALWAYS ──────────────────────────────────────────────────────────
  // Give the tab its sound back before doing anything that can fail. If the
  // worklet below throws, the user still hears their video.
  source.connect(context.destination);
  // ───────────────────────────────────────────────────────────────────────────

  ring = new PcmRing(TARGET_RATE, CAPACITY_SECONDS);
  const sourceRate = context.sampleRate;

  await context.audioWorklet.addModule(chrome.runtime.getURL("offscreen/pcm-worklet.js"));
  const capture = new AudioWorkletNode(context, "pcm-capture");
  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    ring?.write(resample(event.data, sourceRate, TARGET_RATE));
  };

  // The worklet is connected to the source but NOT to the destination: it is a
  // tap, not a second playback path. Connecting it to destination would double
  // the audio and put a 4096-sample delay on the copy.
  source.connect(capture);
}

async function stop(): Promise<void> {
  stream?.getTracks().forEach((track) => track.stop());
  await context?.close().catch(() => {});
  stream = undefined;
  context = undefined;
  ring = undefined;
}

/** Base64 rather than a Blob: the service worker has no URL.createObjectURL. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type Request =
  | { kind: "audio-start"; streamId: string }
  | { kind: "audio-stop" }
  | { kind: "audio-slice"; back: number; length: number }
  | { kind: "audio-status" };

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  if (!message?.kind?.startsWith("audio-")) return;

  void (async () => {
    try {
      switch (message.kind) {
        case "audio-start":
          await start(message.streamId);
          return sendResponse({ ok: true });
        case "audio-stop":
          await stop();
          return sendResponse({ ok: true });
        case "audio-status":
          return sendResponse({ ok: true, recording: Boolean(ring), seconds: ring?.seconds ?? 0 });
        case "audio-slice": {
          if (!ring) return sendResponse({ ok: false, reason: "TabCaptureUnavailable" });
          const samples = ring.read(message.back, message.length);
          if (samples.length === 0) return sendResponse({ ok: false, reason: "EmptySlice" });
          return sendResponse({
            ok: true,
            wavBase64: toBase64(encodeWav(samples, TARGET_RATE)),
            seconds: samples.length / TARGET_RATE,
          });
        }
      }
    } catch (cause) {
      console.error("[waitaminute] offscreen", cause);
      // A failed START must not leave a half-built graph muting the tab.
      if (message.kind === "audio-start") await stop();
      sendResponse({ ok: false, reason: String(cause) });
    }
  })();

  return true;
});

console.debug("[waitaminute] offscreen recorder ready");
