# Hey Buddy, Note This

Press one key while watching a video. Never pause, never switch tabs, never lose
your place. The last 60 seconds becomes a note — the speaker's actual words,
cleaned up, with a takeaway line on top and a deep link back to the exact moment.

A Chrome extension. Bring your own API key. No backend, no account, no server
that sees your transcripts.

## What it is, and isn't

It's a **time machine with a cleanup pass**, not a summarizer.

You already know the passage mattered — that's why you pressed the key. What you
lost is the exact phrasing, in the seconds it took to reach the keyboard. So the
model reconstructs; it does not judge. Captions arrive with no punctuation, no
capitalization, and mangled jargon, and repairing that is the whole job.

The note keeps a takeaway on top so you can skim months later, and the speaker's
own words underneath so a wrong takeaway is survivable — the source is right
there to correct it.

If the model decides a passage was an ad, an intro, or dead air, it writes
nothing at all. That matters more than it sounds: a doc you don't trust is a doc
you stop reading.

## Hotkeys

| Key | What it captures |
|---|---|
| `Alt+Shift+N` | the last 60 seconds |
| `Alt+Shift+B` | the 60 seconds *before* that — for when you pressed too late |
| `Alt+Shift+L` | the last 3 minutes |

Rebind at `chrome://extensions/shortcuts`.

## Where notes go

Two destinations, and neither one failing loses a note — every capture is
committed to extension storage before anything else is attempted.

- **A local Markdown file**, one per day, in `Downloads/heystop/`. Works with no
  setup at all.
- **A Google Doc**, if you connect one. Optional; see setup below.

## Install

```bash
npm install
npm run build
```

Then load `dist/` unpacked at `chrome://extensions` with Developer mode on.

Open the options page and pick a model provider. Anthropic, OpenAI, OpenRouter,
Groq, Together, DeepSeek and Gemini are preset; anything speaking the OpenAI
`/chat/completions` shape works, including a local Ollama or LM Studio. The model
name is always editable — model names change faster than this extension ships.

Your key is stored in `chrome.storage.local`, never synced, and requests go
straight from your browser to the provider you chose.

## Sites

YouTube works out of the box, via its caption API.

Anything else — Vimeo, a course platform, a university player — gets added in
options under **Other sites**. That path reads the video's own subtitle track
through the standard `TextTrack` API, so it works anywhere the player uses
ordinary captions, with no per-site code. Each site asks for its own permission;
the install prompt stays narrow.

## Google Docs (optional)

The OAuth client ID is personal and isn't in this repo. Without it, Docs is
simply off and notes stay local — which is a complete product on its own.

Setup steps are in [AGENTS.md](AGENTS.md#google-docs-setup-one-time-per-machine).
Scopes are `documents` and `drive.file` — access to files this extension created,
never the rest of your Drive.

## The capture log

Options has a log of your last 50 presses, successes and failures alike, with
latency and token counts. It exists to answer questions you can't answer by
reading code: does the prompt actually decline ad breaks, is a preset's model
name still valid, is this fast enough to press and keep watching.

Cost is computed from rates you enter, not a built-in price table. Prices drift
as fast as model names, and a stale price reports a confident wrong number where
a stale model name at least fails loudly.

## Development

```bash
npm run build      # typecheck, then bundle to dist/
npm run dev        # watch build
npm test           # vitest
```

Architecture, the MV3 context rules, and the security boundaries are in
[AGENTS.md](AGENTS.md). The product reasoning and build order are in
[PLAN.md](PLAN.md).

## No captions? Audio fallback

For videos with no caption track at all, click the toolbar icon once to arm
audio capture on that tab. The tab keeps its sound — the captured stream is piped
straight back to your speakers — and the last few minutes are held as raw PCM,
transcribed only when you press a hotkey.

Requires a provider that offers speech to text; OpenAI and Groq are wired up.
Chrome allows one capture at a time, so arming a second tab moves it. Timestamps
from this path are approximate.

## Status

Steps 1–11 and 14 of [PLAN.md](PLAN.md) are built: captions, model routing,
notes, local files, Google Docs, three hotkeys, toasts, the capture log, the
generic caption source, and the audio fallback.

Not done: frame capture (step 12, optional and cuttable by design), and the two
weeks of real study that decide whether any of this works (step 13). **Nothing
here has been used against a real video yet.**

## License

MIT — see [LICENSE](LICENSE).
