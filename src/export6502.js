// export6502.js — emits a self-contained ca65 source file: song data + a small
// NMI-driven playback driver (music_init / music_play). The data is produced by
// the same compileSong() the web player uses, so what you hear in the browser
// is what the driver plays on hardware.
import { compileSong, framesPerStepFor, midiFreq, pulsePeriod, triPeriod } from "./apu.js";

const hex = (n) => "$" + (n & 0xff).toString(16).padStart(2, "0");

function stepTables(song) {
  // fixed-stride step tables so the driver can walk them with simple pointers:
  //   melodic channels: 3 bytes/step = period lo, period hi ($ff = no event), length in steps
  //   noise:            2 bytes/step = period table index ($ff = no event), length in steps
  const mel = (ch, toPeriod) =>
    song.cells[ch].map((c) => {
      if (!c) return [0, 0xff, 0];
      const p = toPeriod(midiFreq(c.n));
      return [p & 0xff, (p >> 8) & 0x07, c.len];
    });
  return {
    p1: mel("p1", pulsePeriod),
    p2: mel("p2", pulsePeriod),
    tri: mel("tri", triPeriod),
    noise: song.cells.noise.map((c) => (c ? [c.n, c.len] : [0xff, 0])),
  };
}

const byteRows = (rows) => rows.map((r) => "  .byte " + r.map(hex).join(",")).join("\n");

export function export6502(doc) {
  const song = compileSong(doc, { mode: "song" });
  const fps = framesPerStepFor(doc.bpm);
  const t = stepTables(song);
  const envBytes = (env) => "  .byte " + env.map(hex).join(",");
  const dutyBits = (d) => (d << 6) | 0x30; // duty + constant volume + length-counter halt

  return `; ---------------------------------------------------------------
; nestracker export — ca65 syntax
; song: ${song.steps} steps at ${doc.bpm} bpm (one step every ${fps} NTSC frames)
;
; WHAT THIS FILE IS
;   Complete music data + playback driver for the NES APU. No other
;   code is needed. To use it in your game:
;
;     .include "song.s"        ; or assemble/link it as its own file
;     ...
;     jsr music_init           ; once, at reset (after APU is reachable)
;     ...
;     jsr music_play           ; once per frame, from your NMI handler
;
;   The driver loops the song forever. It uses no interrupts itself
;   and touches only the APU registers and its own variables.
;
; REQUIREMENTS
;   - The ZEROPAGE segment must exist in your linker config (it does in
;     every standard NES cfg). The driver needs zeropage for its data
;     pointers — (indirect),y addressing only works there.
;   - Call music_play exactly once per NMI for correct tempo.
;
; DATA FORMAT (fixed stride, walked by pointer)
;   pulse1/pulse2/triangle: 3 bytes per step = period lo, period hi,
;     note length in steps. hi = $ff means "no event this step".
;   noise: 2 bytes per step = noise period index ($ff = no event),
;     note length in steps.
;   envelopes: 16 bytes, volume 0-15 per frame from note start; the
;     last value holds for the rest of the note. (Triangle has no
;     volume control — real hardware quirk — so no table for it.)
; ---------------------------------------------------------------

SONG_FRAMES_PER_STEP = ${fps}
SONG_STEPS           = ${song.steps}
P1_CTRL              = ${hex(dutyBits(song.chans.p1.duty))} ; duty bits + const vol + halt
P2_CTRL              = ${hex(dutyBits(song.chans.p2.duty))}
NOISE_CTRL           = $30

.export music_init, music_play

.segment "ZEROPAGE"
mus_p1_ptr:   .res 2
mus_p2_ptr:   .res 2
mus_tri_ptr:  .res 2
mus_no_ptr:   .res 2
mus_step_lo:  .res 1
mus_step_hi:  .res 1
mus_frame:    .res 1  ; frames left in the current step
mus_p1_rem:   .res 1  ; steps left on the sounding note (0 = silent)
mus_p2_rem:   .res 1
mus_tri_rem:  .res 1
mus_no_rem:   .res 1
mus_p1_env:   .res 1  ; frames into the note, capped at 15 (envelope index)
mus_p2_env:   .res 1
mus_no_env:   .res 1

.segment "CODE"

music_init:
  lda #$0f
  sta $4015          ; enable pulse1, pulse2, triangle, noise
  lda #$40
  sta $4017          ; 5-step frame sequencer, no IRQ
  lda #$08
  sta $4001          ; sweep off (negate set so low notes aren't muted)
  sta $4005
  lda #$30
  sta $4000          ; silent, constant volume, length halt
  sta $4004
  sta $400c
  lda #$80
  sta $4008          ; triangle silent
  jsr mus_rewind
  lda #0
  sta mus_p1_rem
  sta mus_p2_rem
  sta mus_tri_rem
  sta mus_no_rem
  lda #1
  sta mus_frame      ; first music_play call starts step 0 immediately
  rts

; reset the data pointers + step counter only — also used at the song's loop
; point, where note states and the frame countdown must keep running untouched
mus_rewind:
  lda #<song_p1
  sta mus_p1_ptr
  lda #>song_p1
  sta mus_p1_ptr+1
  lda #<song_p2
  sta mus_p2_ptr
  lda #>song_p2
  sta mus_p2_ptr+1
  lda #<song_tri
  sta mus_tri_ptr
  lda #>song_tri
  sta mus_tri_ptr+1
  lda #<song_noise
  sta mus_no_ptr
  lda #>song_noise
  sta mus_no_ptr+1
  lda #0
  sta mus_step_lo
  sta mus_step_hi
  rts

music_play:
  dec mus_frame
  bne @envelopes
  lda #SONG_FRAMES_PER_STEP
  sta mus_frame
  jsr mus_step

@envelopes:
  ; ---- pulse 1: volume envelope, or silence when no note ----
  lda mus_p1_rem
  bne @p1on
  lda #$30
  sta $4000
  jmp @p2
@p1on:
  ldy mus_p1_env
  lda env_p1,y
  ora #P1_CTRL
  sta $4000
  cpy #15
  bcs @p2
  inc mus_p1_env
@p2:
  lda mus_p2_rem
  bne @p2on
  lda #$30
  sta $4004
  jmp @noise
@p2on:
  ldy mus_p2_env
  lda env_p2,y
  ora #P2_CTRL
  sta $4004
  cpy #15
  bcs @noise
  inc mus_p2_env
@noise:
  lda mus_no_rem
  bne @noon
  lda #$30
  sta $400c
  rts
@noon:
  ldy mus_no_env
  lda env_noise,y
  ora #NOISE_CTRL
  sta $400c
  cpy #15
  bcs @done
  inc mus_no_env
@done:
  rts

; ---- advance one step: read events, start/stop notes, walk pointers ----
mus_step:
  ; wrap to the top of the song first, so the final step plays out in full
  lda mus_step_lo
  cmp #<SONG_STEPS
  bne @events
  lda mus_step_hi
  cmp #>SONG_STEPS
  bne @events
  jsr mus_rewind
@events:
  ; pulse 1
  ldy #1
  lda (mus_p1_ptr),y
  cmp #$ff
  beq @p1rest
  sta $4003          ; period hi (also reloads the length counter)
  ldy #0
  lda (mus_p1_ptr),y
  sta $4002          ; period lo
  ldy #2
  lda (mus_p1_ptr),y
  sta mus_p1_rem
  lda #0
  sta mus_p1_env
  jmp @p1next
@p1rest:
  lda mus_p1_rem
  beq @p1next
  dec mus_p1_rem
@p1next:
  clc
  lda mus_p1_ptr
  adc #3
  sta mus_p1_ptr
  bcc @p2ev
  inc mus_p1_ptr+1
@p2ev:
  ; pulse 2
  ldy #1
  lda (mus_p2_ptr),y
  cmp #$ff
  beq @p2rest
  sta $4007
  ldy #0
  lda (mus_p2_ptr),y
  sta $4006
  ldy #2
  lda (mus_p2_ptr),y
  sta mus_p2_rem
  lda #0
  sta mus_p2_env
  jmp @p2next
@p2rest:
  lda mus_p2_rem
  beq @p2next
  dec mus_p2_rem
@p2next:
  clc
  lda mus_p2_ptr
  adc #3
  sta mus_p2_ptr
  bcc @triev
  inc mus_p2_ptr+1
@triev:
  ; triangle — no volume; gate it with the linear counter
  ldy #1
  lda (mus_tri_ptr),y
  cmp #$ff
  beq @trirest
  ora #$f8           ; length-counter load bits (halted, value irrelevant)
  pha
  lda #$ff
  sta $4008          ; linear counter: control set, reload 127 = keep playing
  ldy #0
  lda (mus_tri_ptr),y
  sta $400a
  pla
  sta $400b          ; period hi + linear counter reload
  ldy #2
  lda (mus_tri_ptr),y
  sta mus_tri_rem
  jmp @trinext
@trirest:
  lda mus_tri_rem
  beq @trinext
  dec mus_tri_rem
  bne @trinext
  lda #$80
  sta $4008          ; reload value 0 -> silent at the next quarter-frame
@trinext:
  clc
  lda mus_tri_ptr
  adc #3
  sta mus_tri_ptr
  bcc @noev
  inc mus_tri_ptr+1
@noev:
  ; noise
  ldy #0
  lda (mus_no_ptr),y
  cmp #$ff
  beq @norest
  sta $400e          ; period index, long mode
  lda #$f8
  sta $400f          ; reload length counter (halted)
  ldy #1
  lda (mus_no_ptr),y
  sta mus_no_rem
  lda #0
  sta mus_no_env
  jmp @nonext
@norest:
  lda mus_no_rem
  beq @nonext
  dec mus_no_rem
@nonext:
  clc
  lda mus_no_ptr
  adc #2
  sta mus_no_ptr
  bcc @count
  inc mus_no_ptr+1
@count:
  inc mus_step_lo
  bne @out
  inc mus_step_hi
@out:
  rts

; ---- envelopes: volume 0-15 per frame from note start (pre-mixed with
; ---- the channel volume you set in nestracker) ----
env_p1:
${envBytes(song.chans.p1.env)}
env_p2:
${envBytes(song.chans.p2.env)}
env_noise:
${envBytes(song.chans.noise.env)}

; ---- step data ----
song_p1:
${byteRows(t.p1)}
song_p2:
${byteRows(t.p2)}
song_tri:
${byteRows(t.tri)}
song_noise:
${byteRows(t.noise)}
`;
}
