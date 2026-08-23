# Hey Buddy, Note This — Execution Plan

Revised 2026-08-15 after `/office-hours` + `/plan-ceo-review` (SELECTIVE EXPANSION).
Supersedes `~/Downloads/project-plan-video-notetaker.md`, which stays as the original.

---

## What this is

Press one key while watching a video. Never pause, never switch tabs, never lose your
place. A note lands in your Google Doc with the speaker's actual words, a takeaway line
on top, and a deep-link back to the exact moment.

**The reframe:** the original plan said the hard part was getting a model to infer what
the speaker emphasized. It isn't. You already know what mattered — you pressed the key.
What you lose is the phrasing, in the seconds it takes to reach the keyboard. This is a
**time machine with a cleanup pass**, not a summarizer with a hotkey.

## Premises

1. You are user #1. Success = two weeks of real studying where you stop scrubbing back.
2. Core value is retroactive capture, not AI insight. The hotkey is the relevance signal.
3. Note format: takeaway on top, cleaned transcript below. Self-correcting — a wrong
   takeaway is survivable because the source sits right under it.
4. Google Docs is the destination. OAuth cost accepted.
5. Frame/OCR capture is optional and cuttable. Not load-bearing.
6. The riskiest engineering is the audio path, not the AI.
7. **The video never stops and you never leave the tab.** Therefore: tab-mute is P0, the
   toast never steals focus, OAuth never pops mid-capture, and **latency barely matters**
   (you pressed and kept watching — 8-12s is fine).

## Architecture

```
  ┌─────────────────────── PAGE (MAIN world) ───────────────────────┐
  │  interceptor.ts   patches fetch/XHR before the player boots      │
  │                   ALLOWLIST timedtext URLs only. NEVER holds     │
  │                   the API key. Shares context with page JS.      │
  └───────┬──────────────────────────────────────────────────────────┘
          │ window.postMessage
  ┌───────▼──────────── CONTENT SCRIPT (ISOLATED) ───────────────────┐
  │  content.ts       owns the cue list (30-min rolling cap),        │
  │                   reads <video>.currentTime, renders the toast   │
  └───────┬──────────────────────────────────────────────────────────┘
          │ chrome.runtime.sendMessage { cues, currentTime, window }
  ┌───────▼──────────── SERVICE WORKER (stateless) ──────────────────┐
  │  slice(cues, t, window) ──▶ noteGen ──▶ Anthropic (user's key)   │
  │                                  ├──▶ GoogleDocsSink  (canonical)│
  │                                  └──▶ LocalMdSink     (safety net)│
  └──────────────────────────────────────────────────────────────────┘

  PHASE 7+ audio fallback, same TranscriptSlice shape:
    SW: getMediaStreamId()  →  OFFSCREEN: getUserMedia(streamId)
                                   ├──▶ ctx.destination  ◀── P0 KEEPS TAB AUDIBLE
                                   └──▶ AudioWorklet → Float32 ring → WAV → Whisper
```

The one abstraction that matters:

```ts
interface TranscriptSource {
  isAvailable(): boolean
  getSlice(currentTime: number, window: WindowSpec): Promise<TranscriptSlice>
}
// CaptionSource ships first (~50ms, free). AudioSource ships second.
// Identical output shape, so everything downstream is written once.
```

## Build order

Each step must work before the next one starts.

**1. Scaffold** — MV3 + TS + Vite. Hotkey fires a `console.log`. Loads unpacked.

**2. CaptionSource for YouTube** — MAIN-world interceptor grabs the timedtext payload,
posts cues to the content script. Hotkey dumps the last 60s of text to console.
*This is the moment the idea becomes real. Do not proceed until it works.*

**3. `slice()` + its tests** — pure function, no I/O, all three hotkeys depend on it.
Test: normal, clamped at video start, empty, spanning a caption gap, unordered cues,
3-min window on a 90s video. 20 minutes of work that de-risks every hotkey at once.

**4. noteGen** — transcript slice in, `{takeaway, cleaned}` out. Must be allowed to
return `takeaway: null`. Iterate against 5-6 real slices including a deliberately empty
one. Snapshot the outputs so you can tell whether a prompt edit helped or just changed
things.

**5. LocalMdSink** — write the note to disk. Full loop working, zero OAuth. You can
start using the tool here.

**6. GoogleDocsSink** — `chrome.identity`, scopes `documents` + `drive.file` (never full
`drive`). Doc create/append with the deep-link heading. Budget real time for the Google
Cloud consent screen; it's tedious and unskippable.

**7. Three hotkeys** — last 60s, previous 60s, last 3 min. Same code path, different
offsets into the cue list you already hold.

**8. Toast + every error state** — see the registry below. Non-focus-stealing, near the
player, never covering controls. Success auto-dismisses in ~2s; errors stay until
dismissed. Shows today's capture count.

**9. Options page** — masked key, Google connect, target doc, measured per-note cost,
and a log of the last 50 captures (timestamp, source, latency, cost, outcome). That log
is your dogfooding instrument.

**10. Second platform CaptionSource** — proves the abstraction isn't YouTube-shaped.

**11. AudioSource** — offscreen doc, `getMediaStreamId()` in the SW, `getUserMedia` in
the offscreen doc. **Wire the AudioContext re-pipe FIRST** so the tab keeps its sound,
then build the PCM ring buffer. All of premise 6's pain lives here, on purpose, isolated.

**12. Frame capture (optional)** — ~~canvas snapshot~~ as supporting context. Cut it without
regret if canvas tainting fights back.

**BUILT 2026-08-22, and canvas tainting did fight back exactly as predicted.** A
cross-origin video stream taints any canvas it is drawn onto, so `toDataURL` throws on
every real player. Rather than cut, the capture moved to `chrome.tabs.captureVisibleTab`
— which sidesteps tainting but photographs the whole viewport, so `lib/frame.ts` crops
back to the player and refuses to send anything it cannot confine. Off by default,
`activeTab` only (never `<all_urls>`), and it can never cost a note: the capture cannot throw, and a
provider that rejects the image gets asked again without it.

**13. Dogfood two weeks** — did you stop scrubbing back? What broke? What felt slow?

**14. Ship** — README, demo GIF, MIT, Chrome Web Store.

## Error registry — zero silent failures

```
 NAMED ERROR             | ACTION                      | USER SEES
 ------------------------|-----------------------------|---------------------------
 PageNeedsReload         | badge the toolbar icon      | (badge: reload this page)
 CaptionsUnavailable     | fall through to AudioSource | "No captions on this video"
 InterceptorTooLate      | re-request track            | (silent retry)
 EmptySlice              | abort BEFORE spending money | "Nothing said in that window"
 ApiKeyMissing/Invalid   | open options                | "Add / check your API key"
 RateLimited             | backoff 2s/4s, 2 retries    | "Rate limited, retrying..."
 ProviderUnavailable     | backoff, 2 retries          | "Provider down, retrying..."
 NetworkUnavailable      | queue to storage, replay    | "Offline — note queued"
 ProviderTimeout         | abort at 45s, NO retry      | "<model> didn't respond — try again"
 MalformedNoteResponse   | 1 retry, then raw fallback  | "Saved transcript only"
 NothingToNote           | write NOTHING at all        | "Nothing worth noting there"
 NotAuthorized           | open options                | "Connect Google to save notes"
 TokenExpired            | silent refresh + retry      | (transparent)
 AuthCancelled           | local .md only, keep going  | "Saved locally"
 DocMissing              | recreate, note the swap     | "Doc was gone — made a new one"
 DocsQuotaExceeded       | local .md only              | "Quota hit — saved locally"
 DocsWriteFailed         | local .md only              | "Couldn't write to your doc"
 LocalWriteFailed        | Docs only, warn once        | "Couldn't write local copy"
 OrphanedCapture         | replay from storage on boot | "Recovered 1 pending note"
 TabCaptureUnavailable   | disable on this site        | "Audio blocked here (DRM)"
 CaptureGestureRequired  | prompt via toolbar click    | "Click the icon once to enable"
```

**`NothingToNote` is the most important row.** You will press the hotkey during ads,
tangents, and dead air. If the prompt can't return null, the model confabulates a
takeaway from nothing and your doc fills with garbage. A doc you don't trust is a doc
you stop reading. This is the failure mode that kills the product quietly.

## Security rules

1. **The API key never enters the MAIN world.** MAIN shares a JS context with the page —
   any script on the site can read your globals. Interceptor handles caption text only;
   the key lives in the service worker.
2. **The interceptor allowlists, never blocklists.** It's wrapping `fetch` on a page
   carrying your Google session cookies. Retain a response only if the URL matches the
   timedtext pattern. Everything else passes through unread.
3. **OAuth scope is `documents` + `drive.file`.** Never full `drive`.
4. **Key in `chrome.storage.local`, never `.sync`.** It must not leave the device.
5. Prompt injection via caption text is possible but low-stakes (worst case: a junk
   note). Delimit the transcript and label it as data. Don't over-engineer it.

## Corrections to the original plan

1. `chrome.tabCapture.capture()` is **not exposed to offscreen documents**. Use
   `getMediaStreamId()` in the SW → `getUserMedia` in the offscreen doc (Chrome 116+).
2. **Capturing tab audio mutes the tab.** Re-pipe via
   `ctx.createMediaStreamSource(stream).connect(ctx.destination)`.
3. **MediaRecorder timeslice writes the WebM header into chunk 0 only** — a naive rolling
   buffer yields an undecodable file. Using a PCM ring buffer instead (exact window,
   always valid, and it unlocks local Whisper later).
4. Latency is not a tight constraint (premise 7). Drop the "under 15s" DoD anxiety.
5. Build order inverted: prove the loop with captions before touching MV3 audio.

## Definition of done for v1

- One keypress. No pause, no tab switch, no lost audio, no lost place.
- Note in the Doc with a working deep-link back to the moment.
- YouTube + one other platform.
- Every failure produces a readable toast. Nothing fails silently.
- **You studied with it for two weeks and stopped scrubbing back.**

## Deferred (TODOS)

- Semantic search / Q&A over accumulated captures (P3, XL)
- Frame + OCR as supporting context (P2, M) — cuttable by design
- Additional platform caption extractors (P2, S each)
- Local/offline STT via whisper.cpp (P3, L) — the PCM ring buffer unlocks it

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Office Hours | `/office-hours` | Problem framing | 1 | CLEAR | Premise rewritten; 1 eureka logged |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | SELECTIVE EXPANSION, 7 proposals, 6 accepted, 1 deferred |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | STILL UNRUN | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not needed (2 UI surfaces) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — | codex not installed |

**BUILD STATUS 2026-08-23:** steps 1–12 and 14 built. Steps 1–9 verified in a real
browser end to end, including Google Docs. **Step 12 (frame capture) is now verified
too** — a capture with the frame toggle on logged a `Frame` dot and input tokens of
1945 against 628 for a caption-only capture on the same video. Steps 10 (generic
TextTrack) and 11 (audio) are written and unit-tested but have never run against a
real video. Step 13 (two weeks of dogfooding) has not started — it is the only
remaining requirement for v1 done.

**Watch item, one sample only:** that frame capture took 29.2s against 5.8s for
caption-only. ~1,300 extra input tokens costs pennies; half a minute between hotkey
and note is a product problem, because premise 7 is that the user never leaves the
tab. Not yet attributed — it could be image encode, model thinking on a larger input,
or ordinary variance. **Do not "fix" it by shrinking `MAX_EDGE_PX`** until it is
measured: the frame's whole job is resolving deixis and garbled jargon off a slide,
and that is exactly what a smaller image stops being able to do.

**UNRESOLVED:** 0
**CRITICAL GAPS:** 0 (the one found — `NothingToNote` undefined — was closed in the error registry)
**VERDICT:** CEO CLEARED — eng review recommended before implementation.
