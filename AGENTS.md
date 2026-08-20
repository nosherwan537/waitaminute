# AGENTS.md

Operating manual for any agent (or human) working in this repo. Read this before
touching code. `PLAN.md` is the product spec; this file is the engineering contract.

## What this is

A Chrome MV3 extension. Press a hotkey while watching a video; the last 60 seconds of
what was said becomes a note. It is a **time machine with a cleanup pass**, not a
summarizer. The video never stops and the user never leaves the tab — that premise
constrains almost every design decision below.

## Layout

```
src/
  types.ts              shared types + the WINDOWS table (single source of hotkey offsets)
  lib/slice.ts          PURE. slice(), evictOldCues(), formatTimestamp(), deepLink()
  lib/errors.ts         NamedError + the PLAN.md error registry names
  lib/notegen.ts        PURE prompt building + reply parsing, plus the thin call shell
  lib/providers/        model routing: 3 adapters, N presets (see below)
  content/interceptor.ts   MAIN world. Patches fetch/XHR. SECURITY-CRITICAL.
  content/content-script.ts ISOLATED world. Owns the cue list, talks to the SW.
  content/toast.ts      the entire product UI. Shadow DOM, never steals focus.
  background/service-worker.ts  stateless. The ONLY place secrets may live.
  options/              key entry + capture counts
scripts/build.mjs       one Rollup build per MV3 execution context (see its header)
test/                   vitest, no DOM, no network
public/manifest.json    the manifest. dist/ is generated — never edit dist/ by hand.
```

## The four execution contexts

MV3 splits code across contexts with different privileges. Getting this wrong is how
extensions leak credentials. Memorize the table:

| Context | Shares JS with page? | May hold secrets? | Lifetime |
|---|---|---|---|
| MAIN world (`interceptor.ts`) | **yes** | **never** | tab |
| ISOLATED world (`content-script.ts`) | no | no | tab |
| Service worker | no | **yes, only here** | ~30s idle, then killed |
| Options page | no | yes (writes to `storage.local`) | while open |

The service worker is killed aggressively, so it holds nothing that must survive. The
cue list lives in the content script for exactly that reason.

## Non-negotiable rules

1. **No secret ever reaches the MAIN world.** No API key, OAuth token, or user data in
   `interceptor.ts` or anything it imports. Any script on YouTube can read that context.
2. **The interceptor allowlists.** It only retains responses whose URL matches the
   timedtext pattern. Never convert this to a blocklist — the page carries the user's
   Google session cookies.
3. **`chrome.storage.local`, never `.sync`.** The key must not leave the device.
4. **OAuth scopes stay `documents` + `drive.file`.** Never full `drive`.
5. **The toast never takes focus.** No button, no input, no `autofocus`, no `tabindex`.
   Stealing focus breaks spacebar-to-pause, which is a P0 bug for this product.
6. **Zero silent failures.** Every failure path maps to a named error in the PLAN.md
   error registry and produces a readable toast.
7. **`dist/` is generated.** Edit `src/`, run `npm run build`.
8. **`slice()` stays pure.** No I/O, no `chrome.*`, no DOM. It carries the test coverage
   for all three hotkeys at once; that only works while it stays testable in isolation.

## Adding a hotkey

Three coordinated edits, in this order:

1. `src/types.ts` — add the entry to `WINDOWS` (`back` = seconds behind the playhead
   where the window ends; `length` = window length).
2. `public/manifest.json` — add the `commands` entry with a suggested key.
3. `src/background/service-worker.ts` — extend `isCommand()`.

No new slicing logic should be needed. If you find yourself writing some, the `WindowSpec`
abstraction is wrong and that is the thing to fix.

## Adding a model provider

Almost always a **row in `src/lib/providers/presets.ts`** and nothing else. If
the service speaks the OpenAI `/chat/completions` shape — most do, including
OpenRouter, Groq, Together, DeepSeek, Ollama and LM Studio — point the row at
the `openai-compatible` adapter and you are done. Add the origin to
`optional_host_permissions` in the manifest so it can be requested at runtime.

Write a new adapter only for a genuinely different wire format. An adapter is
three pure functions (`buildRequest`, `extractText`, `extractUsage`); the fetch,
the retry policy, and the HTTP-status-to-named-error mapping live once in
`providers/index.ts` and must stay there — duplicating them is how a 429 starts
behaving differently depending on who returned it.

`extractUsage` **must not throw and must not guess**. Return `undefined` when the
provider said nothing about tokens, and use `usageFrom` so a half-reported usage
block is rejected rather than priced as zero. A missing number reads as unknown;
a wrong one silently misreports what the user spent. Watch for providers that
report thinking tokens separately from response tokens (Gemini does, Anthropic
does not) — both are billed as output.

Model names in presets are **starting points, always editable in the UI**. They
change faster than this extension ships, and a stale default must never become a
dead end for the user.

## Google Docs setup (one time, per machine)

The OAuth client ID is personal and is NOT in git. Without it the extension
builds and runs fine — Docs is simply off and notes stay in the local .md.

1. Google Cloud console → new project → enable the **Google Docs API** and the
   **Google Drive API**.
2. OAuth consent screen → External → add yourself as a test user. Scopes:
   `documents` and `drive.file`, nothing wider.
3. Credentials → Create OAuth client ID → **Chrome Extension**. It asks for the
   extension ID, so load `dist/` unpacked first and copy the ID it gets.
4. Write `oauth.local.json` in the repo root (gitignored):

   ```json
   { "clientId": "….apps.googleusercontent.com", "key": "<optional>" }
   ```

   `key` is the `key` field from a packed manifest. Set it if the extension ID
   changes across reloads — `getAuthToken` needs a stable ID, and a changed one
   makes Google reject the client.
5. `npm run build`. It prints `oauth -> client id injected`.

`getAuthToken` is used rather than `launchWebAuthFlow` because the registry
promises a transparent token refresh, and the implicit flow has no refresh token
— it would mean a consent popup every hour, mid-video. Do not swap this without
solving that.

## The capture log

`src/lib/capture-log.ts` records **every** hotkey press, successes and failures
alike, and the failure rows are the valuable ones: `NothingToNote` is how you
tell whether the prompt declines ad breaks or confabulates through them, and
`ModelNotFound` is how you learn a preset's default model name went stale. Any
new failure path must reach `logCapture` in the service worker — a path that
throws without logging is invisible during dogfooding.

Cost is computed from **user-supplied rates**, never a built-in price table.
Prices drift as fast as model names, but a stale model name fails loudly while a
stale price reports a confident wrong number. Tokens come off the wire and are
always true; the dollar conversion is the user's own.

Telemetry may never fail a capture: `appendLog` swallows its own errors on
purpose.

## Adding a caption source (new platform)

**Usually you do not need to.** `content/track-source.ts` reads the standard
`TextTrack` API and covers any site whose player uses ordinary `<track>`
captions. The user adds the site in options; it is registered at runtime by
`background/site-registry.ts`. No code.

Write a real source only for a platform that hides captions behind an internal
API, as YouTube does. It must emit `TranscriptSlice` unchanged so nothing
downstream learns which platform it came from. A MAIN-world interceptor also
needs a static `content_scripts` match pair and `host_permissions`.

In `track-source.ts`, never set `track.mode = "showing"` to load cues. That
burns subtitles onto the user's video. `"hidden"` loads them with no display,
and the original mode must be restored afterwards — reading from a page must
not leave it altered.

## The audio path (step 11)

Reached only when captions are unavailable AND the user armed the tab by
clicking the toolbar icon. Four things here are load-bearing:

1. **Capturing tab audio mutes the tab.** `recorder.ts` connects the source to
   `context.destination` FIRST, before the worklet, so no error path can leave a
   user's lecture silent. Never reorder that.
2. **`chrome.tabCapture.capture()` is not available to offscreen documents.**
   The worker calls `getMediaStreamId()`; the offscreen document calls
   `getUserMedia`. `getMediaStreamId` is callback-only and reports failure via
   `runtime.lastError`, so it must be promisified by hand.
3. **`getMediaStreamId` needs a user gesture** — hence the toolbar click. This is
   the registry's `CaptureGestureRequired`.
4. **Exactly one offscreen document may exist per extension.** Audio capture is
   therefore one tab at a time; arming a second tab moves it. Platform limit,
   not a decision.

A PCM ring is used rather than `MediaRecorder` because a timeslice recorder
writes the WebM header into chunk 0 only — a rolling buffer of those chunks
becomes undecodable the moment chunk 0 falls off the back. That failure appears
only after the buffer wraps, which is to say only in real use.

Timestamps from this path are approximate: the ring holds real time, which
tracks the playhead only at 1x with no buffering. `startSec` is not trustworthy
to the second and the deep link is a best effort.

## Commands

```bash
npm run build     # tsc --noEmit, then bundle to dist/
npm run dev       # watch build
npm test          # vitest run
npm run test:watch
```

Load unpacked from `dist/` at `chrome://extensions`.

## Conventions

- TypeScript strict, plus `noUncheckedIndexedAccess`. Index access yields `T | undefined`;
  handle it rather than asserting past it.
- Comments explain **why**, not what. The existing files set the bar — match their density
  and voice. A comment that restates the line below it is noise.
- Errors are named. Reuse the names from the PLAN.md registry verbatim; they are the
  vocabulary shared between code, toasts, and the plan.
- Empty `catch` blocks need a one-line comment saying why swallowing is correct.

## Definition of done for a change

- [ ] `npm test` and `npm run build` both pass
- [ ] No new permission in the manifest without a line in the PR body justifying it
- [ ] New failure paths have a named error and a toast
- [ ] Security rules above re-checked if the diff touches `interceptor.ts`,
      `service-worker.ts`, or `manifest.json`
- [ ] Committed in a small, non-breaking increment
