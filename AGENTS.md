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

## Adding a caption source (new platform)

Implement the shape in PLAN.md's `TranscriptSource`. It must emit `TranscriptSlice`
unchanged so nothing downstream learns which platform it came from. Add `host_permissions`
and a `content_scripts` match pair (MAIN + ISOLATED) for the new origin.

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
