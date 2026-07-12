# CLAUDE.md

## Project

nestracker: mobile-web NES chiptune step sequencer. Single page, no backend.
Companion app to nesprite (https://djessemann.github.io/nesprite/).

## Owner

- Content designer. Reads code, not a professional engineer. Explain changes
  plainly.

## Design rules

- Use nesprite's design system verbatim: css vars --bg/--ink/--line/--muted/
  --soft, ui-monospace font stack, lowercase labels, square 1px-bordered
  buttons, inverted (white bg) active states, segmented toggles, sticky
  header, 640px column, two columns at 1100px.
- No border-radius, shadows, animation, component libraries, Tailwind, or
  new fonts.
- Color is for channel identity only (NES palette reds/blues/greens on tabs,
  notes, sliders, envelope bars). Chrome stays monochrome.
- UI copy is non-technical: "tone: thin/medium/full", not "duty cycle";
  "shape", not "envelope". Technical detail goes in exported song.s comments
  or code comments, never in the UI or the in-app "how to" page.

## Files

- `src/apu.js` — 2A03 sound core (pulse duty sequences, triangle staircase,
  LFSR noise, non-linear mixer), compileSong() (UI doc -> flat playable
  song; envelopes pre-scaled by channel volume), Player (frame ticker ->
  notes -> APU), renderSong() (offline render). Single source of truth for
  how the song sounds. Runs in the AudioWorklet (via ?raw source import,
  see audio.js) and on the main thread for wav/stem export. Must stay
  dependency-free: no ESM imports, single one-line `export` statement at
  the bottom (audio.js strips it with a regex).
- `src/audio.js` — fetches apu.js source at runtime, strips the export
  line, appends worklet glue, loads it as an AudioWorklet. Exposes
  initAudio()/post(). initAudio must be called from a user gesture.
- `src/export6502.js` — emits song.s: header docs, constants, a ca65 driver
  (music_init/music_play), envelope + step tables. Data comes from the same
  compileSong(). Keep the header comments accurate; they document the
  format.
- `src/files.js` — wav encoder, minimal zip (store method), download.
- `src/app.js` — all UI. Imperative: state object + render functions, no
  framework. index.html holds markup and CSS.

## Data model

- Document: { bpm, patterns[], order[], chans }.
- Pattern: { p1, p2, tri, noise }, each Array(16) of null | { n, len }
  (n = midi note or noise period index; len in steps).
- order[] holds pattern indices. "repeat" adds a second reference to the
  same pattern; "copy" clones it.
- Monophonic per channel (matches the hardware).

## Rules

- No build step. The repo is the site; GitHub Pages serves the branch
  directly. Never add a bundler, framework, or anything that requires
  compiling before the browser can run it.
- Never rebuild the grid DOM during a pointer gesture; it destroys the row
  element holding the pointer capture and kills the drag. Gesture edits go
  through paintSpans(); full renders happen after.
- Note lengths are whole steps; note-off happens only at step boundaries.
  The 6502 driver depends on this (it tracks remaining steps, not frames).
- If you change how playback interprets the song, change compileSong()/
  Player once. Never fork logic between live and export paths. Then run
  `npm test`.
- bpm input is a free-typing field with a clamped doc value. Do not write
  the clamped value back into the field while typing; it locks up.
- Keep inputMode="numeric" on controlled number inputs (iOS).
- Grid gestures: Pointer Events with setPointerCapture on the row; cells
  are pointer-events:none so the row does the math. Rows need
  touch-action:none or scrolling breaks the drag.
- The grid must stay usable at 375px wide; test on a narrow viewport.
- localStorage key "nestracker-v2" holds { doc, oct }. v1 song files (with
  a `patt` key) load through migrateV1(). Do not break it.
- Channel mutes live on Player (setMute) only. Session-only state; must
  never affect compileSong or the export paths.

## Tests

- `npm test`. tests/engine.test.mjs checks the player and formats.
  tests/driver.test.mjs assembles the 6502 export with ca65, executes it on
  a mini interpreter, and asserts APU register writes per frame.

## Roadmap (priority order)

1. Pitch effects (arp, slide, vibrato)
2. DPCM (baked-in kit first)
3. FamiTone2-compatible export
4. Keyboard entry on desktop

## Commands

- `npm run dev` — static server
- `npm test`
