// files.js — wav encoding, a minimal zip writer (stored, no compression), downloads.

export function encodeWav(data, sampleRate = 44100) {
  const len = data.length;
  const ab = new ArrayBuffer(44 + len * 2);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Uint8Array(ab);
}

// ---- zip (store method) — one download instead of five blocked ones on iOS ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files) { // files: [{ name, data: Uint8Array }]
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  const str = (s) => new TextEncoder().encode(s);
  for (const f of files) {
    const name = str(f.name);
    const crc = crc32(f.data);
    const head = [str("PK\x03\x04"), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name];
    central.push({ name, crc, size: f.data.length, offset });
    for (const p of head) { parts.push(p); offset += p.length; }
    parts.push(f.data); offset += f.data.length;
  }
  const cdStart = offset;
  for (const e of central) {
    const rec = [str("PK\x01\x02"), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset), e.name];
    for (const p of rec) { parts.push(p); offset += p.length; }
  }
  const cdSize = offset - cdStart;
  parts.push(str("PK\x05\x06"), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function download(data, name, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
