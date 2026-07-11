// Plain-node tests for the sound engine and export formats (no test framework):
//   node tests/engine.test.mjs
import { compileSong, renderSong, framesPerStepFor, pulsePeriod, midiFreq, Player } from "../src/apu.js";
import { export6502 } from "../src/export6502.js";
import { encodeWav, makeZip } from "../src/files.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.error("FAIL  " + msg); }
};

// ---- a small two-part test song ----
const cell = (n, len = 1) => ({ n, len });
const pat = () => ({ p1: Array(16).fill(null), p2: Array(16).fill(null), tri: Array(16).fill(null), noise: Array(16).fill(null) });
const A = pat(), B = pat();
A.p1[0] = cell(69, 2);   // a-4, held 2 steps
A.p2[4] = cell(64);
A.tri[0] = cell(45, 8);  // long bass note
A.noise[0] = cell(4);
B.p1[8] = cell(72);
const doc = {
  bpm: 150,
  patterns: [A, B],
  order: [0, 1, 0],
  chans: {
    p1: { duty: 2, vol: 12, shape: "pluck", env: [15, 11, 8, 6, 4, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
    p2: { duty: 1, vol: 10, shape: "soft", env: [5, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9] },
    tri: {},
    noise: { vol: 15, shape: "crisp", env: [15, 10, 6, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  },
};

// ---- compileSong ----
const songAll = compileSong(doc, { mode: "song" });
ok(songAll.steps === 48, "song mode: 3 order slots -> 48 steps");
ok(songAll.cells.p1[32] && songAll.cells.p1[32].n === 69, "order repeats pattern content");
const songLoop = compileSong(doc, { mode: "loop", loopPat: 1 });
ok(songLoop.steps === 16 && songLoop.cells.p1[8].n === 72, "loop mode: just the edited part");
ok(songAll.chans.p1.env[0] === 12, "envelope pre-scaled by channel volume (15*12/15)");
const soloed = compileSong(doc, { mode: "song", solo: "tri" });
ok(soloed.cells.p1.every((x) => x == null) && soloed.cells.tri.some(Boolean), "solo strips other channels");

// ---- period math ----
ok(pulsePeriod(midiFreq(69)) === 253, "a440 -> pulse timer 253 ($fd)");
ok(framesPerStepFor(150) === 6, "150 bpm -> 6 frames per step");

// ---- render: audible, correct length, distinct stems ----
const wav = renderSong(doc, { mode: "song", sampleRate: 44100 });
const peak = wav.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
ok(peak > 0.05 && peak <= 1, `render is audible and unclipped (peak ${peak.toFixed(3)})`);
const expected = Math.ceil(((48 * 6) / 60 + 0.4) * 44100);
ok(wav.length === expected, "render length = steps * framesPerStep + tail");
const stemTri = renderSong(doc, { mode: "song", solo: "tri" });
const stemNoise = renderSong(doc, { mode: "song", solo: "noise" });
const diff = stemTri.reduce((a, v, i) => a + Math.abs(v - stemNoise[i]), 0);
ok(diff > 100, "stems differ per channel");
// determinism: same input twice -> identical output
const wav2 = renderSong(doc, { mode: "song", sampleRate: 44100 });
ok(wav.every((v, i) => v === wav2[i]), "render is deterministic");

// ---- mute: silences live, blocks new notes, unmute recovers ----
{
  const mp = new Player(44100);
  mp.setSong(compileSong(doc, { mode: "song" }));
  mp.play();
  mp.setMute({ p1: true, p2: true, tri: true, noise: true });
  mp.process(new Float32Array(44100)); // let the dc blocker settle past the mute click
  const quiet = new Float32Array(22050);
  mp.process(quiet);
  const peakMuted = quiet.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  ok(peakMuted < 0.01, `all channels muted -> near silence (peak ${peakMuted.toFixed(4)})`);
  mp.setMute({});
  const loud = new Float32Array(44100);
  mp.process(loud);
  ok(loud.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.05, "unmute -> sound returns");
  mp.setMute({ tri: false, noise: false, p1: true, p2: true });
  const part = new Float32Array(44100);
  mp.process(part);
  ok(part.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.02, "partial mute keeps the others audible");
}

// ---- player streaming == one-shot render (worklet path sanity) ----
const p = new Player(44100);
p.setSong(compileSong(doc, { mode: "song" }));
p.play();
const streamed = new Float32Array(44100);
for (let at = 0; at < streamed.length; at += 128) p.process(streamed.subarray(at, Math.min(at + 128, streamed.length)));
const sdiff = streamed.reduce((a, v, i) => a + Math.abs(v - wav[i]), 0);
ok(sdiff < 1e-6, "chunked (worklet-style) processing matches offline render exactly");

// ---- wav container ----
const bytes = encodeWav(wav.subarray(0, 1000));
const txt = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
ok(txt(0, 4) === "RIFF" && txt(8, 4) === "WAVE" && bytes.length === 44 + 2000, "wav header + 16-bit mono payload");

// ---- zip: system unzip must accept it ----
const dir = mkdtempSync(join(tmpdir(), "neszip-"));
const zip = makeZip([
  { name: "a.wav", data: bytes },
  { name: "b.txt", data: new TextEncoder().encode("hello") },
]);
const zpath = join(dir, "t.zip");
writeFileSync(zpath, zip);
let unzipOk = true;
try { execFileSync("unzip", ["-t", zpath], { stdio: "pipe" }); } catch { unzipOk = false; }
ok(unzipOk, "zip passes `unzip -t`");

// ---- 6502 export ----
const asm = export6502(doc);
ok(asm.includes("music_init:") && asm.includes("music_play:"), "asm includes the driver");
ok(asm.includes("SONG_STEPS           = 48"), "asm step count matches the song");
ok(asm.includes("$fd,$00,$02"), "a440 held 2 steps encodes as fd/00/02");
const stepRows = (label, stride) => {
  const at = asm.indexOf(label);
  const next = asm.indexOf(":", at + label.length);
  const chunk = asm.slice(at, next === -1 ? undefined : next);
  return (chunk.match(/\$[0-9a-f]{2}/g) || []).length / stride;
};
ok(stepRows("song_p1:", 3) === 48, "p1 table has 48 3-byte steps");
ok(stepRows("song_noise:", 2) === 48, "noise table has 48 2-byte steps");

// ---- apu.js survives the worklet source transform ----
const src = readFileSync(new URL("../src/apu.js", import.meta.url), "utf8");
const stripped = src.replace(/^export .*$/m, "");
ok(!/^export /m.test(stripped), "export line strips cleanly");
try { new Function(stripped); ok(true, "stripped apu.js parses as a classic script"); }
catch (e) { ok(false, "stripped apu.js parses as a classic script: " + e.message); }

console.log(failures ? `\n${failures} failure(s)` : "\nall tests passed");
process.exit(failures ? 1 : 0);
