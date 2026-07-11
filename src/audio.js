// audio.js — live playback bridge. Loads apu.js source into an AudioWorklet so
// the exact code that renders wav exports is what plays through the speakers.
import apuSource from "./apu.js?raw";

const GLUE = `
class NesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player = new Player(sampleRate);
    this.lastStep = -1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === "song") this.player.setSong(m.song);
      else if (m.cmd === "play") { this.player.setSong(m.song); this.player.play(); }
      else if (m.cmd === "stop") this.player.stop();
      else if (m.cmd === "preview") this.player.preview(m.ch, m.cell);
    };
    this.player.onStep = (s) => this.port.postMessage({ step: s });
  }
  process(inputs, outputs) {
    this.player.process(outputs[0][0]);
    return true;
  }
}
registerProcessor("nes-apu", NesProcessor);
`;

let ctx = null;
let node = null;

// must be called from a user gesture the first time (autoplay policy)
export async function initAudio(onStep) {
  if (node) { ctx.resume(); return node; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = apuSource.replace(/^export .*$/m, "") + GLUE;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  node = new AudioWorkletNode(ctx, "nes-apu", { numberOfInputs: 0, outputChannelCount: [1] });
  node.port.onmessage = (e) => { if (e.data.step != null && onStep) onStep(e.data.step); };
  node.connect(ctx.destination);
  ctx.resume();
  return node;
}

export function post(msg) { if (node) node.port.postMessage(msg); }
export function audioReady() { return !!node; }
