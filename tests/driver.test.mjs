// Executes the exported song.s driver on a miniature 6502 interpreter and
// checks the APU register writes frame by frame. Requires ca65/ld65 on PATH;
// skips (exit 0) if they're missing.
//   node tests/driver.test.mjs
import { export6502 } from "../src/export6502.js";
import { pulsePeriod, triPeriod, midiFreq } from "../src/apu.js";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

try { execFileSync("ca65", ["--version"], { stdio: "pipe" }); }
catch { console.log("ca65 not installed — skipping driver test"); process.exit(0); }

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.error("FAIL  " + msg); }
};

// ---- the same test song the engine test uses (one pattern, played twice) ----
const cell = (n, len = 1) => ({ n, len });
const pat = () => ({ p1: Array(16).fill(null), p2: Array(16).fill(null), tri: Array(16).fill(null), noise: Array(16).fill(null) });
const A = pat();
A.p1[0] = cell(69, 2); A.p2[4] = cell(64); A.tri[0] = cell(45, 8); A.noise[0] = cell(4);
const doc = {
  bpm: 150, patterns: [A], order: [0, 0],
  chans: {
    p1: { duty: 2, vol: 12, env: [15, 11, 8, 6, 4, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
    p2: { duty: 1, vol: 10, env: [5, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9] },
    tri: {},
    noise: { vol: 15, env: [15, 10, 6, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  },
};

// ---- assemble with the real toolchain ----
const dir = mkdtempSync(join(tmpdir(), "nesdrv-"));
writeFileSync(join(dir, "song.s"), export6502(doc));
writeFileSync(join(dir, "t.cfg"),
  "MEMORY { ZP: start=$0000, size=$100, type=rw; PRG: start=$8000, size=$8000, type=ro; }\n" +
  "SEGMENTS { ZEROPAGE: load=ZP, type=zp; CODE: load=PRG, type=ro; }\n");
execFileSync("ca65", ["song.s", "-o", "song.o"], { cwd: dir });
execFileSync("ld65", ["-C", "t.cfg", "song.o", "-o", "song.bin", "-Ln", "song.lbl"], { cwd: dir });
const prg = readFileSync(join(dir, "song.bin"));
const labels = {};
for (const line of readFileSync(join(dir, "song.lbl"), "utf8").split("\n")) {
  const m = line.match(/^al ([0-9A-F]+) \.(\w+)/);
  if (m) labels[m[2]] = parseInt(m[1], 16);
}
ok(labels.music_init != null && labels.music_play != null, "symbols exported");

// ---- mini 6502: exactly the opcodes the driver uses; anything else throws ----
const mem = new Uint8Array(0x10000);
mem.set(prg, 0x8000);
const apuWrites = []; // { frame, addr, val }
let frame = -1; // -1 while running music_init
const cpu = { a: 0, y: 0, z: false, c: false };
const rd = (a) => mem[a];
const wr = (a, v) => {
  mem[a] = v;
  if (a >= 0x4000 && a <= 0x4017) apuWrites.push({ frame, addr: a, val: v });
};
const setZ = (v) => { cpu.z = (v & 0xff) === 0; return v & 0xff; };
function run(entry) {
  let pc = entry;
  const stack = []; // { r: returnAddr } for jsr, { d: byte } for pha
  for (let n = 0; n < 200000; n++) {
    const op = mem[pc++];
    const imm = () => mem[pc++];
    const zp = () => mem[pc++];
    const abs = () => { const a = mem[pc] | (mem[pc + 1] << 8); pc += 2; return a; };
    const branch = (take) => { const d = mem[pc++]; if (take) pc += d < 128 ? d : d - 256; };
    switch (op) {
      case 0xa9: cpu.a = setZ(imm()); break;                                   // lda #
      case 0xa5: cpu.a = setZ(rd(zp())); break;                                // lda zp
      case 0xad: cpu.a = setZ(rd(abs())); break;                               // lda abs
      case 0xb9: cpu.a = setZ(rd((abs() + cpu.y) & 0xffff)); break;            // lda abs,y
      case 0xb1: { const z = zp(); cpu.a = setZ(rd(((mem[z] | (mem[(z + 1) & 0xff] << 8)) + cpu.y) & 0xffff)); break; } // lda (zp),y
      case 0xa0: cpu.y = setZ(imm()); break;                                   // ldy #
      case 0xa4: cpu.y = setZ(rd(zp())); break;                                // ldy zp
      case 0x85: wr(zp(), cpu.a); break;                                       // sta zp
      case 0x8d: wr(abs(), cpu.a); break;                                      // sta abs
      case 0x09: cpu.a = setZ(cpu.a | imm()); break;                           // ora #
      case 0xc9: { const r = cpu.a - imm(); cpu.c = r >= 0; cpu.z = (r & 0xff) === 0; break; } // cmp #
      case 0xc0: { const r = cpu.y - imm(); cpu.c = r >= 0; cpu.z = (r & 0xff) === 0; break; } // cpy #
      case 0xe6: { const a = zp(); wr(a, setZ(rd(a) + 1)); break; }            // inc zp
      case 0xc6: { const a = zp(); wr(a, setZ(rd(a) - 1)); break; }            // dec zp
      case 0x69: { const r = cpu.a + imm() + (cpu.c ? 1 : 0); cpu.c = r > 0xff; cpu.a = setZ(r); break; } // adc #
      case 0x18: cpu.c = false; break;                                         // clc
      case 0x48: stack.push({ d: cpu.a }); break;                              // pha
      case 0x68: cpu.a = setZ(stack.pop().d); break;                           // pla
      case 0xf0: branch(cpu.z); break;                                         // beq
      case 0xd0: branch(!cpu.z); break;                                        // bne
      case 0x90: branch(!cpu.c); break;                                        // bcc
      case 0xb0: branch(cpu.c); break;                                         // bcs
      case 0x4c: pc = mem[pc] | (mem[pc + 1] << 8); break;                     // jmp abs
      case 0x20: { const t = abs(); stack.push({ r: pc }); pc = t; break; }    // jsr
      case 0x60: { const e = stack.pop(); if (!e) return; if (e.r === undefined) throw new Error("rts into pha'd data"); pc = e.r; break; } // rts
      default: throw new Error(`unhandled opcode $${op.toString(16).padStart(2, "0")} at $${(pc - 1).toString(16)}`);
    }
  }
  throw new Error("runaway execution");
}

// ---- drive it: init, then 400 frames (past the 192-frame loop point) ----
run(labels.music_init);
const initWrites = apuWrites.slice();
for (let f = 0; f < 400; f++) { frame = f; run(labels.music_play); }

const at = (f) => apuWrites.filter((w) => w.frame === f);
const val = (f, addr) => { const ws = at(f).filter((w) => w.addr === addr); return ws.length ? ws[ws.length - 1].val : null; };

// init: apu setup
ok(initWrites.some((w) => w.addr === 0x4015 && w.val === 0x0f), "init enables all four channels");
ok(initWrites.some((w) => w.addr === 0x4001 && w.val === 0x08), "init disables sweep");

// frame 0 = step 0: note-on writes
const p1t = pulsePeriod(midiFreq(69)); // a440 -> 253
ok(val(0, 0x4002) === (p1t & 0xff) && val(0, 0x4003) === (p1t >> 8), "step 0: pulse1 period fd/00");
const trit = triPeriod(midiFreq(45)); // a1 -> 507
ok(val(0, 0x400a) === (trit & 0xff) && val(0, 0x400b) === ((trit >> 8) | 0xf8), "step 0: triangle period + length load");
ok(val(0, 0x400e) === 4, "step 0: noise period index 4");
ok(val(0, 0x4000) === (0x80 | 0x30 | 12), "step 0: pulse1 envelope frame 0 (duty full, vol 12)");
ok(val(0, 0x4004) === 0x30, "step 0: pulse2 silent (no note yet)");

// frame 1: envelope advances — env[1]=11 pre-scaled by vol 12 -> 9
ok(val(1, 0x4000) === (0x80 | 0x30 | 9), "frame 1: pulse1 envelope decays to 9");

// step 1 (frame 6): p1 still held (len 2) — no re-trigger, still sounding
ok(val(6, 0x4002) === null && val(6, 0x4003) === null, "step 1: held pulse1 note is not re-triggered");
ok(val(6, 0x4000) !== 0x30, "step 1: held pulse1 note still sounding");

// step 2 (frame 12): p1 length expired -> silenced
ok(val(12, 0x4000) === 0x30, "step 2: pulse1 falls silent after 2 steps");

// step 4 (frame 24): p2 comes in
const p2t = pulsePeriod(midiFreq(64));
ok(val(24, 0x4006) === (p2t & 0xff) && val(24, 0x4007) === (p2t >> 8), "step 4: pulse2 note starts");
ok(val(24, 0x4004) === (0x40 | 0x30 | Math.round((5 * 10) / 15)), "step 4: pulse2 envelope frame 0 (duty medium)");

// step 8 (frame 48): triangle length expired -> linear counter gated off
ok(val(48, 0x4008) === 0x80, "step 8: triangle gated off");

// order is [0,0]: step 16 (frame 96) replays step 0 of the same pattern
ok(val(96, 0x4002) === (p1t & 0xff), "step 16: second order slot replays the pattern");

// song loops after 32 steps: frame 192 = step 0 again
ok(val(192, 0x4002) === (p1t & 0xff) && val(192, 0x4003) === (p1t >> 8), "frame 192: song wraps back to the start");

console.log(failures ? `\n${failures} failure(s)` : "\nall driver tests passed");
process.exit(failures ? 1 : 0);
