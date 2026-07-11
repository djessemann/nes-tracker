// app.js — all UI, in nesprite's imperative style: one state object, render
// functions per region, no framework, no build step.
import { NOTE_NAMES, compileSong, renderSong } from "./apu.js";
import { initAudio, post, audioReady } from "./audio.js";
import { encodeWav, makeZip, download } from "./files.js";
import { export6502 } from "./export6502.js";

// ---------- constants ----------
const STEPS = 16;
const CHANNELS = [
  { id: "p1", label: "pulse 1", color: "#f83800" },
  { id: "p2", label: "pulse 2", color: "#0078f8" },
  { id: "tri", label: "triangle", color: "#00b800" },
  { id: "noise", label: "noise", color: "#bcbcbc" },
];
const chanColor = (id) => CHANNELS.find((c) => c.id === id).color;

// sound shapes: volume 0-15 per frame from note start; last value holds.
// plain names in the ui — "envelope" stays in code and song.s comments only.
const PULSE_SHAPES = {
  pluck: [15, 11, 8, 6, 4, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  lead: [12, 15, 14, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13],
  soft: [5, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
  long: [15, 14, 13, 13, 12, 12, 11, 11, 10, 10, 9, 9, 9, 8, 8, 8],
};
const NOISE_SHAPES = {
  crisp: [15, 10, 6, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  tight: [8, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  boom: [15, 13, 12, 10, 9, 8, 6, 5, 4, 3, 2, 2, 1, 1, 0, 0],
  wash: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
};
const shapesFor = (ch) => (ch === "noise" ? NOISE_SHAPES : PULSE_SHAPES);

const emptyPattern = () => ({
  p1: Array(STEPS).fill(null),
  p2: Array(STEPS).fill(null),
  tri: Array(STEPS).fill(null),
  noise: Array(STEPS).fill(null),
});
const defaultDoc = () => ({
  bpm: 150,
  patterns: [emptyPattern()],
  order: [0],
  chans: {
    p1: { duty: 2, vol: 12, shape: "pluck", env: [...PULSE_SHAPES.pluck] },
    p2: { duty: 1, vol: 10, shape: "soft", env: [...PULSE_SHAPES.soft] },
    tri: {},
    noise: { vol: 8, shape: "crisp", env: [...NOISE_SHAPES.crisp] },
  },
});

// ---------- storage & migration ----------
const LS_KEY = "nestracker-v2";
function migrateV1(d) {
  const pat = emptyPattern();
  for (const ch of ["p1", "p2", "tri", "noise"])
    (d.patt[ch] || []).forEach((n, s) => { if (n != null) pat[ch][s] = { n, len: 1 }; });
  const doc = defaultDoc();
  doc.patterns = [pat];
  doc.bpm = d.bpm || 150;
  if (d.duty) { doc.chans.p1.duty = d.duty[0]; doc.chans.p2.duty = d.duty[1]; }
  if (d.vol) {
    doc.chans.p1.vol = d.vol.p1 ?? 12; doc.chans.p2.vol = d.vol.p2 ?? 10;
    doc.chans.noise.vol = d.vol.noise ?? 8;
    // v1 notes were flat constant volume; "lead" is the closest shape
    doc.chans.p1.shape = doc.chans.p2.shape = "lead";
    doc.chans.p1.env = [...PULSE_SHAPES.lead]; doc.chans.p2.env = [...PULSE_SHAPES.lead];
  }
  return doc;
}
function normalizeDoc(d) {
  if (!d || !Array.isArray(d.patterns) || !Array.isArray(d.order) || !d.order.length) return null;
  return d;
}

// ---------- state ----------
const state = {
  doc: defaultDoc(),
  oct: { p1: 4, p2: 4, tri: 3 },
  tab: "p1",
  mode: "loop",   // loop = this part, song = all parts
  pos: 0,         // order slot being edited
  playing: false,
  playStep: -1,
  page: "tracker",
  shapeOpen: false,
  mute: { p1: false, p2: false, tri: false, noise: false }, // listening tool; not saved

  undo: [],
};
try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    const s = JSON.parse(raw);
    const doc = normalizeDoc(s.doc);
    if (doc) { state.doc = doc; state.oct = s.oct || state.oct; }
  }
} catch { /* fresh doc */ }

const safePos = () => Math.min(state.pos, state.doc.order.length - 1);
const curPattern = () => state.doc.patterns[state.doc.order[safePos()]];

// ---------- autosave: debounced on change, flushed when the tab hides ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function flushSave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ doc: state.doc, oct: state.oct })); } catch { /* storage blocked */ }
}
window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });

// ---------- audio sync ----------
const compiled = () => compileSong(state.doc, { mode: state.mode, loopPat: safePos() });
function syncSong() {
  if (!audioReady()) return;
  post({ cmd: "song", song: compiled() });
  post({ cmd: "mute", mute: state.mute });
}
const onStep = (s) => { if (state.playing) { state.playStep = s; renderPlayhead(); renderPos(); renderFrames(); } };

// every mutation funnels through here: save + live-update + re-render
function changed() { scheduleSave(); syncSong(); render(); }

// ---------- undo ----------
function pushUndo() {
  state.undo.push(JSON.stringify({ patterns: state.doc.patterns, order: state.doc.order }));
  if (state.undo.length > 40) state.undo.shift();
}
function doUndo() {
  const s = state.undo.pop();
  if (!s) return;
  const d = JSON.parse(s);
  state.doc.patterns = d.patterns;
  state.doc.order = d.order;
  state.pos = Math.min(state.pos, d.order.length - 1);
  changed();
}

// ---------- pattern edits ----------
// place a note, trimming or removing anything it overlaps (one note per moment per channel)
function placeNote(col, s0, n, len) {
  const L = Math.min(len, STEPS - s0);
  for (let s = 0; s < STEPS; s++) {
    const c = col[s];
    if (!c || s === s0) continue;
    if (s < s0 && s + c.len > s0) col[s] = { ...c, len: s0 - s };
    else if (s > s0 && s < s0 + L) col[s] = null;
  }
  col[s0] = { n, len: L };
}
function noteAt(col, row, step) {
  for (let s = 0; s <= step; s++) {
    const c = col[s];
    if (c && c.n === row && s + c.len > step) return s;
  }
  return null;
}

// ---------- dom lookups ----------
const $ = (id) => document.getElementById(id);
const els = {
  modeSeg: $("modeSeg"), newBtn: $("newBtn"), howtoBtn: $("howtoBtn"),
  tracker: $("tracker"), howto: $("howto"),
  playBtn: $("playBtn"), bpm: $("bpm"), pos: $("pos"),
  tabs: $("tabs"), mutes: $("mutes"), grid: $("grid"), undoBtn: $("undoBtn"), clearBtn: $("clearBtn"),
  ctrls: $("ctrls"), shapeRow: $("shapeRow"), envWrap: $("envWrap"), env: $("env"),
  orderSec: $("orderSec"), frames: $("frames"),
  addPart: $("addPart"), repeatPart: $("repeatPart"), copyPart: $("copyPart"), delPart: $("delPart"),
  saveBtn: $("saveBtn"), loadBtn: $("loadBtn"), wavBtn: $("wavBtn"), stemsBtn: $("stemsBtn"), codeBtn: $("codeBtn"),
  fileInput: $("fileInput"),
  asmModal: $("asmModal"), asmText: $("asmText"), asmCopy: $("asmCopy"), asmDl: $("asmDl"), asmClose: $("asmClose"),
  confirmModal: $("confirmModal"), confirmMsg: $("confirmMsg"), confirmOk: $("confirmOk"), confirmCancel: $("confirmCancel"),
};

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5l13 7.5-13 7.5z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>';

// ---------- confirm modal ----------
let confirmAction = null;
function confirmBox(msg, onOk) {
  confirmAction = onOk;
  els.confirmMsg.textContent = msg;
  els.confirmCancel.style.display = onOk ? "" : "none";
  els.confirmModal.hidden = false;
}
els.confirmOk.onclick = () => { const fn = confirmAction; confirmAction = null; els.confirmModal.hidden = true; if (fn) fn(); };
els.confirmCancel.onclick = () => { confirmAction = null; els.confirmModal.hidden = true; };

// ---------- grid ----------
const rowsFor = () =>
  state.tab === "noise"
    ? Array.from({ length: 16 }, (_, i) => ({ label: String(i + 1), value: i }))
    : NOTE_NAMES.map((n, i) => ({ label: n + state.oct[state.tab], value: 12 * (state.oct[state.tab] + 1) + i })).reverse();

let cellEls = {}; // "row:step" -> element, for cheap playhead + span updates
let drag = null;  // { row, anchor, existing, moved, pushed, rowEl }

const LABEL_W = 28; // keep in sync with .gridrow grid-template-columns
function stepFromX(rowEl, clientX) {
  const r = rowEl.getBoundingClientRect();
  const cellW = (r.width - LABEL_W) / STEPS;
  return Math.max(0, Math.min(STEPS - 1, Math.floor((clientX - r.left - LABEL_W) / cellW)));
}
async function previewNote(row) {
  await initAudio(onStep);
  post({ cmd: "song", song: compiled() });
  post({ cmd: "mute", mute: state.mute });
  post({ cmd: "preview", ch: state.tab, cell: { n: row, len: 1 } });
}
// during a gesture, never rebuild the grid — that would destroy the row
// element holding the pointer capture and kill the drag. paintSpans()
// restyles the existing cells in place instead.
function gestureEdit() { scheduleSave(); syncSong(); paintSpans(); }
function gridDown(e, row, rowEl) {
  rowEl.setPointerCapture(e.pointerId);
  const step = stepFromX(rowEl, e.clientX);
  const col = curPattern()[state.tab];
  const at = noteAt(col, row, step);
  if (at != null) {
    drag = { row, anchor: at, existing: true, moved: false, pushed: false, rowEl };
  } else {
    pushUndo();
    placeNote(col, step, row, 1);
    drag = { row, anchor: step, existing: false, moved: false, pushed: true, rowEl };
    previewNote(row);
    gestureEdit();
  }
}
function gridMove(e) {
  if (!drag) return;
  const step = stepFromX(drag.rowEl, e.clientX);
  const len = Math.max(1, step - drag.anchor + 1);
  const col = curPattern()[state.tab];
  const cur = col[drag.anchor];
  if (cur && cur.len !== len) {
    if (!drag.pushed) { pushUndo(); drag.pushed = true; }
    drag.moved = true;
    placeNote(col, drag.anchor, drag.row, len);
    gestureEdit();
  }
}
function gridUp() {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.existing && !d.moved) {
    pushUndo();
    curPattern()[state.tab][d.anchor] = null;
    gestureEdit();
  }
}

// span map for the current channel: "row:step" -> head | body
function spanMap() {
  const span = {};
  curPattern()[state.tab].forEach((c, s) => {
    if (!c) return;
    for (let k = 0; k < c.len && s + k < STEPS; k++) span[`${c.n}:${s + k}`] = k === 0 ? "head" : "body";
  });
  return span;
}
function paintSpans() { // restyle existing cells without rebuilding the dom
  const col = chanColor(state.tab);
  const span = spanMap();
  for (const key in cellEls) {
    const part = span[key], cell = cellEls[key];
    if (part) {
      cell.style.background = col;
      cell.style.borderColor = col;
      cell.style.opacity = part === "body" ? "0.55" : "1";
    } else {
      cell.style.background = "";
      cell.style.borderColor = "";
      cell.style.opacity = "";
    }
  }
}
function renderGrid() {
  const col = chanColor(state.tab);
  const span = spanMap();
  els.grid.innerHTML = "";
  cellEls = {};
  const playCol = playColumn();
  for (const row of rowsFor()) {
    const rowEl = document.createElement("div");
    rowEl.className = "gridrow";
    const lbl = document.createElement("div");
    lbl.className = "rowlabel";
    lbl.textContent = row.label;
    rowEl.appendChild(lbl);
    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement("div");
      cell.className = "cell" + (s % 4 === 0 ? " beat" : "") + (playCol === s ? " playing" : "");
      const part = span[`${row.value}:${s}`];
      if (part) {
        cell.style.background = col;
        cell.style.borderColor = col;
        cell.style.opacity = part === "body" ? "0.55" : "1";
      }
      cellEls[`${row.value}:${s}`] = cell;
      rowEl.appendChild(cell);
    }
    rowEl.onpointerdown = (e) => gridDown(e, row.value, rowEl);
    rowEl.onpointermove = gridMove;
    rowEl.onpointerup = gridUp;
    rowEl.onpointercancel = gridUp;
    els.grid.appendChild(rowEl);
  }
}
function playColumn() {
  if (state.playStep < 0 || !state.playing) return -1;
  if (state.mode === "song")
    return Math.floor(state.playStep / STEPS) === safePos() ? state.playStep % STEPS : -1;
  return state.playStep % STEPS;
}
function renderPlayhead() {
  const playCol = playColumn();
  for (const key in cellEls) {
    const s = +key.split(":")[1];
    cellEls[key].classList.toggle("playing", s === playCol);
  }
}

// ---------- transport ----------
async function togglePlay() {
  if (state.playing) {
    post({ cmd: "stop" });
    state.playing = false;
    state.playStep = -1;
    renderTransport(); renderPlayhead(); renderPos(); renderFrames();
    return;
  }
  await initAudio(onStep);
  post({ cmd: "mute", mute: state.mute });
  post({ cmd: "play", song: compiled() });
  state.playing = true;
  renderTransport();
}
function renderTransport() {
  els.playBtn.innerHTML = (state.playing ? ICON_STOP + "stop" : ICON_PLAY + "play");
  els.playBtn.classList.toggle("on", state.playing);
}
function renderPos() {
  const playCol = playColumn();
  els.pos.textContent =
    (state.mode === "song" ? `part ${String(safePos()).padStart(2, "0")} · ` : "") +
    `step ${playCol < 0 ? "--" : String(playCol).padStart(2, "0")}/16`;
}
// bpm: free-typing text + clamped doc value; never clamp the text in oninput
els.bpm.addEventListener("input", () => {
  const n = parseInt(els.bpm.value, 10);
  if (!isNaN(n)) { state.doc.bpm = Math.max(40, Math.min(300, n)); scheduleSave(); syncSong(); }
});
els.bpm.addEventListener("blur", () => { els.bpm.value = String(state.doc.bpm); });

// ---------- tabs + per-channel controls ----------
function renderTabs() {
  els.tabs.innerHTML = "";
  els.mutes.innerHTML = "";
  for (const c of CHANNELS) {
    const b = document.createElement("button");
    b.className = "btn tab";
    b.textContent = c.label;
    if (state.tab === c.id) {
      b.style.background = c.color; b.style.color = "#000"; b.style.borderColor = c.color; b.style.fontWeight = "700";
    } else {
      b.style.color = c.color; b.style.borderColor = "var(--soft)";
    }
    if (state.mute[c.id]) b.style.opacity = "0.35";
    b.onclick = () => { state.tab = c.id; state.shapeOpen = false; render(); };
    els.tabs.appendChild(b);

    const m = document.createElement("button");
    m.className = "btn" + (state.mute[c.id] ? " on" : "");
    m.textContent = state.mute[c.id] ? "muted" : "mute";
    m.onclick = async () => {
      state.mute[c.id] = !state.mute[c.id];
      if (audioReady()) post({ cmd: "mute", mute: state.mute });
      renderTabs();
    };
    els.mutes.appendChild(m);
  }
}
function seg(options, value, onPick) {
  const wrap = document.createElement("span");
  wrap.className = "modeseg";
  options.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.classList.toggle("on", value === (typeof options[0] === "string" ? name : i));
    b.onclick = () => onPick(name, i);
    wrap.appendChild(b);
  });
  return wrap;
}
function group(label, ...nodes) {
  const g = document.createElement("span");
  g.className = "ctrlGroup";
  g.append(label, ...nodes);
  return g;
}
function renderCtrls() {
  const tab = state.tab, chan = state.doc.chans[tab], col = chanColor(tab);
  els.ctrls.innerHTML = "";
  if (tab === "p1" || tab === "p2") {
    const tones = ["thin", "medium", "full"];
    const s = seg(tones, tones[chan.duty], (_, i) => { chan.duty = i; changed(); });
    els.ctrls.appendChild(group("tone", s));
  }
  if (tab !== "noise") {
    const minus = document.createElement("button");
    minus.className = "btn sm"; minus.textContent = "−";
    minus.onclick = () => { state.oct[tab] = Math.max(1, state.oct[tab] - 1); changed(); };
    const val = document.createElement("span");
    val.className = "octval"; val.textContent = state.oct[tab];
    const plus = document.createElement("button");
    plus.className = "btn sm"; plus.textContent = "+";
    plus.onclick = () => { state.oct[tab] = Math.min(7, state.oct[tab] + 1); changed(); };
    els.ctrls.appendChild(group("octave", minus, val, plus));
  }
  if (tab !== "tri") {
    const r = document.createElement("input");
    r.type = "range"; r.min = 0; r.max = 15; r.value = chan.vol;
    r.style.width = "80px"; r.style.accentColor = col;
    const val = document.createElement("span");
    val.className = "octval"; val.textContent = chan.vol;
    r.oninput = () => { chan.vol = +r.value; val.textContent = r.value; scheduleSave(); syncSong(); };
    els.ctrls.appendChild(group("volume", r, val));
  }

  els.shapeRow.innerHTML = "";
  if (tab !== "tri") {
    const names = Object.keys(shapesFor(tab));
    const s = seg(names, chan.shape, (name) => {
      chan.shape = name;
      chan.env = [...shapesFor(tab)[name]];
      changed();
    });
    els.shapeRow.appendChild(group("shape", s));
    const edit = document.createElement("button");
    edit.className = "btn sm";
    edit.textContent = state.shapeOpen ? "done" : "edit";
    edit.onclick = () => { state.shapeOpen = !state.shapeOpen; render(); };
    els.shapeRow.appendChild(edit);
  }
  renderEnv();
}
function renderEnv() {
  const tab = state.tab, open = state.shapeOpen && tab !== "tri";
  els.envWrap.style.display = open ? "" : "none";
  if (!open) return;
  const chan = state.doc.chans[tab], col = chanColor(tab);
  els.env.innerHTML = "";
  chan.env.forEach((v) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = Math.max(4, (v / 15) * 100) + "%";
    bar.style.background = v ? col : "#333";
    els.env.appendChild(bar);
  });
}
function envPaint(e) {
  const r = els.env.getBoundingClientRect();
  const i = Math.max(0, Math.min(15, Math.floor(((e.clientX - r.left) / r.width) * 16)));
  const v = Math.max(0, Math.min(15, Math.round((1 - (e.clientY - r.top) / r.height) * 15)));
  const chan = state.doc.chans[state.tab];
  if (chan.env[i] === v && chan.shape === "custom") return;
  chan.env[i] = v;
  chan.shape = "custom";
  scheduleSave(); syncSong(); renderEnv(); renderShapeSeg();
}
function renderShapeSeg() { // refresh the shape buttons' active state without a full re-render
  const chan = state.doc.chans[state.tab];
  els.shapeRow.querySelectorAll(".modeseg button").forEach((b) => b.classList.toggle("on", b.textContent === chan.shape));
}
els.env.onpointerdown = (e) => { els.env.setPointerCapture(e.pointerId); envPaint(e); };
els.env.onpointermove = (e) => { if (e.buttons) envPaint(e); };

// ---------- song structure ----------
function renderFrames() {
  const showOrder = state.mode === "song" || state.doc.order.length > 1;
  els.orderSec.style.display = showOrder ? "" : "none";
  if (!showOrder) return;
  const playSlot = state.playing && state.mode === "song" ? Math.floor(state.playStep / STEPS) : -1;
  els.frames.innerHTML = "";
  state.doc.order.forEach((pid, i) => {
    const f = document.createElement("div");
    f.className = "frame" + (i === safePos() ? " on" : "");
    f.innerHTML = `<b>${String(pid).padStart(2, "0")}</b><small>${playSlot === i ? "▶ " : ""}part ${i}</small>`;
    f.onclick = () => { state.pos = i; changed(); };
    els.frames.appendChild(f);
  });
  els.delPart.disabled = state.doc.order.length <= 1;
}
els.addPart.onclick = () => {
  pushUndo();
  state.doc.patterns.push(emptyPattern());
  state.doc.order.push(state.doc.patterns.length - 1);
  state.pos = state.doc.order.length - 1;
  changed();
};
els.repeatPart.onclick = () => {
  pushUndo();
  state.doc.order.splice(safePos() + 1, 0, state.doc.order[safePos()]);
  state.pos = safePos() + 1;
  changed();
};
els.copyPart.onclick = () => {
  pushUndo();
  const src = curPattern();
  state.doc.patterns.push({ p1: src.p1.slice(), p2: src.p2.slice(), tri: src.tri.slice(), noise: src.noise.slice() });
  state.doc.order.splice(safePos() + 1, 0, state.doc.patterns.length - 1);
  state.pos = safePos() + 1;
  changed();
};
els.delPart.onclick = () => {
  if (state.doc.order.length <= 1) return;
  pushUndo();
  state.doc.order.splice(safePos(), 1);
  state.pos = Math.max(0, safePos() - 1);
  changed();
};

// ---------- header ----------
els.modeSeg.querySelectorAll("button").forEach((b) => {
  b.onclick = () => { state.mode = b.dataset.mode; changed(); };
});
els.howtoBtn.onclick = () => {
  state.page = state.page === "howto" ? "tracker" : "howto";
  render();
};
els.newBtn.onclick = () =>
  confirmBox("start a new song? the current one is erased (save it first if you want to keep it).", () => {
    state.undo = [];
    state.doc = defaultDoc();
    state.pos = 0; state.mode = "loop"; state.playStep = -1;
    if (state.playing) { post({ cmd: "stop" }); state.playing = false; }
    els.bpm.value = "150";
    changed();
  });

// ---------- exports / save / load ----------
function runBusy(fn) {
  for (const b of [els.wavBtn, els.stemsBtn]) b.disabled = true;
  els.wavBtn.textContent = "…";
  setTimeout(() => {
    try { fn(); } finally {
      for (const b of [els.wavBtn, els.stemsBtn]) b.disabled = false;
      els.wavBtn.textContent = "audio";
    }
  }, 30);
}
els.wavBtn.onclick = () =>
  runBusy(() => {
    const data = renderSong(state.doc, { mode: state.mode, loopPat: safePos(), loops: state.mode === "loop" ? 2 : 1 });
    download(encodeWav(data), "nestracker-song.wav", "audio/wav");
  });
els.stemsBtn.onclick = () =>
  runBusy(() => {
    const files = [];
    for (const c of CHANNELS) {
      const scope = state.mode === "song" ? state.doc.order : [state.doc.order[safePos()]];
      if (!scope.some((pi) => state.doc.patterns[pi][c.id].some((x) => x != null))) continue;
      const data = renderSong(state.doc, { mode: state.mode, loopPat: safePos(), loops: state.mode === "loop" ? 2 : 1, solo: c.id });
      files.push({ name: `nestracker-${c.id}.wav`, data: encodeWav(data) });
    }
    if (!files.length) return;
    if (files.length === 1) download(files[0].data, files[0].name, "audio/wav");
    else download(makeZip(files), "nestracker-stems.zip", "application/zip");
  });
els.codeBtn.onclick = () => {
  els.asmText.textContent = export6502(state.doc);
  els.asmModal.hidden = false;
};
els.asmClose.onclick = () => { els.asmModal.hidden = true; };
els.asmModal.onclick = (e) => { if (e.target === els.asmModal) els.asmModal.hidden = true; };
els.asmCopy.onclick = () => navigator.clipboard?.writeText(els.asmText.textContent);
els.asmDl.onclick = () => download(els.asmText.textContent, "song.s", "text/plain");

els.saveBtn.onclick = () =>
  download(JSON.stringify({ format: "nestracker-v2", ...state.doc, oct: state.oct }, null, 1), "nestracker-song.json", "application/json");
els.loadBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      const doc = d.patt ? migrateV1(d) : normalizeDoc(d);
      if (!doc) throw new Error();
      pushUndo();
      state.doc = doc;
      if (d.oct) state.oct = d.oct;
      state.pos = 0;
      els.bpm.value = String(doc.bpm);
      changed();
    } catch {
      confirmBox("couldn't read that file — it doesn't look like a nestracker song.", null);
    }
  };
  r.readAsText(f);
  e.target.value = "";
};

els.undoBtn.onclick = doUndo;
els.clearBtn.onclick = () => {
  pushUndo();
  curPattern()[state.tab] = Array(STEPS).fill(null);
  changed();
};
els.playBtn.onclick = togglePlay;

// ---------- top-level render ----------
function render() {
  els.tracker.style.display = state.page === "howto" ? "none" : "";
  els.howto.style.display = state.page === "howto" ? "" : "none";
  els.howtoBtn.textContent = state.page === "howto" ? "back" : "how to";
  els.modeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
  if (state.page === "howto") return;
  renderTransport();
  renderPos();
  renderTabs();
  renderGrid();
  renderCtrls();
  renderFrames();
}

els.bpm.value = String(state.doc.bpm);
render();
