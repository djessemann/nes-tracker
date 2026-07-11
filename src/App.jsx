import { useState, useRef, useEffect, useCallback } from "react";
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
function loadInitial() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const doc = normalizeDoc(s.doc);
      if (doc) return { doc, oct: s.oct || { p1: 4, p2: 4, tri: 3 } };
    }
  } catch { /* fall through to a fresh doc */ }
  return { doc: defaultDoc(), oct: { p1: 4, p2: 4, tri: 3 } };
}

// ---------- component ----------
export default function NesTracker() {
  const boot = useRef(loadInitial()).current;
  const [doc, setDoc] = useState(boot.doc);
  const [oct, setOct] = useState(boot.oct);
  const [tab, setTab] = useState("p1");
  const [mode, setMode] = useState("loop"); // loop = this part, song = all parts
  const [pos, setPos] = useState(0); // order slot being edited
  const [bpmText, setBpmText] = useState(String(boot.doc.bpm));
  const [playing, setPlaying] = useState(false);
  const [playStep, setPlayStep] = useState(-1);
  const [page, setPage] = useState("tracker");
  const [asmText, setAsmText] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { msg, onOk }
  const [shapeOpen, setShapeOpen] = useState(false);

  const safePos = Math.min(pos, doc.order.length - 1);
  const patId = doc.order[safePos];
  const pattern = doc.patterns[patId];

  const undoRef = useRef([]);
  const playingRef = useRef(false);
  playingRef.current = playing;

  // ----- autosave: debounced on change, flushed when the tab hides/closes -----
  const saveRef = useRef(null);
  saveRef.current = { doc, oct };
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ doc, oct })); } catch { /* storage blocked; skip */ }
    }, 300);
    return () => clearTimeout(t);
  }, [doc, oct]);
  useEffect(() => {
    const flush = () => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(saveRef.current)); } catch { /* storage blocked; skip */ }
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // ----- live song sync: whatever changes, the worklet hears it -----
  const compiled = useCallback(
    () => compileSong(doc, { mode, loopPat: safePos }),
    [doc, mode, safePos]
  );
  useEffect(() => {
    if (audioReady()) post({ cmd: "song", song: compiled() });
  }, [compiled]);

  const play = async () => {
    if (playing) { post({ cmd: "stop" }); setPlaying(false); setPlayStep(-1); return; }
    await initAudio((s) => { if (playingRef.current) setPlayStep(s); });
    post({ cmd: "play", song: compiled() });
    setPlaying(true);
  };
  useEffect(() => () => post({ cmd: "stop" }), []);

  // ----- undo -----
  const pushUndo = () => {
    undoRef.current.push(JSON.stringify({ patterns: doc.patterns, order: doc.order }));
    if (undoRef.current.length > 40) undoRef.current.shift();
  };
  const undo = () => {
    const s = undoRef.current.pop();
    if (!s) return;
    const d = JSON.parse(s);
    setDoc((cur) => ({ ...cur, patterns: d.patterns, order: d.order }));
    setPos((p) => Math.min(p, d.order.length - 1));
  };

  // ----- pattern edits -----
  const setCells = (ch, fn) =>
    setDoc((d) => {
      const pid = d.order[Math.min(safePos, d.order.length - 1)];
      const pats = d.patterns.slice();
      const pat = { ...pats[pid] };
      pat[ch] = fn(pat[ch].slice());
      pats[pid] = pat;
      return { ...d, patterns: pats };
    });
  // place a note, trimming or removing anything it overlaps (one note per moment per channel)
  const placeNote = (col, s0, n, len) => {
    const L = Math.min(len, STEPS - s0);
    for (let s = 0; s < STEPS; s++) {
      const c = col[s];
      if (!c || s === s0) continue;
      if (s < s0 && s + c.len > s0) col[s] = { ...c, len: s0 - s };
      else if (s > s0 && s < s0 + L) col[s] = null;
    }
    col[s0] = { n, len: L };
    return col;
  };
  const noteAt = (col, row, step) => {
    for (let s = 0; s <= step; s++) {
      const c = col[s];
      if (c && c.n === row && s + c.len > step) return s;
    }
    return null;
  };

  // ----- grid gestures: tap = place/erase, drag right = hold the note -----
  const dragRef = useRef(null);
  const stepFromX = (rowEl, clientX) => {
    const r = rowEl.getBoundingClientRect();
    const cellW = (r.width - 34) / STEPS;
    return Math.max(0, Math.min(STEPS - 1, Math.floor((clientX - r.left - 34) / cellW)));
  };
  const gridDown = (e, row) => {
    const rowEl = e.currentTarget;
    rowEl.setPointerCapture(e.pointerId);
    const step = stepFromX(rowEl, e.clientX);
    const col = pattern[tab];
    const at = noteAt(col, row, step);
    if (at != null) {
      dragRef.current = { row, anchor: at, existing: true, moved: false, pushed: false, rowEl };
    } else {
      pushUndo();
      setCells(tab, (c) => placeNote(c, step, row, 1));
      dragRef.current = { row, anchor: step, existing: false, moved: false, pushed: true, rowEl };
      previewNote(row);
    }
  };
  const gridMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const step = stepFromX(d.rowEl, e.clientX);
    const len = Math.max(1, step - d.anchor + 1);
    const cur = pattern[tab][d.anchor];
    if (cur && cur.len !== len) {
      if (!d.pushed) { pushUndo(); d.pushed = true; }
      d.moved = true;
      setCells(tab, (c) => placeNote(c, d.anchor, d.row, len));
    }
  };
  const gridUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.existing && !d.moved) {
      pushUndo();
      setCells(tab, (c) => { c[d.anchor] = null; return c; });
    }
  };
  const previewNote = async (row) => {
    await initAudio((s) => { if (playingRef.current) setPlayStep(s); });
    post({ cmd: "song", song: compiled() });
    post({ cmd: "preview", ch: tab, cell: { n: row, len: 1 } });
  };

  const clearChannel = () => { pushUndo(); setCells(tab, (c) => c.map(() => null)); };

  // ----- rows for the grid -----
  const rows =
    tab === "noise"
      ? Array.from({ length: 16 }, (_, i) => ({ label: String(i + 1), value: i }))
      : NOTE_NAMES.map((n, i) => ({ label: n + oct[tab], value: 12 * (oct[tab] + 1) + i }))
          .slice()
          .reverse();

  // ----- song structure -----
  const addPart = () => {
    pushUndo();
    setDoc((d) => ({ ...d, patterns: [...d.patterns, emptyPattern()], order: [...d.order, d.patterns.length] }));
    setPos(doc.order.length);
  };
  const repeatPart = () => {
    pushUndo();
    setDoc((d) => {
      const o = d.order.slice();
      o.splice(safePos + 1, 0, o[safePos]);
      return { ...d, order: o };
    });
    setPos(safePos + 1);
  };
  const copyPart = () => {
    pushUndo();
    setDoc((d) => {
      const src = d.patterns[d.order[safePos]];
      const copy = { p1: src.p1.slice(), p2: src.p2.slice(), tri: src.tri.slice(), noise: src.noise.slice() };
      const o = d.order.slice();
      o.splice(safePos + 1, 0, d.patterns.length);
      return { ...d, patterns: [...d.patterns, copy], order: o };
    });
    setPos(safePos + 1);
  };
  const deletePart = () => {
    if (doc.order.length <= 1) return;
    pushUndo();
    setDoc((d) => {
      const o = d.order.slice();
      o.splice(safePos, 1);
      return { ...d, order: o };
    });
    setPos(Math.max(0, safePos - 1));
  };

  // ----- sound (per-channel) -----
  const setChan = (ch, patch) =>
    setDoc((d) => ({ ...d, chans: { ...d.chans, [ch]: { ...d.chans[ch], ...patch } } }));
  const setShape = (name) =>
    setChan(tab, { shape: name, env: [...shapesFor(tab)[name]] });
  const envRef = useRef(null);
  const envPaint = (e) => {
    const r = envRef.current.getBoundingClientRect();
    const i = Math.max(0, Math.min(15, Math.floor(((e.clientX - r.left) / r.width) * 16)));
    const v = Math.max(0, Math.min(15, Math.round((1 - (e.clientY - r.top) / r.height) * 15)));
    setDoc((d) => {
      const env = d.chans[tab].env.slice();
      env[i] = v;
      return { ...d, chans: { ...d.chans, [tab]: { ...d.chans[tab], env, shape: "custom" } } };
    });
  };

  // ----- exports -----
  const runBusy = (fn) => { setBusy(true); setTimeout(async () => { try { await fn(); } finally { setBusy(false); } }, 30); };
  const exportWav = () =>
    runBusy(() => {
      const data = renderSong(doc, { mode, loopPat: safePos, loops: mode === "loop" ? 2 : 1 });
      download(encodeWav(data), "nestracker-song.wav", "audio/wav");
    });
  const exportStems = () =>
    runBusy(() => {
      const files = [];
      for (const c of CHANNELS) {
        const has = (mode === "song" ? doc.order : [patId]).some((pi) =>
          doc.patterns[pi][c.id].some((x) => x != null));
        if (!has) continue;
        const data = renderSong(doc, { mode, loopPat: safePos, loops: mode === "loop" ? 2 : 1, solo: c.id });
        files.push({ name: `nestracker-${c.id}.wav`, data: encodeWav(data) });
      }
      if (!files.length) return;
      if (files.length === 1) download(files[0].data, files[0].name, "audio/wav");
      else download(makeZip(files), "nestracker-stems.zip", "application/zip");
    });
  const exportCode = () => setAsmText(export6502(doc));

  // ----- save / load / new -----
  const save = () =>
    download(JSON.stringify({ format: "nestracker-v2", ...doc, oct }, null, 1), "nestracker-song.json", "application/json");
  const fileRef = useRef(null);
  const load = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        const doc2 = d.patt ? migrateV1(d) : normalizeDoc(d);
        if (!doc2) throw new Error();
        pushUndo();
        setDoc(doc2);
        if (d.oct) setOct(d.oct);
        setBpmText(String(doc2.bpm));
        setPos(0);
      } catch {
        setConfirm({ msg: "couldn't read that file — it doesn't look like a nestracker song.", onOk: null });
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };
  const newSong = () =>
    setConfirm({
      msg: "start a new song? the current one is erased (save it first if you want to keep it).",
      onOk: () => {
        undoRef.current = [];
        setDoc(defaultDoc());
        setBpmText("150");
        setPos(0); setMode("loop"); setPlayStep(-1);
        if (playing) { post({ cmd: "stop" }); setPlaying(false); }
      },
    });

  // ----- derived view bits -----
  const col = chanColor(tab);
  const playCol = playStep < 0 ? -1
    : mode === "song"
      ? (Math.floor(playStep / STEPS) === safePos ? playStep % STEPS : -1)
      : playStep % STEPS;
  const playSlot = playing && mode === "song" ? Math.floor(playStep / STEPS) : -1;
  const showOrder = mode === "song" || doc.order.length > 1;
  const chan = doc.chans[tab];

  // active spans per row for the current channel: "row:step" -> head | body
  const spanMap = {};
  pattern[tab].forEach((c, s) => {
    if (!c) return;
    for (let k = 0; k < c.len && s + k < STEPS; k++)
      spanMap[`${c.n}:${s + k}`] = k === 0 ? "head" : "body";
  });

  return (
    <div className="app">
      <style>{CSS}</style>

      <header>
        <h1>nestracker</h1>
        <div className="modeseg">
          <button className={mode === "loop" ? "on" : ""} onClick={() => setMode("loop")}>loop</button>
          <button className={mode === "song" ? "on" : ""} onClick={() => setMode("song")}>song</button>
        </div>
        <div className="hdr-actions">
          <button className="howto-link" onClick={newSong}>new</button>
          <button className="howto-link" onClick={() => setPage(page === "howto" ? "tracker" : "howto")}>
            {page === "howto" ? "back" : "how to"}
          </button>
        </div>
      </header>

      {page === "howto" ? (
        <HowTo />
      ) : (
        <div className="layout">
          <div className="left">
            <div className="transport">
              <button className={"btn play" + (playing ? " on" : "")} onClick={play}>
                {playing ? <Sq /> : <Tri />}{playing ? "stop" : "play"}
              </button>
              <label className="stat">
                tempo{" "}
                <input
                  className="num" type="number" inputMode="numeric" min="40" max="300" value={bpmText}
                  onChange={(e) => {
                    setBpmText(e.target.value);
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n)) setDoc((d) => ({ ...d, bpm: Math.max(40, Math.min(300, n)) }));
                  }}
                  onBlur={() => setBpmText(String(doc.bpm))}
                />
              </label>
              <span className="pos">
                {mode === "song" ? `part ${String(safePos).padStart(2, "0")} · ` : ""}
                step {playCol < 0 ? "--" : String(playCol).padStart(2, "0")}/16
              </span>
            </div>

            <nav className="tabs">
              {CHANNELS.map((c) => (
                <button
                  key={c.id}
                  className="btn tab"
                  onClick={() => { setTab(c.id); setShapeOpen(false); }}
                  style={tab === c.id
                    ? { background: c.color, color: "#000", borderColor: c.color, fontWeight: 700 }
                    : { color: c.color, borderColor: "var(--soft)" }}
                >
                  {c.label}
                </button>
              ))}
            </nav>

            <section className="gridwrap">
              <div className="grid">
                {rows.map((row) => (
                  <div
                    className="gridrow" key={row.value}
                    onPointerDown={(e) => gridDown(e, row.value)}
                    onPointerMove={gridMove}
                    onPointerUp={gridUp}
                    onPointerCancel={gridUp}
                  >
                    <div className="rowlabel">{row.label}</div>
                    {Array.from({ length: STEPS }, (_, s) => {
                      const part = spanMap[`${row.value}:${s}`];
                      const style = part
                        ? { background: col, opacity: part === "body" ? 0.55 : 1, borderColor: col }
                        : null;
                      return (
                        <div
                          key={s}
                          className={"cell" + (s % 4 === 0 ? " beat" : "") + (playCol === s ? " playing" : "")}
                          style={style}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>
            <div className="row under">
              <span className="stat hint">tap to place · tap again to erase · drag right to hold</span>
              <button className="btn sm" onClick={undo}>↶ undo</button>
              <button className="btn sm" onClick={clearChannel}>clear</button>
            </div>
          </div>

          <div className="right">
            <h2>sound</h2>
            <section className="chanControls">
              {(tab === "p1" || tab === "p2") && (
                <span className="ctrlGroup">
                  tone
                  <span className="modeseg">
                    {["thin", "medium", "full"].map((d, i) => (
                      <button key={d} className={chan.duty === i ? "on" : ""} onClick={() => setChan(tab, { duty: i })}>{d}</button>
                    ))}
                  </span>
                </span>
              )}
              {tab !== "noise" && (
                <span className="ctrlGroup">
                  octave
                  <button className="btn sm" onClick={() => setOct((o) => ({ ...o, [tab]: Math.max(1, o[tab] - 1) }))}>−</button>
                  <span className="octval">{oct[tab]}</span>
                  <button className="btn sm" onClick={() => setOct((o) => ({ ...o, [tab]: Math.min(7, o[tab] + 1) }))}>+</button>
                </span>
              )}
              {tab !== "tri" && (
                <span className="ctrlGroup">
                  volume
                  <input
                    type="range" min="0" max="15" value={chan.vol}
                    onChange={(e) => setChan(tab, { vol: +e.target.value })}
                    style={{ width: 80, accentColor: col }}
                  />
                  <span className="octval">{chan.vol}</span>
                </span>
              )}
            </section>
            {tab !== "tri" && (
              <section className="chanControls">
                <span className="ctrlGroup">
                  shape
                  <span className="modeseg">
                    {Object.keys(shapesFor(tab)).map((name) => (
                      <button key={name} className={chan.shape === name ? "on" : ""} onClick={() => setShape(name)}>{name}</button>
                    ))}
                  </span>
                </span>
                <button className="btn sm" onClick={() => setShapeOpen(!shapeOpen)}>
                  {shapeOpen ? "done" : "edit"}
                </button>
              </section>
            )}
            {shapeOpen && tab !== "tri" && (
              <>
                <div
                  className="env" ref={envRef}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); envPaint(e); }}
                  onPointerMove={(e) => { if (e.buttons) envPaint(e); }}
                >
                  {chan.env.map((v, i) => (
                    <div key={i} className="bar" style={{ height: `${Math.max(4, (v / 15) * 100)}%`, background: v ? col : "#333" }} />
                  ))}
                </div>
                <p className="stat hint" style={{ margin: "6px 0 0" }}>
                  how each note fades — left is the start of the note, drag to draw
                  {chan.shape === "custom" ? " (custom)" : ""}
                </p>
              </>
            )}
            {tab === "tri" && (
              <p className="stat hint" style={{ margin: "4px 0 0" }}>
                the triangle always plays at one loudness — that's how the real console works
              </p>
            )}

            {showOrder ? (
              <>
                <h2>song</h2>
                <div className="frames">
                  {doc.order.map((pid, i) => (
                    <div
                      key={i}
                      className={"frame" + (i === safePos ? " on" : "")}
                      onClick={() => setPos(i)}
                    >
                      <b>{String(pid).padStart(2, "0")}</b>
                      <small>{playSlot === i ? "▶ " : ""}part {i}</small>
                    </div>
                  ))}
                </div>
                <div className="grid4">
                  <button className="btn" onClick={addPart}>+ new</button>
                  <button className="btn" onClick={repeatPart}>repeat</button>
                  <button className="btn" onClick={copyPart}>copy</button>
                  <button className="btn" onClick={deletePart} disabled={doc.order.length <= 1}>delete</button>
                </div>
                <p className="stat hint" style={{ margin: "6px 0 0" }}>
                  repeat plays the same part again · copy makes a version you can change
                </p>
              </>
            ) : (
              <>
                <h2>song</h2>
                <p className="stat hint" style={{ margin: 0 }}>
                  switch to <b>song</b> up top to chain parts into a longer piece
                </p>
              </>
            )}

            <h2>keep &amp; share</h2>
            <div className="grid2">
              <button className="btn" onClick={save}>save</button>
              <button className="btn" onClick={() => fileRef.current.click()}>load</button>
            </div>
            <div className="grid3" style={{ marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={exportWav}>{busy ? "…" : "audio"}</button>
              <button className="btn" disabled={busy} onClick={exportStems}>stems</button>
              <button className="btn" onClick={exportCode}>code</button>
            </div>
            <p className="stat hint" style={{ margin: "6px 0 0" }}>
              audio = wav of {mode === "loop" ? "this part, twice through" : "the whole song"} ·
              stems = one wav per sound · code = for nes games
            </p>
            <input ref={fileRef} type="file" accept=".json" onChange={load} style={{ display: "none" }} />
          </div>
        </div>
      )}

      {asmText && (
        <div className="modal-overlay" onClick={() => setAsmText(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-bar">
              <span>song.s</span>
              <span className="row">
                <button className="btn sm" onClick={() => navigator.clipboard?.writeText(asmText)}>copy</button>
                <button className="btn sm" onClick={() => download(asmText, "song.s", "text/plain")}>download</button>
                <button className="btn sm" onClick={() => setAsmText(null)}>×</button>
              </span>
            </div>
            <pre className="asm">{asmText}</pre>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal-overlay">
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-msg">{confirm.msg}</p>
            <div className="modal-actions">
              {confirm.onOk && <button className="btn" onClick={() => setConfirm(null)}>cancel</button>}
              <button className="btn on" onClick={() => { confirm.onOk?.(); setConfirm(null); }}>ok</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const Tri = () => <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7 4.5l13 7.5-13 7.5z" /></svg>;
const Sq = () => <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" /></svg>;

// ---------- how to ----------
function HowTo() {
  return (
    <div className="howto">
      <h2>what is this</h2>
      <p>
        a little music maker that sounds like an old nintendo. tap squares to place notes,
        press play to hear them loop, and export your song when you like it.
        everything happens in your browser, and your work is saved automatically on this device.
      </p>

      <h2>the four sounds</h2>
      <p>
        <b style={{ color: "#f83800" }}>pulse 1</b> and <b style={{ color: "#0078f8" }}>pulse 2</b> —
        the bright, beepy melody sounds. the <code>tone</code> switch makes them thinner and buzzier
        or rounder and fuller.
      </p>
      <p>
        <b style={{ color: "#00b800" }}>triangle</b> — soft and deep. good for basslines.
        it always plays at one loudness, just like on the real console.
      </p>
      <p>
        <b style={{ color: "#bcbcbc" }}>noise</b> — static, for drums. row 1 is short and crisp
        (think hi-hats), higher numbers get deeper and boomier.
      </p>

      <h2>placing notes</h2>
      <p>
        pick a sound, then tap squares. up and down is pitch, left to right is time.
        tap a note again to erase it. <b>drag to the right to hold a note longer</b> —
        long triangle notes make great basslines. each sound can only play one note
        at a time — a real limit of the console.
      </p>
      <p>
        <code>octave − / +</code> shifts the grid higher or lower. notes you placed elsewhere
        keep playing even when they scroll out of view. <code>undo</code> takes back your
        last change, and placing a note plays it so you can hear what you're getting.
      </p>

      <h2>shaping the sound</h2>
      <p>
        each sound has a <code>shape</code> — how a note fades after it starts.
        <code> pluck</code> hits and dies away, <code>lead</code> holds strong,
        <code> soft</code> swells in gently, <code>long</code> fades slowly.
        tap <code>edit</code> to draw your own with your finger.
      </p>

      <h2>building a song</h2>
      <p>
        the <code>loop | song</code> switch at the top: <code>loop</code> plays just the part
        you're editing, over and over — good for sketching. <code>song</code> plays all your
        parts in a row.
      </p>
      <p>
        in song view: <code>+ new</code> adds an empty part, <code>repeat</code> plays the same
        part again (edit one, both change), <code>copy</code> makes a separate version you can
        change, <code>delete</code> removes one. tap a part to edit it.
      </p>

      <h2>saving</h2>
      <p>
        your song autosaves on this device. <code>save</code> downloads it as a small file you can
        keep or share; <code>load</code> opens one again — including songs from the older
        version of this app. nothing is stored online.
      </p>

      <h2>exporting</h2>
      <p>
        <code>audio</code> downloads your music as a sound file (wav).
        <code> stems</code> gives you a separate wav for each sound, zipped together,
        so you can mix them in other apps.
      </p>
      <p>
        <code>code</code> is for programmers: it turns your song into a single file that plays
        in a real nes game — the music data plus a small player. how to wire it up is explained
        at the top of the file. if that means nothing to you, you can happily ignore this button.
      </p>

      <h2>not here yet</h2>
      <p>
        no slides, vibrato, or echo effects, and no sampled drums — those are on the list.
      </p>
    </div>
  );
}

// ---------- styles — nesprite's design system, verbatim tokens ----------
const CSS = `
  :root {
    --bg: #000000; --ink: #ffffff; --line: #ffffff; --muted: #999999; --soft: #666666;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  .app { max-width: 640px; margin: 0 auto; padding: 0 12px 48px; }

  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    display: flex; align-items: center; gap: 10px; padding: 14px 2px 12px;
    border-bottom: 1px solid var(--line); margin-bottom: 14px;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: .5px; }
  .hdr-actions { margin-left: auto; display: flex; gap: 8px; }
  .howto-link { color: var(--ink); background: var(--bg); font: inherit; font-size: 12px;
                border: 1px solid var(--line); padding: 7px 11px; cursor: pointer; border-radius: 0; }

  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted);
       margin: 18px 0 8px; font-weight: 700; }

  .btn, .num {
    font: inherit; color: var(--ink); background: var(--bg);
    border: 1px solid var(--line); border-radius: 0; padding: 9px 11px; cursor: pointer;
  }
  .btn:active { background: #222; }
  .btn.on { background: var(--ink); color: #000; border-color: var(--ink); font-weight: 700; }
  .btn:disabled { opacity: .4; cursor: default; }
  .btn.sm { padding: 6px 10px; font-size: 12px; }
  .btn:focus-visible, .howto-link:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .num { width: 58px; text-align: center; padding: 8px 4px; cursor: text; }

  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
  .hint { line-height: 1.5; display: inline; }
  .hint b, .hint code { color: var(--ink); font: inherit; font-weight: 700; }

  .modeseg { display: inline-flex; }
  .modeseg button {
    font: inherit; color: var(--ink); background: var(--bg); cursor: pointer;
    border: 1px solid var(--line); border-radius: 0; font-size: 12px; padding: 7px 12px; letter-spacing: .5px;
  }
  .modeseg button + button { border-left-width: 0; }
  .modeseg button.on { background: var(--ink); color: #000; font-weight: 700; }
  .modeseg button:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }

  .transport { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .btn.play { width: 92px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  .transport .pos { margin-left: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
  .tabs .btn { padding: 9px 2px; font-size: 12px; }

  .gridwrap { border: 1px solid var(--line); overflow-x: auto; }
  .grid { display: flex; flex-direction: column; gap: 2px; padding: 4px; min-width: 430px; }
  .gridrow { display: grid; grid-template-columns: 34px repeat(16, 1fr); gap: 2px; height: 26px; touch-action: none; }
  .rowlabel { color: var(--soft); font-size: 10px; display: flex; align-items: center; padding-left: 2px;
              user-select: none; -webkit-user-select: none;
              position: sticky; left: 4px; background: var(--bg); z-index: 1; }
  .cell { background: #0d0d0d; border: 1px solid #262626; pointer-events: none; }
  .cell.beat { background: #1c1c1c; }
  .cell.playing { border-color: var(--ink); }
  .under { justify-content: flex-end; margin-top: 6px; }
  .under .hint { margin-right: auto; }

  .chanControls { display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
                  padding: 2px 0 8px; color: var(--muted); font-size: 12px; }
  .ctrlGroup { display: flex; gap: 6px; align-items: center; }
  .octval { min-width: 18px; text-align: center; color: var(--ink); }
  .chanControls .modeseg button { padding: 6px 10px; }

  .env { display: flex; align-items: flex-end; gap: 2px; height: 82px; border: 1px solid var(--line);
         padding: 6px; touch-action: none; cursor: pointer; }
  .env .bar { flex: 1; min-height: 3px; }

  .frames { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 8px; }
  .frame { flex: 0 0 auto; border: 1px solid var(--line); background: var(--bg);
           padding: 5px 10px; cursor: pointer; text-align: center; }
  .frame.on { box-shadow: 0 0 0 2px var(--ink); }
  .frame b { display: block; font-size: 15px; }
  .frame small { color: var(--muted); font-size: 10px; white-space: nowrap; }

  .modal-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.72);
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  .modal { background: var(--bg); border: 1px solid var(--line); width: 100%; max-width: 360px; padding: 18px; }
  .modal.wide { max-width: 560px; max-height: 80vh; display: flex; flex-direction: column; padding: 0; }
  .modal-msg { margin: 0 0 16px; color: var(--ink); line-height: 1.5; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
  .modal-bar { display: flex; justify-content: space-between; align-items: center;
               padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .asm { margin: 0; padding: 10px; overflow: auto; font-size: 11px; line-height: 1.5; color: var(--muted); }

  .howto { max-width: 560px; padding-bottom: 24px; }
  .howto p { margin: 0 0 10px; line-height: 1.55; color: var(--muted); font-size: 13px; }
  .howto b { font-weight: 700; }
  .howto code { background: #141414; border: 1px solid #2a2a2a; padding: 0 4px; color: var(--ink);
                font: inherit; font-size: 12px; }

  .layout, .left, .right { display: contents; }
  @media (min-width: 1100px) {
    .app { max-width: 1120px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; align-items: start; }
    .left { display: block; position: sticky; top: 64px; }
    .right { display: block; }
    .right > h2:first-child { margin-top: 0; }
    .gridrow { height: 30px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
