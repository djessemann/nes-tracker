# nestracker

**Use it here: https://djessemann.github.io/nes-tracker/**

Make NES chiptune loops and songs in your browser. A touch-friendly step
sequencer for the four sound channels of the NES's 2A03 chip (pulse 1,
pulse 2, triangle, noise), with real emulated synthesis and exports you
can actually use: wav audio, per-channel stems, or a ca65 assembly file
(data + driver) that plays in a real NES game.

Companion app to [nesprite](https://djessemann.github.io/nesprite/), and
shares its design system: black, monospace, 1px white borders, no fuss.

## Run it

No build step — the repo is the site, like nesprite. Serve the folder
with any static server and open it:

```bash
npm run dev      # python3 -m http.server 8080
npm test         # engine + 6502 driver tests (driver test needs ca65)
```

No backend, no accounts, nothing stored online. Songs autosave to the
browser and save/load as JSON files.

## Features

- 16-step × one-octave grid, one channel at a time; tap to place, tap to
  erase, **drag right to hold notes** across steps
- Song mode: chain 16-step parts (new / repeat / copy / delete) into a
  full arrangement
- Sound shapes: per-channel volume envelopes with plain-language presets
  (pluck / lead / soft / long, crisp / tight / boom / wash) and a
  draw-your-own editor
- Real 2A03 emulation in an AudioWorklet: duty-sequence pulses, the
  32-step 4-bit triangle staircase, a clocked 15-bit LFSR noise channel,
  and the hardware's non-linear mixer — the same code renders live audio
  and all exports
- **audio** — 16-bit wav of the loop or the whole song
- **stems** — one wav per channel, zipped (one download, iOS-friendly)
- **code** — a single ca65 `.s` file: song data plus a `music_init` /
  `music_play` driver you call from your NMI handler; assembles clean
  with ca65/ld65 and is covered by an automated 6502 execution test
- **save / load** — JSON project files; files from the v1 prototype load
  and migrate automatically

## Architecture

Plain HTML + JavaScript modules, no framework, no build step:

- `index.html` — markup + all CSS
- `src/app.js` — the UI (imperative, nesprite-style)
- `src/apu.js` — the sound core + song player (single source of truth;
  runs both in the AudioWorklet and for offline wav rendering)
- `src/audio.js` — worklet bridge (fetches apu.js source into the worklet)
- `src/export6502.js` — ca65 exporter (data + driver)
- `src/files.js` — wav encoder, zip writer, downloads

See `CLAUDE.md` for conventions before making changes.

## Roadmap ideas

- Pitch effects: arpeggio, slide, vibrato
- DPCM sample channel (baked-in drum kit first)
- FamiTone2 / FamiStudio-compatible export
- Keyboard entry on desktop
