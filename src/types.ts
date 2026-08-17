/** A single caption cue, times in seconds relative to the start of the video. */
export interface Cue {
  start: number;
  dur: number;
  text: string;
}

/**
 * Which slice of the transcript a hotkey asks for, expressed relative to the
 * playhead. `back` is how far behind the playhead the window ENDS.
 *
 *   playhead ──┐
 *              ▼
 *   ...────────┤   capture-now:      back=0,  length=60
 *   ...──┤         capture-previous: back=60, length=60
 *   ...────────┤   capture-long:     back=0,  length=180
 */
export interface WindowSpec {
  /** Seconds behind the playhead where the window ends. */
  back: number;
  /** Window length in seconds. */
  length: number;
}

export const WINDOWS = {
  "capture-now": { back: 0, length: 60 },
  "capture-previous": { back: 60, length: 60 },
  "capture-long": { back: 0, length: 180 },
} as const satisfies Record<string, WindowSpec>;

export type CommandName = keyof typeof WINDOWS;

/**
 * A resolved chunk of transcript. Both CaptionSource and (later) AudioSource
 * produce exactly this shape, so nothing downstream knows or cares which one
 * it came from.
 */
export interface TranscriptSlice {
  text: string;
  startSec: number;
  endSec: number;
  videoTitle: string;
  videoUrl: string;
  /** Deep-link back to startSec. Turns the notes doc into an index. */
  deepLink: string;
  /**
   * BCP-47 tag of the caption track ("en", "es", "hi"). Drives whether the note
   * gets an English translation alongside the speaker's actual words.
   */
  language?: string;
  /** Human-readable track name ("Spanish"), for the note heading. */
  languageName?: string;
}

/** Messages the MAIN-world interceptor posts to the isolated content script. */
export type InterceptorMessage = {
  source: "heystop";
  kind: "cues";
  cues: Cue[];
};

/** Messages the content script sends to the service worker. */
export type CaptureRequest = {
  kind: "capture";
  command: CommandName;
  slice: TranscriptSlice;
};

/** Messages the service worker sends back to the content script. */
export type ToastMessage = {
  kind: "toast";
  state: "processing" | "success" | "error" | "info";
  text: string;
  /** Captures completed today, shown on success. */
  count?: number;
};
