// apu.js — pure-JS 2A03 sound core + song player.
//
// This file is the single source of truth for how the song sounds. It runs in
// three places, always as the same code:
//   1. live playback  — inside an AudioWorklet (audio.js loads this file's
//      source as ?raw, strips the export line, and appends processor glue)
//   2. wav export     — renderSong() below, run synchronously on the main thread
//   3. stems export   — renderSong() with a solo channel
//
// Because the worklet consumes this file as raw source, it must stay
// dependency-free and use no ESM imports. The only `export` statement is the
// single line at the bottom (audio.js strips it with a regex — keep it one line).

const CPU = 1789773; // NTSC 2A03 clock (Hz)
const FRAME_RATE = 60; // envelope/step clock, like an NMI-driven driver
// NTSC noise period table (CPU cycles per LFSR clock), index 0 = fastest/highest
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
// 8-step duty sequences for $4000 duty values 0..2 (12.5%, 25%, 50%)
const DUTY_SEQ = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
];
// 32-step triangle staircase: 15..0 then 0..15 (the real 4-bit sequence)
const TRI_SEQ = [];
for (let i = 15; i >= 0; i--) TRI_SEQ.push(i);
for (let i = 0; i <= 15; i++) TRI_SEQ.push(i);

const NOTE_NAMES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
// pulse timer value for a frequency: f = CPU / (16 * (t + 1))
const pulsePeriod = (f) => Math.max(8, Math.min(0x7ff, Math.round(CPU / (16 * f)) - 1));
// triangle timer: f = CPU / (32 * (t + 1))
const triPeriod = (f) => Math.max(2, Math.min(0x7ff, Math.round(CPU / (32 * f)) - 1));

// ---------- channel generators (clocked in CPU cycles) ----------
class PulseChan {
  constructor() { this.timer = 200; this.duty = 2; this.vol = 0; this.seq = 0; this.acc = 0; }
  setNote(t) { this.timer = t; this.seq = 0; this.acc = 0; } // phase reset, like writing $4003
  clock(cycles) {
    const p = (this.timer + 1) * 2; // sequencer advances every 2*(t+1) cycles
    this.acc += cycles;
    while (this.acc >= p) { this.acc -= p; this.seq = (this.seq + 1) & 7; }
    return DUTY_SEQ[this.duty][this.seq] * this.vol;
  }
}
class TriChan {
  constructor() { this.timer = 200; this.on = false; this.seq = 0; this.acc = 0; }
  setNote(t) { this.timer = t; this.on = true; }
  clock(cycles) {
    // the triangle halts in place when silenced (no volume control on hardware);
    // the mixer's DC blocker absorbs the held level
    if (!this.on) return TRI_SEQ[this.seq];
    const p = this.timer + 1;
    this.acc += cycles;
    while (this.acc >= p) { this.acc -= p; this.seq = (this.seq + 1) & 31; }
    return TRI_SEQ[this.seq];
  }
}
class NoiseChan {
  constructor() { this.pi = 8; this.vol = 0; this.lfsr = 1; this.acc = 0; }
  clock(cycles) {
    const p = NOISE_PERIODS[this.pi];
    this.acc += cycles;
    while (this.acc >= p) {
      this.acc -= p;
      const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1; // long mode
      this.lfsr = (this.lfsr >> 1) | (bit << 14);
    }
    return (this.lfsr & 1) ? 0 : this.vol;
  }
}

// ---------- the APU: channels + the real non-linear mixer ----------
class APU {
  constructor(sampleRate) {
    this.cyclesPerSample = CPU / sampleRate;
    this.p1 = new PulseChan();
    this.p2 = new PulseChan();
    this.tri = new TriChan();
    this.noise = new NoiseChan();
    this.dcPrev = 0; this.dcOut = 0; // 1-pole DC blocker
  }
  sample() {
    const c = this.cyclesPerSample;
    const p1 = this.p1.clock(c), p2 = this.p2.clock(c);
    const t = this.tri.clock(c), n = this.noise.clock(c);
    const pOut = (p1 + p2) ? 95.88 / (8128 / (p1 + p2) + 100) : 0;
    const tnd = t / 8227 + n / 12241;
    const tOut = tnd ? 159.79 / (1 / tnd + 100) : 0;
    const raw = (pOut + tOut) * 1.6; // 0..~1.6 -> roughly ±0.8 after DC removal
    const out = raw - this.dcPrev + 0.9985 * this.dcOut;
    this.dcPrev = raw; this.dcOut = out;
    return out;
  }
  silence() { this.p1.vol = 0; this.p2.vol = 0; this.tri.on = false; this.noise.vol = 0; }
}

// ---------- compile the UI document into a flat, playable song ----------
// doc: { bpm, patterns, order, chans } (see App.jsx). mode "loop" plays just
// patterns[loopPat]; "song" plays the whole order. Envelopes come out here
// pre-scaled by the channel volume so the player and the 6502 export read
// identical tables.
const framesPerStepFor = (bpm) => Math.max(1, Math.round(900 / Math.max(40, Math.min(300, bpm))));
function compileSong(doc, { mode, loopPat = 0, solo = null } = {}) {
  const patIds = mode === "song" ? doc.order : [doc.order[loopPat] ?? doc.order[0]];
  const cells = { p1: [], p2: [], tri: [], noise: [] };
  for (const pi of patIds)
    for (const ch of ["p1", "p2", "tri", "noise"])
      cells[ch].push(...doc.patterns[pi][ch]);
  if (solo) for (const ch of ["p1", "p2", "tri", "noise"]) if (ch !== solo) cells[ch] = cells[ch].map(() => null);
  const scale = (env, vol) => env.map((e) => Math.round((e * vol) / 15));
  return {
    framesPerStep: framesPerStepFor(doc.bpm),
    steps: patIds.length * 16,
    cells,
    chans: {
      p1: { duty: doc.chans.p1.duty, env: scale(doc.chans.p1.env, doc.chans.p1.vol) },
      p2: { duty: doc.chans.p2.duty, env: scale(doc.chans.p2.env, doc.chans.p2.vol) },
      tri: {},
      noise: { env: scale(doc.chans.noise.env, doc.chans.noise.vol) },
    },
  };
}

// ---------- player: frames -> notes -> APU, one sample at a time ----------
class Player {
  constructor(sampleRate) {
    this.apu = new APU(sampleRate);
    this.samplesPerFrame = sampleRate / FRAME_RATE;
    this.song = null;
    this.playing = false;
    this.mute = {};
    this.onStep = null;
    this.step = -1; this.frameInStep = 0; this.sampleAcc = 0;
    this.notes = { p1: null, p2: null, tri: null, noise: null }; // {framesLeft, frame}
  }
  setSong(song) {
    // hot-swap mid-play: keep transport position if the length still matches
    const keep = this.playing && this.song && this.song.steps === song.steps;
    this.song = song;
    if (!keep) this.rewind();
  }
  rewind() { this.step = -1; this.frameInStep = 0; this.sampleAcc = 0; this.notes = { p1: null, p2: null, tri: null, noise: null }; }
  play() { this.rewind(); this.playing = true; }
  stop() { this.playing = false; this.rewind(); this.apu.silence(); }
  // mute is a live-listening tool: silences a channel now and blocks new notes.
  // It never touches song data, so exports are unaffected.
  setMute(mute) {
    this.mute = mute || {};
    for (const ch of ["p1", "p2", "noise"]) {
      if (this.mute[ch]) {
        this.notes[ch] = null;
        (ch === "noise" ? this.apu.noise : this.apu[ch]).vol = 0;
      }
    }
    if (this.mute.tri) { this.notes.tri = null; this.apu.tri.on = false; }
  }
  startNote(ch, cell, fps) {
    if (this.mute[ch]) return;
    const note = { framesLeft: cell.len * fps, frame: 0 };
    if (ch === "p1" || ch === "p2") this.apu[ch].setNote(pulsePeriod(midiFreq(cell.n)));
    else if (ch === "tri") this.apu.tri.setNote(triPeriod(midiFreq(cell.n)));
    else this.apu.noise.pi = cell.n;
    this.notes[ch] = note;
  }
  frameTick() {
    const s = this.song, fps = s.framesPerStep;
    if (this.frameInStep === 0) {
      this.step = (this.step + 1) % s.steps;
      if (this.onStep) this.onStep(this.step);
      for (const ch of ["p1", "p2", "tri", "noise"]) {
        const cell = s.cells[ch][this.step];
        if (cell) this.startNote(ch, cell, fps);
      }
    }
    for (const ch of ["p1", "p2", "noise"]) {
      const n = this.notes[ch];
      const chan = ch === "noise" ? this.apu.noise : this.apu[ch];
      if (n) {
        chan.vol = s.chans[ch].env[Math.min(n.frame, 15)];
        if (ch !== "noise") chan.duty = s.chans[ch].duty;
        n.frame++; n.framesLeft--;
        if (n.framesLeft <= 0) { this.notes[ch] = null; chan.vol = 0; }
      }
    }
    const tn = this.notes.tri;
    if (tn) { tn.framesLeft--; if (tn.framesLeft <= 0) { this.notes.tri = null; this.apu.tri.on = false; } }
    this.frameInStep = (this.frameInStep + 1) % fps;
  }
  // one-shot preview of a single cell (used when placing notes)
  preview(ch, cell) {
    if (!this.song) return;
    this.startNote(ch, { ...cell, len: 0 }, 0);
    this.notes[ch].framesLeft = 9;
  }
  process(out) {
    for (let i = 0; i < out.length; i++) {
      if (this.playing || this.anyNote()) {
        if (this.sampleAcc <= 0) {
          if (this.playing) this.frameTick(); else this.previewTick();
          this.sampleAcc += this.samplesPerFrame;
        }
        this.sampleAcc--;
        out[i] = this.apu.sample();
      } else out[i] = 0;
    }
  }
  anyNote() { return this.notes.p1 || this.notes.p2 || this.notes.tri || this.notes.noise; }
  previewTick() { // envelope-only ticking while a preview note rings
    const s = this.song;
    for (const ch of ["p1", "p2", "noise"]) {
      const n = this.notes[ch];
      const chan = ch === "noise" ? this.apu.noise : this.apu[ch];
      if (n) {
        chan.vol = s.chans[ch].env[Math.min(n.frame, 15)];
        if (ch !== "noise") chan.duty = s.chans[ch].duty;
        n.frame++; n.framesLeft--;
        if (n.framesLeft <= 0) { this.notes[ch] = null; chan.vol = 0; }
      }
    }
    const tn = this.notes.tri;
    if (tn) { tn.framesLeft--; if (tn.framesLeft <= 0) { this.notes.tri = null; this.apu.tri.on = false; } }
  }
}

// ---------- offline render: same Player, straight to a Float32Array ----------
function renderSong(doc, { mode, loopPat = 0, solo = null, loops = 1, sampleRate = 44100 } = {}) {
  const song = compileSong(doc, { mode, loopPat, solo });
  const player = new Player(sampleRate);
  player.setSong(song);
  player.play();
  const frames = song.steps * song.framesPerStep * loops;
  const total = Math.ceil((frames / FRAME_RATE + 0.4) * sampleRate);
  const buf = new Float32Array(total);
  const musicEnd = Math.ceil((frames / FRAME_RATE) * sampleRate);
  const chunk = 4096;
  for (let at = 0; at < total; at += chunk) {
    const slice = buf.subarray(at, Math.min(at + chunk, total));
    player.process(slice);
    if (at + chunk >= musicEnd && player.playing) { player.playing = false; } // let the tail ring out
  }
  return buf;
}

export { CPU, FRAME_RATE, NOISE_PERIODS, NOTE_NAMES, midiFreq, pulsePeriod, triPeriod, framesPerStepFor, compileSong, Player, APU, renderSong };
