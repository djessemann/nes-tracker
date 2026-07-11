// audio.js — live playback bridge. Fetches apu.js source at runtime and loads
// it into an AudioWorklet, so the exact code that renders wav exports is what
// plays through the speakers. No build step: the site serves apu.js both as an
// ES module (for exports) and as raw text (for the worklet blob).

const GLUE = `
class NesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player = new Player(sampleRate);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === "song") this.player.setSong(m.song);
      else if (m.cmd === "play") { this.player.setSong(m.song); this.player.play(); }
      else if (m.cmd === "stop") this.player.stop();
      else if (m.cmd === "mute") this.player.setMute(m.mute);
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
let initPromise = null;

// must be called from a user gesture the first time (autoplay policy)
export function initAudio(onStep) {
  if (initPromise) { if (ctx) ctx.resume(); return initPromise; }
  initPromise = (async () => {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(new URL("./apu.js", import.meta.url));
    const src = (await res.text()).replace(/^export .*$/m, "") + GLUE;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    node = new AudioWorkletNode(ctx, "nes-apu", { numberOfInputs: 0, outputChannelCount: [1] });
    node.port.onmessage = (e) => { if (e.data.step != null && onStep) onStep(e.data.step); };
    node.connect(ctx.destination);
    ctx.resume();
    return node;
  })();
  return initPromise;
}

export function post(msg) { if (node) node.port.postMessage(msg); }
export function audioReady() { return !!node; }
