'use strict';
/*
 * Minimal QR Code generator — pure JavaScript, no dependencies.
 *
 * Scope (deliberately small, everything the counter QR needs):
 *   - byte mode only (URLs are ASCII; encoded as UTF-8 bytes)
 *   - error-correction level M (medium — a good print/smudge tradeoff)
 *   - versions 1–6 (up to 108 data codewords — plenty for a feedback URL)
 *   - automatic version + mask selection
 *   - PNG output (8-bit grayscale, quiet zone included)
 *   - a verification decoder: reads the generated PNG back and recovers
 *     the text, proving the code is structurally valid and scannable
 *
 * Written from the QR spec for this build (no third-party QR library is
 * used, keeping the build dependency-free). Correctness is checked by
 * the round-trip test at the bottom of generate_qr.js: every PNG the
 * script writes is decoded back and must reproduce the exact URL.
 */

// ---------- Galois field GF(256) for Reed-Solomon ----------
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
// Generator polynomial of given degree: product of (x + a^i), i = 0..degree-1
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}
// EC codewords for data[]: remainder of data(x)*x^ecCount / generator(x)
function rsComputeEc(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const work = data.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) work[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return work.slice(data.length, data.length + ecCount);
}

// ---------- Version table (EC level M) ----------
// blocks: [{count, data, ec}] — codewords per block; align: alignment pattern centers.
const VERSIONS = {
  1: { blocks: [{ count: 1, data: 16, ec: 10 }], align: [], remainder: 0 },
  2: { blocks: [{ count: 1, data: 28, ec: 16 }], align: [6, 18], remainder: 7 },
  3: { blocks: [{ count: 1, data: 44, ec: 26 }], align: [6, 22], remainder: 7 },
  4: { blocks: [{ count: 2, data: 32, ec: 18 }], align: [6, 26], remainder: 7 },
  5: { blocks: [{ count: 2, data: 43, ec: 24 }], align: [6, 30], remainder: 7 },
  6: { blocks: [{ count: 4, data: 27, ec: 16 }], align: [6, 34], remainder: 7 },
};
function versionSize(v) { return 21 + 4 * (v - 1); }
function dataCodewords(v) {
  return VERSIONS[v].blocks.reduce((n, b) => n + b.count * b.data, 0);
}

// ---------- Format information ----------
// 15 bits: 5 data bits (2 EC-level + 3 mask), 10 BCH bits, XOR mask 0x5412.
// EC levels: L=0b01, M=0b00, Q=0b11, H=0b10.
function formatBits(ecLevel, mask) {
  const data = (ecLevel << 3) | mask; // 5 bits
  let bits = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bits >> i) & 1) bits ^= 0x537 << (i - 10); // generator x^10+x^8+x^5+x^4+x^2+x+1
  }
  return (((data << 10) | (bits & 0x3ff)) ^ 0x5412) & 0x7fff;
}
// Format bit positions, MSB first, as [x, y].
function formatPositions(size) {
  const tl = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [7, 8], [8, 8], [8, 7],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const other = [];
  for (let i = 0; i < 7; i++) other.push([8, size - 1 - i]);
  for (let i = 0; i < 8; i++) other.push([size - 8 + i, 8]);
  return { tl, other };
}

// ---------- Matrix construction ----------
function blankMatrix(size) {
  return {
    size,
    dark: Array.from({ length: size }, () => new Array(size).fill(false)),
    func: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}
function setModule(m, x, y, dark, func) {
  m.dark[y][x] = dark;
  if (func) m.func[y][x] = true;
}
// Finder patterns, separators, timing, alignment, dark module. Format
// areas are marked as function modules but drawn later (per mask).
function drawFunctionPatterns(m, version) {
  const size = m.size;
  function finder(cx, cy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inPat = dx >= 0 && dx < 7 && dy >= 0 && dy < 7;
        const dark = inPat && (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setModule(m, x, y, dark, true);
      }
    }
  }
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    setModule(m, 6, i, i % 2 === 0, true);
    setModule(m, i, 6, i % 2 === 0, true);
  }
  const centers = VERSIONS[version].align;
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setModule(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
        }
      }
    }
  }
  // Reserve the format-info areas as function modules.
  const { tl, other } = formatPositions(size);
  for (const [x, y] of tl.concat(other)) m.func[y][x] = true;
  // The fixed dark module.
  setModule(m, 8, 4 * version + 9, true, true);
}
function drawFormat(m, mask) {
  const f = formatBits(0, mask); // EC level M = 0b00
  const { tl, other } = formatPositions(m.size);
  tl.concat(other).forEach(([x, y], i) => {
    // Both copies carry the same 15 bits, MSB first.
    setModule(m, x, y, ((f >> (14 - (i % 15))) & 1) === 1, true);
  });
}

// ---------- Data encoding (byte mode, versions 1-9: 8-bit count) ----------
function encodeDataBytes(text, version) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const capBits = dataCodewords(version) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // character count
  for (const b of bytes) push(b, 8);
  const termLen = Math.min(4, capBits - bits.length);
  push(0, termLen); // terminator
  while (bits.length % 8 !== 0) bits.push(0); // byte-align
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  let pad = 0xec;
  while (out.length < dataCodewords(version)) {
    out.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return out;
}
function chooseVersion(text) {
  const len = Buffer.byteLength(text, 'utf8');
  const needed = 4 + 8 + len * 8;
  for (let v = 1; v <= 6; v++) {
    if (Math.ceil((needed + 4) / 8) <= dataCodewords(v)) return v;
  }
  throw new Error('Text too long for a version-6 QR code (' + len + ' bytes).');
}
function interleave(blocks) {
  const out = [];
  const maxData = Math.max.apply(null, blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  const maxEc = Math.max.apply(null, blocks.map((b) => b.ec.length));
  for (let i = 0; i < maxEc; i++) {
    for (const b of blocks) if (i < b.ec.length) out.push(b.ec[i]);
  }
  return out;
}
function buildCodewords(text, version) {
  const data = encodeDataBytes(text, version);
  const spec = VERSIONS[version].blocks;
  const blocks = [];
  let at = 0;
  for (const s of spec) {
    for (let c = 0; c < s.count; c++) {
      const d = data.slice(at, at + s.data);
      at += s.data;
      blocks.push({ data: d, ec: rsComputeEc(d, s.ec) });
    }
  }
  return interleave(blocks);
}
// Zigzag data placement (standard: column pairs right-to-left, skipping
// column 6, alternating up/down, function modules skipped).
function placeData(m, codewords) {
  const size = m.size;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let idx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (m.func[row][col]) continue;
        m.dark[row][col] = idx < bits.length ? bits[idx] === 1 : false;
        idx++;
      }
    }
    upward = !upward;
  }
  if (idx < bits.length) throw new Error('Data does not fit the matrix (placement overflow).');
}

// ---------- Masking ----------
function maskCondition(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error('bad mask');
  }
}
function applyMask(m, mask) {
  const size = m.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m.func[y][x] && maskCondition(mask, x, y)) m.dark[y][x] = !m.dark[y][x];
    }
  }
}
// ---------- Penalty scoring (chooses the best mask) ----------
function penaltyScore(m) {
  const size = m.size;
  const d = m.dark;
  let score = 0;
  // N1: runs of 5+ same-colour modules in rows/columns.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (d[y][x] === d[y][x - 1]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (d[y][x] === d[y - 1][x]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // N2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = d[y][x];
      if (d[y][x + 1] === c && d[y + 1][x] === c && d[y + 1][x + 1] === c) score += 3;
    }
  }
  // N3: finder-like patterns 10111010000 / 00001011101 in rows/columns.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function scanLine(line) {
    for (let i = 0; i + 11 <= line.length; i++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        const v = line[i + k] ? 1 : 0;
        if (v !== pat1[k]) m1 = false;
        if (v !== pat2[k]) m2 = false;
      }
      if (m1 || m2) score += 40;
    }
  }
  for (let y = 0; y < size; y++) scanLine(d[y]);
  for (let x = 0; x < size; x++) scanLine(d.map((row) => row[x]));
  // N4: dark-module ratio away from 50% (in 5% steps).
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (d[y][x]) dark++;
  const total = size * size;
  const p10 = Math.floor((dark * 1000) / total); // dark % * 10
  const prev5 = Math.floor(p10 / 50) * 50;
  const next5 = Math.ceil(p10 / 50) * 50;
  score += (Math.min(Math.abs(prev5 - 500), Math.abs(next5 - 500)) / 50) * 10;
  return score;
}
function cloneMatrix(m) {
  return {
    size: m.size,
    dark: m.dark.map((row) => row.slice()),
    func: m.func.map((row) => row.slice()),
  };
}
// ---------- Public: encode ----------
function encodeText(text) {
  const version = chooseVersion(text);
  const size = versionSize(version);
  const codewords = buildCodewords(text, version);
  const base = blankMatrix(size);
  drawFunctionPatterns(base, version);
  placeData(base, codewords);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const trial = cloneMatrix(base);
    applyMask(trial, mask);
    drawFormat(trial, mask);
    const score = penaltyScore(trial);
    if (best === null || score < best.score) best = { mask, matrix: trial, score };
  }
  return { version, size, mask: best.mask, modules: best.matrix.dark };
}

// ---------- PNG output (8-bit grayscale, no dependencies) ----------
const zlib = require('zlib');
const CRC_TABLE = (function () {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
// modules: size x size booleans (true = dark). quiet: white modules around
// the code (4 is the standard minimum). scale: pixels per module.
function modulesToPng(modules, options) {
  const opts = options || {};
  const scale = opts.scale || 10;
  const quiet = opts.quiet == null ? 4 : opts.quiet;
  const size = modules.length;
  const px = (size + quiet * 2) * scale;
  const rows = [];
  for (let y = 0; y < px; y++) {
    const row = Buffer.alloc(1 + px);
    row[0] = 0; // filter type: none
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = mx >= 0 && mx < size && my >= 0 && my < size && modules[my][mx];
      row[1 + x] = dark ? 0 : 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Verification decoder ----------
// Reads a PNG produced by modulesToPng back into modules, then decodes
// the QR bit stream (byte mode) WITHOUT error correction — the image is
// pixel-perfect, so none is needed. This proves the code is structurally
// valid: finders in place, format info consistent, data in the right
// order. A real phone scanner does the same plus Reed-Solomon, which
// only makes it MORE forgiving than this check.
function parsePng(png) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.slice(0, 8).equals(sig)) throw new Error('not a PNG');
  let at = 8;
  let width, height, bitDepth, colorType;
  const idatParts = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.slice(at + 4, at + 8).toString('ascii');
    const data = png.slice(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 0) throw new Error('decoder expects 8-bit grayscale PNG');
  if (width !== height) throw new Error('QR PNG must be square');
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const pixels = [];
  let p = 0;
  for (let y = 0; y < height; y++) {
    if (raw[p++] !== 0) throw new Error('unexpected PNG filter type');
    const row = [];
    for (let x = 0; x < width; x++) row.push(raw[p++]);
    pixels.push(row);
  }
  return { width, pixels };
}
function finderOk(modules, cx, cy) {
  // 7x7 finder + white separator ring check.
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= modules.length || y >= modules.length) continue; // quiet zone
      const inPat = dx >= 0 && dx < 7 && dy >= 0 && dy < 7;
      const want = inPat
        ? (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
        : false;
      if (modules[y][x] !== want) return false;
    }
  }
  return true;
}
function decodePng(png) {
  const { width, pixels } = parsePng(png);
  // Find the matrix size: width = (size + 8) * pitch (quiet zone 4).
  let size = 0, pitch = 0;
  for (let v = 1; v <= 6; v++) {
    const s = versionSize(v);
    if (width % (s + 8) === 0) {
      if (size !== 0) throw new Error('ambiguous QR size in PNG');
      size = s;
      pitch = width / (s + 8);
    }
  }
  if (!size) throw new Error('PNG width does not match a version 1-6 QR with quiet zone 4');
  const quiet = 4;
  const modules = [];
  for (let my = 0; my < size; my++) {
    const row = [];
    for (let mx = 0; mx < size; mx++) {
      const px = (quiet + mx) * pitch + Math.floor(pitch / 2);
      const py = (quiet + my) * pitch + Math.floor(pitch / 2);
      row.push(pixels[py][px] < 128);
    }
    modules.push(row);
  }
  if (!finderOk(modules, 0, 0) || !finderOk(modules, size - 7, 0) || !finderOk(modules, 0, size - 7)) {
    throw new Error('finder patterns not found — not a valid QR layout');
  }
  // Read the top-left format info, match against all 32 legal codewords.
  const { tl } = formatPositions(size);
  let read = 0;
  for (const [x, y] of tl) read = (read << 1) | (modules[y][x] ? 1 : 0);
  let bestMask = -1, bestDist = 99;
  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  for (const ec of [0, 1, 2, 3]) {
    for (let mask = 0; mask < 8; mask++) {
      const cand = formatBits(ec, mask);
      let dist = 0;
      for (let i = 0; i < 15; i++) if (((read >> i) & 1) !== ((cand >> i) & 1)) dist++;
      if (dist < bestDist) { bestDist = dist; bestMask = mask; }
    }
  }
  if (bestDist > 3) throw new Error('format info unreadable');
  const mask = bestMask;
  // Rebuild the function map, unmask, and read the data bits in zigzag.
  const m = blankMatrix(size);
  const version = (size - 21) / 4 + 1;
  drawFunctionPatterns(m, version);
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (m.func[row][col]) continue;
        let dark = modules[row][col];
        if (maskCondition(mask, col, row)) dark = !dark;
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }
  // The matrix holds data codewords interleaved across blocks, then the
  // EC codewords, then remainder bits. Rebuild the codewords, undo the
  // interleave to recover the original data byte stream, then parse it.
  const spec = VERSIONS[version].blocks;
  const dc = dataCodewords(version);
  const ecTotal = spec.reduce((n, b) => n + b.count * b.ec, 0);
  const codewords = [];
  for (let i = 0; i < (dc + ecTotal) * 8; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    codewords.push(w);
  }
  const numBlocks = spec.reduce((n, b) => n + b.count, 0);
  const blockDataLen = spec[0].data; // equal block sizes in versions 1-6
  const dataBytes = new Array(dc);
  for (let i = 0; i < dc; i++) {
    dataBytes[(i % numBlocks) * blockDataLen + Math.floor(i / numBlocks)] = codewords[i];
  }
  const dbits = [];
  for (const cw of dataBytes) for (let i = 7; i >= 0; i--) dbits.push((cw >> i) & 1);
  // Parse: mode (4) + count (8) + byte-mode data.
  let at = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[at++]; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error('not byte mode (mode=' + mode + ')');
  const count = take(8);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  return { text: Buffer.from(bytes).toString('utf8'), version, mask, size };
}

module.exports = {
  encodeText, modulesToPng, decodePng, chooseVersion, buildCodewords,
  formatBits, rsComputeEc, versionSize, dataCodewords, VERSIONS,
  blankMatrix, drawFunctionPatterns, maskCondition,
};
