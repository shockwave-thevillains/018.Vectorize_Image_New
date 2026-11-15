/* Vektor — penyusun SVG/EPS dan penulis ZIP. */

// ---------------------------------------------------------------- ukuran
export function outputSize(w, h, mode, customMP) {
  if (mode === 'orig') return { w, h };
  const mp = mode === 'custom' ? Math.max(15, Number(customMP) || 15) : Number(mode);
  const target = mp * 1e6;
  const k = Math.sqrt(target / (w * h));
  let W = Math.ceil(w * k), H = Math.ceil(h * k);
  while (W * H < target) { if (W / w < H / h) W++; else H++; }
  return { w: W, h: H };
}

// ---------------------------------------------------------------- nama
export function stemOf(name) {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name).replace(/[\\/:*?"<>|]+/g, '_');
}
export function outName(stem, index, code, start) {
  const c = (code || '').trim();
  if (!c) return stem;
  return `${c}_${(Number(start) || 0) + index}_${stem}`;
}

// ---------------------------------------------------------------- geometri
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

// Menelusuri satu sub-path (daftar referensi rantai) dan memanggil sink.M/L/C.
function walk(refs, chains, sink, closeIt) {
  let first = true;
  for (let r = 0; r < refs.length; r++) {
    const ref = refs[r];
    const ch = chains[ref >> 1];
    const p = ch.p, c = ch.c;
    if (!(ref & 1)) {
      if (first) sink.M(p[0], p[1]);
      let j = 2;
      for (let s = 0; s < c.length; s++) {
        if (c[s] === 0) { sink.L(p[j], p[j + 1]); j += 2; }
        else { sink.C(p[j], p[j + 1], p[j + 2], p[j + 3], p[j + 4], p[j + 5]); j += 6; }
      }
    } else {
      // Arah balik: simpan offset awal tiap segmen.
      const off = new Int32Array(c.length + 1);
      let j = 2;
      for (let s = 0; s < c.length; s++) { off[s] = j; j += c[s] === 0 ? 2 : 6; }
      off[c.length] = j;
      if (first) sink.M(p[j - 2], p[j - 1]);
      for (let s = c.length - 1; s >= 0; s--) {
        const prev = s === 0 ? 0 : off[s] - 2; // titik awal segmen s
        if (c[s] === 0) sink.L(p[prev], p[prev + 1]);
        else {
          const o = off[s];
          sink.C(p[o + 2], p[o + 3], p[o], p[o + 1], p[prev], p[prev + 1]);
        }
      }
    }
    first = false;
  }
  if (closeIt) sink.Z();
}

function svgSink(kx, ky) {
  const out = [];
  return {
    out,
    M: (x, y) => out.push('M', num(x * kx), num(y * ky)),
    L: (x, y) => out.push('L', num(x * kx), num(y * ky)),
    C: (a, b, c, d, e, f) => out.push('C', num(a * kx), num(b * ky), num(c * kx), num(d * ky), num(e * kx), num(f * ky)),
    Z: () => out.push('Z'),
    text: () => out.join(' ').replace(/ ([MLCZ])/g, '$1').replace(/([MLCZ]) /g, '$1'),
  };
}

function epsSink(kx, ky, H) {
  const out = [];
  let line = [];
  const flush = () => { if (line.length) { out.push(line.join(' ')); line = []; } };
  return {
    out,
    M: (x, y) => { flush(); line.push(num(x * kx), num(H - y * ky), 'm'); },
    L: (x, y) => { line.push(num(x * kx), num(H - y * ky), 'l'); if (line.length > 24) flush(); },
    C: (a, b, c, d, e, f) => { line.push(num(a * kx), num(H - b * ky), num(c * kx), num(H - d * ky), num(e * kx), num(H - f * ky), 'c'); if (line.length > 20) flush(); },
    Z: () => { line.push('h'); flush(); },
    end: () => flush(),
  };
}

// Region yang tersembunyi: putih latar (default) XOR diklik, atau warnanya disembunyikan.
// opt.hidden: Uint8Array per region (1 = tersembunyi). Tanpa opt.hidden → default.
export function defaultHidden(res) {
  return Uint8Array.from(res.regions, (r) => (r.hid ? 1 : 0));
}
const hiddenOf = (res, opt) => opt.hidden || defaultHidden(res);

// Daftar bentuk siap gambar, sesuai mode lapisan, region tersembunyi, dan warna.
function shapes(res, opt) {
  const pal = res.palette.map((c, k) => (opt.recolor && opt.recolor[k]) || c);
  const hidden = hiddenOf(res, opt);
  const colorOf = (i) => (opt.regionColor && opt.regionColor[i]) || pal[res.regions[i].k];
  const list = [];
  if (opt.stacking === 'cutout') {
    // Satu compound path per warna (region tidak saling tumpang tindih).
    const byColor = new Map();
    res.regions.forEach((r, i) => {
      if (hidden[i]) return;
      // Dikelompokkan per warna akhir (warna region yang diwarnai/digabung ikut).
      const col = colorOf(i);
      const key = hex(col);
      if (!byColor.has(key)) byColor.set(key, { color: col, subs: [], regions: [] });
      const g = byColor.get(key);
      g.subs.push(...r.subs);
      g.regions.push(i);
    });
    for (const g of byColor.values()) list.push({ color: g.color, subs: g.subs, regions: g.regions });
  } else {
    // Tumpuk: lubang diisi kecuali berbatasan dengan region tersembunyi/transparan.
    res.regions.forEach((r, i) => {
      // Bentuk yang digabung ke tetangga yang mengelilinginya tidak perlu digambar:
      // tetangga itu sudah mengisi lubangnya (mode tumpuk).
      if (hidden[i] || (opt.absorbed && opt.absorbed[i])) return;
      const subs = r.subs.filter((s) => s.outer || !s.fill || touchesHidden(res, s, i, hidden));
      list.push({ color: colorOf(i), subs, regions: [i] });
    });
  }
  // Urutan gambar tiap region (untuk pengisi celah: hanya meluas ke bawah bentuk sesudahnya).
  const rank = new Int32Array(res.regions.length).fill(-1);
  list.forEach((it, n) => { for (const i of it.regions) rank[i] = n; });
  list.rank = rank;
  return list;
}

function touchesHidden(res, sub, i, hidden) {
  for (let n = 0; n < sub.refs.length; n++) {
    const ch = res.chains[sub.refs[n] >> 1];
    const other = ch.a === i ? ch.b : ch.a;
    if (other < 0 || hidden[other]) return true;
  }
  return false;
}

// Garis pengisi celah: batas antar dua bentuk yang sama-sama tampil, hanya batas
// dengan bentuk yang digambar sesudahnya — garis meluas ke bawah bentuk itu
// (tertutup), jadi celah tertutup tanpa ada bentuk yang menebal.
// Di titik temu tiga bentuk, sudut ujung garis (lebar 2·hw) bisa menonjol ke
// bentuk ketiga bila sudut antar batas di titik itu lancip dan bentuk ketiga
// digambar lebih dulu. Ujung garis lalu dipendekkan tepat sejauh yang perlu:
// hw / tan(sudut) — nol bila sudutnya >= 90°.
function gapStrokes(res, i, hidden, sinkFactory, rank, hw = 0) {
  const segs = [];
  const other = (ch, r) => (ch.a === r ? ch.b : ch.a);
  const covers = (k, r) => k >= 0 && !hidden[k] && rank[k] > rank[r];
  for (const s of res.regions[i].subs) {
    const m = s.refs.length;
    for (let n = 0; n < m; n++) {
      const ref = s.refs[n];
      const ch = res.chains[ref >> 1];
      if (ch.a < 0 || ch.b < 0 || hidden[ch.a] || hidden[ch.b]) continue;
      const j = other(ch, i);
      if (rank[j] <= rank[i]) continue;
      const sink = sinkFactory();
      if (hw > 0 && m > 1) {
        const rec = recSink();
        walk([ref], res.chains, rec, false);
        const sg = rec.segs;
        if (!sg.length) continue;
        const u0 = tanOut(sg, true), u1 = tanOut(sg, false);
        // Sisi bentuk ini: rantai sebelum/sesudahnya di sub-path yang sama.
        const prev = s.refs[(n + m - 1) % m], next = s.refs[(n + 1) % m];
        let t0 = 0, t1 = 0;
        if (!covers(other(res.chains[prev >> 1], i), i)) t0 = Math.max(t0, cut(u0, refTan(res, prev, false), hw));
        if (!covers(other(res.chains[next >> 1], i), i)) t1 = Math.max(t1, cut(u1, refTan(res, next, true), hw));
        // Sisi bentuk sesudahnya: rantai tetangga di sub-path bentuk itu.
        const nb = neighborRefs(res, j, ref >> 1);
        if (nb) {
          // Bentuk j menelusuri rantai ini berlawanan arah: akhir walk j = awal walk ini.
          if (!covers(other(res.chains[nb.next >> 1], j), i)) t0 = Math.max(t0, cut(u0, refTan(res, nb.next, true), hw));
          if (!covers(other(res.chains[nb.prev >> 1], j), i)) t1 = Math.max(t1, cut(u1, refTan(res, nb.prev, false), hw));
        }
        if (!replayTrimmed(sg, t0, t1, sink)) continue;
      } else walk([ref], res.chains, sink, false);
      segs.push(sink);
    }
  }
  return segs;
}

// Arah keluar (vektor satuan) dari titik awal (atStart) atau titik akhir segmen.
function tanOut(sg, atStart) {
  const q = atStart ? sg[0] : sg[sg.length - 1];
  const n = q.length;
  const x0 = atStart ? q[0] : q[n - 2], y0 = atStart ? q[1] : q[n - 1];
  for (let k = atStart ? 2 : n - 4; atStart ? k < n : k >= 0; k += atStart ? 2 : -2) {
    const dx = q[k] - x0, dy = q[k + 1] - y0, l = Math.hypot(dx, dy);
    if (l > 1e-9) return [dx / l, dy / l];
  }
  return null;
}
// Arah keluar rantai ref (arah walk) dari titik awalnya atau dari titik akhirnya.
function refTan(res, ref, atStart) {
  const rec = recSink();
  walk([ref], res.chains, rec, false);
  return rec.segs.length ? tanOut(rec.segs, atStart) : null;
}
// Rantai sebelum & sesudah rantai idx di sub-path bentuk r.
function neighborRefs(res, r, idx) {
  for (const s of res.regions[r].subs) {
    const m = s.refs.length;
    if (m < 2) continue;
    for (let k = 0; k < m; k++) if (s.refs[k] >> 1 === idx) return { prev: s.refs[(k + m - 1) % m], next: s.refs[(k + 1) % m] };
  }
  return null;
}
// Pemendekan ujung: u arah garis dari titik temu, v arah batas tetangga dari titik
// temu yang sama; sudut lancip θ → sudut garis menonjol sejauh hw / tan θ.
function cut(u, v, hw) {
  if (!u || !v) return 0;
  const c = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
  if (c <= 0) return 0;
  const sn = Math.sqrt(1 - c * c);
  return Math.min(4 * hw, (hw * c) / Math.max(sn, 1e-6));
}

// Perekam perintah M/L/C menjadi daftar segmen [x0,y0, ..., x1,y1].
function recSink() {
  const segs = [];
  let x = 0, y = 0;
  return {
    segs,
    M: (a, b) => { x = a; y = b; },
    L: (a, b) => { segs.push([x, y, a, b]); x = a; y = b; },
    C: (a, b, c, d, e, f) => { segs.push([x, y, a, b, c, d, e, f]); x = e; y = f; },
    Z: () => {},
  };
}
const bez = (q, t) => {
  if (q.length === 4) return [q[0] + (q[2] - q[0]) * t, q[1] + (q[3] - q[1]) * t];
  const u = 1 - t;
  return [u * u * u * q[0] + 3 * u * u * t * q[2] + 3 * u * t * t * q[4] + t * t * t * q[6],
    u * u * u * q[1] + 3 * u * u * t * q[3] + 3 * u * t * t * q[5] + t * t * t * q[7]];
};
// Potongan segmen q pada parameter [a, b] (de Casteljau).
function subSeg(q, a, b) {
  if (q.length === 4) { const p = bez(q, a), r = bez(q, b); return [p[0], p[1], r[0], r[1]]; }
  const split = (c, t) => {
    const l = (p, r) => [p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t];
    const P0 = [c[0], c[1]], P1 = [c[2], c[3]], P2 = [c[4], c[5]], P3 = [c[6], c[7]];
    const A = l(P0, P1), B = l(P1, P2), C = l(P2, P3), D = l(A, B), E = l(B, C), F = l(D, E);
    return [[...P0, ...A, ...D, ...F], [...F, ...E, ...C, ...P3]];
  };
  let c = q;
  if (b < 1) c = split(c, b)[0];
  if (a > 0) c = split(c, a / b)[1];
  return c;
}
// Parameter t pada jarak busur d dari awal segmen (tabel 16 sampel).
function segLen(q) {
  const L = [0];
  let [px, py] = bez(q, 0);
  for (let k = 1; k <= 16; k++) { const [x, y] = bez(q, k / 16); L.push(L[k - 1] + Math.hypot(x - px, y - py)); px = x; py = y; }
  return L;
}
const tAt = (L, d) => {
  for (let k = 1; k < L.length; k++) if (L[k] >= d) return (k - 1 + (d - L[k - 1]) / Math.max(1e-9, L[k] - L[k - 1])) / 16;
  return 1;
};
// Memutar ulang segmen ke sink, dipendekkan t0 di awal dan t1 di akhir.
// false bila garis terlalu pendek untuk dipendekkan.
function replayTrimmed(segs, t0, t1, sink) {
  const lens = segs.map(segLen);
  const total = lens.reduce((a, L) => a + L[16], 0);
  if (total <= t0 + t1 + 1e-6) return false;
  let acc = 0, started = false;
  const end = total - t1;
  for (let k = 0; k < segs.length; k++) {
    const L = lens[k], len = L[16];
    const s0 = acc, s1 = acc + len;
    acc = s1;
    if (s1 <= t0 || s0 >= end) continue;
    const a = s0 < t0 ? tAt(L, t0 - s0) : 0, b = s1 > end ? tAt(L, end - s0) : 1;
    const q = a > 0 || b < 1 ? subSeg(segs[k], a, b) : segs[k];
    if (!started) { sink.M(q[0], q[1]); started = true; }
    if (q.length === 4) sink.L(q[2], q[3]);
    else sink.C(q[2], q[3], q[4], q[5], q[6], q[7]);
  }
  return started;
}

// Garis tipis (stroke) di atas semua bentuk: kurva Bézier di koordinat kerja.
function lineD(L, kx, ky) {
  const p = L.p, o = ['M', num(p[0] * kx), num(p[1] * ky)];
  for (let j = 2; j < p.length; j += 6) o.push('C', num(p[j] * kx), num(p[j + 1] * ky), num(p[j + 2] * kx), num(p[j + 3] * ky), num(p[j + 4] * kx), num(p[j + 5] * ky));
  return o.join(' ');
}
function linesSVG(res, kx, ky, fixedW) {
  if (!res.lines || !res.lines.length) return '';
  return '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + res.lines.map((L) =>
    `<path stroke="${hex(L.rgb)}" stroke-width="${fixedW ? 1 : num(L.w * kx)}"${fixedW ? ' vector-effect="non-scaling-stroke"' : ''} d="${lineD(L, kx, ky)}"/>`).join('') + '</g>';
}
function linesEPS(res, kx, ky, OH) {
  const L = [];
  if (!res.lines || !res.lines.length) return L;
  L.push('1 setlinecap 1 setlinejoin');
  for (const ln of res.lines) {
    const p = ln.p;
    L.push(`${num(ln.w * kx)} setlinewidth ${ln.rgb.map((v) => num(v / 255)).join(' ')} rg`);
    const parts = ['newpath', num(p[0] * kx), num(OH - p[1] * ky), 'm'];
    for (let j = 2; j < p.length; j += 6) parts.push(num(p[j] * kx), num(OH - p[j + 1] * ky), num(p[j + 2] * kx), num(OH - p[j + 3] * ky), num(p[j + 4] * kx), num(OH - p[j + 5] * ky), 'c');
    parts.push('s');
    L.push(parts.join(' '));
  }
  return L;
}

// Cahaya bulan/matahari (mode Gradien): lingkaran sepusat bertumpuk, makin luar
// makin transparan, hanya di bentuk langit (clip) → awan, gunung, dan benda
// bercahaya itu sendiri tidak ikut terwarnai.
let glowSeq = 0;
const glowTag = Math.random().toString(36).slice(2, 7);
function glowSVG(res, opt, kx, ky, hidden) {
  if (!res.glows || !res.glows.length) return '';
  const out = [];
  for (const g of res.glows) {
    const regs = g.regions.filter((r) => !hidden[r] && !(opt.absorbed && opt.absorbed[r]));
    if (!regs.length) continue;
    const id = `vg${glowTag}${++glowSeq}`;
    const d = [];
    for (const r of regs) { const sk = svgSink(kx, ky); for (const sb of res.regions[r].subs) walk(sb.refs, res.chains, sk, true); d.push(sk.text()); }
    const col = hex(g.G);
    out.push(`<clipPath id="${id}"><path clip-rule="evenodd" d="${d.join('')}"/></clipPath><g clip-path="url(#${id})" fill="${col}">`);
    for (const [r, op] of g.levels) out.push(`<circle cx="${num(g.cx * kx)}" cy="${num(g.cy * ky)}" r="${num(r * kx)}" fill-opacity="${num(op)}"/>`);
    out.push('</g>');
  }
  return out.join('');
}
// EPS (tanpa transparansi): per bentuk langit, lingkaran diisi warna hasil
// campuran warna bentuk itu dengan cahaya, dipotong ke bentuknya.
function glowEPS(res, opt, kx, ky, OH, hidden, colorOf) {
  const L = [];
  if (!res.glows || !res.glows.length) return L;
  for (const g of res.glows) {
    for (const r of g.regions) {
      if (hidden[r] || (opt.absorbed && opt.absorbed[r])) continue;
      L.push('gsave newpath');
      const sk = epsSink(kx, ky, OH);
      for (const sb of res.regions[r].subs) walk(sb.refs, res.chains, sk, true);
      sk.end();
      L.push(...sk.out);
      L.push('eoclip');
      let c = colorOf(r).slice();
      for (const [rad, op] of g.levels) {
        c = c.map((v, k) => v * (1 - op) + g.G[k] * op);
        L.push(`${c.map((v) => num(v / 255)).join(' ')} rg newpath ${num(g.cx * kx)} ${num(OH - g.cy * ky)} ${num(rad * kx)} 0 360 arc closepath fill`);
      }
      L.push('grestore');
    }
  }
  return L;
}

// Lebar garis pengisi celah dalam px output: minimal opt.gapWidth, ikut membesar
// pada artboard besar agar tetap menutup celah saat dilihat diperkecil.
const gapWidthFor = (opt, OW, res) => Math.max(opt.gapWidth || 1, (2.5 * OW) / res.srcW);

export function buildSVG(res, opt) {
  const { w: OW, h: OH } = opt.size;
  const kx = OW / res.W, ky = OH / res.H;
  const items = shapes(res, opt);
  const hidden = hiddenOf(res, opt);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${OW}" height="${OH}" viewBox="0 0 ${OW} ${OH}">`);
  // Pengisi celah: tiap bentuk mendapat garis tepi sewarna di batas dengan bentuk
  // lain yang tampil, digambar tepat setelah isinya — menutup celah sub-piksel
  // antar bentuk bersebelahan tanpa membesarkan tepi luar objek.
  // Garis pengisi digambar tepat setelah isi bentuknya dan hanya di batas dengan
  // bentuk yang digambar sesudahnya (yang lalu menutupinya). Lapisan pengisi di
  // bawah semua bentuk tidak cukup pada mode Tumpuk: bentuk besar di bawahnya
  // menutup lapisan itu sehingga warnanya tampak sebagai garis terang di sambungan.
  const gw = num(gapWidthFor(opt, OW, res));
  for (const it of items) {
    const sk = svgSink(kx, ky);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    const c = hex(it.color);
    parts.push(`<path fill="${c}" fill-rule="evenodd" d="${sk.text()}"/>`);
    if (opt.gapFill) {
      const d = [];
      for (const i of it.regions) for (const g of gapStrokes(res, i, hidden, () => svgSink(kx, ky), items.rank, gw / (2 * kx))) d.push(g.text());
      if (d.length) parts.push(`<path fill="none" stroke="${c}" stroke-width="${gw}" stroke-linejoin="round" d="${d.join('')}"/>`);
    }
  }
  const gl = glowSVG(res, opt, kx, ky, hidden);
  if (gl) parts.push(gl);
  const ls = linesSVG(res, kx, ky);
  if (ls) parts.push(ls);
  parts.push('</svg>');
  return parts.join('\n');
}

// EPS 10 (PostScript Level 2, hanya path) — terbaca Illustrator, CorelDRAW, Affinity.
export function buildEPS(res, opt, title) {
  const { w: OW, h: OH } = opt.size;
  const kx = OW / res.W, ky = OH / res.H;
  const items = shapes(res, opt);
  const hidden = hiddenOf(res, opt);
  const L = [];
  L.push('%!PS-Adobe-3.0 EPSF-3.0');
  L.push('%%Creator: Vektor');
  L.push(`%%Title: ${String(title).replace(/[\r\n()]/g, '_')}`);
  L.push(`%%CreationDate: ${new Date().toISOString()}`);
  L.push(`%%BoundingBox: 0 0 ${OW} ${OH}`);
  L.push(`%%HiResBoundingBox: 0 0 ${OW} ${OH}`);
  L.push('%%DocumentData: Clean7Bit');
  L.push('%%LanguageLevel: 2');
  L.push('%%Pages: 1');
  L.push('%%EndComments');
  L.push('%%BeginProlog');
  L.push('/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def');
  L.push('/rg {setrgbcolor} bind def /f {eofill} bind def /s {stroke} bind def');
  L.push('%%EndProlog');
  L.push('%%Page: 1 1');
  L.push('gsave');
  const col = (c) => c.map((v) => num(v / 255)).join(' ') + ' rg';
  const gwE = gapWidthFor(opt, OW, res);
  if (opt.gapFill) L.push(`${num(gwE)} setlinewidth 1 setlinejoin 0 setlinecap`);
  for (const it of items) {
    L.push(col(it.color));
    L.push('newpath');
    const sk = epsSink(kx, ky, OH);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    sk.end();
    L.push(...sk.out);
    L.push('f');
    if (opt.gapFill) {
      const sinks = [];
      for (const i of it.regions) sinks.push(...gapStrokes(res, i, hidden, () => epsSink(kx, ky, OH), items.rank, gwE / (2 * kx)));
      if (sinks.length) {
        L.push('newpath');
        for (const g of sinks) { g.end(); L.push(...g.out); }
        L.push('s');
      }
    }
  }
  {
    const pal = res.palette.map((c, k) => (opt.recolor && opt.recolor[k]) || c);
    L.push(...glowEPS(res, opt, kx, ky, OH, hidden, (i) => (opt.regionColor && opt.regionColor[i]) || pal[res.regions[i].k]));
  }
  L.push(...linesEPS(res, kx, ky, OH));
  L.push('grestore');
  L.push('showpage');
  L.push('%%Trailer');
  L.push('%%EOF');
  return L.join('\n') + '\n';
}

// Isi <svg> untuk penampil (koordinat kerja, tanpa header).
export function previewMarkup(res, opt) {
  const items = shapes(res, opt);
  const hidden = hiddenOf(res, opt);
  const parts = [];
  // Pengisi celah sama seperti ekspor: garis sewarna setelah isi tiap bentuk, hanya
  // di batas dengan bentuk sesudahnya — tanpa ini, sambungan dua bentuk tampak
  // sebagai garis tipis terang (antialias kedua tepi membuat lapisan bawah terlihat).
  const sw = res.mode === 'gradient' ? 1 : 1.5;
  for (const it of items) {
    const sk = svgSink(1, 1);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    const c = hex(it.color);
    parts.push(`<path fill="${c}" fill-rule="evenodd" d="${sk.text()}"/>`);
    if (opt.gapFill) {
      const d = [];
      for (const i of it.regions) for (const g of gapStrokes(res, i, hidden, () => svgSink(1, 1), items.rank, 0.5 * (res.scale || 1))) d.push(g.text());
      if (d.length) parts.push(`<path fill="none" stroke="${c}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round" d="${d.join('')}"/>`);
    }
  }
  return parts.join('') + glowSVG(res, opt, 1, 1, hidden) + linesSVG(res, 1, 1);
}

export function outlineMarkup(res, hidden) {
  const h = hidden || defaultHidden(res);
  const sk = svgSink(1, 1);
  res.regions.forEach((r, i) => { if (!h[i]) for (const s of r.subs) walk(s.refs, res.chains, sk, true); });
  const ld = (res.lines || []).map((L) => lineD(L, 1, 1)).join(' ');
  return `<path d="${sk.text()}"/>` + (ld ? `<path d="${ld}"/>` : '');
}

// Path satu region (untuk sorotan saat kursor di atasnya).
export function regionPath(res, i) {
  const sk = svgSink(1, 1);
  for (const s of res.regions[i].subs) walk(s.refs, res.chains, sk, true);
  return sk.text();
}

export { hex };

// ---------------------------------------------------------------- ZIP
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export async function makeZip(files, onProgress) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    const comp = await deflate(raw);
    const method = comp && comp.length < raw.length ? 8 : 0;
    const body = method === 8 ? comp : raw;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + body.length;
    if (onProgress) onProgress((i + 1) / files.length);
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}

export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
