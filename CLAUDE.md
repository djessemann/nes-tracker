# CLAUDE.md — project guide for Claude Code

## What this is

nestracker: a mobile-web NES chiptune step sequencer. One page, no backend.
Companion app to nesprite (https://djessemann.github.io/nesprite/).

## Owner context

- The owner is a content designer, comfortable reading code but not a
  professional engineer. Explain changes plainly.
- Visual style is nesprite's design system, used verbatim: css vars
  --bg/--ink/--line/--muted/--soft, ui-monospace font stack, lowercase
  labels everywhere, square 1px-bordered buttons, inverted (white bg)
  active states, segmented toggles, sticky header, 640px column that
  becomes two columns at 1100px. No border-radius, no shadows, no
  animation, no component libraries, no Tailwind, no new fonts.
- The one sanctioned use of color: channel identity (NES palette reds/
  blues/greens on tabs, notes, sliders, envelope bars). Chrome stays
  monochrome.
- UI copy must stay non-technical ("tone: thin/medium/full", never "duty
  cycle"; "shape", never "envelope"). Technical detail belongs in the
  exported song.s comments or code comments, not in the UI or the in-app
  "how to" page.

## Map of the code

- `src/apu.js` — 2A03 sound core (pulse duty sequences, triangle
  staircase, LFSR noise, non-linear mixer), compileSong() (UI doc ->
  flat playable song; envelopes pre-scaled by channel volume here),
  Player (frame ticker -> notes -> APU), renderSong() (offline render).
  THE INVARIANT: this file is the single source of truth for how the
  song sounds. It runs inside the AudioWorklet (via ?raw source import,
  see audio.js) AND on the main thread for wav/stem export. It must stay
  dependency-free, no ESM imports, and keep its single one-line `export`
  statement at the bottom (audio.js strips it with a regex).
- `src/audio.js` — builds the worklet from apu.js source + glue, exposes
  initAudio()/post(). initAudio must be called from a user gesture.
- `src/export6502.js` — emits song.s: header docs, constants, a ca65
  driver (music_init/music_play), envelope + step tables. Data comes from
  the same compileSong(). Keep the header comments accurate — they are
  the documentation for the format.
- `src/files.js` — wav encoder, minimal zip (store method), download.
- `src/App.jsx` — all UI. Document state shape:
  { bpm, patterns[], order[], chans } where a pattern is
  { p1, p2, tri, noise }, each Array(16) of null | { n, len } (n = midi
  note or noise period index; len in steps). order[] holds pattern
  indices — "repeat" adds a second reference to the same pattern, "copy"
  clones it. Monophonic per channel — the hardware is too.

## Conventions & gotchas

- Note lengths are whole steps; note-off happens only at step boundaries
  (the 6502 driver depends on this — it tracks remaining steps, not
  frames).
- If you change how playback interprets the song, change compileSong()/
  Player once — never fork logic between live/export paths. Then run
  `npm test`: tests/engine.test.mjs checks the player and formats, and
  tests/driver.test.mjs assembles the 6502 export with ca65 and executes
  it on a mini interpreter, asserting APU register writes per frame.
- bpm input: free-typing text state + clamped numeric state. Don't clamp
  in onChange against the text or the field locks up (it happened once).
- Controlled number inputs and iOS: keep inputMode="numeric".
- Grid gestures use Pointer Events with setPointerCapture on the row;
  cells are pointer-events:none so the row does the math. touch-action:
  none on rows, or scrolling eats the drag.
- Test on a narrow viewport; the grid must stay usable at 375px wide.
- localStorage key "nestracker-v2" holds { doc, oct }. Old v1 song files
  (with a `patt` key) still load through migrateV1() — don't break it.

## Roadmap (owner's priorities)

1. Pitch effects (arp, slide, vibrato)
2. DPCM later (baked-in kit first)
3. FamiTone2-compatible export
4. Keyboard entry on desktop

## Commands

- `npm run dev` / `npm run build` / `npm test`
