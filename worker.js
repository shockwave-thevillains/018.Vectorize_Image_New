/*
 * Vektor — mesin tracing (Web Worker).
 *
 * Alur:
 *  1. Palet dari piksel "rata" (piksel transisi/antialias diabaikan) → warna bersih.
 *  2. Upscale (default 4×) dengan interpolasi halus.
 *  3. Label: piksel yang jelas cocok dengan palet jadi benih; piksel transisi
 *     dibagi ke warna tetangga terdekat (region growing) → batas jatuh di titik
 *     50% antar warna = presisi sub-piksel.
 *  4. Bersihkan bintik kecil, buang putih luar (dan opsional putih dalam).
 *  5. Telusuri batas pada kisi sudut piksel. Batas antar dua region dipecah
 *     menjadi rantai di titik pertemuan ≥3 region; tiap rantai di-fit SEKALI dan
 *     dipakai bersama oleh kedua sisi → tanpa celah, tanpa tumpang tindih.
 *  6. Fitting: deteksi sudut, garis lurus, Bézier kubik (Schneider), elips utuh.
 */
'use strict';

const T = 255; // label transparan
const U = 254; // belum ditetapkan
const HW = 253; // putih latar: tetap ditrace, tersembunyi secara default

// ---------------------------------------------------------------- warna
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function rgb2lab(r, g, b, out, o = 0) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const fy = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const fz = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
  return out;
}
const tmpLab = new Float32Array(3);

// ---------------------------------------------------------------- pesan
self.onmessage = async (e) => {
  const { id, file, opts, aiMask } = e.data;
  const progress = (p, stage) => self.postMessage({ id, type: 'progress', p, stage });
  try {
    const result = await vectorize(file, opts, progress, aiMask);
    const transfer = [];
    for (const ch of result.chains) transfer.push(ch.p.buffer, ch.c.buffer);
    transfer.push(result.rmap.buffer);
    self.postMessage({ id, type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};

// ---------------------------------------------------------------- utama
async function vectorize(file, o, progress, aiMask) {
  const bmp = await createImageBitmap(file);
  const sw = bmp.width, sh = bmp.height;

  const c0 = new OffscreenCanvas(sw, sh);
  const g0 = c0.getContext('2d', { willReadFrequently: true });
  g0.drawImage(bmp, 0, 0);
  const src = g0.getImageData(0, 0, sw, sh).data;

  // Latar berwarna kunci (mis. magenta): dibuang di tingkat piksel sebelum apa pun.
  if (o.bgKey === 'magenta') {
    chromaKey(src, sw, sh, [255, 0, 255], (o.keyTol ?? 30) / 100);
    g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  }

  // Mode siluet: 2 warna tetap (hitam pekat + putih), ambang luminans.
  const sil = o.mode === 'silhouette';
  const binary = sil && o.silTones === 'binary';
  // Siluet bernada: gambar dijadikan abu-abu dulu (noise warna JPEG hilang),
  // lalu hitam dan setiap tingkat abu-abu menjadi warna palet sendiri.
  const orig = sil && !binary ? new Uint8ClampedArray(src) : null;
  if (sil && !binary) {
    for (let p = 0; p < src.length; p += 4) {
      const y = Math.round(0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]);
      src[p] = src[p + 1] = src[p + 2] = y;
    }
    g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  }
  // Gradien: grain/noise JPEG di area datar diratakan (bilateral) sebelum palet,
  // supaya area halus menjadi bentuk besar yang mulus; tepi kontras tetap tajam.
  // Gradien: garis tipis dideteksi dulu, dihapus dari gambar (diisi warna
  // latarnya), lalu digambar ulang sebagai garis vektor bertebal seragam.
  let thinLines = o.mode === 'gradient' && o.lineStrokes !== false ? detectLines(src, sw, sh, ...(o._dl || [])) : [];
  let flatEdge = null;
  if (thinLines.length) g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  if (o.mode === 'gradient') {
    // Detail kecil yang kontras (garis tipis, titik, huruf) dilindungi: bobotnya
    // dihitung dari selisih terhadap rata-rata 5×5 sebelum penghalusan.
    const keep = detailMask(src, sw, sh, 30, 40);
    const orig = new Uint8ClampedArray(src);
    const sr = 6 + 0.4 * (o.gradSmooth ?? 30);
    for (let k = 0; k < 2; k++) bilateral(src, sw, sh, 3, 2.2, sr);
    // Gradasi lebar (cahaya lampu, dinding) dihaluskan berjangkauan jauh tanpa
    // menyeberangi tepi kontras → pita warna nanti berkontur mulus.
    // (Domain transform hanya bila penghalusan bidang landai dimatikan: arahnya
    // horizontal/vertikal sehingga halo cahaya menjadi kotak.)
    if (o.flatSmooth === false) domainTransform(src, sw, sh, Math.max(4, Math.min(sw, sh) / 90), 45, 3);
    // Bidang landai (langit, cahaya bulan/matahari): grain dihaluskan isotropik
    // berjangkauan jauh di resolusi rendah → kontur pita warna bulat & mulus,
    // bukan kotak bergerigi. Tepi/garis kontras tidak tersentuh.
    if (o.flatSmooth !== false) flatEdge = smoothFlat(src, sw, sh, ...(o._fs || []));
    for (let i = 0, p = 0; i < keep.length; i++, p += 4) {
      const m = keep[i];
      if (!m) continue;
      src[p] += m * (orig[p] - src[p]); src[p + 1] += m * (orig[p + 1] - src[p + 1]); src[p + 2] += m * (orig[p + 2] - src[p + 2]);
    }
    g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  }
  // Warna + Rapikan: grain/tekstur bintik dan derau JPEG diratakan dengan
  // penghalusan yang menjaga tepi, sebelum palet (seperti vectorizer.ai yang
  // "membaca" maksud gambar, bukan tiap bintik). Detail kontras dilindungi.
  const clean = o.mode === 'color' && o.clean !== false;
  // Haluskan tepi kasar hanya untuk mode Warna.
  o = { ...o, rough: o.mode === 'color' ? +o.rough || 0 : 0 };
  const raw = clean && o.lineStrokes !== false ? new Uint8ClampedArray(src) : null;
  if (clean) {
    const keep = detailMask(src, sw, sh, 30, 40);
    const orig = new Uint8ClampedArray(src);
    for (let k = 0; k < 2; k++) bilateral(src, sw, sh, 2, 1.6, 13);
    // Hanya grain yang diratakan: piksel di tepi nyata (selisih tengah besar
    // pada gambar asli) dikembalikan utuh, jadi outline tipis tidak memudar.
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1, p = (y * sw + 1) * 4; x < sw - 1; x++, p += 4) {
        if (diff(orig, p - 4, p + 4) + diff(orig, p - sw * 4, p + sw * 4) <= 110) continue;
        src[p] = orig[p]; src[p + 1] = orig[p + 1]; src[p + 2] = orig[p + 2];
      }
    }
    for (let i = 0, p = 0; i < keep.length; i++, p += 4) {
      const m = keep[i];
      if (!m) continue;
      src[p] += m * (orig[p] - src[p]); src[p + 1] += m * (orig[p + 1] - src[p + 1]); src[p + 2] += m * (orig[p + 2] - src[p + 2]);
    }
    g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  }
  const pal = binary
    ? [{ r: 0, g: 0, b: 0, L: 0, A: 0, B: 0, n: 2 }, { r: 255, g: 255, b: 255, L: 100, A: 0, B: 0, n: 1 }]
    : buildPalette(src, sw, sh, o);
  // Siluet bernada: warna output = rata-rata warna asli piksel dengan tingkat abu-abu itu.
  if (orig) {
    for (const p of pal) {
      const g = Math.round(0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
      let n = 0, r = 0, gg = 0, b = 0;
      for (let q = 0; q < src.length; q += 4) {
        if (Math.abs(src[q] - g) > 6) continue;
        n++; r += orig[q]; gg += orig[q + 1]; b += orig[q + 2];
      }
      if (n) { p.r = clamp255(r / n); p.g = clamp255(gg / n); p.b = clamp255(b / n); }
    }
  }
  // Warna + Rapikan, gambar kaya warna/tekstur (palet >= 24): garis tipis yang
  // pecah di isian ditambahkan sebagai stroke rata di atasnya. Isian tidak
  // diubah (topologi & putih tetap). Ilustrasi flat: garisnya sudah tegas.
  if (raw && pal.length >= 24) thinLines = detectLines(raw, sw, sh, 2, 2.8);
  progress(0.06, 'palet');

  // Penghalusan searah garis pada resolusi sumber, lalu upscale dari hasilnya.
  if (o.flow !== false) {
    const pre = flatEdge ? new Uint8ClampedArray(src) : null;
    flowSmooth(src, sw, sh, Math.max(2, Math.round(1.5 + 2.5 * o.smooth)));
    // Gradien: garis tipis diratakan lebih panjang searah garis (kecerahan &
    // tebal seragam, tidak putus); hanya piksel dengan arah yang sangat jelas.
    if (o.mode === 'gradient') {
      flowSmooth(src, sw, sh, 7, 0.7, 120);
      // Bidang landai yang sudah dihaluskan tidak ikut diratakan searah "garis"
      // (arah semu di langit membuat pita bergaris/berlidah api).
      if (pre) restoreFlat(src, pre, flatEdge, sw, sh, 2);
      o._orient = orientField(src, sw, sh);
    }
    g0.putImageData(new ImageData(src, sw, sh), 0, 0);
  }
  progress(0.1, 'arah garis');

  // Upscale — dibatasi total piksel kerja agar memori aman.
  let s = Math.min(o.upscale, Math.sqrt(o.maxWorkPixels / (sw * sh)));
  const W = Math.max(1, Math.round(sw * s));
  const H = Math.max(1, Math.round(sh * s));
  s = W / sw;
  let data;
  if (W === sw && H === sh) {
    data = src;
  } else {
    const c1 = new OffscreenCanvas(W, H);
    const g1 = c1.getContext('2d', { willReadFrequently: true });
    g1.imageSmoothingEnabled = true;
    g1.imageSmoothingQuality = 'high';
    g1.drawImage(c0, 0, 0, W, H);
    data = g1.getImageData(0, 0, W, H).data;
  }
  bmp.close();
  progress(0.15, 'upscale');

  const N = W * H;
  const lab = assignLabels(data, W, H, s, pal, o);
  progress(0.35, 'label');

  const order = new Int32Array(N);
  const comp = new Int32Array(N);
  // Gradien: cahaya di sekitar benda terang yang bulat (bulan, matahari) dibuat
  // menjadi cincin sepusat yang makin redup ke luar.
  let glows = [], glowFlag = null;
  if (o.mode === 'gradient' && o.glowRings !== false) {
    glowFlag = new Uint8Array(N);
    // Garis vektor (outline yang dihapus dari isian) menjadi pembatas cahaya.
    const wall = new Uint8Array(N);
    for (const L of thinLines) {
      const rr = Math.max(1, Math.ceil(((L.w || 1) / 2 + 0.75) * s));
      for (let k = 0; k < L.pts.length; k++) {
        const [ax, ay] = L.pts[k], [bx, by] = L.pts[Math.min(L.pts.length - 1, k + 1)];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * s));
        for (let q = 0; q <= steps; q++) {
          const cx = ((ax + (bx - ax) * (q / steps)) + 0.5) * s, cy = ((ay + (by - ay) * (q / steps)) + 0.5) * s;
          for (let yy = Math.max(0, Math.floor(cy - rr)); yy <= Math.min(H - 1, Math.ceil(cy + rr)); yy++)
            for (let xx = Math.max(0, Math.floor(cx - rr)); xx <= Math.min(W - 1, Math.ceil(cx + rr)); xx++)
              if ((xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2 <= rr * rr) wall[yy * W + xx] = 1;
        }
      }
    }
    glows = glowRings(lab, data, W, H, s, pal, comp, order, glowFlag, wall);
  }
  // Gradien: noise JPEG antar tingkat warna yang berdekatan dibuang lebih tegas.
  const minA = Math.max(1, Math.round(o.minArea * (o.mode === 'gradient' ? 3 : clean ? 2.5 : 1) * s * s));
  // Gradien / Rapikan: bintik kecil yang kontras (titik grid, bintang, butir nasi)
  // dipertahankan; bintik berkontras rendah (tekstur, derau) dilebur.
  despeckle(lab, W, H, minA, comp, order, pal, o.mode === 'gradient' || clean ? { de: 22, min: Math.max(2, Math.round((clean ? 3 : 0.8) * s * s)) } : null);
  if (o.mode === 'gradient') {
    mergeWeak(lab, data, W, H, pal, s, comp, order);
    dropSlivers(lab, W, H, pal, s, comp, order);
  }
  // Rapikan: bentuk sempit berwarna campuran dua tetangganya (sisa antialias di
  // ujung goresan, pinggiran garis) dilebur ke tetangga yang paling mirip.
  if (clean) dropSlivers(lab, W, H, pal, s, comp, order, 2.2, 0.2, 6);
  if (clean && o.thinDrop !== false) dropThin(lab, W, H, pal, s, comp, order);
  // Cocokkan tiap bentuk dengan gambar asli: bentuk yang warnanya tidak sesuai
  // rata-rata piksel aslinya (bagian yang tidak ada di gambar awal) dilebur.
  if (clean && o.verify !== false) verifyRegions(lab, data, W, H, pal, s, comp, order);
  // Batas yang di gambar asli hanyalah gradasi (tanpa garis tegas) tidak dibuat
  // menjadi garis: bercak di dalam gradasi dilebur ke tetangganya.
  if (clean && o.softMerge !== false) mergeSoft(lab, data, W, H, pal, s, comp, order, o.softMergeArea ?? 0.006, o.softMergeDE ?? 16, o.softMergeFrac ?? 0.8, o.softNearDE ?? 12, o.softNearFrac ?? 0.4);
  // Warna antara yang bedanya sangat tipis dengan tetangganya dianggap sama.
  if (clean && (o.stepDE ?? 8) > 0) mergeSteps(lab, W, H, pal, comp, order, o.stepDE ?? 8);
  // Penyederhanaan menurut kekuatan tepi: bercak (bayangan lembut, gradasi
  // berpita) yang batasnya dengan tetangga lemah di gambar asli dan warnanya
  // mirip dilebur ke tetangga terbesar. Batas kontras (outline) tidak disentuh.
  if (clean && o.simplify > 0) {
    const lv = o.simplify >= 2;
    mergeWeak(lab, data, W, H, pal, s, comp, order, lv ? 40 : 30, lv ? 20 : 16, (lv ? 0.01 : 0.004) * W * H);
  }
  // Tepi kasar: tonjolan & lekukan kecil di semua batas (juga bercak warna di
  // sepanjang tepi kuas) dihaluskan dengan filter mayoritas berjangkauan
  // o.rough px sumber, lalu sisa bintiknya dibuang.
  if (o.rough > 0) {
    // Hanya di antara warna yang mirip: garis tipis berkontras (outline) tidak terkikis.
    majorityFilter(lab, W, H, Math.max(1, Math.round(o.rough * s)), 2, pal, 20);
    despeckle(lab, W, H, Math.max(minA, Math.round((o.rough * s) ** 2 * 3)), comp, order, pal, { de: 22, min: Math.max(2, Math.round(3 * s * s)) });
  }
  progress(0.45, 'bersih');

  // Putih → transparan.
  const isWhite = new Uint8Array(256);
  pal.forEach((p, k) => {
    const d = Math.hypot(p.L - 100, p.A, p.B);
    if (d <= o.whiteTol) isWhite[k] = 1;
  });
  isWhite[T] = 1;
  // Warna putih utama (untuk bentuk latar yang disembunyikan).
  let whiteK = -1;
  pal.forEach((p, k) => { if (isWhite[k] && (whiteK < 0 || p.n > pal[whiteK].n)) whiteK = k; });
  let mode = o.bgKey ? 'off' : sil ? (o.cavity === 'transparent' ? 'all' : o.cavity === 'smart' ? 'smart' : 'outer') : o.whiteMode || 'outer';
  const useAI = mode === 'ai' && aiMask;
  if (mode === 'ai') mode = 'outer';
  if (whiteK >= 0) {
    if (mode === 'all') {
      for (let i = 0; i < N; i++) if (lab[i] !== T && isWhite[lab[i]]) lab[i] = HW;
    } else if (mode !== 'off') {
      floodBorder(lab, W, H, isWhite, order, Math.max(1, Math.round((o.gapClose ?? 1.5) * s)));
    }
  }

  // Komponen; putih latar terkurung (mode pintar) ikut ditandai HW.
  let info = label(lab, W, H, comp, order);
  // AI: putih di dalam gambar yang dinilai latar oleh model (rata-rata < 0,3) ikut dihapus.
  if (useAI && whiteK >= 0) {
    const S = 1024, sx = S / W, sy = S / H;
    let any = false;
    for (let c = 0; c < info.count; c++) {
      const l = info.lbl[c];
      if (l === T || l === HW || !isWhite[l] || info.border[c]) continue;
      let sum = 0, n = 0;
      const step = Math.max(1, Math.floor(info.size[c] / 4000));
      for (let h = info.start[c], e = h + info.size[c]; h < e; h += step) {
        const i = order[h];
        sum += aiMask[Math.min(S - 1, ((i / W) | 0) * sy | 0) * S + Math.min(S - 1, (i % W) * sx | 0)];
        n++;
      }
      if (n && sum / n < 0.3 * 255) {
        any = true;
        for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = HW;
      }
    }
    if (any) info = label(lab, W, H, comp, order);
  }

  // Siluet padat: rongga putih di dalam objek diisi warna siluet.
  // Rongga putih diisi warna tetangga terbanyak (hitam / abu-abu di sekelilingnya).
  if (sil && o.cavity === 'fill') {
    let any = false;
    const votes = new Int32Array(256);
    for (let c = 0; c < info.count; c++) {
      const l = info.lbl[c];
      if (l === T || l === HW || !isWhite[l]) continue;
      votes.fill(0);
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
        const i = order[h], x = i % W;
        const see = (q) => { const lq = lab[q]; if (lq < HW && !isWhite[lq]) votes[lq]++; };
        if (x > 0) see(i - 1);
        if (x < W - 1) see(i + 1);
        if (i >= W) see(i - W);
        if (i < N - W) see(i + W);
      }
      let best = -1, bv = 0;
      for (let k = 0; k < HW; k++) if (votes[k] > bv) { bv = votes[k]; best = k; }
      if (best < 0) continue;
      any = true;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = best;
    }
    if (any) info = label(lab, W, H, comp, order);
  }
  if (mode === 'smart' && whiteK >= 0) {
    const removed = new Uint8Array(info.count);
    smartWhite(lab, W, comp, order, info, isWhite, removed, pal, s);
    let any = false;
    for (let c = 0; c < info.count; c++) {
      if (!removed[c]) continue;
      any = true;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = HW;
    }
    if (any) info = label(lab, W, H, comp, order);
  }
  progress(0.55, 'region');

  const feats = whiteFeatures(lab, W, H, comp, order, info, isWhite, pal, s);
  o._pal = pal;
  const out = traceAll(lab, comp, info, W, H, s, o, whiteK, (p) => progress(0.55 + p * 0.43, 'kurva'), data);
  for (const [c, f] of feats) {
    const r = out.compToReg[c];
    if (r >= 0) out.regions[r].f = f;
  }
  // Cahaya: region langit = bentuk yang sebagian besar pikselnya di jangkauan
  // cahaya adalah langit (ditandai saat cahaya dikeluarkan).
  const glowOut = [];
  if (glows.some((g) => g.levels && g.levels.length)) {
    const all = glowSkyComps(glows, glowFlag, comp, info.count, W, H);
    glows.forEach((g, gi) => {
      const regs = [];
      for (const c of all[gi]) { const r = out.compToReg[c]; if (r >= 0) regs.push(r); }
      if (regs.length && g.levels && g.levels.length) glowOut.push({ cx: g.cx, cy: g.cy, R: g.R, G: g.G, levels: g.levels, regions: regs });
    });
  }

  // Peta region beresolusi sumber (dikecilkan bila besar) untuk klik & sorot instan.
  const q = Math.min(1, Math.sqrt(2e6 / (sw * sh)));
  const mw = Math.max(1, Math.round(sw * q)), mh = Math.max(1, Math.round(sh * q));
  const rmap = new Int32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const wy = Math.min(H - 1, Math.floor(((y + 0.5) / q) * s));
    for (let x = 0; x < mw; x++) {
      const wx = Math.min(W - 1, Math.floor(((x + 0.5) / q) * s));
      rmap[y * mw + x] = out.compToReg[comp[wy * W + wx]];
    }
  }

  return {
    mode: o.mode || 'color',
    srcW: sw,
    srcH: sh,
    W,
    H,
    scale: s,
    palette: pal.map((p) => [p.r, p.g, p.b]),
    whiteIdx: pal.map((_, k) => !!isWhite[k]),
    chains: out.chains,
    regions: out.regions,
    nodes: out.nodes,
    lines: fitLines(thinLines, s),
    glows: glowOut,
    rmap,
    rmapW: mw,
    rmapH: mh,
  };
}

// ---------------------------------------------------------------- garis tipis
// Deteksi garis tipis (≤ ~2,8 px sumber) yang lebih terang/gelap dari kedua
// sisinya pada arah tegak lurus garis. Hasil: rantai titik tengah + lebar +
// warna asli (dikoreksi dari campuran dengan latar). Garis dihapus dari px
// (diisi rata-rata warna kedua sisinya) supaya tidak ikut menjadi isian.
function detectLines(px, w, h, R = 2.5, WMAX = 3.6) {
  const N = w * h;
  const of = orientField(px, w, h);
  const samp = (x, y, out) => {
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const p00 = (y0 * w + x0) * 4, p10 = p00 + 4, p01 = p00 + w * 4, p11 = p01 + 4;
    for (let c = 0; c < 3; c++) out[c] = (1 - fx) * (1 - fy) * px[p00 + c] + fx * (1 - fy) * px[p10 + c] + (1 - fx) * fy * px[p01 + c] + fx * fy * px[p11 + c];
    return out;
  };
  const d3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const Y = (a) => 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
  const S = new Float32Array(N), WD = new Float32Array(N), NX = new Float32Array(N), NY = new Float32Array(N);
  const OX = new Float32Array(N), OY = new Float32Array(N);
  const CR = new Float32Array(N * 3), BG = new Float32Array(N * 3);
  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], M = [0, 0, 0], Q = [0, 0, 0];
  const bC = [0, 0, 0], bM = [0, 0, 0];
  const mask = new Uint8Array(N);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] < 255 || of.C[i] < 0.45) continue;
      const nx = -of.TY[i], ny = of.TX[i];
      // Puncak garis dicari sub-piksel di sepanjang normal (±0,75 px): garis
      // 1–2 px yang miring sering berpusat di antara dua piksel.
      // Garis gelap (outline) boleh lebih tebal (R, WMAX); garis terang memakai
      // batas lama (2 px, 2,8 px) supaya pendar terang tidak ikut terhapus.
      let st = 0, bt = 0, dark = false, Rr = R;
      for (let pass = 0; pass < 2; pass++) {
        st = 0; bt = 0;
        for (let t = -0.75; t <= 0.75; t += 0.25) {
          const cx = x + t * nx, cy = y + t * ny;
          samp(cx, cy, C); samp(cx + Rr * nx, cy + Rr * ny, A); samp(cx - Rr * nx, cy - Rr * ny, B);
          for (let c = 0; c < 3; c++) M[c] = (A[c] + B[c]) / 2;
          const yc = Y(C), ya = Y(A), yb = Y(B);
          const isDark = yc < ya - 8 && yc < yb - 8;
          if (!((yc > ya + 8 && yc > yb + 8) || isDark)) continue;
          if (pass === 1 && isDark) continue;
          const v = d3(C, M);
          if (v <= st || d3(A, B) > 0.7 * v) continue;
          st = v; bt = t; dark = isDark;
          for (let c = 0; c < 3; c++) { bC[c] = C[c]; bM[c] = M[c]; }
        }
        if (dark || Rr === 2 || !st) break;
        Rr = 2;
      }
      const WM = dark ? WMAX : Math.min(WMAX, 2.8), RR = dark ? Rr : 2;
      // Hanya piksel yang paling dekat ke puncak (|t| ≤ 0,5) → punggung ±1 px.
      if (st < 28 || Math.abs(bt) > 0.5) continue;
      const cx = x + bt * nx, cy = y + bt * ny;
      // Lebar: jarak di mana selisih terhadap latar turun ke separuhnya.
      let wd = 0, flat = 0;
      for (const sg of [1, -1]) {
        let t = 0.25;
        for (; t <= WM + 0.2; t += 0.25) if (d3(samp(cx + sg * t * nx, cy + sg * t * ny, Q), bM) < st / 2) break;
        wd += t - 0.125;
        // Latar di sisi ini harus rata (bukan celah gelap di antara dua garis terang).
        const s2 = samp(cx + sg * RR * nx, cy + sg * RR * ny, A), s4 = samp(cx + sg * (RR + 1.5) * nx, cy + sg * (RR + 1.5) * ny, B);
        if (d3(s2, s4) < 0.6 * st) flat++;
      }
      if (wd > WM || !flat) continue;
      S[i] = st; WD[i] = wd; NX[i] = nx; NY[i] = ny; OX[i] = cx; OY[i] = cy;
      for (let c = 0; c < 3; c++) { CR[i * 3 + c] = bC[c]; BG[i * 3 + c] = bM[c]; }
      mask[i] = 1;
    }
  }
  thinZS(mask, w, h);
  // Pisah di persimpangan, lalu telusuri rantai.
  const nb = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  const deg = (i) => { let n = 0; for (const d of nb) if (mask[i + d]) n++; return n; };
  // Anak tangga garis diagonal (piksel sudut yang tetangganya sudah saling
  // bersentuhan) dibuang → garis 8-terhubung bersih.
  const ring = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1];
  for (let i = w + 1; i < N - w - 1; i++) {
    if (!mask[i]) continue;
    for (let k = 0; k < 8; k += 2) {
      const a = ring[k], b = ring[(k + 2) % 8], ab = ring[(k + 1) % 8];
      if (mask[i + a] && mask[i + b] && !mask[i + ab] && deg(i) === 2) { mask[i] = 0; break; }
    }
  }
  // Persimpangan = ≥3 cabang (transisi 0→1 di cincin 8 tetangga).
  const branches = (i) => { let n = 0; for (let k = 0; k < 8; k++) if (!mask[i + ring[k]] && mask[i + ring[(k + 1) % 8]]) n++; return n; };
  for (let i = w + 1; i < N - w - 1; i++) if (mask[i] && deg(i) >= 3 && branches(i) >= 3) mask[i] = 2;
  for (let i = 0; i < N; i++) if (mask[i] === 2) mask[i] = 0;
  const seen = new Uint8Array(N);
  const lines = [];
  const walk = (s0) => {
    const pts = [s0];
    seen[s0] = 1;
    let cur = s0;
    for (;;) {
      let nxt = -1;
      for (const d of [-w, 1, w, -1, -w - 1, -w + 1, w - 1, w + 1]) { const j = cur + d; if (mask[j] && !seen[j]) { nxt = j; break; } }
      if (nxt < 0) break;
      seen[nxt] = 1; pts.push(nxt); cur = nxt;
    }
    return pts;
  };
  const order = [];
  for (let i = w; i < N - w; i++) if (mask[i] && deg(i) <= 1) order.push(i);
  for (let i = w; i < N - w; i++) if (mask[i]) order.push(i);
  let raw = [];
  for (const s0 of order) {
    if (seen[s0]) continue;
    const pts = walk(s0);
    if (pts.length >= 3) raw.push(pts);
  }
  raw = linkChains(raw, w, 6, 35);
  // Celah lebih panjang (persilangan, simpul) hanya bila benar-benar segaris.
  raw = linkChains(raw, w, 14, 14, 1.6);
  const cand = [];
  for (const pts of raw) {
    if (pts.length < 10) continue;
    const ws = [], ch = [[], [], [], [], [], []];
    for (const i of pts) { ws.push(WD[i]); for (let c = 0; c < 3; c++) { ch[c].push(CR[i * 3 + c]); ch[c + 3].push(BG[i * 3 + c]); } }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const wd = med(ws), cv = Math.min(1, Math.max(0.5, wd));
    // Warna sejati garis: pusat garis dikoreksi dari campuran dengan latar
    // (berdasarkan lebar median satu garis, bukan per piksel → stabil).
    // Koreksi seragam di ketiga kanal dan dibatasi gamut → rona tidak bergeser.
    const cc = [0, 1, 2].map((c) => med(ch[c])), mm = [0, 1, 2].map((c) => med(ch[c + 3]));
    let k = 1 / cv;
    for (let c = 0; c < 3; c++) { const d = cc[c] - mm[c]; if (d > 0.5) k = Math.min(k, (255 - mm[c]) / d); else if (d < -0.5) k = Math.min(k, -mm[c] / d); }
    const rgb = [0, 1, 2].map((c) => mm[c] + (cc[c] - mm[c]) * Math.max(1, k));
    cand.push({ pts: pts.map((i) => [OX[i], OY[i]]), w: Math.max(1, wd), rgb, idx: pts });
  }
  // Warna garis yang mirip diseragamkan (dikelompokkan, berbobot panjang).
  const groups = [], la = new Float32Array(3), lb = new Float32Array(3);
  const lab = (c, o) => rgb2lab(clamp255(c[0]) | 0, clamp255(c[1]) | 0, clamp255(c[2]) | 0, o);
  for (const L of cand.sort((a, b) => b.pts.length - a.pts.length)) {
    lab(L.rgb, la);
    let g = groups.find((q) => { lab([q.r / q.n, q.g / q.n, q.b / q.n], lb); return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) < 9; });
    if (!g) groups.push((g = { r: 0, g: 0, b: 0, n: 0, m: [] }));
    const k = L.pts.length;
    g.r += L.rgb[0] * k; g.g += L.rgb[1] * k; g.b += L.rgb[2] * k; g.n += k; g.m.push(L);
  }
  for (const g of groups) for (const L of g.m) L.rgb = [g.r / g.n, g.g / g.n, g.b / g.n].map(clamp255);
  lines.push(...cand);
  // Hapus garis dari gambar: piksel dalam ±(w/2+1,5) diisi peralihan linear
  // antara warna kedua sisinya (diambil di luar garis, dari gambar asli).
  const orig = new Uint8ClampedArray(px);
  const sampO = (x, y, out) => {
    const xx = Math.max(0, Math.min(w - 1, Math.round(x))), yy = Math.max(0, Math.min(h - 1, Math.round(y))), p = (yy * w + xx) * 4;
    out[0] = orig[p]; out[1] = orig[p + 1]; out[2] = orig[p + 2]; return out;
  };
  const SA = [0, 0, 0], SB = [0, 0, 0], hole = new Uint8Array(N);
  for (const L of lines) {
    const half = L.w / 2 + 1.5;
    for (const i of L.idx) {
      const x = OX[i], y = OY[i], nx = NX[i], ny = NY[i];
      sampO(x + (half + 1) * nx, y + (half + 1) * ny, SA); sampO(x - (half + 1) * nx, y - (half + 1) * ny, SB);
      for (let t = -half; t <= half; t += 0.5) {
        const xx = Math.round(x + t * nx), yy = Math.round(y + t * ny);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const p = (yy * w + xx) * 4;
        if (orig[p + 3] < 255) continue;
        const f = (t + half) / (2 * half);
        px[p] = SB[0] + f * (SA[0] - SB[0]); px[p + 1] = SB[1] + f * (SA[1] - SB[1]); px[p + 2] = SB[2] + f * (SA[2] - SB[2]);
        hole[p >> 2] = 1;
      }
    }
    delete L.idx;
  }
  // Isian bekas garis dihaluskan (difusi dari tepinya) → tanpa belang akibat
  // derau JPEG di titik-titik sampel sisi garis.
  const hi = [];
  for (let i = w; i < N - w; i++) if (hole[i]) hi.push(i);
  const buf = new Float32Array(hi.length * 3);
  for (let it = 0; it < 12; it++) {
    for (let k = 0; k < hi.length; k++) {
      const p = hi[k] * 4;
      for (let c = 0; c < 3; c++) buf[k * 3 + c] = (px[p - 4 + c] + px[p + 4 + c] + px[p - w * 4 + c] + px[p + w * 4 + c] + 2 * px[p + c]) / 6;
    }
    for (let k = 0; k < hi.length; k++) { const p = hi[k] * 4; for (let c = 0; c < 3; c++) px[p + c] = buf[k * 3 + c]; }
  }
  return lines;
}

// Sambungkan rantai yang ujungnya berdekatan (≤ maxGap px) dan searah
// (sudut ≤ maxAng°): garis yang putus atau terpotong di persilangan menyatu.
function linkChains(chains, w, maxGap, maxAng, maxLat = Infinity) {
  const P = (i) => [i % w, (i / w) | 0];
  const cosMax = Math.cos((maxAng * Math.PI) / 180);
  const endDir = (c, atEnd) => {
    const n = c.length, k = Math.min(5, n - 1);
    const a = P(atEnd ? c[n - 1 - k] : c[k]), b = P(atEnd ? c[n - 1] : c[0]);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  let merged = true;
  while (merged) {
    merged = false;
    const ends = [];
    chains.forEach((c, ci) => { ends.push([ci, 0], [ci, 1]); });
    const cand = [];
    const grid = new Map(), cell = maxGap;
    const key = (x, y) => ((x / cell) | 0) * 100003 + ((y / cell) | 0);
    for (const [ci, e] of ends) {
      const c = chains[ci], p = P(e ? c[c.length - 1] : c[0]);
      const k = key(p[0], p[1]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([ci, e, p]);
    }
    for (const [ci, e] of ends) {
      const c = chains[ci], p = P(e ? c[c.length - 1] : c[0]), d1 = endDir(c, e);
      const gx = (p[0] / cell) | 0, gy = (p[1] / cell) | 0;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const [cj, f, q] of grid.get((gx + ox) * 100003 + gy + oy) || []) {
          if (cj <= ci) continue;
          const dx = q[0] - p[0], dy = q[1] - p[1], dist = Math.hypot(dx, dy);
          if (dist > maxGap) continue;
          const d2 = endDir(chains[cj], f);
          // Arah ujung A menghadap B, arah ujung B menghadap A.
          if (-(d1[0] * d2[0] + d1[1] * d2[1]) < cosMax) continue;
          if (dist > 1.5 && (dx * d1[0] + dy * d1[1]) / dist < cosMax) continue;
          // Ujung B harus berada di perpanjangan garis A (simpangan samping kecil).
          if (Math.abs(dx * d1[1] - dy * d1[0]) > maxLat) continue;
          cand.push([dist, ci, e, cj, f]);
        }
      }
    }
    cand.sort((a, b) => a[0] - b[0]);
    const used = new Set(), dead = new Set();
    for (const [, ci, e, cj, f] of cand) {
      if (dead.has(ci) || dead.has(cj) || used.has(ci * 2 + e) || used.has(cj * 2 + f)) continue;
      let A = chains[ci], B = chains[cj];
      if (!e) A = A.slice().reverse();
      if (f) B = B.slice().reverse();
      chains[ci] = A.concat(B);
      dead.add(cj);
      used.add(ci * 2 + 0); used.add(ci * 2 + 1);
      merged = true;
    }
    chains = chains.filter((_, k) => !dead.has(k));
  }
  return chains;
}

// Penipisan Zhang–Suen (mask 0/1, di tempat).
function thinZS(m, w, h) {
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1], p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const bn = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (bn < 2 || bn > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) a++;
          if (a !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      if (del.length) changed = true;
      for (const i of del) m[i] = 0;
    }
  }
}

// Rantai titik (px sumber) → kurva halus di koordinat kerja: perataan ringan,
// penyederhanaan Douglas–Peucker, lalu Catmull-Rom → Bézier kubik.
function fitLines(lines, s) {
  const out = [];
  for (const L of lines) {
    let P = L.pts.map(([x, y]) => [(x + 0.5) * s, (y + 0.5) * s]);
    for (let it = 0; it < 3; it++) {
      const Q = P.map((p) => p.slice());
      for (let k = 1; k < P.length - 1; k++) { Q[k][0] = (P[k - 1][0] + 2 * P[k][0] + P[k + 1][0]) / 4; Q[k][1] = (P[k - 1][1] + 2 * P[k][1] + P[k + 1][1]) / 4; }
      P = Q;
    }
    const tol = 0.45 * s, keep = new Uint8Array(P.length);
    keep[0] = keep[P.length - 1] = 1;
    const rdp = (a, b) => {
      const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = Math.hypot(dx, dy) || 1;
      let mi = -1, md = tol;
      for (let k = a + 1; k < b; k++) { const d = Math.abs((P[k][0] - ax) * dy - (P[k][1] - ay) * dx) / L2; if (d > md) { md = d; mi = k; } }
      if (mi > 0) { keep[mi] = 1; rdp(a, mi); rdp(mi, b); }
    };
    rdp(0, P.length - 1);
    const K = P.filter((_, k) => keep[k]);
    // Ujung diperpanjang ±1,2 px sumber agar menyentuh titik/bentuk di ujungnya.
    if (K.length >= 2) {
      const ext = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1; a[0] += (dx / l) * 1.2 * s; a[1] += (dy / l) * 1.2 * s; };
      ext(K[0], K[1]); ext(K[K.length - 1], K[K.length - 2]);
    }
    const p = [K[0][0], K[0][1]];
    for (let k = 0; k < K.length - 1; k++) {
      const p0 = K[Math.max(0, k - 1)], p1 = K[k], p2 = K[k + 1], p3 = K[Math.min(K.length - 1, k + 2)];
      p.push(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    out.push({ p, w: L.w * s, rgb: L.rgb });
  }
  return out;
}

// ---------------------------------------------------------------- chroma key
// Piksel yang jaraknya ke warna kunci ≤ toleransi → transparan. Piksel tepi
// (campuran objek + kunci, akibat antialias) mendapat alpha sesuai porsi
// objeknya dan warna objek murni dari tetangga terdekat yang bersih, sehingga
// tidak ada pinggiran ungu dan tepi tetap sub-piksel setelah upscale.
function chromaKey(px, w, h, key, tol) {
  const N = w * h;
  const MAXD = Math.sqrt(3) * 255;
  const t0 = tol * MAXD;
  const t1 = Math.min(MAXD, t0 + Math.max(40, 0.35 * MAXD * (0.5 - tol) + 40));
  const d = new Float32Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    d[i] = px[p + 3] < 16 ? 0 : Math.hypot(px[p] - key[0], px[p + 1] - key[1], px[p + 2] - key[2]);
  }
  // Pinggiran campuran hanya ada di dekat latar kunci yang sebenarnya (<= 4 px
  // dari piksel yang pasti kunci). Warna objek yang kebetulan mirip kunci
  // (biru-ungu) di tengah gambar tidak disentuh.
  const near = new Uint8Array(N);
  let fr = [];
  for (let i = 0; i < N; i++) if (d[i] <= t0) { near[i] = 1; fr.push(i); }
  for (let step = 0; step < 4 && fr.length; step++) {
    const nx = [];
    for (const i of fr) {
      const x = i % w;
      if (x > 0 && !near[i - 1]) { near[i - 1] = 1; nx.push(i - 1); }
      if (x < w - 1 && !near[i + 1]) { near[i + 1] = 1; nx.push(i + 1); }
      if (i >= w && !near[i - w]) { near[i - w] = 1; nx.push(i - w); }
      if (i < N - w && !near[i + w]) { near[i + w] = 1; nx.push(i + w); }
    }
    fr = nx;
  }
  const R = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const di = d[i];
      if (di <= t0) { px[p + 3] = 0; continue; }
      if (di >= t1 || !near[i]) continue;
      // Warna objek murni: tetangga terdekat yang jauh dari kunci.
      let best = -1, bd = Infinity;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (d[j] < t1) continue;
          const dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; best = j; }
        }
      }
      let a;
      if (best >= 0) {
        const q = best * 4;
        const cr = px[q], cg = px[q + 1], cb = px[q + 2];
        // Porsi objek: proyeksi piksel pada garis kunci → warna objek.
        const vx = cr - key[0], vy = cg - key[1], vz = cb - key[2];
        const vv = vx * vx + vy * vy + vz * vz || 1;
        a = ((px[p] - key[0]) * vx + (px[p + 1] - key[1]) * vy + (px[p + 2] - key[2]) * vz) / vv;
        px[p] = cr; px[p + 1] = cg; px[p + 2] = cb;
      } else {
        a = (di - t0) / (t1 - t0);
      }
      px[p + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  // Lapis 2 — rembesan warna kunci (mis. kompresi JPEG): piksel ≤ 3 px dari area
  // transparan yang warnanya = campuran warna objek di dekatnya + kunci.
  const dt = new Uint8Array(N).fill(255);
  let cur = [];
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] === 0) { dt[i] = 0; cur.push(i); }
  for (let step = 1; step <= 6 && cur.length; step++) {
    const next = [];
    for (const i of cur) {
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < N - w ? i + w : -1];
      for (const j of nb) if (j >= 0 && dt[j] === 255) { dt[j] = step; next.push(j); }
    }
    cur = next;
  }
  const R2 = 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      if (dt[i] === 0 || dt[i] > 3 || px[p + 3] < 255) continue;
      let bestRes = 22, bc = -1, ba = 1;
      for (let dy = -R2; dy <= R2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R2; dx <= R2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (dt[j] <= 3 || px[j * 4 + 3] < 255) continue; // kandidat = warna bersih di dalam objek
          const q = j * 4;
          const vx = px[q] - key[0], vy = px[q + 1] - key[1], vz = px[q + 2] - key[2];
          const vv = vx * vx + vy * vy + vz * vz;
          if (vv < 400) continue;
          const wx = px[p] - key[0], wy = px[p + 1] - key[1], wz = px[p + 2] - key[2];
          const a = (wx * vx + wy * vy + wz * vz) / vv;
          if (a < 0 || a > 1.05) continue;
          const res = Math.hypot(wx - a * vx, wy - a * vy, wz - a * vz);
          if (res < bestRes) { bestRes = res; bc = q; ba = a; }
        }
      }
      if (bc < 0 || ba > 0.97) continue;
      px[p] = px[bc]; px[p + 1] = px[bc + 1]; px[p + 2] = px[bc + 2];
      px[p + 3] = Math.round(255 * Math.min(1, ba));
    }
  }
}

// ---------------------------------------------------------------- palet
function buildPalette(px, w, h, o) {
  const cnt = new Float64Array(32768);
  const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  const acnt = new Float64Array(32768);
  const ar = new Float64Array(32768), ag = new Float64Array(32768), ab = new Float64Array(32768);
  const FT = 36;
  // Histogram piksel "sangat rata" (selisih <= 12 ke tiap tetangga) untuk uji
  // lembah: pita tepi yang buram tidak masuk, gradasi lebar yang landai masuk.
  const strict = o.mode === 'color' && o.clean !== false ? new Float64Array(32768) : null;
  let flat = 0, all = 0;
  const samples = [];
  // Latar kunci: piksel <= 5 px dari area transparan. Rembesan warna kunci hanya
  // ada di sana, jadi warna di tengah objek tidak boleh dianggap rembesan.
  let nearT = null;
  const nearCnt = o.bgKey === 'magenta' ? new Float64Array(32768) : null;
  if (nearCnt) {
    nearT = new Uint8Array(w * h);
    let fr = [];
    for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] < 128) { nearT[i] = 1; fr.push(i); }
    for (let step = 0; step < 5 && fr.length; step++) {
      const nx = [];
      for (const i of fr) {
        const x = i % w;
        if (x > 0 && !nearT[i - 1]) { nearT[i - 1] = 1; nx.push(i - 1); }
        if (x < w - 1 && !nearT[i + 1]) { nearT[i + 1] = 1; nx.push(i + 1); }
        if (i >= w && !nearT[i - w]) { nearT[i - w] = 1; nx.push(i - w); }
        if (i < w * h - w && !nearT[i + w]) { nearT[i + w] = 1; nx.push(i + w); }
      }
      fr = nx;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const a = px[p + 3];
      if (a < 128) continue;
      let r = px[p], g = px[p + 1], b = px[p + 2];
      if (a < 255 && o.bgKey !== 'magenta') {
        const k = a / 255;
        r = Math.round(r * k + 255 * (1 - k));
        g = Math.round(g * k + 255 * (1 - k));
        b = Math.round(b * k + 255 * (1 - k));
      }
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      acnt[key]++; ar[key] += r; ag[key] += g; ab[key] += b; all++;
      if (nearT && nearT[i]) nearCnt[key]++;

      let isFlat = true;
      if (x > 0) isFlat = isFlat && diff(px, p, p - 4) <= FT;
      if (x < w - 1) isFlat = isFlat && diff(px, p, p + 4) <= FT;
      if (y > 0) isFlat = isFlat && diff(px, p, p - w * 4) <= FT;
      if (y < h - 1) isFlat = isFlat && diff(px, p, p + w * 4) <= FT;
      if (isFlat) { cnt[key]++; sr[key] += r; sg[key] += g; sb[key] += b; flat++; }
      if (strict) {
        const ST = 12;
        if ((x === 0 || diff(px, p, p - 4) <= ST) && (x === w - 1 || diff(px, p, p + 4) <= ST)
          && (y === 0 || diff(px, p, p - w * 4) <= ST) && (y === h - 1 || diff(px, p, p + w * 4) <= ST)) {
          strict[key]++;
          if (((x * 7 + y * 13) & 3) === 0) samples.push(r, g, b); // ¼ piksel rata, untuk uji lembah halus
        }
      }
    }
  }
  // Gambar foto/gradien penuh: tidak cukup piksel rata → pakai semua.
  let C = cnt, R = sr, G = sg, B = sb, total = flat;
  if (flat < all * 0.15) { C = acnt; R = ar; G = ag; B = ab; total = all; }
  if (total === 0) return [{ r: 255, g: 255, b: 255, L: 100, A: 0, B: 0, n: 1 }];

  const bins = [];
  for (let k = 0; k < 32768; k++) if (C[k] > 0) bins.push(k);
  bins.sort((a, b) => C[b] - C[a]);
  const bl = new Float32Array(32768 * 3);
  for (const k of bins) rgb2lab(Math.round(R[k] / C[k]), Math.round(G[k] / C[k]), Math.round(B[k] / C[k]), bl, k * 3);

  const grad = o.mode === 'gradient';
  // Mode gradien: banyak tingkat warna, tanpa peleburan agresif (gradasi = warna asli).
  const md = grad ? 7 : o.colorMerge;
  // Putih tidak pernah dilebur ke warna yang jelas berbeda (mis. ungu muda),
  // berapa pun kepekaan warnanya: putih punya arti khusus (latar/isi putih).
  const isW = (L, A, B) => L >= 96 && Math.hypot(A, B) < 5;
  const farW = (L, A, B) => L < 94 || Math.hypot(A, B) > 7;
  const sepW = (L1, A1, B1, L2, A2, B2) => (isW(L1, A1, B1) && farW(L2, A2, B2)) || (isW(L2, A2, B2) && farW(L1, A1, B1));
  // Warna + Rapikan: dua warna mirip tetap terpisah bila di antara keduanya
  // nyaris tidak ada piksel rata berwarna peralihan ("lembah" di histogram):
  // itu dua bidang datar yang memang berbeda (butir nasi di atas nasi), bukan
  // gradasi atau derau (yang peralihannya rata dan padat).
  const ec = !grad && o.mode === 'color' && o.clean !== false;
  const binOf = (r, g, b) => ((Math.max(0, Math.min(255, r)) >> 3) << 10) | ((Math.max(0, Math.min(255, g)) >> 3) << 5) | (Math.max(0, Math.min(255, b)) >> 3);
  let sumStrict = 0;
  if (strict) for (let k = 0; k < 32768; k++) sumStrict += strict[k];
  const valleyIn = (D, p, q) => {
    const ka = binOf(p.r, p.g, p.b), kb = binOf(q.r, q.g, q.b);
    const peak = Math.min(D[ka], D[kb]);
    // Hanya bidang yang cukup luas: varian kecil (pinggiran outline) tidak dihitung.
    if (peak < Math.max(24, (D === C ? total : sumStrict) * 0.0002)) return false;
    let low = Infinity, used = 0;
    for (let t = 0.15; t < 0.9; t += 0.1) {
      const k = binOf(p.r + t * (q.r - p.r), p.g + t * (q.g - p.g), p.b + t * (q.b - p.b));
      if (k === ka || k === kb) continue;
      used++;
      if (D[k] < low) low = D[k];
    }
    return used > 0 && low < 0.12 * peak;
  };
  // Histogram "sangat rata" untuk bidang lebar; histogram rata biasa untuk
  // bidang tipis (outline) yang hampir tidak punya piksel sangat rata.
  // Uji lembah halus untuk dua warna yang dekat: piksel rata di dekat ruas p–q
  // (jarak RGB <= 40 % panjang ruas, min. 6) diproyeksikan ke ruas itu dalam
  // 12 bagian. Dua bidang datar → dua puncak dengan lembah di antaranya;
  // gradasi/derau → sebaran rata tanpa lembah.
  const valleyFine = (p, q) => {
    if (!samples.length) return false;
    const vx = q.r - p.r, vy = q.g - p.g, vz = q.b - p.b, vv = vx * vx + vy * vy + vz * vz;
    if (vv < 9) return false;
    const L = Math.sqrt(vv), rad = Math.max(6, 0.4 * L), BN = 12;
    const hist = new Float64Array(BN);
    for (let k = 0; k < samples.length; k += 3) {
      const dx = samples[k] - p.r, dy = samples[k + 1] - p.g, dz = samples[k + 2] - p.b;
      const t = (dx * vx + dy * vy + dz * vz) / vv;
      if (t < -0.15 || t > 1.15) continue;
      const ex = dx - t * vx, ey = dy - t * vy, ez = dz - t * vz;
      if (ex * ex + ey * ey + ez * ez > rad * rad) continue;
      hist[Math.max(0, Math.min(BN - 1, Math.floor(t * BN)))]++;
    }
    let a = 0, b = 0;
    for (let i = 0; i < 3; i++) { a = Math.max(a, hist[i]); b = Math.max(b, hist[BN - 1 - i]); }
    const peak = Math.min(a, b);
    if (peak < Math.max(30, samples.length / 3 * 0.0005)) return false;
    let low = Infinity;
    for (let i = 4; i < BN - 4; i++) low = Math.min(low, hist[i]);
    return low < 0.2 * peak;
  };
  const valley = (p, q) => (strict && valleyIn(strict, p, q)) || valleyIn(C, p, q) || (strict && valleyFine(p, q));
  let cl = [];
  for (const k of bins) {
    const L = bl[k * 3], A = bl[k * 3 + 1], Bb = bl[k * 3 + 2];
    let best = -1, bd = Infinity;
    for (let j = 0; j < cl.length; j++) {
      const c = cl[j];
      const d = (c.L / c.n - L) ** 2 + (c.A / c.n - A) ** 2 + (c.B / c.n - Bb) ** 2;
      if (d < bd && !sepW(c.L / c.n, c.A / c.n, c.B / c.n, L, A, Bb)) { bd = d; best = j; }
    }
    const n = C[k];
    // Rapikan: bin yang dipisahkan "lembah" dari pusat klaster (bidang datar lain
    // yang mirip, mis. butir nasi putih di atas nasi) membuka klaster sendiri.
    if (best >= 0 && Math.sqrt(bd) < md && !(ec && bd > 16 && valley({ r: cl[best].r / cl[best].n, g: cl[best].g / cl[best].n, b: cl[best].b / cl[best].n }, { r: R[k] / C[k], g: G[k] / C[k], b: B[k] / C[k] }))) {
      const c = cl[best];
      c.n += n; c.L += L * n; c.A += A * n; c.B += Bb * n; c.r += R[k]; c.g += G[k]; c.b += B[k];
    } else {
      cl.push({ n, L: L * n, A: A * n, B: Bb * n, r: R[k], g: G[k], b: B[k] });
    }
  }
  const minN = Math.max(6, total * 0.00004);
  cl = cl.filter((c) => c.n >= minN);
  if (!cl.length) cl = [{ n: 1, L: 100, A: 0, B: 0, r: 255, g: 255, b: 255 }];

  // Normalisasi ke pusat.
  let P = cl.map((c) => ({ n: c.n, L: c.L / c.n, A: c.A / c.n, B: c.B / c.n, r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }));

  // Penyempurnaan k-means atas bin.
  for (let it = 0; it < 4; it++) {
    const acc = P.map(() => ({ n: 0, L: 0, A: 0, B: 0, r: 0, g: 0, b: 0 }));
    for (const k of bins) {
      const L = bl[k * 3], A = bl[k * 3 + 1], Bb = bl[k * 3 + 2];
      let best = 0, bd = Infinity;
      for (let j = 0; j < P.length; j++) {
        const d = (P[j].L - L) ** 2 + (P[j].A - A) ** 2 + (P[j].B - Bb) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (!grad && Math.sqrt(bd) > md * 2.5) continue; // bin pencilan tidak menggeser pusat
      const a = acc[best], n = C[k];
      a.n += n; a.L += L * n; a.A += A * n; a.B += Bb * n; a.r += R[k]; a.g += G[k]; a.b += B[k];
    }
    P = acc.filter((a) => a.n > 0).map((a) => ({ n: a.n, L: a.L / a.n, A: a.A / a.n, B: a.B / a.n, r: a.r / a.n, g: a.g / a.n, b: a.b / a.n }));
  }

  // Gabungkan warna yang terlalu mirip, lalu batasi jumlah warna (Ward).
  const maxC = grad ? Math.max(8, o.gradColors || 64) : o.maxColors > 0 ? o.maxColors : 64;
  for (;;) {
    let wi = -1, wj = -1, wc = Infinity; // pasangan Ward termurah
    let mi = -1, mj = -1, mdist = Infinity; // pasangan terdekat
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        if (sepW(P[i].L, P[i].A, P[i].B, P[j].L, P[j].A, P[j].B)) continue;
        const d2 = (P[i].L - P[j].L) ** 2 + (P[i].A - P[j].A) ** 2 + (P[i].B - P[j].B) ** 2;
        const cost = (d2 * P[i].n * P[j].n) / (P[i].n + P[j].n);
        if (cost < wc) { wc = cost; wi = i; wj = j; }
        if (d2 < mdist && !(ec && d2 < md * md && valley(P[i], P[j]))) { mdist = d2; mi = i; mj = j; }
      }
    }
    // Varian minor: warna kecil yang cukup dekat dengan warna dominan
    // (mis. tepi garis tipis yang lebih gelap akibat kompresi) ikut dilebur.
    let vi = -1, vj = -1, vd = Infinity;
    for (let i = 0; i < P.length && !grad; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const ratio = Math.min(P[i].n, P[j].n) / Math.max(P[i].n, P[j].n);
        if (ratio > 0.2 || sepW(P[i].L, P[i].A, P[i].B, P[j].L, P[j].A, P[j].B)) continue;
        const d = Math.sqrt((P[i].L - P[j].L) ** 2 + (P[i].A - P[j].A) ** 2 + (P[i].B - P[j].B) ** 2);
        if (d < md * 1.6 && d < vd && !(ec && valley(P[i], P[j]))) { vd = d; vi = i; vj = j; }
      }
    }
    let a, b;
    if (mi >= 0 && Math.sqrt(mdist) < (grad ? 3 : md * 0.8)) { a = mi; b = mj; }
    else if (vi >= 0) { a = vi; b = vj; }
    else if (P.length > maxC && wi >= 0) { a = wi; b = wj; }
    else break;
    const p = P[a], q = P[b], n = p.n + q.n;
    P[a] = {
      n,
      L: (p.L * p.n + q.L * q.n) / n, A: (p.A * p.n + q.A * q.n) / n, B: (p.B * p.n + q.B * q.n) / n,
      r: (p.r * p.n + q.r * q.n) / n, g: (p.g * p.n + q.g * q.n) / n, b: (p.b * p.n + q.b * q.n) / n,
    };
    P.splice(b, 1);
  }

  // Latar kunci: warna yang berada di antara warna kunci dan warna lain di palet
  // adalah rembesan kunci (mis. navy keunguan di tepi garis) → lebur ke warna aslinya.
  if (o.bgKey === 'magenta') {
    const K = [255, 0, 255];
    // Bagian piksel warna ini (bin sekitarnya) yang berada di dekat area transparan.
    const nearFrac = (c) => {
      const r0 = clamp255(c.r) >> 3, g0 = clamp255(c.g) >> 3, b0 = clamp255(c.b) >> 3;
      let nr = 0, tot = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
        const r = r0 + dr, g = g0 + dg, b = b0 + db;
        if (r < 0 || g < 0 || b < 0 || r > 31 || g > 31 || b > 31) continue;
        const key = (r << 10) | (g << 5) | b;
        nr += nearCnt[key]; tot += acnt[key];
      }
      return tot ? nr / tot : 0;
    };
    for (let k = P.length - 1; k >= 0 && P.length > 1; k--) {
      const c = P[k];
      if (nearFrac(c) < 0.5) continue; // bukan di tepi latar → bukan rembesan
      let bi = -1, br = 20; // selisih RGB maksimum dari garis campuran
      for (let i = 0; i < P.length; i++) {
        if (i === k) continue;
        const b = P[i];
        // Rembesan selalu jauh lebih sedikit daripada warna aslinya.
        if (c.n > 0.5 * b.n) continue;
        const vx = K[0] - b.r, vy = K[1] - b.g, vz = K[2] - b.b, vv = vx * vx + vy * vy + vz * vz;
        if (vv < 1) continue;
        const t = ((c.r - b.r) * vx + (c.g - b.g) * vy + (c.b - b.b) * vz) / vv;
        if (t < 0.05 || t > 0.8) continue;
        const r = Math.hypot(b.r + t * vx - c.r, b.g + t * vy - c.g, b.b + t * vz - c.b);
        if (r < br) { br = r; bi = i; }
      }
      if (bi < 0) continue;
      P[bi].n += c.n; // warna asli tetap milik b; jumlah piksel digabung
      P.splice(k, 1);
    }
  }

  // Gradien: pusat warna disempurnakan sekali lagi (k-means) setelah penggabungan.
  if (grad) {
    for (let it = 0; it < 3; it++) {
      const acc = P.map(() => ({ n: 0, L: 0, A: 0, B: 0, r: 0, g: 0, b: 0 }));
      for (const k of bins) {
        const L = bl[k * 3], A = bl[k * 3 + 1], Bb = bl[k * 3 + 2];
        let best = 0, bd = Infinity;
        for (let j = 0; j < P.length; j++) {
          const d = (P[j].L - L) ** 2 + (P[j].A - A) ** 2 + (P[j].B - Bb) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
        const a = acc[best], n = C[k];
        a.n += n; a.L += L * n; a.A += A * n; a.B += Bb * n; a.r += R[k]; a.g += G[k]; a.b += B[k];
      }
      P = acc.filter((a) => a.n > 0).map((a) => ({ n: a.n, L: a.L / a.n, A: a.A / a.n, B: a.B / a.n, r: a.r / a.n, g: a.g / a.n, b: a.b / a.n }));
    }
  }

  // Buang warna "campuran": porsi kecil dan berada di antara dua warna lain
  // (piksel transisi antialias, mis. abu-abu di tepi hitam–putih).
  const totalN = P.reduce((t, p) => t + p.n, 0);
  for (let k = P.length - 1; k >= 0 && P.length > 2; k--) {
    const c = P[k];
    if (c.n > totalN * 0.02) continue;
    // Rapikan: warna dengan banyak piksel "sangat rata" adalah bidang sungguhan
    // (butir abu-abu, bayangan kecil), bukan peralihan antialias.
    if (strict) {
      const r0 = clamp255(c.r) >> 3, g0 = clamp255(c.g) >> 3, b0 = clamp255(c.b) >> 3;
      let m = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
        const r = r0 + dr, g = g0 + dg, b = b0 + db;
        if (r < 0 || g < 0 || b < 0 || r > 31 || g > 31 || b > 31) continue;
        const key = (r << 10) | (g << 5) | b;
        if (!strict[key]) continue;
        // Hanya piksel rata yang memang paling dekat ke warna ini (bukan milik
        // warna tetangga yang mirip, mis. ungu sedotan di sebelah peralihan).
        let own = true;
        const L = bl[key * 3], A = bl[key * 3 + 1], Bb = bl[key * 3 + 2];
        const dc = (c.L - L) ** 2 + (c.A - A) ** 2 + (c.B - Bb) ** 2;
        for (let j = 0; j < P.length && own; j++) if (j !== k && (P[j].L - L) ** 2 + (P[j].A - A) ** 2 + (P[j].B - Bb) ** 2 < dc) own = false;
        if (own) m += strict[key];
      }
      if (m >= 0.5 * c.n) continue;
    }
    let mixed = false;
    for (let i = 0; i < P.length && !mixed; i++) {
      for (let j = i + 1; j < P.length && !mixed; j++) {
        if (i === k || j === k) continue;
        const a = P[i], b = P[j];
        const vx = b.L - a.L, vy = b.A - a.A, vz = b.B - a.B, vv = vx * vx + vy * vy + vz * vz;
        if (vv < 1) continue;
        const t = ((c.L - a.L) * vx + (c.A - a.A) * vy + (c.B - a.B) * vz) / vv;
        if (t < 0.15 || t > 0.85) continue;
        // Transisi antialias selalu jauh lebih sedikit daripada kedua warna pengapitnya.
        if (c.n > 0.12 * Math.min(a.n, b.n)) continue;
        const d = Math.hypot(a.L + t * vx - c.L, a.A + t * vy - c.A, a.B + t * vz - c.B);
        if (d < md) mixed = true;
      }
    }
    if (mixed) P.splice(k, 1);
  }

  // Urutkan dari paling dominan; warna final dari rata-rata RGB, Lab dihitung ulang.
  P.sort((a, b) => b.n - a.n);
  return P.slice(0, 250).map((p) => {
    const r = clamp255(p.r), g = clamp255(p.g), b = clamp255(p.b);
    rgb2lab(r, g, b, tmpLab);
    return { r, g, b, L: tmpLab[0], A: tmpLab[1], B: tmpLab[2], n: p.n };
  });
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
function diff(px, a, b) {
  return Math.abs(px[a] - px[b]) + Math.abs(px[a + 1] - px[b + 1]) + Math.abs(px[a + 2] - px[b + 2]);
}

// ---------------------------------------------------------------- label
function assignLabels(data, W, H, s, pal, o) {
  const N = W * H;
  const K = pal.length;
  const pl = new Float32Array(K * 3);
  pal.forEach((p, k) => { pl[k * 3] = p.L; pl[k * 3 + 1] = p.A; pl[k * 3 + 2] = p.B; });

  // Cache warna terdekat (dan jarak ke kandidat kedua) pada kisi 6 bit per kanal.
  const cIdx = new Int16Array(262144).fill(-1);
  const cD1 = new Float32Array(262144), cD2 = new Float32Array(262144);
  let nD1 = 0, nD2 = 0;
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (cIdx[key] < 0) {
      rgb2lab((r & 252) + 2, (g & 252) + 2, (b & 252) + 2, tmpLab);
      let best = 0, bd = Infinity, sd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (pl[k * 3] - tmpLab[0]) ** 2 + (pl[k * 3 + 1] - tmpLab[1]) ** 2 + (pl[k * 3 + 2] - tmpLab[2]) ** 2;
        if (d < bd) { sd = bd; bd = d; best = k; } else if (d < sd) sd = d;
      }
      cIdx[key] = best; cD1[key] = Math.sqrt(bd); cD2[key] = Math.sqrt(sd);
    }
    nD1 = cD1[key]; nD2 = cD2[key];
    return cIdx[key];
  };

  // Komposit atas putih → RGB kerja (ditulis di tempat).
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const a = data[p + 3];
    if (a < 255 && a >= 128 && o.bgKey !== 'magenta') {
      const k = a / 255;
      data[p] = data[p] * k + 255 * (1 - k);
      data[p + 1] = data[p + 1] * k + 255 * (1 - k);
      data[p + 2] = data[p + 2] * k + 255 * (1 - k);
    }
  }

  // Upscale bilinear browser patah di tiap pusat piksel sumber → kontur 50%
  // ikut bergelombang. Blur binomial ringan menghaluskan lipatan itu tanpa
  // menggeser tepi lurus.
  if (s >= 1.5) {
    const passes = Math.max(1, Math.round((0.32 * s) ** 2));
    for (let k = 0; k < passes; k++) blurPass(data, W, H);
  }

  const lab = new Uint8Array(N);

  // Siluet: ambang luminans pada gambar kerja yang sudah halus → kontur sub-piksel.
  if (o.mode === 'silhouette' && o.silTones === 'binary') {
    const thr = o.silThreshold ?? 128;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      if (data[p + 3] < 128) { lab[i] = T; continue; }
      lab[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] < thr ? 0 : 1;
    }
    return lab;
  }

  // Benih = piksel yang warnanya dekat palet DAN tidak berada di lereng gradien.
  // Lereng diukur dengan selisih tengah (x-1 vs x+1, y-1 vs y+1): piksel campuran
  // di tepi dua warna punya selisih besar, sedangkan inti garis tipis (puncak)
  // dan area rata punya selisih kecil.
  const FTW = Math.max(14, 40 / s);
  const CT = FTW * 1.5;
  const tight = 4;
  const loose = Math.max(8, o.colorMerge * 1.2);
  const W4 = W * 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      if (data[p + 3] < 128) { lab[i] = T; continue; }
      const k = nearest(data[p], data[p + 1], data[p + 2]);
      const d = nD1;
      if (d <= tight && s < 1.5) { lab[i] = k; continue; }
      // Dekat palet, atau jelas lebih dekat ke satu warna daripada warna lain
      // (inti garis tipis yang warnanya sedikit bergeser).
      if (d <= loose || d < nD2 * 0.45) {
        const cx = x > 0 && x < W - 1 ? diff(data, p - 4, p + 4) : 0;
        const cy = y > 0 && y < H - 1 ? diff(data, p - W4, p + W4) : 0;
        const lim = d <= tight ? CT * 2 : CT;
        if (cx <= lim && cy <= lim) { lab[i] = k; continue; }
      }
      lab[i] = U;
    }
  }

  const grow2 = o.mode === 'gradient';
  // Region growing: piksel transisi mengambil warna tetangga yang paling mirip.
  let cur = [];
  const queued = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (lab[i] !== U) continue;
    const x = i % W;
    if ((x > 0 && lab[i - 1] < U) || (x < W - 1 && lab[i + 1] < U) || (i >= W && lab[i - W] < U) || (i + W < N && lab[i + W] < U)) {
      cur.push(i); queued[i] = 1;
    }
  }
  while (cur.length) {
    const choice = new Int16Array(cur.length);
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n], p = i * 4, x = i % W;
      rgb2lab(data[p], data[p + 1], data[p + 2], tmpLab);
      let best = -1, bd = Infinity;
      const tryL = (l) => {
        if (l >= U) return;
        const d = (pl[l * 3] - tmpLab[0]) ** 2 + (pl[l * 3 + 1] - tmpLab[1]) ** 2 + (pl[l * 3 + 2] - tmpLab[2]) ** 2;
        if (d < bd) { bd = d; best = l; }
      };
      if (x > 0) tryL(lab[i - 1]);
      if (x < W - 1) tryL(lab[i + 1]);
      if (i >= W) tryL(lab[i - W]);
      if (i + W < N) tryL(lab[i + W]);
      // Gradien: piksel yang warnanya jauh dari semua tetangganya (inti garis
      // tipis yang buram, mis. garis punggung gunung di depan langit) tidak
      // ditelan tetangga: ambil warna palet terdekat bila jauh lebih cocok.
      if (grow2 && best >= 0 && bd > 324) {
        const g = nearest(data[p], data[p + 1], data[p + 2]);
        if (nD1 * nD1 < 0.3 * bd && pal[g].L < tmpLab[0] + 5) best = g;
      }
      choice[n] = best;
    }
    const next = [];
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n];
      if (choice[n] < 0) { queued[i] = 0; continue; }
      lab[i] = choice[n];
      const x = i % W;
      if (x > 0 && lab[i - 1] === U && !queued[i - 1]) { queued[i - 1] = 1; next.push(i - 1); }
      if (x < W - 1 && lab[i + 1] === U && !queued[i + 1]) { queued[i + 1] = 1; next.push(i + 1); }
      if (i >= W && lab[i - W] === U && !queued[i - W]) { queued[i - W] = 1; next.push(i - W); }
      if (i + W < N && lab[i + W] === U && !queued[i + W]) { queued[i + W] = 1; next.push(i + W); }
    }
    cur = next;
  }
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (lab[i] === U) lab[i] = nearest(data[p], data[p + 1], data[p + 2]);
  }
  if (o.mode === 'gradient') {
    edgeSnap(lab, data, W, H, pal, Math.max(2, Math.round(1.6 * s)));
    majorityFilter(lab, W, H, Math.max(1, Math.round(s * 0.6)), 2, pal, 20);
    if (o._orient) orientedMajority(lab, W, H, s, o._orient, Math.max(3, Math.round(3 * s)), 2);
  }
  else if (o.lineThreshold !== false) lineThreshold(lab, data, W, H, pal);
  // Rapikan: batas antar warna yang mirip (dE <= 10) mengikuti mayoritas
  // sekitarnya → tidak bergerigi; batas kontras (outline) tidak disentuh.
  if (o.mode === 'color' && o.clean !== false) {
    majorityFilter(lab, W, H, Math.max(1, Math.round(s * 0.75)), 2, pal, 18);
  }
  return lab;
}

// Penajaman batas label: piksel yang berada di pita tipis peralihan (warnanya di
// antara warna kedua sisi tepi, diukur ±r searah gradien) dipindahkan ke sisi
// yang lebih mirip. Halo gelap di sekitar garis outline hilang; garis tipis
// (kedua sisinya sama) dan gradasi lebar tidak tersentuh.
function edgeSnap(lab, data, W, H, pal, r) {
  const N = W * H;
  const Y = new Float32Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) Y[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  const out = new Uint8Array(lab);
  const pl = pal.map((p) => [p.L, p.A, p.B]);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, own = lab[i];
      if (own >= HW) continue;
      // Hanya piksel dekat batas label.
      if (lab[i - 1] === own && lab[i + 1] === own && lab[i - W] === own && lab[i + W] === own &&
          lab[i - W - 1] === own && lab[i + W + 1] === own && lab[i - W + 1] === own && lab[i + W - 1] === own) {
        let near = false;
        for (let d = 2; d <= r && !near; d++) {
          if ((x + d < W && lab[i + d] !== own) || (x - d >= 0 && lab[i - d] !== own) ||
              (y + d < H && lab[i + d * W] !== own) || (y - d >= 0 && lab[i - d * W] !== own)) near = true;
        }
        if (!near) continue;
      }
      const gx = (Y[i - W + 1] + 2 * Y[i + 1] + Y[i + W + 1]) - (Y[i - W - 1] + 2 * Y[i - 1] + Y[i + W - 1]);
      const gy = (Y[i + W - 1] + 2 * Y[i + W] + Y[i + W + 1]) - (Y[i - W - 1] + 2 * Y[i - W] + Y[i - W + 1]);
      const m = Math.hypot(gx, gy);
      if (m < 8) continue;
      const ux = gx / m, uy = gy / m;
      const ax = Math.round(x - ux * r), ay = Math.round(y - uy * r), bx = Math.round(x + ux * r), by = Math.round(y + uy * r);
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= W || bx >= W || ay >= H || by >= H) continue;
      const la = lab[ay * W + ax], lb = lab[by * W + bx];
      if (la >= HW || lb >= HW || la === lb || la === own || lb === own) continue;
      const A = pl[la], B = pl[lb], C = pl[own];
      const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz;
      if (vv < 1) continue;
      const t = ((C[0] - A[0]) * vx + (C[1] - A[1]) * vy + (C[2] - A[2]) * vz) / vv;
      if (t < 0.02 || t > 0.98) continue;
      const res = Math.hypot(A[0] + t * vx - C[0], A[1] + t * vy - C[1], A[2] + t * vz - C[2]);
      if (res > 12 + 0.25 * Math.sqrt(vv)) continue;
      // Sisi tujuan: menurut kecerahan piksel terhadap titik tengah kedua sisi.
      const ya = 0.299 * pal[la].r + 0.587 * pal[la].g + 0.114 * pal[la].b;
      const yb = 0.299 * pal[lb].r + 0.587 * pal[lb].g + 0.114 * pal[lb].b;
      if (Math.abs(ya - yb) > 8) out[i] = Math.abs(Y[i] - ya) <= Math.abs(Y[i] - yb) ? la : lb;
      else out[i] = t < 0.5 ? la : lb;
    }
  }
  lab.set(out);
}

// Bobot detail 0..1 per piksel: selisih (jumlah |RGB|) terhadap rata-rata 5×5,
// naik linear dari t0 ke t0+span. Grain kecil → 0; garis tipis/titik → 1.
function detailMask(px, w, h, t0, span) {
  const N = w * h;
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let i = 0, p = 0; i < N; i++, p += 4) { ch[0][i] = px[p]; ch[1][i] = px[p + 1]; ch[2][i] = px[p + 2]; }
  for (const A of ch) boxBlur(A, w, h, 2);
  const m = new Float32Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const d = Math.abs(px[p] - ch[0][i]) + Math.abs(px[p + 1] - ch[1][i]) + Math.abs(px[p + 2] - ch[2][i]);
    m[i] = Math.max(0, Math.min(1, (d - t0) / span));
  }
  return m;
}

// Domain transform recursive filter (Gastal & Oliveira 2011): penghalus
// penjaga tepi O(N). Jarak antar piksel "diregangkan" sebanding selisih warna,
// sehingga perataan berhenti di tepi kontras. ss = jangkauan ruang (px),
// sr = kepekaan warna (jumlah selisih RGB).
function domainTransform(px, w, h, ss, sr, iters) {
  const N = w * h;
  const C = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let i = 0, p = 0; i < N; i++, p += 4) { C[0][i] = px[p]; C[1][i] = px[p + 1]; C[2][i] = px[p + 2]; }
  const k = ss / sr;
  const dx = new Float32Array(N), dy = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      if (x > 0) {
        const q = p - 4;
        dx[i] = px[p + 3] < 255 || px[q + 3] < 255 ? 1e4 : 1 + k * (Math.abs(px[p] - px[q]) + Math.abs(px[p + 1] - px[q + 1]) + Math.abs(px[p + 2] - px[q + 2]));
      }
      if (y > 0) {
        const q = p - w * 4;
        dy[i] = px[p + 3] < 255 || px[q + 3] < 255 ? 1e4 : 1 + k * (Math.abs(px[p] - px[q]) + Math.abs(px[p + 1] - px[q + 1]) + Math.abs(px[p + 2] - px[q + 2]));
      }
    }
  }
  const wx = new Float32Array(N), wy = new Float32Array(N);
  for (let it = 0; it < iters; it++) {
    const sH = (ss * Math.sqrt(3) * Math.pow(2, iters - it - 1)) / Math.sqrt(Math.pow(4, iters) - 1);
    const a = Math.exp(-Math.SQRT2 / sH);
    for (let i = 0; i < N; i++) { wx[i] = Math.pow(a, dx[i]); wy[i] = Math.pow(a, dy[i]); }
    for (const I of C) {
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 1; x < w; x++) I[o + x] += wx[o + x] * (I[o + x - 1] - I[o + x]);
        for (let x = w - 2; x >= 0; x--) I[o + x] += wx[o + x + 1] * (I[o + x + 1] - I[o + x]);
      }
      for (let x = 0; x < w; x++) {
        for (let y = 1; y < h; y++) { const i = y * w + x; I[i] += wy[i] * (I[i - w] - I[i]); }
        for (let y = h - 2; y >= 0; y--) { const i = y * w + x; I[i] += wy[i + w] * (I[i + w] - I[i]); }
      }
    }
  }
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (px[p + 3] < 255) continue;
    px[p] = C[0][i]; px[p + 1] = C[1][i]; px[p + 2] = C[2][i];
  }
}

// Filter bilateral (jendela (2r+1)², sigma ruang ss, sigma warna sr dalam RGB):
// rata-rata berbobot tetangga yang dekat posisinya DAN warnanya. Grain halus
// diratakan; tepi kontras (selisih >> sr) tidak tercampur.
// Penghalusan bidang landai: gambar diperkecil f× (rata-rata kotak, grain hilang),
// di-bilateral beberapa kali (jangkauan efektif ss·f px, hanya antar warna
// mirip), diperbesar bilinear, lalu dicampur ke gambar hanya di piksel yang
// selisihnya kecil (bidang landai); di dekat tepi/garis gambar asli dipakai.
function smoothFlat(px, w, h, f = 0, ss = 2.5, sr = 9, iters = 3, E = 24, rr = 14) {
  if (!f) f = Math.max(2, Math.round(Math.min(w, h) / 180));
  const N = w * h;
  // Gambar diburamkan ringan (kotak 3×3 dua kali): grain teredam, garis tipis tetap.
  const g = new Float32Array(N * 3);
  for (let i = 0, p = 0; i < N; i++, p += 4) { g[i * 3] = px[p]; g[i * 3 + 1] = px[p + 1]; g[i * 3 + 2] = px[p + 2]; }
  const tmp = new Float32Array(N * 3);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      for (let c = 0; c < 3; c++) { let a = 0; for (let xx = x0; xx <= x1; xx++) a += g[(y * w + xx) * 3 + c]; tmp[(y * w + x) * 3 + c] = a / (x1 - x0 + 1); }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let c = 0; c < 3; c++) { let a = 0; for (let yy = y0; yy <= y1; yy++) a += tmp[(yy * w + x) * 3 + c]; g[(y * w + x) * 3 + c] = a / (y1 - y0 + 1); }
    }
  }
  // Tepi: selisih tengah besar pada gambar buram (garis, tepi bulan, kawah).
  const edge = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(g[(i + 1) * 3 + c] - g[(i - 1) * 3 + c]) + Math.abs(g[(i + w) * 3 + c] - g[(i - w) * 3 + c]);
    if (d > E) edge[i] = 1;
  }
  for (let i = 0, p = 3; i < N; i++, p += 4) if (px[p] < 255) edge[i] = 1;
  const edgeOut = Uint8Array.from(edge);
  // Resolusi rendah: rata-rata sel tanpa piksel tepi (warna dua sisi tidak tercampur).
  const lw = Math.max(1, Math.ceil(w / f)), lh = Math.max(1, Math.ceil(h / f));
  const lo = new Uint8ClampedArray(lw * lh * 4);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      let r = 0, gg = 0, b = 0, n = 0;
      for (let yy = y * f; yy < Math.min(h, y * f + f); yy++) {
        for (let xx = x * f; xx < Math.min(w, x * f + f); xx++) {
          const i = yy * w + xx;
          if (edge[i]) continue;
          r += g[i * 3]; gg += g[i * 3 + 1]; b += g[i * 3 + 2]; n++;
        }
      }
      const q = (y * lw + x) * 4;
      if (n * 3 >= f * f) { lo[q] = r / n; lo[q + 1] = gg / n; lo[q + 2] = b / n; lo[q + 3] = 255; }
    }
  }
  const r = Math.max(2, Math.ceil(ss * 1.8));
  for (let k = 0; k < iters; k++) bilateral(lo, lw, lh, r, ss, sr);
  // Pembesaran sadar-tepi (joint bilateral): sel rendah di sekitar piksel diberi
  // bobot jarak × kemiripan warna dengan piksel buramnya → di dekat tepi bulan,
  // halo hanya mengambil warna halo.
  const K = 2, sig2 = 2 * (0.8 * f) ** 2, rr2 = 2 * rr * rr;
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / f - 0.5, cy = Math.round(fy);
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      if (edge[i] || px[p + 3] < 255) continue;
      const fx = (x + 0.5) / f - 0.5, cx = Math.round(fx);
      const g0 = g[i * 3], g1 = g[i * 3 + 1], g2 = g[i * 3 + 2];
      let a0 = 0, a1 = 0, a2 = 0, ws = 0;
      for (let yy = cy - K; yy <= cy + K; yy++) {
        if (yy < 0 || yy >= lh) continue;
        for (let xx = cx - K; xx <= cx + K; xx++) {
          if (xx < 0 || xx >= lw) continue;
          const q = (yy * lw + xx) * 4;
          if (lo[q + 3] < 255) continue;
          const dx = (xx - fx) * f, dy = (yy - fy) * f;
          const d0 = lo[q] - g0, d1 = lo[q + 1] - g1, d2 = lo[q + 2] - g2;
          const wt = Math.exp(-(dx * dx + dy * dy) / sig2 - (d0 * d0 + d1 * d1 + d2 * d2) / rr2);
          a0 += wt * lo[q]; a1 += wt * lo[q + 1]; a2 += wt * lo[q + 2]; ws += wt;
        }
      }
      if (ws < 1e-4) continue;
      px[p] = a0 / ws; px[p + 1] = a1 / ws; px[p + 2] = a2 / ws;
    }
  }
  return edgeOut;
}

// Kembalikan piksel yang jauh (> r px) dari tepi ke nilai sebelum diratakan.
function restoreFlat(px, pre, edge, w, h, r) {
  const N = w * h, near = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!edge[y * w + x]) continue;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) near[yy * w + xx] = 1;
  }
  for (let i = 0, p = 0; i < N; i++, p += 4) if (!near[i]) { px[p] = pre[p]; px[p + 1] = pre[p + 1]; px[p + 2] = pre[p + 2]; }
}

function bilateral(px, w, h, r, ss, sr) {
  const src = new Uint8ClampedArray(px);
  const sw = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) sw.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss))]);
  const LUT = new Float32Array(12300);
  for (let k = 0; k < LUT.length; k++) LUT[k] = Math.exp(-(k * 16) / (2 * sr * sr));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (src[p + 3] < 255) continue;
      const r0 = src[p], g0 = src[p + 1], b0 = src[p + 2];
      let ar = 0, ag = 0, ab = 0, ws = 0;
      for (const [dx, dy, wsp] of sw) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = (yy * w + xx) * 4;
        if (src[q + 3] < 255) continue;
        const dr = src[q] - r0, dg = src[q + 1] - g0, db = src[q + 2] - b0;
        const wt = wsp * LUT[(dr * dr + dg * dg + db * db) >> 4];
        ar += wt * src[q]; ag += wt * src[q + 1]; ab += wt * src[q + 2]; ws += wt;
      }
      px[p] = ar / ws; px[p + 1] = ag / ws; px[p + 2] = ab / ws;
    }
  }
}

// Arah garis per piksel sumber (tensor struktur, diperhalus): tangen (TX,TY)
// dan koherensi 0..1 (1 = arah sangat jelas, mis. garis lurus tipis).
function orientField(px, w, h) {
  const N = w * h, W4 = w * 4;
  const E = new Float32Array(N), F = new Float32Array(N), G = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, p = i * 4;
      let e = 0, f = 0, g = 0;
      for (let c = 0; c < 3; c++) {
        const gx = (px[p + 4 + c] - px[p - 4 + c]) * 0.5, gy = (px[p + W4 + c] - px[p - W4 + c]) * 0.5;
        e += gx * gx; f += gx * gy; g += gy * gy;
      }
      E[i] = e; F[i] = f; G[i] = g;
    }
  }
  for (const A of [E, F, G]) { boxBlur(A, w, h, 2); boxBlur(A, w, h, 1); }
  const TX = new Float32Array(N), TY = new Float32Array(N), C = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = E[i], f = F[i], g = G[i], tr = e + g;
    if (tr < 60) continue;
    const disc = Math.sqrt((e - g) * (e - g) + 4 * f * f);
    const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
    let tx = -f, ty = l1 - g;
    const ux = l1 - e, uy = -f;
    if (ux * ux + uy * uy > tx * tx + ty * ty) { tx = ux; ty = uy; }
    const L = Math.hypot(tx, ty);
    if (L < 1e-9) continue;
    TX[i] = tx / L; TY[i] = ty / L; C[i] = (l1 - l2) / (l1 + l2 + 1e-9);
  }
  return { TX, TY, C, w, h };
}

// Mayoritas memanjang: piksel di batas label pada area berarah jelas mengambil
// label terbanyak di sepanjang segmen ±L searah garis. Bagian garis tipis yang
// putus tersambung dan tepinya rata (lebar mengikuti mayoritas sepanjang garis).
function orientedMajority(lab, W, H, s, of, L, passes) {
  const N = W * H;
  const cnt = new Uint16Array(256);
  let src = lab, dst = new Uint8Array(N);
  for (let ps = 0; ps < passes; ps++) {
    dst.set(src);
    for (let y = 1; y < H - 1; y++) {
      const sy = Math.min(of.h - 1, (y / s) | 0);
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, own = src[i];
        if (own >= HW) continue;
        if (src[i - 1] === own && src[i + 1] === own && src[i - W] === own && src[i + W] === own &&
            src[i - W - 1] === own && src[i - W + 1] === own && src[i + W - 1] === own && src[i + W + 1] === own) continue;
        const j = sy * of.w + Math.min(of.w - 1, (x / s) | 0);
        if (of.C[j] < 0.6) continue;
        const tx = of.TX[j], ty = of.TY[j];
        let best = own, bc = 0;
        const seen = [];
        for (let k = -L; k <= L; k++) {
          const xx = Math.round(x + k * tx), yy = Math.round(y + k * ty);
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const l = src[yy * W + xx];
          if (l >= HW) continue;
          if (!cnt[l]) seen.push(l);
          const c = ++cnt[l];
          if (c > bc || (c === bc && l === own)) { bc = c; best = l; }
        }
        for (const l of seen) cnt[l] = 0;
        dst[i] = best;
      }
    }
    const t = src === lab ? new Uint8Array(N) : src;
    src = dst; dst = t;
  }
  if (src !== lab) lab.set(src);
}

// Filter mayoritas (mode) pada peta label: tiap piksel mengambil label terbanyak
// di jendela (2r+1)². Batas antar pita gradien yang bergerigi/berbintik menjadi
// rata, sehingga garis kontur lebih rapi. Label transparan tidak diubah.
function majorityFilter(lab, W, H, r, passes, pal, maxDE) {
  const close = (a, b) => !pal || Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B) <= maxDE;
  const N = W * H;
  const cnt = new Uint16Array(256);
  let src = lab, dst = new Uint8Array(N);
  for (let ps = 0; ps < passes; ps++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, own = src[i];
        if (own === T) { dst[i] = own; continue; }
        // Lewati area seragam dengan cepat.
        if (x > 0 && x < W - 1 && y > 0 && y < H - 1 && src[i - 1] === own && src[i + 1] === own && src[i - W] === own && src[i + W] === own) { dst[i] = own; continue; }
        const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r), x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
        let best = own, bc = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0, j = yy * W + x0; xx <= x1; xx++, j++) {
            const l = src[j];
            if (l === T) continue;
            const c = ++cnt[l];
            if (c > bc || (c === bc && l === own)) { bc = c; best = l; }
          }
        }
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0, j = yy * W + x0; xx <= x1; xx++, j++) cnt[src[j]] = 0;
        dst[i] = best !== own && !close(own, best) ? own : best;
      }
    }
    const t = src === lab ? new Uint8Array(N) : src;
    src = dst; dst = t;
  }
  if (src !== lab) lab.set(src);
}

// Garis ala siluet untuk mode warna: batas antara warna garis (palet paling
// gelap) dan warna isian di sebelahnya ditentukan oleh ambang kecerahan di titik
// tengah keduanya — fungsi mulus dari nilai piksel, bukan hasil "tumbuh" region —
// sehingga tepi garis rata dan tebalnya konsisten. Warna tetap dipertahankan.
function lineThreshold(lab, data, W, H, pal) {
  const N = W * H;
  let kl = -1;
  pal.forEach((p, k) => { if (p.L < 45 && (kl < 0 || p.L < pal[kl].L)) kl = k; });
  if (kl < 0) return;
  const Y = pal.map((p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
  // Peta isian: warna non-garis terdekat untuk tiap piksel (garis diisi dari tepinya).
  const F = new Uint8Array(lab);
  for (let i = 0; i < N; i++) if (F[i] === kl) F[i] = U;
  const fillOk = (l) => l < U && l !== kl;
  let cur = [];
  for (let i = 0; i < N; i++) {
    if (F[i] !== U) continue;
    const x = i % W;
    if ((x > 0 && fillOk(F[i - 1])) || (x < W - 1 && fillOk(F[i + 1])) || (i >= W && fillOk(F[i - W])) || (i + W < N && fillOk(F[i + W]))) cur.push(i);
  }
  const queued = new Uint8Array(N);
  for (const i of cur) queued[i] = 1;
  while (cur.length) {
    const pick = new Uint8Array(cur.length);
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n], x = i % W, p = i * 4;
      const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      let best = U, bd = Infinity;
      const see = (l) => { if (!fillOk(l)) return; const d = Math.abs(Y[l] - y); if (d < bd) { bd = d; best = l; } };
      if (x > 0) see(F[i - 1]);
      if (x < W - 1) see(F[i + 1]);
      if (i >= W) see(F[i - W]);
      if (i + W < N) see(F[i + W]);
      pick[n] = best;
    }
    const next = [];
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n];
      if (pick[n] === U) continue;
      F[i] = pick[n];
      const x = i % W;
      if (x > 0 && F[i - 1] === U && !queued[i - 1]) { queued[i - 1] = 1; next.push(i - 1); }
      if (x < W - 1 && F[i + 1] === U && !queued[i + 1]) { queued[i + 1] = 1; next.push(i + 1); }
      if (i >= W && F[i - W] === U && !queued[i - W]) { queued[i - W] = 1; next.push(i - W); }
      if (i + W < N && F[i + W] === U && !queued[i + W]) { queued[i + W] = 1; next.push(i + W); }
    }
    cur = next;
  }
  // Ambang: lebih gelap dari titik tengah garis–isian → garis, selain itu isian.
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const l = lab[i];
    if (l === T) continue;
    const f = F[i];
    if (f >= U) continue; // area gelap luas tanpa isian di sekitar
    if (Y[f] - Y[kl] < 60) continue; // isian sama-sama gelap → biarkan
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    const dark = y < (Y[kl] + Y[f]) / 2;
    if (dark) lab[i] = kl;
    else if (l === kl) lab[i] = f;
  }
}

// Satu lintasan blur binomial [1 4 6 4 1]/16 terpisah (σ ≈ 1 px), di tempat,
// kanal RGB saja.
function blurPass(data, W, H) {
  const RW = W * 4;
  const row = new Uint8ClampedArray(RW);
  for (let y = 0; y < H; y++) {
    const off = y * RW;
    row.set(data.subarray(off, off + RW));
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - 2) * 4, b = Math.max(0, x - 1) * 4, c = x * 4;
      const d = Math.min(W - 1, x + 1) * 4, e = Math.min(W - 1, x + 2) * 4;
      for (let ch = 0; ch < 3; ch++) {
        data[off + c + ch] = (row[a + ch] + 4 * row[b + ch] + 6 * row[c + ch] + 4 * row[d + ch] + row[e + ch] + 8) >> 4;
      }
    }
  }
  let p2 = data.slice(0, RW), p1 = data.slice(0, RW), cur = new Uint8ClampedArray(RW);
  for (let y = 0; y < H; y++) {
    const off = y * RW;
    cur.set(data.subarray(off, off + RW));
    const n1 = Math.min(H - 1, y + 1) * RW, n2 = Math.min(H - 1, y + 2) * RW;
    for (let i = 0; i < RW; i++) {
      if ((i & 3) === 3) continue;
      data[off + i] = (p2[i] + 4 * p1[i] + 6 * cur[i] + 4 * data[n1 + i] + data[n2 + i] + 8) >> 4;
    }
    const t = p2; p2 = p1; p1 = cur; cur = t;
  }
}

// Penghalusan searah garis (line integral convolution mengikuti arah tepi dari
// tensor struktur). Getaran tepi akibat kompresi diratakan SEPANJANG garis, jadi
// kedua sisi garis outline ikut rata dan tebalnya seragam; tidak ada blur yang
// menyilang garis. Di sudut/pertemuan warna arahnya tidak koheren → dibiarkan.
function flowSmooth(px, w, h, R, minCoh = 0.5, minTr = 300) {
  const N = w * h, W4 = w * 4;
  const E = new Float32Array(N), F = new Float32Array(N), G = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, p = i * 4;
      let e = 0, f = 0, g = 0;
      for (let c = 0; c < 3; c++) {
        const gx = (px[p + 4 + c] - px[p - 4 + c]) * 0.5;
        const gy = (px[p + W4 + c] - px[p - W4 + c]) * 0.5;
        e += gx * gx; f += gx * gy; g += gy * gy;
      }
      E[i] = e; F[i] = f; G[i] = g;
    }
  }
  for (const A of [E, F, G]) { boxBlur(A, w, h, 2); boxBlur(A, w, h, 1); }
  const TX = new Float32Array(N), TY = new Float32Array(N), WT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = E[i], f = F[i], g = G[i], tr = e + g;
    if (tr < minTr) continue;
    const disc = Math.sqrt((e - g) * (e - g) + 4 * f * f);
    const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
    const coh = (l1 - l2) / (l1 + l2 + 1e-9);
    if (coh < minCoh) continue;
    let tx = -f, ty = l1 - g;
    const ux = l1 - e, uy = -f;
    if (ux * ux + uy * uy > tx * tx + ty * ty) { tx = ux; ty = uy; }
    const L = Math.hypot(tx, ty);
    if (L < 1e-9) continue;
    TX[i] = tx / L; TY[i] = ty / L;
    WT[i] = Math.min(1, ((coh - minCoh) / Math.max(0.1, 0.9 - minCoh)) ** 2);
  }
  const out = new Uint8ClampedArray(px);
  const sig2 = 2 * (R / 1.6) ** 2;
  const acc = new Float64Array(3);
  const sample = (x, y, wk) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const p00 = (y0 * w + x0) * 4, p10 = p00 + 4, p01 = p00 + W4, p11 = p01 + 4;
    if (px[p00 + 3] < 255 || px[p10 + 3] < 255 || px[p01 + 3] < 255 || px[p11 + 3] < 255) return false; // jangan campur area transparan
    const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
    for (let ch = 0; ch < 3; ch++) acc[ch] += wk * (a * px[p00 + ch] + b * px[p10 + ch] + c * px[p01 + ch] + d * px[p11 + ch]);
    return true;
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const wt = WT[i];
      if (!wt) continue;
      const p = i * 4;
      if (px[p + 3] < 255) continue;
      acc[0] = px[p]; acc[1] = px[p + 1]; acc[2] = px[p + 2];
      let wsum = 1;
      for (let dir = -1; dir <= 1; dir += 2) {
        let vx = dir * TX[i], vy = dir * TY[i], sx = x, sy = y;
        for (let k = 1; k <= R; k++) {
          sx += vx; sy += vy;
          if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) break;
          const j = Math.round(sy) * w + Math.round(sx);
          let tx = TX[j], ty = TY[j];
          if (tx || ty) {
            if (tx * vx + ty * vy < 0) { tx = -tx; ty = -ty; }
            vx = tx; vy = ty;
          }
          const wk = Math.exp(-(k * k) / sig2);
          if (sample(sx, sy, wk)) wsum += wk;
        }
      }
      for (let ch = 0; ch < 3; ch++) out[p + ch] = px[p + ch] + wt * (acc[ch] / wsum - px[p + ch]);
    }
  }
  px.set(out);
}

// Box blur terpisah (radius r) pada larik float, di tempat.
function boxBlur(A, w, h, r) {
  const n = 2 * r + 1;
  const line = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) line[x] = A[o + x];
    let s = 0;
    for (let k = -r; k <= r; k++) s += line[Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      A[o + x] = s / n;
      s += line[Math.min(w - 1, x + r + 1)] - line[Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = A[y * w + x];
    let s = 0;
    for (let k = -r; k <= r; k++) s += line[Math.min(h - 1, Math.max(0, k))];
    for (let y = 0; y < h; y++) {
      A[y * w + x] = s / n;
      s += line[Math.min(h - 1, y + r + 1)] - line[Math.max(0, y - r)];
    }
  }
}

// ---------------------------------------------------------------- komponen
// Pelabelan komponen 4-tetangga. `order` dipakai sebagai antrean BFS sekaligus
// daftar piksel per komponen.
// Deteksi lingkaran terang + cincin cahaya.
// 1. Bentuk berwarna terang (L >= 60) yang tepinya cocok dengan lingkaran
//    (inlier >= 55 %, sebaran sudut inlier >= 120°, isi >= 35 % lingkaran,
//    jari-jari 1,5–25 % sisi pendek gambar) = sumber cahaya.
// 2. Profil warna langit per (sudut, jarak) di sekitarnya dirata-ratakan
//    (dua lintasan: piksel yang jauh dari profil — awan, gunung — diabaikan) dan
//    dihaluskan searah sudut dan jarak; batas cahaya = jarak tempat kecerahan
//    rata-rata sudah hampir sama dengan langit jauh.
// 3. Piksel langit di dalam batas cahaya diberi warna palet terdekat dari
//    profil pada jarak & sudutnya → batas pita berupa busur sepusat. Benda di
//    depan (warna jauh dari profil) tidak diubah.
function glowRings(lab, data, W, H, s, pal, comp, order, glowFlag, wall) {
  const info = label(lab, W, H, comp, order);
  const minDim = Math.min(W, H);
  const disks = [];
  for (let c = 0; c < info.count; c++) {
    const l = info.lbl[c];
    if (l >= HW || pal[l].L < 60) continue;
    const area = info.size[c];
    const rMin = 0.035 * minDim, rMax = 0.25 * minDim;
    if (area < 0.35 * Math.PI * rMin * rMin || area > Math.PI * rMax * rMax) continue;
    // Kontur luar: untuk tiap arah (180) dari titik berat, titik tepi terjauh
    // (lubang di dalam — kawah — tidak ikut).
    let gx = 0, gy = 0;
    for (let h = info.start[c], e = h + area; h < e; h++) { const i = order[h]; gx += i % W; gy += (i / W) | 0; }
    gx = gx / area + 0.5; gy = gy / area + 0.5;
    const NA = 180, far = new Float64Array(NA).fill(-1), fx = new Float64Array(NA), fy = new Float64Array(NA);
    for (let h = info.start[c], e = h + area; h < e; h++) {
      const i = order[h], x = i % W, y = (i / W) | 0;
      if (!((x > 0 && comp[i - 1] !== c) || (x < W - 1 && comp[i + 1] !== c) || (y > 0 && comp[i - W] !== c) || (y < H - 1 && comp[i + W] !== c))) continue;
      const dx = x + 0.5 - gx, dy = y + 0.5 - gy, dd = dx * dx + dy * dy;
      const a = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * NA) % NA;
      if (dd > far[a]) { far[a] = dd; fx[a] = x + 0.5; fy[a] = y + 0.5; }
    }
    const B = [];
    for (let a = 0; a < NA; a++) if (far[a] >= 0) B.push(fx[a], fy[a]);
    if (B.length < 40) continue;
    // RANSAC: lingkaran dari 3 titik acak, pilih yang didukung titik terbanyak,
    // lalu pas ulang dengan pendukungnya. Tahan terhadap bagian yang tertutup
    // benda lain (matahari di balik gunung) atau menyatu dengan cahaya.
    const nb = B.length / 2;
    const inliers = (f) => {
      const tol = Math.max(1.5 * s, 0.03 * f.R);
      const m = new Uint8Array(nb);
      let k2 = 0;
      for (let k = 0; k < nb; k++) if (Math.abs(Math.hypot(B[k * 2] - f.cx, B[k * 2 + 1] - f.cy) - f.R) <= tol) { m[k] = 1; k2++; }
      return { m, n: k2 };
    };
    let best = null;
    let seed = (c * 2654435761) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let it = 0; it < 400; it++) {
      const a = Math.floor(rnd() * nb), b = Math.floor(rnd() * nb), e = Math.floor(rnd() * nb);
      if (a === b || b === e || a === e) continue;
      const f = circle3(B[a * 2], B[a * 2 + 1], B[b * 2], B[b * 2 + 1], B[e * 2], B[e * 2 + 1]);
      if (!f || f.R < rMin || f.R > rMax) continue;
      const q = inliers(f);
      if (!best || q.n > best.n) best = { f, n: q.n, m: q.m };
    }
    let fit = best ? circleFit(B, best.m) : null;
    if (fit) fit.m = inliers(fit).m;
    if (!fit || !fit.m || fit.R < rMin || fit.R > rMax) continue;
    const m = fit.m;
    let inl = 0;
    const bins = new Uint8Array(36);
    for (let k = 0; k < m.length; k++) if (m[k]) { inl++; bins[Math.floor(((Math.atan2(B[k * 2 + 1] - fit.cy, B[k * 2] - fit.cx) + Math.PI) / (2 * Math.PI)) * 36) % 36] = 1; }
    let cov = 0;
    for (const b of bins) cov += b;
    if (inl < 0.48 * m.length || cov < 12) continue;
    // Bentuk harus di dalam lingkaran dan mengisinya cukup banyak.
    let inside = 0;
    for (let h = info.start[c], e = h + area; h < e; h++) {
      const i = order[h];
      if (Math.hypot((i % W) + 0.5 - fit.cx, ((i / W) | 0) + 0.5 - fit.cy) <= fit.R + 2 * s) inside++;
    }
    if (inside < 0.95 * area || area < 0.35 * Math.PI * fit.R * fit.R) continue;
    if (disks.some((d) => Math.hypot(d.cx - fit.cx, d.cy - fit.cy) < 0.5 * Math.max(d.R, fit.R))) continue;
    disks.push({ cx: fit.cx, cy: fit.cy, R: fit.R, comp: c, inl: +(inl / m.length).toFixed(2), cov });
  }
  const out = [];
  if (!disks.length) return out;

  const K = pal.length;
  const cache = new Map();
  const nearestPal = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = cache.get(key);
    if (v === undefined) {
      rgb2lab(r, g, b, tmpLab);
      let bd = Infinity;
      v = 0;
      for (let k = 0; k < K; k++) {
        if (k === HW || k === T) continue;
        const d = (pal[k].L - tmpLab[0]) ** 2 + (pal[k].A - tmpLab[1]) ** 2 + (pal[k].B - tmpLab[2]) ** 2;
        if (d < bd) { bd = d; v = k; }
      }
      cache.set(key, v);
    }
    return v;
  };

  for (const d of disks) {
    const R0 = d.R + 1.5 * s, Rout = Math.min(4 * d.R, 0.45 * Math.max(W, H));
    const NT = 90, dr = Math.max(1, s), NR = Math.max(4, Math.ceil((Rout - R0) / dr));
    const x0 = Math.max(0, Math.floor(d.cx - Rout)), x1 = Math.min(W - 1, Math.ceil(d.cx + Rout));
    const y0 = Math.max(0, Math.floor(d.cy - Rout)), y1 = Math.min(H - 1, Math.ceil(d.cy + Rout));
    const binOf = (x, y) => {
      const dx = x + 0.5 - d.cx, dy = y + 0.5 - d.cy, r = Math.hypot(dx, dy);
      if (r < R0 || r >= Rout) return -1;
      const t = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * NT) % NT;
      return t * NR + Math.min(NR - 1, Math.floor((r - R0) / dr));
    };
    // Profil: rata-rata per bin, dihaluskan sudut (σ 3 bin, melingkar) & jarak (σ 2 bin).
    const smoothProf = (S, C) => {
      const P = new Float32Array(NT * NR * 3), Wt = new Float32Array(NT * NR);
      const kt = [], kr = [];
      for (let q = -9; q <= 9; q++) kt.push(Math.exp(-(q * q) / 18));
      for (let q = -6; q <= 6; q++) kr.push(Math.exp(-(q * q) / 8));
      const A = new Float32Array(NT * NR * 3), AW = new Float32Array(NT * NR);
      for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) {
        let a0 = 0, a1 = 0, a2 = 0, w = 0;
        for (let q = -9; q <= 9; q++) {
          const b = (((t + q) % NT + NT) % NT) * NR + r, n = C[b];
          if (!n) continue;
          const wt = kt[q + 9] * n;
          a0 += wt * S[b * 3] / n; a1 += wt * S[b * 3 + 1] / n; a2 += wt * S[b * 3 + 2] / n; w += wt;
        }
        const b = t * NR + r;
        if (w > 0) { A[b * 3] = a0 / w; A[b * 3 + 1] = a1 / w; A[b * 3 + 2] = a2 / w; AW[b] = w; }
      }
      for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) {
        let a0 = 0, a1 = 0, a2 = 0, w = 0;
        for (let q = -6; q <= 6; q++) {
          const rr = r + q;
          if (rr < 0 || rr >= NR) continue;
          const b = t * NR + rr;
          if (!AW[b]) continue;
          const wt = kr[q + 6] * AW[b];
          a0 += wt * A[b * 3]; a1 += wt * A[b * 3 + 1]; a2 += wt * A[b * 3 + 2]; w += wt;
        }
        const b = t * NR + r;
        if (w > 0) { P[b * 3] = a0 / w; P[b * 3 + 1] = a1 / w; P[b * 3 + 2] = a2 / w; Wt[b] = w; }
      }
      return { P, Wt };
    };
    const accum = (prof, tau) => {
      const S = new Float64Array(NT * NR * 3), C = new Float64Array(NT * NR);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const b = binOf(x, y);
        if (b < 0) continue;
        const i = y * W + x, p = i * 4;
        if (lab[i] >= HW) continue;
        if (prof) {
          const P = prof.P;
          if (!prof.Wt[b] || Math.hypot(data[p] - P[b * 3], data[p + 1] - P[b * 3 + 1], data[p + 2] - P[b * 3 + 2]) > tau) continue;
        }
        S[b * 3] += data[p]; S[b * 3 + 1] += data[p + 1]; S[b * 3 + 2] += data[p + 2]; C[b]++;
      }
      return smoothProf(S, C);
    };
    let prof = accum(null, 0);
    prof = accum(prof, 40);
    prof = accum(prof, 25);
    // Batas cahaya: kecerahan rata-rata per jarak vs langit jauh (25 % terluar).
    const Lr = new Float64Array(NR), Lw = new Float64Array(NR);
    for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) {
      const b = t * NR + r;
      if (!prof.Wt[b]) continue;
      Lr[r] += 0.299 * prof.P[b * 3] + 0.587 * prof.P[b * 3 + 1] + 0.114 * prof.P[b * 3 + 2]; Lw[r]++;
    }
    for (let r = 0; r < NR; r++) Lr[r] = Lw[r] ? Lr[r] / Lw[r] : NaN;
    let far = 0, fn = 0;
    for (let r = Math.floor(NR * 0.75); r < NR; r++) if (!isNaN(Lr[r])) { far += Lr[r]; fn++; }
    if (!fn || isNaN(Lr[0])) continue;
    far /= fn;
    const amp = Lr[0] - far;
    if (amp < 10) continue; // tidak ada cahaya yang berarti
    let RgI = NR - 1;
    for (let r = 0; r < NR; r++) if (!isNaN(Lr[r]) && Lr[r] - far < 0.12 * amp) { RgI = r; break; }
    const Rg = R0 + (RgI + 1) * dr;
    out.push({ cx: d.cx, cy: d.cy, R: d.R, Rg, comp: d.comp });
    // Langit tanpa cahaya per baris: profil tepat di luar jangkauan cahaya, di
    // dua titik lingkaran yang sebaris (kiri & kanan); baris tanpa data diisi
    // dari baris terdekat.
    const rs = Math.min(NR - 1, RgI + 2), Rs = R0 + (rs + 0.5) * dr;
    const sky = new Float32Array((y1 - y0 + 1) * 3), skyOk = new Uint8Array(y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - d.cy;
      if (Math.abs(dy) >= Rs) continue;
      const dxx = Math.sqrt(Rs * Rs - dy * dy);
      let a0 = 0, a1 = 0, a2 = 0, n = 0;
      for (const sx of [dxx, -dxx]) {
        const t = Math.floor(((Math.atan2(dy, sx) + Math.PI) / (2 * Math.PI)) * NT) % NT, b = t * NR + rs;
        if (!prof.Wt[b]) continue;
        a0 += prof.P[b * 3]; a1 += prof.P[b * 3 + 1]; a2 += prof.P[b * 3 + 2]; n++;
      }
      if (n) { const k = (y - y0) * 3; sky[k] = a0 / n; sky[k + 1] = a1 / n; sky[k + 2] = a2 / n; skyOk[y - y0] = 1; }
    }
    let anySky = -1;
    for (let k = 0; k < skyOk.length; k++) if (skyOk[k]) { anySky = k; break; }
    if (anySky < 0) continue;
    for (let k = 0, last = anySky; k < skyOk.length; k++) {
      if (skyOk[k]) { last = k; continue; }
      let nx = -1;
      for (let q = k + 1; q < skyOk.length; q++) if (skyOk[q]) { nx = q; break; }
      const src = nx >= 0 && (k - last > nx - k || !skyOk[last]) ? nx : last;
      sky[k * 3] = sky[src * 3]; sky[k * 3 + 1] = sky[src * 3 + 1]; sky[k * 3 + 2] = sky[src * 3 + 2];
    }
    const skyRow = (y) => { const k = (Math.max(y0, Math.min(y1, y)) - y0) * 3; return [sky[k], sky[k + 1], sky[k + 2]]; };
    // Warna cahaya G = profil tepat di tepi benda, dari separuh arah yang
    // paling terang (arah yang tertutup gunung/awan tidak ikut).
    const G = [0, 0, 0];
    const rimY = [];
    for (let t = 0; t < NT; t++) { const b = t * NR; if (prof.Wt[b]) rimY.push([0.299 * prof.P[b * 3] + 0.587 * prof.P[b * 3 + 1] + 0.114 * prof.P[b * 3 + 2], t]); }
    if (rimY.length < 6) continue;
    rimY.sort((p, q) => q[0] - p[0]);
    const lit = new Uint8Array(NT);
    let gn = 0;
    for (let k = 0; k < Math.ceil(rimY.length / 2); k++) { const t = rimY[k][1], b = t * NR; G[0] += prof.P[b * 3]; G[1] += prof.P[b * 3 + 1]; G[2] += prof.P[b * 3 + 2]; gn++; }
    G[0] /= gn; G[1] /= gn; G[2] /= gn;
    // Arah yang tidak tertutup: warna tepi dekat G.
    for (let t = 0; t < NT; t++) { const b = t * NR; if (prof.Wt[b] && Math.hypot(prof.P[b * 3] - G[0], prof.P[b * 3 + 1] - G[1], prof.P[b * 3 + 2] - G[2]) < 30) lit[t] = 1; }
    // Kekuatan cahaya a(r): profil = langit + a·(G − langit), kuadrat terkecil
    // per jarak, dihaluskan, tidak naik ke luar, 0 di luar jangkauan.
    const aR = new Float64Array(NR);
    for (let r = 0; r <= RgI && r < NR; r++) {
      let num = 0, den = 0;
      const rr = R0 + (r + 0.5) * dr;
      for (let t = 0; t < NT; t++) {
        const b = t * NR + r;
        if (!prof.Wt[b] || !lit[t]) continue;
        const ang = ((t + 0.5) / NT) * 2 * Math.PI - Math.PI;
        const S = skyRow(Math.round(d.cy + rr * Math.sin(ang) - 0.5));
        for (let c = 0; c < 3; c++) { const g = G[c] - S[c]; num += (prof.P[b * 3 + c] - S[c]) * g; den += g * g; }
      }
      aR[r] = den > 1 ? Math.max(0, Math.min(1, num / den)) : 0;
    }
    for (let it = 0; it < 2; it++) for (let r = 1; r < RgI; r++) aR[r] = (aR[r - 1] + 2 * aR[r] + aR[r + 1]) / 4;
    for (let r = 1; r < NR; r++) aR[r] = r > RgI ? 0 : Math.min(aR[r], aR[r - 1]);
    const aAt = (r) => { const f = (r - R0) / dr - 0.5; if (f <= 0) return aR[0]; const k = Math.floor(f); if (k >= NR - 1) return 0; return aR[k] + (aR[k + 1] - aR[k]) * (f - k); };
    if (aR[0] < 0.15) continue;
    // Jangkauan cahaya sebenarnya: sampai a(r) habis.
    let lastA = 0;
    for (let r = 0; r < NR; r++) if (aR[r] > 0.02) lastA = r;
    const RgE = Math.min(Rg, R0 + (lastA + 3) * dr);
    out[out.length - 1].Rg = RgE;
    // Cahaya dikeluarkan dari langit (warna langit polos), piksel diberi warna
    // palet terdekat; benda di depan (warna jauh dari model) tidak disentuh.
    const gi = out.length - 1, flag = glowFlag;
    // Hanya langit yang tersambung ke tepi benda bercahaya (tanpa melewati
    // garis, benda gelap, atau warna yang tidak cocok) → lereng gunung yang
    // kebetulan berwarna mirip tidak ikut.
    const zx0 = Math.max(0, Math.floor(d.cx - RgE)), zx1 = Math.min(W - 1, Math.ceil(d.cx + RgE));
    const zy0 = Math.max(0, Math.floor(d.cy - RgE)), zy1 = Math.min(H - 1, Math.ceil(d.cy + RgE));
    const ok = (x, y) => {
      const dx = x + 0.5 - d.cx, dy = y + 0.5 - d.cy, r = Math.hypot(dx, dy);
      if (r < R0 || r >= RgE) return false;
      const i = y * W + x, p = i * 4;
      if (lab[i] >= HW || comp[i] === d.comp || flag[i] || (wall && wall[i])) return false;
      if (disks.some((o2) => o2 !== d && Math.hypot(x + 0.5 - o2.cx, y + 0.5 - o2.cy) < o2.R + 2 * s)) return false;
      const S = skyRow(y), a = aAt(r);
      const m0 = S[0] + a * (G[0] - S[0]), m1 = S[1] + a * (G[1] - S[1]), m2 = S[2] + a * (G[2] - S[2]);
      // Dekat tepi benda cahayanya lebih bervariasi → toleransi lebih longgar;
      // benda gelap (garis, gunung) tetap tertahan: tidak boleh jauh lebih gelap.
      const yp = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2], ym = 0.299 * m0 + 0.587 * m1 + 0.114 * m2;
      return yp > ym - 28 && Math.hypot(data[p] - m0, data[p + 1] - m1, data[p + 2] - m2) <= 30 + 35 * a;
    };
    const mark = new Uint8Array((zx1 - zx0 + 1) * (zy1 - zy0 + 1));
    const mi = (x, y) => (y - zy0) * (zx1 - zx0 + 1) + (x - zx0);
    let q = [];
    for (let t = 0; t < NT; t++) {
      if (!lit[t]) continue;
      const ang = ((t + 0.5) / NT) * 2 * Math.PI - Math.PI;
      for (let rr2 = R0; rr2 < R0 + 4 * s; rr2 += 1) {
        const x = Math.floor(d.cx + rr2 * Math.cos(ang)), y = Math.floor(d.cy + rr2 * Math.sin(ang));
        if (x < zx0 || y < zy0 || x > zx1 || y > zy1 || mark[mi(x, y)] || !ok(x, y)) continue;
        mark[mi(x, y)] = 1; q.push(x, y);
      }
    }
    while (q.length) {
      const nq = [];
      for (let k = 0; k < q.length; k += 2) {
        const x = q[k], y = q[k + 1];
        for (const [xx, yy] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (xx < zx0 || yy < zy0 || xx > zx1 || yy > zy1 || mark[mi(xx, yy)]) continue;
          mark[mi(xx, yy)] = 2;
          if (!ok(xx, yy)) continue;
          mark[mi(xx, yy)] = 1; nq.push(xx, yy);
        }
      }
      q = nq;
    }
    for (let y = zy0; y <= zy1; y++) {
      const S = skyRow(y);
      for (let x = zx0; x <= zx1; x++) {
        if (mark[mi(x, y)] !== 1) continue;
        // Langit di balik cahaya = langit baris itu + sedikit sisa (selisih
        // model diredam) → pita langit mendatar tanpa bercak sisa cahaya.
        const i = y * W + x, p = i * 4, a = aAt(Math.hypot(x + 0.5 - d.cx, y + 0.5 - d.cy));
        for (let c = 0; c < 3; c++) data[p + c] = clamp255(S[c] + 0.25 * (data[p + c] - (S[c] + a * (G[c] - S[c]))));
        lab[i] = nearestPal(data[p], data[p + 1], data[p + 2]);
        flag[i] = gi + 1;
      }
    }
    // Lingkaran cahaya: K tingkat (makin luar makin redup). Batas tingkat di
    // jarak tempat a(r) turun ke (k − ½)/K · a(tepi); kekuatan tiap tingkat =
    // rata-rata a(r) di cincinnya; opasitas lingkaran bertumpuk diturunkan dari situ.
    const K = Math.max(3, Math.min(6, Math.round(aR[0] * 8)));
    const radii = [];
    for (let k = 1; k <= K; k++) {
      const lvl = (aR[0] * (k - 0.5)) / K;
      let rq = RgI;
      for (let r = 0; r <= RgI; r++) if (aR[r] < lvl) { rq = r; break; }
      radii.push(R0 + (rq + 0.5) * dr);
    }
    radii.sort((p, q) => q - p);
    const levels = [];
    let prevA = 0;
    for (let k = 0; k < radii.length; k++) {
      const ro = radii[k], ri = k + 1 < radii.length ? radii[k + 1] : d.R;
      if (ro - ri < 1.5 * s && k + 1 < radii.length) continue;
      let sum = 0, n = 0;
      for (let r = ri; r < ro; r += dr * 0.5) { sum += aAt(Math.max(r, R0)); n++; }
      const A = Math.min(0.97, Math.max(prevA + 0.01, n ? sum / n : 0));
      const op = 1 - (1 - A) / (1 - prevA);
      levels.push([ro, op]);
      prevA = A;
    }
    out[gi].G = G.map((v) => Math.round(clamp255(v)));
    out[gi].levels = levels;
  }
  return out;
}

// Komponen langit per cahaya: piksel bertanda >= 50 % dari piksel komponen
// yang berada di dalam lingkaran jangkauan cahaya, minimal 4 piksel.
function glowSkyComps(glows, flag, comp, n, W, H) {
  return glows.map((g, gi) => {
    const inZ = new Map(), fl = new Map();
    const x0 = Math.max(0, Math.floor(g.cx - g.Rg)), x1 = Math.min(W - 1, Math.ceil(g.cx + g.Rg));
    const y0 = Math.max(0, Math.floor(g.cy - g.Rg)), y1 = Math.min(H - 1, Math.ceil(g.cy + g.Rg));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x + 0.5 - g.cx, y + 0.5 - g.cy) >= g.Rg) continue;
      const i = y * W + x, c = comp[i];
      inZ.set(c, (inZ.get(c) || 0) + 1);
      if (flag[i] === gi + 1) fl.set(c, (fl.get(c) || 0) + 1);
    }
    const res = [];
    for (const [c, k] of fl) if (k >= 4 && k >= 0.5 * inZ.get(c)) res.push(c);
    return res;
  });
}

// Lingkaran melalui tiga titik.
function circle3(x1, y1, x2, y2, x3, y3) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return null;
  const s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
  const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d, cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d;
  return { cx, cy, R: Math.hypot(x1 - cx, y1 - cy) };
}

// Lingkaran kuadrat terkecil (Kasa) pada titik P (opsional mask m).
function circleFit(P, m) {
  let n = 0, mx = 0, my = 0;
  for (let k = 0; k < P.length / 2; k++) if (!m || m[k]) { mx += P[k * 2]; my += P[k * 2 + 1]; n++; }
  if (n < 6) return null;
  mx /= n; my /= n;
  let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (let k = 0; k < P.length / 2; k++) {
    if (m && !m[k]) continue;
    const u = P[k * 2] - mx, v = P[k * 2 + 1] - my;
    Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu);
  const uc = (b1 * Svv - b2 * Suv) / det, vc = (Suu * b2 - Suv * b1) / det;
  return { cx: uc + mx, cy: vc + my, R: Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n) };
}

function label(lab, W, H, comp, order) {
  const N = W * H;
  comp.fill(-1);
  const start = [], size = [], lbl = [], border = [];
  let tail = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    const c = start.length, l = lab[s];
    const head0 = tail;
    comp[s] = c; order[tail++] = s;
    let touch = false;
    for (let h = head0; h < tail; h++) {
      const i = order[h], x = i % W;
      if (x === 0 || x === W - 1 || i < W || i >= N - W) touch = true;
      if (x > 0 && comp[i - 1] < 0 && lab[i - 1] === l) { comp[i - 1] = c; order[tail++] = i - 1; }
      if (x < W - 1 && comp[i + 1] < 0 && lab[i + 1] === l) { comp[i + 1] = c; order[tail++] = i + 1; }
      if (i >= W && comp[i - W] < 0 && lab[i - W] === l) { comp[i - W] = c; order[tail++] = i - W; }
      if (i < N - W && comp[i + W] < 0 && lab[i + W] === l) { comp[i + W] = c; order[tail++] = i + W; }
    }
    start.push(head0); size.push(tail - head0); lbl.push(l); border.push(touch);
  }
  return { start, size, lbl, border, count: start.length };
}

// Gradien: bentuk bertetangga yang batasnya tidak bertepatan dengan tepi nyata
// di gambar (selisih warna kecil di ±1 px sumber dari batas) dan warnanya mirip
// dilebur — batas "tingkat palet" yang berkeliaran di area datar hilang, batas
// yang memang ada di gambar tetap. Warna gabungan = warna bagian terluas, dan
// selisihnya dari warna itu dibatasi supaya gradasi tidak ikut hilang.
function mergeWeak(lab, data, W, H, pal, s, comp, order, maxEdge = 26, maxDE = 8, maxArea = Infinity) {
  const info = label(lab, W, H, comp, order);
  const n = info.count, N = W * H;
  const k = Math.max(1, Math.round(s));
  const pairs = new Map();
  const add = (a, b, e) => {
    if (a === b) return;
    const key = a < b ? a * n + b : b * n + a;
    let v = pairs.get(key);
    if (!v) pairs.set(key, (v = [0, 0]));
    v[0]++; v[1] += e;
  };
  const px = (x, y) => (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i];
      if (lab[i] >= HW) continue;
      // Tepi terkuat di semua jarak 0..k: garis tipis (lebih sempit dari k) tetap terdeteksi.
      if (x < W - 1 && comp[i + 1] !== c && lab[i + 1] < HW) {
        let e = 0;
        for (let d = 0; d <= k; d++) e = Math.max(e, diff(data, px(x - d, y), px(x + 1, y)), diff(data, px(x, y), px(x + 1 + d, y)));
        add(c, comp[i + 1], e);
      }
      if (y < H - 1 && comp[i + W] !== c && lab[i + W] < HW) {
        let e = 0;
        for (let d = 0; d <= k; d++) e = Math.max(e, diff(data, px(x, y - d), px(x, y + 1)), diff(data, px(x, y), px(x, y + 1 + d)));
        add(c, comp[i + W], e);
      }
    }
  }
  const list = [];
  for (const [key, v] of pairs) {
    const m = v[1] / v[0];
    if (m < maxEdge) list.push([m, Math.floor(key / n), key % n]);
  }
  list.sort((p, q) => p[0] - q[0]);
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const area = Float64Array.from(info.size);
  const col = Uint8Array.from(info.lbl);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const dE = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  let merged = 0;
  for (const [, a0, b0] of list) {
    const a = find(a0), b = find(b0);
    if (a === b || dE(col[a], col[b]) > maxDE) continue;
    const big = area[a] >= area[b] ? a : b, small = big === a ? b : a;
    if (area[small] > maxArea) continue;
    par[small] = big; area[big] += area[small];
    merged++;
  }
  if (!merged) return;
  for (let i = 0; i < N; i++) if (lab[i] < HW) lab[i] = col[find(comp[i])];
}

// Warna antara: bentuk yang warnanya terletak di antara warna dua tetangganya
// (dE(A,C) + dE(C,B) <= 1,15 x dE(A,B)) dan hanya beda tipis (<= maxDE) dari
// salah satunya adalah tingkat peralihan (pita gradasi, sisa antialias), bukan
// unsur gambar → dilebur utuh ke tetangga yang paling mirip. Detail yang lebih
// gelap/terang dari sekitarnya (bayangan, kilau, butir) tidak berada "di antara"
// sehingga tetap ada.
function mergeSteps(lab, W, H, pal, comp, order, maxDE) {
  const N = W * H;
  const dE = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  for (let pass = 0; pass < 3; pass++) {
    const info = label(lab, W, H, comp, order);
    const n = info.count;
    const adj = new Map();
    const add = (a, b) => { let m = adj.get(a); if (!m) adj.set(a, (m = new Map())); m.set(b, (m.get(b) || 0) + 1); };
    for (let i = 0; i < N; i++) {
      const c = comp[i], x = i % W;
      if (x < W - 1 && comp[i + 1] !== c) { add(c, comp[i + 1]); add(comp[i + 1], c); }
      if (i < N - W && comp[i + W] !== c) { add(c, comp[i + W]); add(comp[i + W], c); }
    }
    // Bentuk kecil dulu. Bentuk yang dilebur tidak boleh sekaligus menjadi tujuan
    // peleburan bentuk lain di putaran yang sama (dan sebaliknya) — kalau tidak,
    // warnanya muncul lagi lewat bentuk yang dilebur ke dalamnya.
    const ids = Array.from({ length: n }, (_, c) => c).sort((a, b) => info.size[a] - info.size[b]);
    const moved = new Uint8Array(n), frozen = new Uint8Array(n);
    const target = new Int32Array(n).fill(-1);
    let changed = 0;
    for (const c of ids) {
      const C = info.lbl[c];
      const m = adj.get(c);
      if (C >= HW || !m || frozen[c]) continue;
      // Panjang batas dan bentuk terbesar per warna tetangga. Bentuk perantara
      // harus lebih kecil dari tetangga di kedua sisinya (pita, bukan bidang utama).
      const per = new Map(), big = new Map();
      let total = 0;
      for (const [q, k] of m) {
        total += k;
        const l = info.lbl[q];
        per.set(l, (per.get(l) || 0) + k);
        const b = big.get(l);
        if (b === undefined || info.size[q] > info.size[b]) big.set(l, q);
      }
      const own = info.size[c];
      const cols = [...per].filter(([l, k]) => l < HW && l !== C && k >= 0.15 * total && info.size[big.get(l)] > own).map(([l]) => l);
      let best = -1, bd = Infinity;
      for (let u = 0; u < cols.length; u++) {
        for (let v = u + 1; v < cols.length; v++) {
          const A = cols[u], B = cols[v];
          const ac = dE(A, C), cb = dE(C, B), ab = dE(A, B);
          if (ac + cb > 1.15 * ab) continue;
          const near = ac <= cb ? A : B, d = Math.min(ac, cb);
          if (d <= maxDE && d < bd) { bd = d; best = near; }
        }
      }
      if (best < 0) continue;
      const t = big.get(best);
      if (moved[t]) continue;
      target[c] = best; moved[c] = 1; frozen[t] = 1;
      changed++;
    }
    if (!changed) break;
    for (let c = 0; c < n; c++) {
      if (target[c] < 0) continue;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = target[c];
    }
  }
}

// Lebur bercak berbatas gradasi: untuk tiap pasangan bentuk bersebelahan diukur
// seberapa tajam peralihan warnanya di gambar asli (selisih warna ±1,5 px sumber
// dari batas, diproyeksikan ke selisih kedua warna palet). Batas tegas (outline,
// butir, kilau) berubah penuh dalam jarak itu; batas pita gradasi hanya sedikit.
// Pasangan yang sebagian besar batasnya gradasi dan warnanya mirip digabung
// (bentuk lebih kecil ke yang lebih besar, dibatasi luas).
// Warna yang bedanya tipis (dE <= nearDE) cukup berbatas lembut sebagian
// (>= nearFrac): bercak cahaya samar di dalam satu bidang. Detail bertepi tegas
// (butir nasi: hanya ~10 % batasnya lembut) tidak tersentuh.
function mergeSoft(lab, data, W, H, pal, s, comp, order, areaFrac, maxDE, minFrac, nearDE = 0, nearFrac = 1) {
  const N = W * H;
  const info = label(lab, W, H, comp, order);
  const n = info.count;
  const R = Math.max(2, Math.round(1.5 * s));
  const pairs = new Map();
  const step = Math.max(1, Math.round(s / 2));
  const at = (x, y) => (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
  const look = (a, b, p1, p2) => {
    const la = info.lbl[a], lb = info.lbl[b];
    if (la >= HW || lb >= HW) return;
    const A = pal[la], B = pal[lb];
    const vx = B.r - A.r, vy = B.g - A.g, vz = B.b - A.b, vv = vx * vx + vy * vy + vz * vz;
    if (vv < 1) return;
    const f1 = ((data[p1] - A.r) * vx + (data[p1 + 1] - A.g) * vy + (data[p1 + 2] - A.b) * vz) / vv;
    const f2 = ((data[p2] - A.r) * vx + (data[p2 + 1] - A.g) * vy + (data[p2 + 2] - A.b) * vz) / vv;
    const key = a < b ? a * n + b : b * n + a;
    let v = pairs.get(key);
    if (!v) pairs.set(key, (v = [0, 0]));
    v[0]++;
    if (Math.abs(f2 - f1) < 0.5) v[1]++;
  };
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i];
      if (x < W - 1 && comp[i + 1] !== c) look(c, comp[i + 1], at(x - R, y), at(x + 1 + R, y));
    }
  }
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x += step) {
      const i = y * W + x, c = comp[i];
      if (comp[i + W] !== c) look(c, comp[i + W], at(x, y - R), at(x, y + 1 + R));
    }
  }
  const dE = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  const list = [];
  for (const [key, v] of pairs) {
    if (v[0] < 4) continue;
    const fr = v[1] / v[0];
    if (fr >= Math.min(minFrac, nearFrac)) list.push([fr, Math.floor(key / n), key % n]);
  }
  list.sort((p, q) => q[0] - p[0]);
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const area = Float64Array.from(info.size);
  const col = Uint8Array.from(info.lbl);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const cap = areaFrac * N;
  let merged = 0;
  for (const [fr, a0, b0] of list) {
    const a = find(a0), b = find(b0);
    if (a === b || col[a] >= HW || col[b] >= HW) continue;
    const d = dE(col[a], col[b]);
    if (d > maxDE || fr < (d <= nearDE ? nearFrac : minFrac)) continue;
    const big = area[a] >= area[b] ? a : b, small = big === a ? b : a;
    if (area[small] > cap) continue;
    par[small] = big; area[big] += area[small];
    merged++;
  }
  if (!merged) return;
  for (let i = 0; i < N; i++) if (lab[i] < HW) lab[i] = col[find(comp[i])];
}

// Verifikasi terhadap gambar asli: untuk tiap bentuk dihitung rata-rata warna
// piksel aslinya. Bila warna palet bentuk itu jauh darinya (dE > maxOwn) dan ada
// tetangga yang warnanya lebih cocok, bentuk itu sebenarnya bukan bagian gambar
// (campuran tepi, halo, salah tebak) → dilebur ke tetangga yang paling cocok.
// Bentuk besar hanya diperiksa bila selisihnya sangat jauh.
function verifyRegions(lab, data, W, H, pal, s, comp, order, maxOwn = 12) {
  const N = W * H;
  const L3 = new Float32Array(3);
  for (let pass = 0; pass < 2; pass++) {
    const info = label(lab, W, H, comp, order);
    const n = info.count;
    const mr = new Float64Array(n), mg = new Float64Array(n), mb = new Float64Array(n);
    for (let i = 0, p = 0; i < N; i++, p += 4) { const c = comp[i]; mr[c] += data[p]; mg[c] += data[p + 1]; mb[c] += data[p + 2]; }
    const adj = new Map();
    const add = (a, b) => { let m = adj.get(a); if (!m) adj.set(a, (m = new Map())); m.set(b, (m.get(b) || 0) + 1); };
    for (let i = 0; i < N; i++) {
      const c = comp[i], x = i % W;
      if (x < W - 1 && comp[i + 1] !== c) { add(c, comp[i + 1]); add(comp[i + 1], c); }
      if (i < N - W && comp[i + W] !== c) { add(c, comp[i + W]); add(comp[i + W], c); }
    }
    const big = 0.02 * N;
    let changed = 0;
    const target = new Int32Array(n).fill(-1);
    for (let c = 0; c < n; c++) {
      const own = info.lbl[c];
      if (own >= HW) continue;
      const k = info.size[c];
      rgb2lab(clamp255(mr[c] / k), clamp255(mg[c] / k), clamp255(mb[c] / k), L3);
      const d = (l) => Math.hypot(pal[l].L - L3[0], pal[l].A - L3[1], pal[l].B - L3[2]);
      const dOwn = d(own);
      if (dOwn <= (k > big ? maxOwn * 2 : maxOwn)) continue;
      const m = adj.get(c);
      if (!m) continue;
      let best = -1, bd = dOwn * 0.7;
      for (const [q] of m) {
        const l = info.lbl[q];
        if (l >= HW || l === own) continue;
        const dq = d(l);
        if (dq < bd) { bd = dq; best = l; }
      }
      if (best >= 0) target[c] = best;
    }
    for (let c = 0; c < n; c++) {
      if (target[c] < 0) continue;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = target[c];
      changed++;
    }
    if (!changed) break;
  }
}

// Serpihan tipis (lebar rata-rata < wMax px sumber) yang terjepit di antara dua
// bentuk lain dan warnanya mirip salah satunya (dE <= maxDE): halo terang/gelap
// akibat kompresi JPEG di sepanjang tepi kontras, atau sisa antialias. Dilebur
// ke tetangga yang paling mirip. Garis tipis yang kontras terhadap kedua sisinya
// (outline) dan bentuk tipis di dalam satu bentuk saja (kilau) tidak disentuh.
function dropThin(lab, W, H, pal, s, comp, order, wMax = 2, maxDE = 18) {
  const dE = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  const N = W * H;
  for (let pass = 0; pass < 2; pass++) {
    const info = label(lab, W, H, comp, order);
    const n = info.count;
    const per = new Float64Array(n);
    for (let i = 0; i < N; i++) {
      const c = comp[i], x = i % W;
      if (x < W - 1 && comp[i + 1] !== c) { per[c]++; per[comp[i + 1]]++; }
      if (i < N - W && comp[i + W] !== c) { per[c]++; per[comp[i + W]]++; }
    }
    const votes = new Map();
    let changed = 0;
    for (let c = 0; c < n; c++) {
      const own = info.lbl[c];
      if (own >= HW || !per[c]) continue;
      const wid = (2 * info.size[c]) / per[c] / s;
      if (wid >= wMax) continue;
      votes.clear();
      let total = 0;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
        const i = order[h], x = i % W;
        const see = (q) => { const k = comp[q]; if (k !== c) { votes.set(k, (votes.get(k) || 0) + 1); total++; } };
        if (x > 0) see(i - 1);
        if (x < W - 1) see(i + 1);
        if (i >= W) see(i - W);
        if (i < N - W) see(i + W);
      }
      // Harus terjepit: minimal dua tetangga yang masing-masing >= 20 % batasnya.
      const big = [...votes].filter((v) => v[1] >= 0.2 * total);
      if (big.length < 2) continue;
      let best = -1, bd = Infinity;
      for (const [k] of big) {
        const l = info.lbl[k];
        if (l >= HW) continue;
        const d = dE(own, l);
        if (d < bd) { bd = d; best = l; }
      }
      // Serpihan setipis rambut (< 1,6 px): halo JPEG bisa cukup berbeda dari induknya.
      if (best < 0 || bd > (wid < 1.6 ? maxDE * 1.5 : maxDE)) continue;
      for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = best;
      changed++;
    }
    if (!changed) break;
  }
}

// Gradien: pita sangat tipis (lebar rata-rata < ~1,3 px sumber) yang warnanya
// campuran dua tetangganya (peralihan antialias di sisi garis) dilebur ke
// tetangga yang paling mirip — tiap garis gambar cukup satu kontur.
function dropSlivers(lab, W, H, pal, s, comp, order, wMax = 1.3, tMin = 0.05, rMax = 10) {
  const info = label(lab, W, H, comp, order);
  const n = info.count, N = W * H;
  const per = new Float64Array(n);
  for (let i = 0; i < N; i++) {
    const c = comp[i], x = i % W;
    if (x < W - 1 && comp[i + 1] !== c) { per[c]++; per[comp[i + 1]]++; }
    if (i < N - W && comp[i + W] !== c) { per[c]++; per[comp[i + W]]++; }
  }
  const dE = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  const votes = new Map();
  let changed = 0;
  for (let c = 0; c < n; c++) {
    const own = info.lbl[c];
    if (own >= HW || !per[c]) continue;
    if ((2 * info.size[c]) / per[c] >= wMax * s) continue;
    votes.clear();
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W;
      const see = (q) => { const l = lab[q]; if (l !== own && l < HW) votes.set(l, (votes.get(l) || 0) + 1); };
      if (x > 0) see(i - 1);
      if (x < W - 1) see(i + 1);
      if (i >= W) see(i - W);
      if (i < N - W) see(i + W);
    }
    const top = [...votes].sort((p, q) => q[1] - p[1]).slice(0, 2);
    if (!top.length) continue;
    let target = -1;
    if (top.length === 2) {
      const A = pal[top[0][0]], B = pal[top[1][0]], C = pal[own];
      const vx = B.L - A.L, vy = B.A - A.A, vz = B.B - A.B, vv = vx * vx + vy * vy + vz * vz;
      if (vv > 1) {
        const t = ((C.L - A.L) * vx + (C.A - A.A) * vy + (C.B - A.B) * vz) / vv;
        const r = Math.hypot(A.L + t * vx - C.L, A.A + t * vy - C.A, A.B + t * vz - C.B);
        if (t > tMin && t < 1 - tMin && r < rMax) target = dE(own, top[0][0]) <= dE(own, top[1][0]) ? top[0][0] : top[1][0];
      }
    }
    if (target < 0 && dE(own, top[0][0]) < 5) target = top[0][0];
    if (target < 0) continue;
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = target;
    changed++;
  }
}

// Bintik kecil dilebur ke tetangga dengan warna paling mirip (bukan sekadar
// kontak terpanjang) agar potongan garis tipis tidak tertelan latar.
function despeckle(lab, W, H, minA, comp, order, pal, keep) {
  const cd = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  const N = W * H;
  for (let pass = 0; pass < 2; pass++) {
    const info = label(lab, W, H, comp, order);
    const small = [];
    for (let c = 0; c < info.count; c++) if (info.size[c] < minA && info.lbl[c] !== T) small.push(c);
    if (!small.length) return;
    small.sort((a, b) => info.size[a] - info.size[b]);
    const votes = new Int32Array(256);
    for (const c of small) {
      votes.fill(0);
      const s0 = info.start[c], s1 = s0 + info.size[c];
      const own = lab[order[s0]];
      for (let h = s0; h < s1; h++) {
        const i = order[h], x = i % W;
        if (x > 0 && lab[i - 1] !== own) votes[lab[i - 1]]++;
        if (x < W - 1 && lab[i + 1] !== own) votes[lab[i + 1]]++;
        if (i >= W && lab[i - W] !== own) votes[lab[i - W]]++;
        if (i < N - W && lab[i + W] !== own) votes[lab[i + W]]++;
      }
      let maxV = 0;
      for (let l = 0; l < 254; l++) if (votes[l] > maxV) maxV = votes[l];
      if (!maxV) continue; // hanya bersebelahan dengan transparan
      let best = -1, bs = Infinity;
      for (let l = 0; l < 254; l++) {
        if (votes[l] === 0 || votes[l] < maxV * 0.1) continue;
        const sc = cd(own, l) / Math.sqrt(votes[l] / maxV);
        if (sc < bs) { bs = sc; best = l; }
      }
      if (keep && info.size[c] >= keep.min && cd(own, best) > keep.de) continue;
      for (let h = s0; h < s1; h++) lab[order[h]] = best;
    }
  }
}

// Putih luar → transparan, dengan penutup celah: isian dari tepi hanya mengalir
// lewat "inti" putih (≥ r piksel dari warna lain), lalu dilebarkan kembali
// maksimal r langkah. Celah garis yang lebih sempit dari 2r tidak bisa dilewati,
// sehingga putih di dalam objek tidak ikut bocor.
function floodBorder(lab, W, H, isWhite, queue, r) {
  const N = W * H;
  const INF = 65535;
  const dist = new Uint16Array(N);
  for (let i = 0; i < N; i++) dist[i] = isWhite[lab[i]] ? INF : 0;
  // Transformasi jarak chamfer 3-4 (luar gambar dianggap latar).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = dist[i];
      if (!d) continue;
      if (x > 0 && dist[i - 1] + 3 < d) d = dist[i - 1] + 3;
      if (y > 0) {
        if (dist[i - W] + 3 < d) d = dist[i - W] + 3;
        if (x > 0 && dist[i - W - 1] + 4 < d) d = dist[i - W - 1] + 4;
        if (x < W - 1 && dist[i - W + 1] + 4 < d) d = dist[i - W + 1] + 4;
      }
      dist[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = dist[i];
      if (!d) continue;
      if (x < W - 1 && dist[i + 1] + 3 < d) d = dist[i + 1] + 3;
      if (y < H - 1) {
        if (dist[i + W] + 3 < d) d = dist[i + W] + 3;
        if (x < W - 1 && dist[i + W + 1] + 4 < d) d = dist[i + W + 1] + 4;
        if (x > 0 && dist[i + W - 1] + 4 < d) d = dist[i + W - 1] + 4;
      }
      dist[i] = d;
    }
  }
  const R = r * 3;
  const seen = new Uint8Array(N);
  let tail = 0;
  // 1. Isi inti dari tepi gambar.
  const pushCore = (i) => { if (!seen[i] && dist[i] > R) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { pushCore(x); pushCore(N - W + x); }
  for (let y = 0; y < H; y++) { pushCore(y * W); pushCore(y * W + W - 1); }
  for (let h = 0; h < tail; h++) {
    const i = queue[h], x = i % W;
    if (x > 0) pushCore(i - 1);
    if (x < W - 1) pushCore(i + 1);
    if (i >= W) pushCore(i - W);
    if (i < N - W) pushCore(i + W);
  }
  // 2. Piksel putih di tepi gambar ikut menjadi titik awal pelebaran.
  const pushW = (i) => { if (!seen[i] && dist[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { pushW(x); pushW(N - W + x); }
  for (let y = 0; y < H; y++) { pushW(y * W); pushW(y * W + W - 1); }
  // 3. Pelebaran geodesik 8-tetangga sebanyak r + 1 langkah di dalam area putih.
  let from = 0;
  for (let step = 0; step <= r; step++) {
    const to = tail;
    for (let h = from; h < to; h++) {
      const i = queue[h], x = i % W;
      const L = x > 0, Rt = x < W - 1, Up = i >= W, Dn = i < N - W;
      if (L) pushW(i - 1);
      if (Rt) pushW(i + 1);
      if (Up) { pushW(i - W); if (L) pushW(i - W - 1); if (Rt) pushW(i - W + 1); }
      if (Dn) { pushW(i + W); if (L) pushW(i + W - 1); if (Rt) pushW(i + W + 1); }
    }
    from = to;
  }
  for (let i = 0; i < N; i++) if (seen[i] && lab[i] !== T) lab[i] = HW;
}

// Putih terkurung yang termasuk latar. Pada ilustrasi ber-outline, putih milik
// objek (badan, wajah) hanya bersentuhan dengan warna garis; putih latar yang
// terkurung (antara kaki, layar, rangka kursi) bersentuhan langsung dengan
// warna latar lain (blob, bayangan, garis berwarna terang) atau area transparan.
function smartWhite(lab, W, comp, order, info, isWhite, removed, pal, s) {
  const N = lab.length;
  // Warna garis = warna non-putih yang paling banyak berbatasan dengan putih.
  const contact = new Float64Array(256);
  const note = (a, b) => {
    const wa = isWhite[a] && a !== T, wb = isWhite[b] && b !== T;
    if (wa && !wb && b !== T && b !== HW) contact[b]++;
    else if (wb && !wa && a !== T && a !== HW) contact[a]++;
  };
  for (let i = 0; i < N; i++) {
    const x = i % W;
    if (x < W - 1) note(lab[i], lab[i + 1]);
    if (i < N - W) note(lab[i], lab[i + W]);
  }
  let outline = -1, best = 0;
  for (let l = 0; l < 254; l++) if (contact[l] > best) { best = contact[l]; outline = l; }
  if (outline < 0) return;
  // Warna "latar": terang (blob, bayangan, garis pastel) dan jauh dari warna garis.
  const ol = pal[outline];
  const bgCol = new Uint8Array(256);
  bgCol[T] = 1;
  bgCol[HW] = 1;
  pal.forEach((p, k) => {
    if (k >= pal.length || isWhite[k] || k === outline) return;
    if (p.L >= 70 && Math.hypot(p.L - ol.L, p.A - ol.A, p.B - ol.B) > 30) bgCol[k] = 1;
  });
  // Kotak batas tiap komponen: bentuk yang seluruhnya berada di dalam area putih
  // (detail kartu, ikon) bukan petunjuk latar.
  const n = info.count;
  const bx0 = new Int32Array(n).fill(W), by0 = new Int32Array(n).fill(1 << 30), bx1 = new Int32Array(n), by1 = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W, y = (i / W) | 0;
      if (x < bx0[c]) bx0[c] = x; if (x > bx1[c]) bx1[c] = x;
      if (y < by0[c]) by0[c] = y; if (y > by1[c]) by1[c] = y;
    }
  }
  const inside = (q, c) => bx0[q] > bx0[c] && bx1[q] < bx1[c] && by0[q] > by0[c] && by1[q] < by1[c];
  for (let c = 0; c < n; c++) {
    const l = info.lbl[c];
    if (l === T || !isWhite[l] || info.border[c]) continue;
    let tot = 0, bg = 0;
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W;
      const see = (q) => {
        const cq = comp[q];
        if (cq === c) return;
        tot++;
        if (bgCol[lab[q]] && !inside(cq, c)) bg++;
      };
      if (x > 0) see(i - 1);
      if (x < W - 1) see(i + 1);
      if (i >= W) see(i - W);
      if (i < N - W) see(i + W);
    }
    if (tot && bg / tot >= 0.06) removed[c] = 1;
  }

  // Ruang kosong: putih yang dikurung beberapa OBJEK terpisah (kaki & dudukan
  // bangku, rak pot). Dilihat apa yang ada di seberang garis outline: objek
  // ber-outline (≥ setengah batasnya warna garis) atau latar. Putih milik objek
  // (badan, wajah, kartu) di seberang garisnya berupa latar atau hanya satu objek.
  const tot = new Float64Array(n), olc = new Float64Array(n);
  for (let i = 0; i < N; i++) {
    const c = comp[i], x = i % W;
    const see = (q) => { const cq = comp[q]; if (cq === c) return; tot[c]++; if (lab[q] === outline) olc[c]++; };
    if (x > 0) see(i - 1);
    if (x < W - 1) see(i + 1);
    if (i >= W) see(i - W);
    if (i < N - W) see(i + W);
  }
  const isObj = (c) => {
    const l = info.lbl[c];
    return l !== T && l !== HW && l !== outline && !isWhite[l] && tot[c] > 0 && olc[c] / tot[c] >= 0.8;
  };
  const maxStep = Math.max(4, Math.round(4 * s));
  const DXY = [1, -1, W, -W];
  for (let c = 0; c < n; c++) {
    const l = info.lbl[c];
    if (removed[c] || l === T || !isWhite[l] || info.border[c]) continue;
    let objHits = 0, bgHits = 0, elemHits = 0;
    const objs = new Set();
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W;
      for (let d = 0; d < 4; d++) {
        if ((d === 0 && x === W - 1) || (d === 1 && x === 0)) continue;
        let j = i + DXY[d];
        if (j < 0 || j >= N || lab[j] !== outline) continue;
        // Menyeberangi garis.
        let k = 0;
        while (k < maxStep && j >= 0 && j < N && lab[j] === outline) {
          const jx = j % W;
          if ((d === 0 && jx === W - 1) || (d === 1 && jx === 0)) { j = -1; break; }
          j += DXY[d]; k++;
        }
        if (j < 0 || j >= N) { bgHits++; continue; } // keluar gambar = latar
        if (lab[j] === outline) continue; // area gelap tebal: netral
        const q = comp[j], lq = lab[j];
        if (lq === T || lq === HW) bgHits++;
        else if (isWhite[lq]) continue; // putih lain di seberang: netral
        else if (isObj(q)) { objHits++; objs.add(q); }
        else { bgHits++; elemHits++; } // elemen latar berwarna (blob, bayangan)
      }
    }
    const all = objHits + bgHits;
    // Putih di depan elemen latar (mis. kepala robot di depan blob) = milik objek.
    if (all > 0 && objs.size >= 2 && objHits / all >= 0.6 && elemHits / all < 0.05) removed[c] = 1;
  }
}

// Sidik tiap area putih (untuk belajar dari hasil akhir pengguna). Semua nilai
// ~0..1 dan tidak bergantung pada resolusi, jadi bisa dibandingkan antar gambar.
//  0 luas (log)          1 menyentuh tepi gambar   2 kontak warna garis
//  3 kontak warna latar  4 kontak transparan        5 kontak warna gelap lain
//  6 jumlah objek di seberang garis   7 porsi objek   8 porsi elemen latar
//  9 kepadatan kotak     10 rasio sisi kotak        11 keputusan bawaan (dihapus)
function whiteFeatures(lab, W, H, comp, order, info, isWhite, pal, s) {
  const N = W * H, n = info.count;
  const feats = new Map();
  const contact = new Float64Array(256);
  for (let i = 0; i < N; i++) {
    const x = i % W, a = lab[i];
    const note = (b) => {
      const wa = a !== T && isWhite[a], wb = b !== T && isWhite[b];
      if (wa && !wb && b < HW) contact[b]++;
      else if (wb && !wa && a < HW) contact[a]++;
    };
    if (x < W - 1) note(lab[i + 1]);
    if (i < N - W) note(lab[i + W]);
  }
  let outline = -1, best = 0;
  for (let l = 0; l < HW; l++) if (contact[l] > best) { best = contact[l]; outline = l; }
  const ol = outline >= 0 ? pal[outline] : { L: 0, A: 0, B: 0 };
  const cat = new Uint8Array(256); // 0 lain, 1 garis, 2 latar, 3 transparan, 4 putih
  pal.forEach((p, k) => {
    const dOl = Math.hypot(p.L - ol.L, p.A - ol.A, p.B - ol.B);
    if (isWhite[k]) cat[k] = 4;
    else if (k === outline || dOl < 25) cat[k] = 1; // varian warna garis (mis. dua navy dari JPEG)
    else if (p.L >= 70 && Math.hypot(p.L - ol.L, p.A - ol.A, p.B - ol.B) > 30) cat[k] = 2;
  });
  cat[T] = 3; cat[HW] = 3;
  const cnt = new Float64Array(n * 6);
  for (let i = 0; i < N; i++) {
    const c = comp[i], x = i % W;
    const see = (q) => { const cq = comp[q]; if (cq === c) return; cnt[c * 6]++; cnt[c * 6 + 1 + cat[lab[q]]]++; };
    if (x > 0) see(i - 1);
    if (x < W - 1) see(i + 1);
    if (i >= W) see(i - W);
    if (i < N - W) see(i + W);
  }
  const isObj = (c) => {
    const l = info.lbl[c];
    return cat[l] === 0 || cat[l] === 2 ? cnt[c * 6] > 0 && cnt[c * 6 + 2] / cnt[c * 6] >= 0.8 : false;
  };
  const isLine = (l) => l < HW && cat[l] === 1;
  const maxStep = Math.max(4, Math.round(4 * s));
  const DXY = [1, -1, W, -W];
  for (let c = 0; c < n; c++) {
    const l = info.lbl[c];
    if (l === T || !(l === HW || isWhite[l])) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, objHits = 0, bgHits = 0, elemHits = 0;
    const objs = new Set();
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (outline < 0) continue;
      for (let d = 0; d < 4; d++) {
        if ((d === 0 && x === W - 1) || (d === 1 && x === 0)) continue;
        let j = i + DXY[d];
        if (j < 0 || j >= N || !isLine(lab[j])) continue;
        let k = 0;
        while (k < maxStep && j >= 0 && j < N && isLine(lab[j])) {
          const jx = j % W;
          if ((d === 0 && jx === W - 1) || (d === 1 && jx === 0)) { j = -1; break; }
          j += DXY[d]; k++;
        }
        if (j < 0 || j >= N) { bgHits++; continue; }
        if (isLine(lab[j])) continue;
        const q = comp[j], lq = lab[j];
        if (cat[lq] === 3) bgHits++;
        else if (cat[lq] === 4) continue;
        else if (isObj(q)) { objHits++; objs.add(q); }
        else { bgHits++; elemHits++; }
      }
    }
    const tot = cnt[c * 6] || 1, all = objHits + bgHits || 1;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    feats.set(c, Float32Array.from([
      Math.max(0, Math.min(1, (Math.log10(info.size[c] / N) + 6) / 6)),
      info.border[c] ? 1 : 0,
      cnt[c * 6 + 2] / tot,
      cnt[c * 6 + 3] / tot,
      cnt[c * 6 + 4] / tot,
      cnt[c * 6 + 1] / tot,
      Math.min(objs.size, 4) / 4,
      objHits / all,
      elemHits / all,
      info.size[c] / (bw * bh),
      Math.min(bw, bh) / Math.max(bw, bh),
      l === HW ? 1 : 0,
    ]));
  }
  return feats;
}

// ---------------------------------------------------------------- tracing
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

function traceAll(lab, comp, info, W, H, s, o, whiteK, progress, data) {
  const W1 = W + 1, NH = W * (H + 1);
  const vis = new Uint8Array(NH + W1 * H);
  const emit = new Uint8Array(info.count);
  for (let c = 0; c < info.count; c++) emit[c] = info.lbl[c] !== T ? 1 : 0;

  const cAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : comp[y * W + x]);
  const leftC = (vx, vy, d) => (d === 0 ? cAt(vx, vy - 1) : d === 1 ? cAt(vx, vy) : d === 2 ? cAt(vx - 1, vy) : cAt(vx - 1, vy - 1));
  const rightC = (vx, vy, d) => (d === 0 ? cAt(vx, vy) : d === 1 ? cAt(vx - 1, vy) : d === 2 ? cAt(vx - 1, vy - 1) : cAt(vx, vy - 1));
  const edgeOf = (vx, vy, d) => (d === 0 ? vy * W + vx : d === 1 ? NH + vy * W1 + vx : d === 2 ? vy * W + vx - 1 : NH + (vy - 1) * W1 + vx);
  const bitOf = (d) => (d === 0 || d === 3 ? 1 : 2);

  function traceCycle(C, vx, vy, d) {
    const sx = vx, sy = vy, sd = d;
    const out = [];
    for (let guard = 0; guard < 1e8; guard++) {
      vis[edgeOf(vx, vy, d)] |= bitOf(d);
      out.push(vy * W1 + vx);
      vx += DX[d]; vy += DY[d];
      let nd = -1;
      for (let k = 0; k < 3; k++) {
        const t = (d + 3 + k) & 3;
        if (leftC(vx, vy, t) === C && rightC(vx, vy, t) !== C) { nd = t; break; }
      }
      d = nd;
      if (d < 0 || (vx === sx && vy === sy && d === sd)) break;
    }
    return Int32Array.from(out);
  }

  // 1. Semua siklus batas, dikelompokkan per komponen.
  const cyc = new Array(info.count);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i];
      if (!emit[c]) continue;
      const add = (v) => { (cyc[c] || (cyc[c] = [])).push(v); };
      if ((y === 0 || comp[i - W] !== c) && !(vis[y * W + x] & 2)) add(traceCycle(c, x + 1, y, 2));
      if ((x === 0 || comp[i - 1] !== c) && !(vis[NH + y * W1 + x] & 2)) add(traceCycle(c, x, y, 1));
      if ((y === H - 1 || comp[i + W] !== c) && !(vis[(y + 1) * W + x] & 1)) add(traceCycle(c, x, y + 1, 0));
      if ((x === W - 1 || comp[i + 1] !== c) && !(vis[NH + y * W1 + x + 1] & 1)) add(traceCycle(c, x + 1, y + 1, 3));
    }
  }
  progress(0.15);

  const isJ = (v) => {
    const vx = v % W1, vy = (v / W1) | 0;
    const a = cAt(vx - 1, vy - 1), b = cAt(vx, vy - 1), c = cAt(vx - 1, vy), d = cAt(vx, vy);
    let n = 1;
    if (b !== a) n++;
    if (c !== a && c !== b) n++;
    if (d !== a && d !== b && d !== c) n++;
    if (n >= 3) return true;
    return n === 2 && a === d && b === c && a !== b;
  };
  const edgeKey = (va, vb) => {
    const xa = va % W1, ya = (va / W1) | 0, xb = vb % W1, yb = (vb / W1) | 0;
    return ya === yb ? ya * W + Math.min(xa, xb) : NH + Math.min(ya, yb) * W1 + xa;
  };
  const dirOf = (va, vb) => {
    const dx = (vb % W1) - (va % W1), dy = ((vb / W1) | 0) - ((va / W1) | 0);
    return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
  };

  const fitter = makeFitter(W1, s, o);
  const chains = [];
  const map = new Map();
  let nodes = 0;
  // Rantai dikumpulkan dulu (raw), di-fit setelah titik pertemuan dirapikan.
  // Rantai dikumpulkan dulu (raw), di-fit setelah titik pertemuan dirapikan.
  // a = komponen di kiri (pemilik siklus), b = komponen di kanan (-1: luar/transparan).
  const addChain = (raw, a, b) => {
    chains.push({ raw, a, b });
    return chains.length - 1;
  };
  const rightOf = (va, vb) => {
    const r = rightC(va % W1, (va / W1) | 0, dirOf(va, vb));
    return r >= 0 && emit[r] === 1 ? r : -1;
  };

  // Titik sampel komponen transparan yang tidak menyentuh tepi (untuk mode tumpuk).
  const tSamples = [];
  for (let c = 0; c < info.count; c++) {
    if (emit[c] || info.border[c]) continue;
    // piksel pertama komponen = piksel dengan indeks terkecil
    tSamples.push(c);
  }
  const tPts = [];
  if (tSamples.length) {
    const want = new Set(tSamples);
    for (let i = 0; i < W * H && want.size; i++) {
      const c = comp[i];
      if (want.has(c)) { want.delete(c); tPts.push((i % W) + 0.5, ((i / W) | 0) + 0.5); }
    }
  }

  const regions = [];
  let doneComps = 0;
  const totalComps = cyc.reduce((n, v) => n + (v ? 1 : 0), 0) || 1;

  for (let c = 0; c < info.count; c++) {
    const list = cyc[c];
    if (!list) continue;
    let outerI = 0, outerA = -1;
    list.forEach((V, k) => {
      const a = Math.abs(polyArea(V, W1));
      if (a > outerA) { outerA = a; outerI = k; }
    });
    const subs = [];
    for (let k = 0; k < list.length; k++) {
      const V = list[k], n = V.length;
      const J = new Uint8Array(n);
      let jc = 0;
      for (let i = 0; i < n; i++) if (isJ(V[i])) { J[i] = 1; jc++; }
      const refs = [];
      if (jc === 0) {
        let m = 0;
        for (let i = 1; i < n; i++) if (V[i] < V[m]) m = i;
        const key = -(V[m] + 1), nxt = V[(m + 1) % n];
        const e = map.get(key);
        if (e) refs.push(e.idx * 2 + (e.next === nxt ? 0 : 1));
        else {
          const idx = addChain({ closed: V }, c, rightOf(V[0], V[1 % n]));
          map.set(key, { idx, next: nxt });
          refs.push(idx * 2);
        }
      } else {
        let j0 = 0;
        while (!J[j0]) j0++;
        let a = j0;
        do {
          let b = (a + 1) % n;
          while (!J[b]) b = (b + 1) % n;
          const len = (b - a + n) % n || n;
          const seq = new Int32Array(len + 1);
          for (let t = 0; t <= len; t++) seq[t] = V[(a + t) % n];
          const k0 = edgeKey(seq[0], seq[1]), k1 = edgeKey(seq[len - 1], seq[len]);
          const key = Math.min(k0, k1);
          const e = map.get(key);
          if (e) refs.push(e.idx * 2 + (e.start === seq[0] && e.first === k0 ? 0 : 1));
          else {
            const idx = addChain({ open: seq }, c, rightOf(seq[0], seq[1]));
            map.set(key, { idx, start: seq[0], first: k0 });
            refs.push(idx * 2);
          }
          a = b;
        } while (a !== j0);
      }
      const outer = k === outerI;
      let fill = false;
      if (!outer) fill = !containsAny(V, W1, tPts);
      subs.push({ refs: Int32Array.from(refs), outer, fill });
    }
    const hw = info.lbl[c] === HW;
    regions.push({ k: hw ? whiteK : info.lbl[c], hid: hw, comp: c, area: outerA, subs });
    if (++doneComps % 64 === 0) progress(0.15 + 0.25 * (doneComps / totalComps));
  }
  // Rapikan titik pertemuan (≥3 region): geser ke rata-rata titik di dekat ujung
  // semua rantai yang bertemu di sana, agar tidak terkunci di sudut piksel yang
  // bergerigi. Titik di tepi gambar tetap.
  const m = Math.max(2, Math.round(1.5 * s));
  const jsum = new Map();
  const acc = (v, x, y) => {
    let e = jsum.get(v);
    if (!e) jsum.set(v, (e = [v % W1, (v / W1) | 0, 1]));
    e[0] += x; e[1] += y; e[2]++;
  };
  const endAvg = (seq, fromEnd) => {
    const n = seq.length, k = Math.min(m, n - 1);
    let sx = 0, sy = 0;
    for (let t = 0; t < k; t++) {
      const i = fromEnd ? n - 2 - t : t, a = seq[i], b = seq[i + 1];
      sx += ((a % W1) + (b % W1)) / 2;
      sy += (((a / W1) | 0) + ((b / W1) | 0)) / 2;
    }
    return [sx / k, sy / k];
  };
  for (const ch of chains) {
    const seq = ch.raw.open;
    if (!seq) continue;
    const a = endAvg(seq, false), b = endAvg(seq, true);
    acc(seq[0], a[0], a[1]);
    acc(seq[seq.length - 1], b[0], b[1]);
  }
  const jpos = (v) => {
    const x = v % W1, y = (v / W1) | 0;
    if (x === 0 || y === 0 || x === W || y === H) return [x, y];
    const e = jsum.get(v);
    return [e[0] / e[2], e[1] / e[2]];
  };
  // Penyederhanaan adaptif (Rapikan): batas yang lemah dukungan pikselnya (dua
  // warna mirip) dihaluskan lebih kuat → lebih sedikit titik, tanpa gelombang.
  const pal = o._pal, adaptive = o.mode === 'color' && o.clean !== false && pal;
  const legacyWeak = o.softFit === false;
  const ws = o.straighten === true;
  const fitWeak = adaptive ? makeFitter(W1, s, { ...o, smooth: o.smooth * 2.2, weakStraight: ws }) : null;
  const fitMid = adaptive ? makeFitter(W1, s, { ...o, smooth: o.smooth * 1.5, weakStraight: ws }) : null;
  const fitSoft = adaptive && ws ? makeFitter(W1, s, { ...o, weakStraight: true }) : null;
  // Batas lembut (peralihan warna melebar di gambar, mis. tepi bayangan) atau
  // antar dua warna yang sangat mirip: letak tepinya tidak pasti, jadi geometri
  // rantainya dihaluskan kuat lalu di-fit biasa → kurva mulus dengan sedikit
  // titik; garis yang memang lurus tetap lurus, lengkung tetap lengkung.
  const fitGentle = adaptive ? makeFitter(W1, s, { ...o, smooth: o.smooth * 1.4, rough: Math.max(o.rough || 0, 3.5) }) : null;
  const fitHalf = adaptive ? makeFitter(W1, s, { ...o, smooth: o.smooth * 1.2, rough: Math.max(o.rough || 0, 2.5) }) : null;
  const pickFit = (ch) => {
    if (!adaptive || ch.b < 0) return fitter;
    const la = info.lbl[ch.a], lb = info.lbl[ch.b];
    if (la >= HW || lb >= HW) return fitter;
    const p = pal[la], q = pal[lb], d = Math.hypot(p.L - q.L, p.A - q.A, p.B - q.B);
    if (legacyWeak) return d < 10 ? fitWeak : d < 18 ? fitMid : d < 30 && fitSoft ? fitSoft : fitter;
    const soft = softness(ch);
    if (soft > 0.6 || d < 8) return fitGentle;
    if (soft > 0.3 || d < 14) return fitHalf;
    return fitter;
  };
  // Tepi sub-piksel: tiap titik batas digeser (tegak lurus batas) ke tempat
  // warna gambar tepat di tengah kedua warna region (titik 50 % antialias), atau
  // alpha 50 % pada batas dengan latar transparan. Batas mengikuti tepi gambar
  // yang sebenarnya, bukan anak tangga piksel label.
  const snapOn = o.subpixel === true && data && o._pal;
  const PALC = snapOn ? o._pal : null;
  const colOf = (c) => {
    if (c < 0) return null;
    const l = info.lbl[c];
    const k = l === HW ? whiteK : l;
    return k >= 0 && k < PALC.length ? PALC[k] : null;
  };
  const samp = (x, y, out) => {
    x -= 0.5; y -= 0.5;
    if (x < 0) x = 0; if (y < 0) y = 0; if (x > W - 1.001) x = W - 1.001; if (y > H - 1.001) y = H - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const p00 = (y0 * W + x0) * 4, p10 = p00 + 4, p01 = p00 + W * 4, p11 = p01 + 4;
    for (let c = 0; c < 4; c++) out[c] = (1 - fx) * (1 - fy) * data[p00 + c] + fx * (1 - fy) * data[p10 + c] + (1 - fx) * fy * data[p01 + c] + fx * fy * data[p11 + c];
    return out;
  };
  const SC = [0, 0, 0, 0];
  const R = Math.max(2, 1.25 * s), step = 0.25, maxShift = 0.6 * s, kT = Math.max(3, Math.round(1.5 * s));
  const makeSnap = (ca, cb) => {
    const A = colOf(ca);
    if (!A) return null;
    const B = cb >= 0 ? colOf(cb) : null;
    if (cb >= 0 && !B) return null;
    let vx = 0, vy = 0, vz = 0, vv = 0;
    if (B) { vx = B.r - A.r; vy = B.g - A.g; vz = B.b - A.b; vv = vx * vx + vy * vy + vz * vz; if (vv < 30 * 30) return null; }
    // f(t): 0 = warna A, 1 = warna B (atau transparan).
    const f = (x, y) => {
      samp(x, y, SC);
      if (!B) return 1 - SC[3] / 255;
      return ((SC[0] - A.r) * vx + (SC[1] - A.g) * vy + (SC[2] - A.b) * vz) / vv;
    };
    return (P, n, closedPath) => {
      const sh = new Float64Array(n), ok = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!closedPath && (i === 0 || i === n - 1)) continue;
        const i0 = closedPath ? (i - kT + n * 4) % n : Math.max(0, i - kT), i1 = closedPath ? (i + kT) % n : Math.min(n - 1, i + kT);
        let tx = P[i1 * 2] - P[i0 * 2], ty = P[i1 * 2 + 1] - P[i0 * 2 + 1];
        const tl = Math.hypot(tx, ty);
        if (tl < 1e-6) continue;
        tx /= tl; ty /= tl;
        const nx = -ty, ny = tx, x = P[i * 2], y = P[i * 2 + 1];
        // Sisi B: arah normal tempat f naik.
        const fp = f(x + nx * R, y + ny * R), fm = f(x - nx * R, y - ny * R);
        const dir = fp > fm ? 1 : -1;
        const lo = dir > 0 ? fm : fp, hi = dir > 0 ? fp : fm;
        if (lo > 0.35 || hi < 0.65) continue; // profil tidak jelas → biarkan
        const g = (t) => f(x + nx * t * dir, y + ny * t * dir) - 0.5;
        let best = null;
        let gPrev = g(0);
        if (Math.abs(gPrev) < 1e-6) best = 0;
        for (let t = step; t <= R && best === null; t += step) {
          const gp = g(t), gm = g(-t);
          if (gPrev < 0 && gp >= 0) best = t - step + (step * -gPrev) / (gp - gPrev);
          else if (gPrev > 0 && gm <= 0) best = -(t - step) - (step * gPrev) / (gPrev - gm);
          if (best === null) {
            // lanjutkan dari titik terdekat ke 0.5 di masing-masing sisi
            if (gPrev < 0) gPrev = gp; else gPrev = gm;
          }
        }
        if (best === null || Math.abs(best) > maxShift) continue;
        sh[i] = best * dir; ok[i] = 1;
      }
      // Geseran diratakan sepanjang batas (median 5) supaya derau tidak ikut.
      const med = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const w = [];
        for (let d = -2; d <= 2; d++) {
          let j = i + d;
          if (closedPath) j = (j + n) % n; else if (j < 0 || j >= n) continue;
          if (ok[j]) w.push(sh[j]);
        }
        w.sort((p, q) => p - q);
        med[i] = w[w.length >> 1];
      }
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const i0 = closedPath ? (i - kT + n * 4) % n : Math.max(0, i - kT), i1 = closedPath ? (i + kT) % n : Math.min(n - 1, i + kT);
        let tx = P[i1 * 2] - P[i0 * 2], ty = P[i1 * 2 + 1] - P[i0 * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        P[i * 2] += (-ty / tl) * med[i];
        P[i * 2 + 1] += (tx / tl) * med[i];
      }
    };
  };
  // Kelembutan batas: bagian titik rantai yang peralihan warnanya, diukur pada
  // gambar ±1,5 px sumber tegak lurus batas, kurang dari separuh selisih kedua
  // warna region (gradasi melebar, bukan tepi tegas).
  const SP = o._pal;
  function softness(ch) {
    if (!SP || !data || ch.b < 0) return 0;
    const la = info.lbl[ch.a], lb = info.lbl[ch.b];
    if (la >= SP.length || lb >= SP.length) return 0;
    const A = SP[la], B = SP[lb];
    const vx = B.r - A.r, vy = B.g - A.g, vz = B.b - A.b, vv = vx * vx + vy * vy + vz * vz;
    if (vv < 1) return 1;
    const V = ch.raw.open || ch.raw.closed, n = V.length, closedPath = !ch.raw.open;
    if (n < 6) return 0;
    const fz = (x, y) => { samp(x, y, SC); return ((SC[0] - A.r) * vx + (SC[1] - A.g) * vy + (SC[2] - A.b) * vz) / vv; };
    const Rs = 1.5 * s, kk = Math.max(3, Math.round(1.5 * s)), stepI = Math.max(1, Math.round(s));
    let soft = 0, cnt = 0;
    for (let i = closedPath ? 0 : kk; i < (closedPath ? n : n - kk); i += stepI) {
      const a = V[closedPath ? (i - kk + n * 4) % n : i - kk], b = V[closedPath ? (i + kk) % n : i + kk], c = V[i];
      let tx = (b % W1) - (a % W1), ty = ((b / W1) | 0) - ((a / W1) | 0);
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl;
      const x = c % W1, y = (c / W1) | 0;
      const d = Math.abs(fz(x - ty * Rs, y + tx * Rs) - fz(x + ty * Rs, y - tx * Rs));
      cnt++;
      if (d < 0.5) soft++;
    }
    return cnt ? soft / cnt : 0;
  }
  const arcOn = o.mode === 'gradient' && o.arcSnap !== false;
  // Cincin sepusat hanya di sekitar sumber cahaya yang terdeteksi glowRings.
  const disks = o._glow || [], pending = [];
  chains.forEach((ch, i) => {
    const seq = ch.raw.open;
    const f = pickFit(ch);
    const adj = snapOn ? makeSnap(ch.a, ch.b) : null;
    let geo = seq ? f.open(seq, jpos(seq[0]), jpos(seq[seq.length - 1]), adj) : f.closed(ch.raw.closed, adj);
    // Gradien: batas yang hampir lingkaran/busur (bulan, matahari, cincin cahaya)
    // dijadikan lingkaran/busur sempurna.
    if (arcOn) {
      const P = sampleGeo(geo);
      const a = arcSnap(P, !seq, s, W, H);
      if (a) geo = a.geo; else if (disks.length) pending.push([ch, P, !seq]);
    }
    ch.p = geo.p; ch.c = geo.c;
    delete ch.raw;
    nodes += geo.c.length;
    if (i % 256 === 0) progress(0.4 + 0.6 * (i / chains.length));
  });
  // Cincin cahaya: batas di sekitar lingkaran besar (bulan, matahari) yang
  // jaraknya ke pusat lingkaran itu hampir tetap → busur sepusat.
  if (disks.length) {
    for (const [ch, P, closed] of pending) {
      const g = concentricSnap(P, closed, disks, s);
      if (g) { ch.p = g.p; ch.c = g.c; nodes += g.c.length - 1; }
    }
  }
  regions.sort((a, b) => b.area - a.area);
  const compToReg = new Int32Array(info.count).fill(-1);
  regions.forEach((r, i) => { compToReg[r.comp] = i; delete r.comp; });
  for (const ch of chains) {
    ch.a = compToReg[ch.a];
    ch.b = ch.b >= 0 ? compToReg[ch.b] : -1;
  }
  return { chains, regions, nodes, compToReg };
}

// Sampel kurva (L/C) menjadi titik-titik [x0,y0,x1,y1,...].
function sampleGeo(geo) {
  const P = [], p = geo.p, c = geo.c;
  let x = p[0], y = p[1], k = 2;
  P.push(x, y);
  for (const cmd of c) {
    if (cmd === 0) { x = p[k]; y = p[k + 1]; k += 2; P.push(x, y); continue; }
    const x1 = p[k], y1 = p[k + 1], x2 = p[k + 2], y2 = p[k + 3], x3 = p[k + 4], y3 = p[k + 5];
    for (let t = 1; t <= 8; t++) {
      const u = t / 8, v = 1 - u;
      P.push(v * v * v * x + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3);
    }
    x = x3; y = y3; k += 6;
  }
  return P;
}
const polyLen = (P) => { let L = 0; for (let i = 2; i < P.length; i += 2) L += Math.hypot(P[i] - P[i - 2], P[i + 1] - P[i - 1]); return L; };
// Sapuan sudut titik-titik terhadap pusat; null bila arah putarnya tidak
// konsisten (balik arah > tol bagian sapuan). Titik dijarangkan per langkah
// sudut minimal agar gerigi kecil tidak dihitung sebagai balik arah.
function sweepOf(P, cx, cy, tol = 0.05, minStep = 0) {
  const n = P.length / 2;
  let sweep = 0, pos = 0, neg = 0, prev = Math.atan2(P[1] - cy, P[0] - cx);
  for (let i = 1; i < n; i++) {
    const a = Math.atan2(P[i * 2 + 1] - cy, P[i * 2] - cx);
    if (minStep && i < n - 1) {
      let dd = a - prev;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      if (Math.abs(dd) < minStep) continue;
    }
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sweep += d; if (d > 0) pos += d; else neg -= d;
    prev = a;
  }
  return Math.min(pos, neg) > tol * Math.abs(sweep) ? null : sweep;
}
// Busur Bézier berpusat (cx,cy) dari titik awal ke titik akhir P (ujung tepat),
// jari-jari diinterpolasi dari ujung ke ujung; tertutup → lingkaran jari-jari R.
function arcGeo(P, closed, cx, cy, R, sweep) {
  const n = P.length / 2;
  const a0 = Math.atan2(P[1] - cy, P[0] - cx);
  const r0 = Math.hypot(P[0] - cx, P[1] - cy), r1 = Math.hypot(P[(n - 1) * 2] - cx, P[(n - 1) * 2 + 1] - cy);
  const span = closed ? Math.sign(sweep) * 2 * Math.PI : sweep;
  const segs = Math.max(closed ? 4 : 1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const dA = span / segs, kk = (4 / 3) * Math.tan(dA / 4);
  const rAt = (t) => (closed ? R : r0 + (r1 - r0) * t);
  const op = [closed ? cx + R * Math.cos(a0) : P[0], closed ? cy + R * Math.sin(a0) : P[1]], oc = [];
  for (let j = 0; j < segs; j++) {
    const a = a0 + dA * j, b = a + dA, ra = rAt(j / segs), rb = rAt((j + 1) / segs);
    const ax = cx + ra * Math.cos(a), ay = cy + ra * Math.sin(a);
    let bx = cx + rb * Math.cos(b), by = cy + rb * Math.sin(b);
    if (j === segs - 1) {
      if (closed) { bx = op[0]; by = op[1]; } else { bx = P[(n - 1) * 2]; by = P[(n - 1) * 2 + 1]; }
    }
    oc.push(1);
    op.push(ax - kk * ra * Math.sin(a), ay + kk * ra * Math.cos(a), bx + kk * rb * Math.sin(b), by - kk * rb * Math.cos(b), bx, by);
  }
  return { p: Float32Array.from(op), c: Uint8Array.from(oc) };
}
// Lingkaran/busur kuadrat terkecil (Kasa). Diterima bila panjang >= 30 px
// sumber, busur >= 60°, arah putar konsisten, simpangan kecil (rms <= max(0,35 px,
// 2 % R), maks <= max(1,2 px, 6 % R)).
function arcSnap(P, closed, s, W, H) {
  const n = P.length / 2;
  if (n < 12 || polyLen(P) < 30 * s) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += P[i * 2]; my += P[i * 2 + 1]; }
  mx /= n; my /= n;
  let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = P[i * 2] - mx, v = P[i * 2 + 1] - my;
    Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu);
  const uc = (b1 * Svv - b2 * Suv) / det, vc = (Suu * b2 - Suv * b1) / det;
  const cx = uc + mx, cy = vc + my;
  const R = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);
  if (!(R >= 6 * s) || R > 0.5 * Math.max(W, H)) return null;
  let ss = 0, mxd = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(Math.hypot(P[i * 2] - cx, P[i * 2 + 1] - cy) - R);
    ss += d * d; if (d > mxd) mxd = d;
  }
  if (Math.sqrt(ss / n) > Math.max(0.35 * s, 0.02 * R) || mxd > Math.max(1.2 * s, 0.06 * R)) return null;
  const sweep = sweepOf(P, cx, cy);
  if (sweep === null) return null;
  if (closed ? Math.abs(Math.abs(sweep) - 2 * Math.PI) > 0.3 : Math.abs(sweep) < Math.PI / 3) return null;
  const geo = arcGeo(P, closed, cx, cy, R, sweep);
  if (!nearPath(P, geo, Math.max(1.5 * s, 0.06 * R))) return null;
  return { geo, cx, cy, R };
}

// Pengaman snap: setiap titik kurva baru harus dekat dengan kurva lama, dan
// sebaliknya (tidak ada busur yang berputar ke arah salah / memotong jalan).
function nearPath(P, geo, tol) {
  const Q = sampleGeo(geo), t2 = tol * tol;
  const close = (A, Bp) => {
    const nb = Bp.length / 2;
    for (let i = 0; i < A.length; i += 2) {
      let ok = false;
      for (let k = 0; k < nb; k++) {
        const dx = A[i] - Bp[k * 2], dy = A[i + 1] - Bp[k * 2 + 1];
        if (dx * dx + dy * dy <= t2) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  };
  // Sampel rapat (~tol/2) supaya jarak antar titik tidak menipu.
  const dense = (A) => {
    const o = [A[0], A[1]];
    for (let i = 2; i < A.length; i += 2) {
      const dx = A[i] - A[i - 2], dy = A[i + 1] - A[i - 1], n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (tol / 2)));
      for (let j = 1; j <= n; j++) o.push(A[i - 2] + (dx * j) / n, A[i - 1] + (dy * j) / n);
    }
    return o;
  };
  const Pd = dense(P), Qd = dense(Q);
  return close(Qd, Pd) && close(Pd, Qd);
}
// Busur sepusat dengan lingkaran besar terdekat: jarak titik ke pusat hampir
// tetap (rentang persentil 10–90 <= 12 % median), di luar lingkaran itu
// (1,05–4 × R), sapuan >= 45° satu arah, panjang >= 20 px sumber.
function concentricSnap(P, closed, disks, s) {
  const n = P.length / 2;
  if (n < 8 || polyLen(P) < 20 * s) return null;
  let best = null;
  for (const d of disks) {
    const ds = new Float64Array(n);
    for (let i = 0; i < n; i++) ds[i] = Math.hypot(P[i * 2] - d.cx, P[i * 2 + 1] - d.cy);
    const sorted = Float64Array.from(ds).sort();
    const med = sorted[n >> 1], lo = sorted[Math.floor(n * 0.1)], hi = sorted[Math.floor(n * 0.9)];
    if (med < 1.05 * d.R || med > (d.Rg || 4 * d.R) + 2 * s) continue;
    const spread = (hi - lo) / med;
    if (spread > 0.15 || (best && spread >= best.spread)) continue;
    const sweep = sweepOf(P, d.cx, d.cy, 0.15, (4 * s) / med);
    if (sweep === null || (closed ? Math.abs(Math.abs(sweep) - 2 * Math.PI) > 0.4 : Math.abs(sweep) < Math.PI / 4)) continue;
    best = { spread, d, med, sweep };
  }
  if (!best) return null;
  const geo = arcGeo(P, closed, best.d.cx, best.d.cy, best.med, best.sweep);
  return nearPath(P, geo, Math.max(2 * s, 0.06 * best.med)) ? geo : null;
}

function polyArea(V, W1) {
  let a = 0;
  const n = V.length;
  for (let i = 0; i < n; i++) {
    const p = V[i], q = V[(i + 1) % n];
    a += (p % W1) * ((q / W1) | 0) - (q % W1) * ((p / W1) | 0);
  }
  return a / 2;
}

function containsAny(V, W1, pts) {
  if (!pts.length) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const n = V.length;
  for (let i = 0; i < n; i++) {
    const x = V[i] % W1, y = (V[i] / W1) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (let k = 0; k < pts.length; k += 2) {
    const px = pts[k], py = pts[k + 1];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = V[i] % W1, yi = (V[i] / W1) | 0, xj = V[j] % W1, yj = (V[j] / W1) | 0;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ---------------------------------------------------------------- fitting
function makeFitter(W1, s, o) {
  const err = Math.max(0.25, o.smooth * s); // toleransi dalam piksel kerja
  const lineTol = err * 0.6;
  const K = Math.max(2, Math.min(6, Math.round(1.5 * s)));
  const cornerThr = (o.corner || 62) * (Math.PI / 180);
  // Penghalusan kuat setelah sudut dikunci: menghapus gelombang tangga piksel
  // sumber (yang setelah upscale berperiode beberapa piksel kerja).
  const heavy = Math.min(o.heavyMax || 40, Math.max(2, Math.round((o.heavyK || 1) * ((0.25 + o.smooth) * s) ** 2)));
  // Tepi kasar (gaya kuas kering, sobekan): gelombang kecil sepanjang tepi
  // (<= o.rough px sumber) dihaluskan; hanya sudut yang tetap tajam pada skala
  // yang lebih besar daripada gelombang itu yang dipertahankan.
  const roughSig = Math.max(0, o.rough || 0) * s;
  const roughPasses = roughSig > 0 ? Math.min(600, Math.round(2 * roughSig * roughSig)) : 0;
  const roughWin = Math.max(1, Math.round(3 * roughSig));

  const vx = (v) => v % W1, vy = (v) => (v / W1) | 0;

  function open(seq, A, B, adj) {
    const n = seq.length;
    const P = new Float64Array((n + 1) * 2);
    P[0] = A[0]; P[1] = A[1];
    for (let i = 0; i < n - 1; i++) {
      P[(i + 1) * 2] = (vx(seq[i]) + vx(seq[i + 1])) / 2;
      P[(i + 1) * 2 + 1] = (vy(seq[i]) + vy(seq[i + 1])) / 2;
    }
    P[n * 2] = B[0]; P[n * 2 + 1] = B[1];
    if (adj) adj(P, n + 1, false);
    return processOpen(P, n + 1);
  }

  function closed(V, adj) {
    const n = V.length;
    const P = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = V[i], b = V[(i + 1) % n];
      P[i * 2] = (vx(a) + vx(b)) / 2;
      P[i * 2 + 1] = (vy(a) + vy(b)) / 2;
    }
    if (adj) adj(P, n, true);
    return processClosed(P, n);
  }

  function processOpen(P, n) {
    if (polyOn && n >= 4) { const r = polyFit(P, n, false); if (r) return r; }
    const fixed = new Uint8Array(n);
    fixed[0] = fixed[n - 1] = 1;
    let Q = smooth(P, n, false, fixed, 1);
    const cor = corners(Q, n, false, roughWin);
    if (roughPasses) {
      for (const i of cor) fixed[i] = 1;
      Q = smooth(Q, n, false, fixed, roughPasses);
    }
    for (const i of cor) fixed[i] = 1;
    Q = smooth(Q, n, false, fixed, heavy, true);
    const out = newPath(Q[0], Q[1]);
    fitSmart(Q, 0, n - 1, null, null, out, cor);
    return finish(out);
  }

  function processClosed(P, n) {
    if (polyOn && n >= 8) {
      // Bentuk bulat tanpa sudut (blueberry, mata, titik) → elips utuh.
      if (n >= 12) {
        const f0 = new Uint8Array(n);
        const Q0 = smooth(P, n, true, f0, 1);
        if (!corners(Q0, n, true, roughWin).length) {
          const ell = fitEllipse(smooth(Q0, n, true, f0, heavy, true), n);
          if (ell) return ell;
        }
      }
      const r = polyFit(P, n, true);
      if (r) return r;
    }
    const fixed = new Uint8Array(n);
    let Q = smooth(P, n, true, fixed, 1);
    const cor = corners(Q, n, true, roughWin);
    if (roughPasses && n > 8) {
      for (const i of cor) fixed[i] = 1;
      Q = smooth(Q, n, true, fixed, Math.min(roughPasses, n * 2));
    }
    if (!cor.length) {
      Q = smooth(Q, n, true, fixed, heavy, true);
      const ell = n >= 12 ? fitEllipse(Q, n) : null;
      if (ell) return ell;
      // Pecah di dua titik berlawanan dengan tangen kontinu.
      const R = rot(Q, n, 0);
      const h = n >> 1;
      const tA = centerTan(Q, n, 0), tB = centerTan(Q, n, h);
      const out = newPath(R[0], R[1]);
      fitSmart(R, 0, h, tA, [-tB[0], -tB[1]], out);
      fitSmart(R, h, n, tB, [-tA[0], -tA[1]], out);
      return finish(out);
    }
    for (const i of cor) fixed[i] = 1;
    Q = smooth(Q, n, true, fixed, heavy, true);
    const c0 = cor[0];
    const R = rot(Q, n, c0);
    const splits = cor.map((i) => (i - c0 + n) % n).sort((a, b) => a - b);
    splits.push(n);
    const out = newPath(R[0], R[1]);
    fitSmart(R, 0, n, null, null, out, splits.slice(1, -1));
    return finish(out);
  }


  // ---- poligon minimal (gaya Potrace) ---------------------------------------
  // 1) Poligon dengan jumlah sisi paling sedikit yang semua titik batasnya
  //    berada <= polyTol dari sisinya (pemrograman dinamis, kerucut sudut).
  // 2) Titik sudut poligon digeser ke perpotongan garis kuadrat-terkecil sisi.
  // 3) Tiap titik sudut: belokan tajam & sisi cukup panjang → sudut runcing;
  //    selain itu → kurva halus dari tengah sisi ke tengah sisi.
  // 4) Kurva halus berurutan yang searah lengkungnya digabung menjadi satu
  //    kubik selama simpangannya <= optTol.
  // Hasil: zig-zag tetap runcing, lengkung jadi satu kurva panjang, titik sedikit.
  const polyOn = o.polyFit === true;
  const polyTol = (o.polyTol ?? Math.max(0.3, 0.55 * o.smooth)) * s;
  const optTol = (o.optTol ?? Math.max(0.15, 0.375 * o.smooth)) * s;
  const cornerMinLen = (o.cornerMinLen ?? 1.0) * s;
  const ddCorner = o.ddCorner ?? 6;

  function polyFit(P, n, closedPath) {
    const fixed = new Uint8Array(n);
    if (!closedPath) fixed[0] = fixed[n - 1] = 1;
    let Q = smooth(P, n, closedPath, fixed, 1);
    if (roughPasses && n > 8) {
      // sigma <= n/20 (tertutup) atau n/8 (terbuka) sampel: bentuk kecil tidak menyusut.
      const cap = closedPath ? 2 * (n / 20) ** 2 : 2 * (n / 8) ** 2;
      Q = smooth(Q, n, closedPath, fixed, Math.max(2, Math.min(roughPasses, Math.round(cap))));
    }
    let R, m;
    if (closedPath) {
      // Mulai di titik dengan belokan terbesar (calon sudut).
      let best = 0, bt = -1;
      const w = Math.max(2, K);
      for (let i = 0; i < n; i++) {
        const a = (i - w + n) % n, b = (i + w) % n;
        const t = turnAt(Q[a * 2], Q[a * 2 + 1], Q[i * 2], Q[i * 2 + 1], Q[b * 2], Q[b * 2 + 1]);
        if (t > bt) { bt = t; best = i; }
      }
      R = rot(Q, n, best); m = n + 1;
    } else { R = Q; m = n; }
    // Batas berkontras rendah yang sebagian besar berupa garis lurus panjang
    // (kilau & setrip sedotan) ditangani fitter garis-lurus yang sudah ada.
    if (weak) {
      let cov = 0;
      for (const r of findRuns(R, 0, m - 1)) if (r.long) cov += r.i1 - r.i0;
      if (cov > 0.45 * (m - 1)) return null;
    }

    // --- 1. lon[i]: indeks terjauh j sehingga sisi i→j sah.
    const lon = new Int32Array(m);
    for (let i = 0; i < m - 1; i++) {
      const x0 = R[i * 2], y0 = R[i * 2 + 1];
      let lo = -Infinity, hi = Infinity, ref = null, far = 0, j = i + 1;
      lon[i] = i + 1;
      for (let k = i + 1; k < m; k++) {
        const dx = R[k * 2] - x0, dy = R[k * 2 + 1] - y0, d = Math.hypot(dx, dy);
        if (d < far - polyTol) break; // berbalik arah
        if (d > far) far = d;
        if (d <= polyTol) { lon[i] = k; continue; }
        let th = Math.atan2(dy, dx);
        if (ref === null) ref = th;
        th -= ref;
        while (th > Math.PI) th -= 2 * Math.PI;
        while (th < -Math.PI) th += 2 * Math.PI;
        if (th < lo || th > hi) break;
        lon[i] = k;
        const h = Math.asin(Math.min(1, polyTol / d));
        if (th - h > lo) lo = th - h;
        if (th + h < hi) hi = th + h;
        if (lo > hi) break;
        j = k;
      }
    }
    // Jumlah prefix untuk penalti (jumlah kuadrat jarak titik ke sisi).
    const SX = new Float64Array(m + 1), SY = new Float64Array(m + 1), SXX = new Float64Array(m + 1), SXY = new Float64Array(m + 1), SYY = new Float64Array(m + 1);
    const ox = R[0], oy = R[1];
    for (let k = 0; k < m; k++) {
      const x = R[k * 2] - ox, y = R[k * 2 + 1] - oy;
      SX[k + 1] = SX[k] + x; SY[k + 1] = SY[k] + y; SXX[k + 1] = SXX[k] + x * x; SXY[k + 1] = SXY[k] + x * y; SYY[k + 1] = SYY[k] + y * y;
    }
    const pen = (i, j) => {
      const ax = R[i * 2] - ox, ay = R[i * 2 + 1] - oy, bx = R[j * 2] - ox, by = R[j * 2 + 1] - oy;
      let nx = by - ay, ny = -(bx - ax);
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      const c = nx * ax + ny * ay, N = j - i + 1;
      const sx = SX[j + 1] - SX[i], sy = SY[j + 1] - SY[i], sxx = SXX[j + 1] - SXX[i], sxy = SXY[j + 1] - SXY[i], syy = SYY[j + 1] - SYY[i];
      return Math.max(0, nx * nx * sxx + 2 * nx * ny * sxy + ny * ny * syy - 2 * c * (nx * sx + ny * sy) + c * c * N);
    };
    // --- DP: sisi paling sedikit, lalu penalti terkecil.
    const cnt = new Int32Array(m).fill(1 << 30), cost = new Float64Array(m).fill(Infinity), prv = new Int32Array(m).fill(-1);
    cnt[0] = 0; cost[0] = 0;
    for (let i = 0; i < m - 1; i++) {
      if (cnt[i] >= 1 << 30) continue;
      for (let j = i + 1; j <= lon[i]; j++) {
        const c = cnt[i] + 1;
        if (c > cnt[j]) continue;
        const pc = cost[i] + pen(i, j);
        if (c < cnt[j] || pc < cost[j]) { cnt[j] = c; cost[j] = pc; prv[j] = i; }
      }
    }
    const idx = [];
    for (let j = m - 1; j >= 0; j = prv[j]) { idx.push(j); if (j === 0) break; }
    idx.reverse();
    if (idx[0] !== 0) { idx.length = 0; idx.push(0, m - 1); }
    const q = idx.length - 1; // jumlah sisi

    // --- 2. garis kuadrat-terkecil tiap sisi, lalu geser titik sudut.
    const lines = [];
    for (let t = 0; t < q; t++) {
      const i = idx[t], j = idx[t + 1], N = j - i + 1;
      const sx = SX[j + 1] - SX[i], sy = SY[j + 1] - SY[i];
      const mx = sx / N, my = sy / N;
      const cxx = (SXX[j + 1] - SXX[i]) / N - mx * mx, cxy = (SXY[j + 1] - SXY[i]) / N - mx * my, cyy = (SYY[j + 1] - SYY[i]) / N - my * my;
      let dx = R[j * 2] - R[i * 2], dy = R[j * 2 + 1] - R[i * 2 + 1];
      if (N > 2) {
        const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        let ex = Math.cos(th), ey = Math.sin(th);
        if (ex * dx + ey * dy < 0) { ex = -ex; ey = -ey; }
        dx = ex; dy = ey;
      }
      const L = Math.hypot(dx, dy) || 1;
      lines.push([mx + ox, my + oy, dx / L, dy / L]);
    }
    const V = idx.map((k) => [R[k * 2], R[k * 2 + 1]]);
    const adjust = (vi, l1, l2) => {
      const [ax, ay, ux, uy] = l1, [bx, by, wx, wy] = l2;
      const den = ux * wy - uy * wx;
      if (Math.abs(den) < 0.05) return;
      const t = ((bx - ax) * wy - (by - ay) * wx) / den;
      const X = ax + t * ux, Y = ay + t * uy;
      if (Math.hypot(X - V[vi][0], Y - V[vi][1]) <= Math.max(polyTol, 0.6 * s)) V[vi] = [X, Y];
    };
    for (let t = 1; t < q; t++) adjust(t, lines[t - 1], lines[t]);
    if (closedPath && q >= 2) { adjust(0, lines[q - 1], lines[0]); V[q] = V[0]; }

    // --- 3. sudut atau kurva.
    const nv = closedPath ? q : q + 1; // jumlah titik sudut unik
    const isCorner = new Uint8Array(nv);
    const VP = (i) => V[closedPath ? ((i % q) + q) % q : i];
    const ctrl = [];
    for (let i = 0; i < nv; i++) {
      if (!closedPath && (i === 0 || i === q)) { isCorner[i] = 1; continue; }
      const a = VP(i - 1), v = VP(i), b = VP(i + 1);
      const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]), l2 = Math.hypot(b[0] - v[0], b[1] - v[1]);
      const tr = turnAt(a[0], a[1], v[0], v[1], b[0], b[1]);
      const m1 = [(a[0] + v[0]) / 2, (a[1] + v[1]) / 2], m2 = [(v[0] + b[0]) / 2, (v[1] + b[1]) / 2];
      const cx = m2[0] - m1[0], cy = m2[1] - m1[1], cl = Math.hypot(cx, cy) || 1;
      const dd = Math.abs((v[0] - m1[0]) * cy - (v[1] - m1[1]) * cx) / cl / s;
      if ((tr >= cornerThr && Math.min(l1, l2) >= cornerMinLen) || dd >= ddCorner) { isCorner[i] = 1; continue; }
      let al = dd > 1 ? (1 - 1 / dd) / 0.75 : 0;
      al = Math.max(0.55, Math.min(1, al));
      const f = 0.5 + 0.5 * al;
      ctrl[i] = [m1, [m1[0] + f * (v[0] - m1[0]), m1[1] + f * (v[1] - m1[1])], [m2[0] + f * (v[0] - m2[0]), m2[1] + f * (v[1] - m2[1])], m2];
    }

    // Susun potongan: titik awal = sebuah sudut (atau tengah sisi bila tak ada sudut).
    let start = 0;
    if (closedPath) { start = -1; for (let i = 0; i < nv; i++) if (isCorner[i]) { start = i; break; } }
    const pieces = []; // {c:0, x, y} garis; {c:1, a:[c1,c2,end]} kubik
    let sx0, sy0;
    if (start >= 0) {
      const v0 = VP(start); sx0 = v0[0]; sy0 = v0[1];
      const steps = closedPath ? nv : q;
      // Luruskan garis panjang: rentang sudut-ke-sudut yang pada dasarnya lurus
      // (uji yang sama dengan fitter lama) menjadi satu garis.
      let spanStart = 0, spanFrom = start;
      for (let k = 1; k <= steps; k++) {
        const i = closedPath ? (start + k) % nv : k;
        if (isCorner[i] || (!closedPath && i === q)) {
          const v = VP(i);
          // Indeks R (tanpa melewati ujung rantai tertutup).
          const a0 = idx[spanFrom], b0 = !closedPath || i > spanFrom ? idx[i] : i === 0 ? m - 1 : -1;
          const straight = longOn && b0 > a0 && b0 - a0 >= 8 && lineOkLong(R, a0, b0);
          if (straight) pieces.length = spanStart;
          pieces.push({ c: 0, x: v[0], y: v[1], cornerEnd: 1 });
          spanStart = pieces.length; spanFrom = i;
        } else { const [m1, c1, c2, m2] = ctrl[i]; pieces.push({ c: 0, x: m1[0], y: m1[1] }); pieces.push({ c: 1, a: [c1, c2, m2] }); }
      }
    } else {
      const m0 = ctrl[0][0]; sx0 = m0[0]; sy0 = m0[1];
      for (let k = 0; k < nv; k++) { const [m1, c1, c2, m2] = ctrl[k]; pieces.push({ c: 0, x: m1[0], y: m1[1] }); pieces.push({ c: 1, a: [c1, c2, m2] }); }
    }

    // --- 4. tulis: di antara dua sudut, semua potongan (garis & kubik) diubah
    // ke bentuk kubik lalu digabung serakah selama simpangannya <= optTol.
    const out = newPath(sx0, sy0);
    let cx = sx0, cy = sy0;
    const flush = (grp) => {
      let u = 0;
      while (u < grp.length) {
        let w = u, bz = grp[u].slice(2);
        for (let v = u + 1; v < grp.length; v++) {
          const f = mergeBez(grp, u, v);
          if (!f) break;
          w = v; bz = f;
        }
        const x0 = grp[u][0], y0 = grp[u][1];
        const dx = bz[4] - x0, dy = bz[5] - y0, L = Math.hypot(dx, dy) || 1;
        const d1 = Math.abs((bz[0] - x0) * dy - (bz[1] - y0) * dx) / L, d2 = Math.abs((bz[2] - x0) * dy - (bz[3] - y0) * dx) / L;
        if (d1 < 0.05 * s && d2 < 0.05 * s) lineTo(out, bz[4], bz[5]);
        else curveTo(out, bz[0], bz[1], bz[2], bz[3], bz[4], bz[5]);
        cx = bz[4]; cy = bz[5];
        u = w + 1;
      }
    };
    let grp = [];
    for (let k = 0; k < pieces.length; k++) {
      const pc = pieces[k];
      if (pc.c === 0 && Math.hypot(pc.x - cx, pc.y - cy) <= 1e-6) {
        // garis nol-panjang
      } else if (pc.c === 0) {
        const x0 = cx, y0 = cy, x1 = pc.x, y1 = pc.y;
        grp.push([x0, y0, x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3, x1, y1]);
        cx = x1; cy = y1;
      } else {
        grp.push([cx, cy, ...pc.a.flat()]);
        cx = pc.a[2][0]; cy = pc.a[2][1];
      }
      // Titik sudut memutus kelompok (sudut tetap runcing).
      if (pc.cornerEnd && grp.length) { const g = grp; grp = []; flush(g); }
    }
    if (grp.length) flush(grp);
    // Penutup: titik akhir harus tepat di titik awal (rantai tertutup) / ujung.
    if (closedPath) { const L = out.p.length; out.p[L - 2] = sx0; out.p[L - 1] = sy0; }
    else { const L = out.p.length; out.p[L - 2] = R[(m - 1) * 2]; out.p[L - 1] = R[(m - 1) * 2 + 1]; }
    return finish(out);
  }

  // Satu kubik untuk potongan run[u..v] (rantai kubik G1): sampel lalu fit
  // dengan tangen ujung tetap; null bila simpangan > optTol.
  function mergeBez(run, u, v) {
    const pts = [];
    for (let k = u; k <= v; k++) {
      const b = run[k];
      for (let i = k === u ? 0 : 1; i <= 8; i++) {
        const t = i / 8, mt = 1 - t;
        pts.push(mt * mt * mt * b[0] + 3 * mt * mt * t * b[2] + 3 * mt * t * t * b[4] + t * t * t * b[6], mt * mt * mt * b[1] + 3 * mt * mt * t * b[3] + 3 * mt * t * t * b[5] + t * t * t * b[7]);
      }
    }
    const Qs = Float64Array.from(pts), N = Qs.length / 2;
    const b0 = run[u], b1 = run[v];
    const t1 = norm(b0[2] - b0[0], b0[3] - b0[1]), t2 = norm(b1[4] - b1[6], b1[5] - b1[7]);
    let uu = chordParam(Qs, 0, N - 1);
    let bz = genBezier(Qs, 0, N - 1, uu, t1, t2);
    let [mx] = maxError(Qs, 0, N - 1, bz, uu);
    for (let it = 0; it < 3 && mx > optTol * optTol; it++) {
      uu = reparam(Qs, 0, N - 1, uu, bz);
      bz = genBezier(Qs, 0, N - 1, uu, t1, t2);
      [mx] = maxError(Qs, 0, N - 1, bz, uu);
    }
    return mx <= optTol * optTol ? bz.slice(2) : null;
  }

  function turnAt(ax, ay, bx, by, cx, cy) {
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
  }

  // Salinan berputar dengan titik awal di akhir (n+1 titik).
  function rot(Q, n, start) {
    const R = new Float64Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const j = (start + i) % n;
      R[i * 2] = Q[j * 2]; R[i * 2 + 1] = Q[j * 2 + 1];
    }
    return R;
  }

  function centerTan(Q, n, i) {
    const m = Math.min(3, Math.max(1, n >> 3));
    const a = (i - m + n) % n, b = (i + m) % n;
    return norm(Q[b * 2] - Q[a * 2], Q[b * 2 + 1] - Q[a * 2 + 1]);
  }

  // Laplacian ([1,2,1]/4); bila taubin, tiap langkah diikuti langkah "mengembang"
  // (μ < 0) agar bentuk tidak menyusut (penghalusan Taubin).
  function smooth(P, n, closedPath, fixed, passes, taubin) {
    let a = P, b = new Float64Array(P.length);
    const steps = taubin ? passes * 2 : passes;
    for (let ps = 0; ps < steps; ps++) {
      const f = taubin && ps & 1 ? -0.53 : 0.5;
      for (let i = 0; i < n; i++) {
        if (fixed[i] || (!closedPath && (i === 0 || i === n - 1))) { b[i * 2] = a[i * 2]; b[i * 2 + 1] = a[i * 2 + 1]; continue; }
        const im = closedPath ? (i - 1 + n) % n : i - 1, ip = closedPath ? (i + 1) % n : i + 1;
        b[i * 2] = a[i * 2] + f * ((a[im * 2] + a[ip * 2]) / 2 - a[i * 2]);
        b[i * 2 + 1] = a[i * 2 + 1] + f * ((a[im * 2 + 1] + a[ip * 2 + 1]) / 2 - a[i * 2 + 1]);
      }
      const t = a === P ? new Float64Array(P.length) : a;
      a = b; b = t;
    }
    return a;
  }

  function corners(Q, n, closedPath, wide = 0) {
    const k = closedPath ? Math.min(K, Math.max(1, (n - 1) >> 1)) : K;
    if (n < 5) return [];
    // Sudut belok di titik i dengan jendela ±w.
    const turn = (i, w) => {
      const im = closedPath ? (i - w + n * 4) % n : Math.max(0, i - w);
      const ip = closedPath ? (i + w) % n : Math.min(n - 1, i + w);
      const ax = Q[i * 2] - Q[im * 2], ay = Q[i * 2 + 1] - Q[im * 2 + 1];
      const bx = Q[ip * 2] - Q[i * 2], by = Q[ip * 2 + 1] - Q[i * 2 + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    };
    const k2w = Math.max(2 * k, roughPasses ? wide : 0);
    const k2 = closedPath ? Math.min(k2w, Math.max(1, (n - 1) >> 1)) : k2w;
    const ang = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!closedPath && (i === 0 || i === n - 1)) continue;
      const a = turn(i, k);
      // Sudut sejati tetap tajam di jendela 2×; gelombang kecil tidak.
      if (a >= cornerThr && turn(i, k2) >= cornerThr * 0.8) ang[i] = a;
    }
    const res = [];
    for (let i = 0; i < n; i++) {
      if (ang[i] < cornerThr) continue;
      let isMax = true;
      for (let j = -k; j <= k && isMax; j++) {
        if (!j) continue;
        let q = i + j;
        if (closedPath) q = (q + n) % n;
        else if (q < 0 || q >= n) continue;
        if (ang[q] > ang[i] || (ang[q] === ang[i] && j < 0)) isMax = false;
      }
      if (isMax) res.push(i);
    }
    return res;
  }

  // ---- garis lurus & sudut tajam -------------------------------------------
  // Bagian yang lurus dijadikan satu garis lurus sempurna. Busur halus tidak
  // ikut diluruskan: pada garis lurus yang bergetar, simpangan titik tersebar
  // di kedua sisi (rata-rata bertanda ≈ 0); pada busur selalu condong ke satu sisi.
  const runMaxDev = 0.45 * s;          // simpangan maksimum dari garis
  const runBias = 0.08 * s;            // rata-rata simpangan bertanda maksimum
  const minRun = Math.max(5, 4.5 * s); // panjang minimum garis lurus (≈ 4,5 px sumber)
  const sharpGap = 4.5 * s;            // lengkung sependek ini di antara 2 garis → sudut tajam
  const mergeAng = 9 * (Math.PI / 180);
  const sharpMin = 7 * s;
  const sharpAng = 25 * (Math.PI / 180);
  // Luruskan garis panjang: tepi yang bergerigi/bergelombang tetapi bila ditarik
  // garis panjang memang lurus (gelombang tersebar di kedua sisi, tidak condong
  // ke satu sisi seperti busur) dijadikan satu garis lurus. Toleransi tumbuh
  // dengan panjang garis: 2,5 % panjangnya, maks. 2 px sumber.
  // Batas berkontras rendah (dua warna mirip, mis. kilau/bayangan sedotan):
  // letak tepinya kurang pasti, jadi toleransinya lebih longgar dan gelombang-S
  // diizinkan; busur (condong ke satu sisi) tetap ditolak.
  const weak = o.weakStraight === true;
  const longOn = o.straighten === true || weak;
  const longMin = (weak ? 8 : 18) * s;
  const longTol = weak ? (L) => Math.min(3 * s, Math.max(1.5 * s, 0.1 * L)) : (L) => Math.min(2 * s, Math.max(0.6 * s, 0.035 * L));
  const biasAll = weak ? 0.4 : 0.22;

  function lineOk(Q, i, j) {
    const ax = Q[i * 2], ay = Q[i * 2 + 1];
    const dx = Q[j * 2] - ax, dy = Q[j * 2 + 1] - ay;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return 0;
    let mx = 0, sum = 0;
    for (let k = i + 1; k < j; k++) {
      const d = ((Q[k * 2] - ax) * dy - (Q[k * 2 + 1] - ay) * dx) / L;
      sum += d;
      const ad = d < 0 ? -d : d;
      if (ad > mx) { mx = ad; if (mx > runMaxDev) return 0; }
    }
    const cnt = j - i - 1;
    if (cnt > 0 && Math.abs(sum / cnt) > runBias) return 0;
    return L;
  }

  // Garis panjang hampir lurus: simpangan <= longTol(L) dan tidak condong ke
  // satu sisi, baik secara keseluruhan maupun per seperempat panjangnya
  // (busur dan lengkung-S ditolak).
  function lineOkLong(Q, i, j) {
    const ax = Q[i * 2], ay = Q[i * 2 + 1];
    const dx = Q[j * 2] - ax, dy = Q[j * 2 + 1] - ay;
    const L = Math.hypot(dx, dy);
    if (L < longMin) return 0;
    const tol = longTol(L);
    const n = j - i - 1;
    if (n < 8) return 0;
    // Simpangan bertanda d(t) terhadap tali busur, t = posisi 0..1 di sepanjangnya.
    // Busur: d ~ c*t(1-t); lengkung-S: d ~ e*t(1-t)(2t-1). Gerigi acak tidak
    // mengikuti keduanya. Bila busur/S-nya nyata (> 25 % / 35 % toleransi),
    // itu lengkungan sungguhan -> jangan diluruskan.
    let sum = 0, su = 0, suu = 0, sv = 0, svv = 0;
    for (let k = i + 1; k < j; k++) {
      const px = Q[k * 2] - ax, py = Q[k * 2 + 1] - ay;
      const d = (px * dy - py * dx) / L;
      if (d > tol || d < -tol) return 0;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (L * L)));
      const u = t * (1 - t), v = u * (2 * t - 1);
      sum += d; su += d * u; suu += u * u; sv += d * v; svv += v * v;
    }
    if (Math.abs(sum / n) > biasAll * tol) return 0;
    if (suu > 0 && Math.abs(su / suu) * 0.25 > 0.25 * tol) return 0; // sagita busur
    if (svv > 0 && Math.abs(sv / svv) * 0.0962 > 0.35 * tol) return 0; // amplitudo S
    return L;
  }

  function findRuns(Q, a, b) {
    const runs = [];
    const step = Math.max(1, Math.round(s));
    let i = a;
    while (i < b - 2) {
      if (longOn) {
        // Coba garis panjang dulu dari titik ini.
        // Ujung uji pertama dipilih menurut panjang sebenarnya (titik pada
        // garis diagonal lebih rapat daripada 1 px).
        let j = i + 1, al = 0;
        while (j < b && al < longMin * 1.05) { al += Math.hypot(Q[j * 2] - Q[(j - 1) * 2], Q[j * 2 + 1] - Q[(j - 1) * 2 + 1]); j++; }
        if (al >= longMin && lineOkLong(Q, i, j)) {
          let good = j;
          while (good < b) { const nj = Math.min(b, good + step); if (lineOkLong(Q, i, nj)) good = nj; else break; }
          while (good < b && lineOkLong(Q, i, good + 1)) good++;
          runs.push({ i0: i, i1: good, p0: [Q[i * 2], Q[i * 2 + 1]], p1: [Q[good * 2], Q[good * 2 + 1]], long: 1 });
          i = good;
          continue;
        }
      }
      let j = Math.min(b, i + Math.ceil(minRun));
      const L = lineOk(Q, i, j);
      if (!L || L < minRun * 0.85) { i += step; continue; }
      let good = j;
      while (good < b) { const nj = Math.min(b, good + step); if (lineOk(Q, i, nj)) good = nj; else break; }
      while (good < b && lineOk(Q, i, good + 1)) good++;
      runs.push({ i0: i, i1: good, p0: [Q[i * 2], Q[i * 2 + 1]], p1: [Q[good * 2], Q[good * 2 + 1]] });
      i = good;
    }
    // Gabungkan potongan berurutan yang hampir segaris menjadi satu garis lurus.
    for (let k = 0; k < runs.length - 1; ) {
      const r1 = runs[k], r2 = runs[k + 1];
      const d1 = norm(r1.p1[0] - r1.p0[0], r1.p1[1] - r1.p0[1]);
      const d2 = norm(r2.p1[0] - r2.p0[0], r2.p1[1] - r2.p0[1]);
      const ang = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      if (ang < mergeAng && arcLen(Q, r1.i1, r2.i0) <= sharpGap && (maxDev(Q, r1.i0, r2.i1) <= runMaxDev * 1.6 || (longOn && (r1.long || r2.long) && lineOkLong(Q, r1.i0, r2.i1)))) {
        runs.splice(k, 2, { i0: r1.i0, i1: r2.i1, p0: r1.p0, p1: r2.p1, long: r1.long || r2.long });
      } else k++;
    }
    return runs;
  }

  function maxDev(Q, i, j) {
    const ax = Q[i * 2], ay = Q[i * 2 + 1];
    const dx = Q[j * 2] - ax, dy = Q[j * 2 + 1] - ay;
    const L = Math.hypot(dx, dy) || 1;
    let mx = 0;
    for (let k = i + 1; k < j; k++) mx = Math.max(mx, Math.abs((Q[k * 2] - ax) * dy - (Q[k * 2 + 1] - ay) * dx) / L);
    return mx;
  }

  function arcLen(Q, i, j) {
    let l = 0;
    for (let k = i; k < j; k++) l += Math.hypot(Q[(k + 1) * 2] - Q[k * 2], Q[(k + 1) * 2 + 1] - Q[k * 2 + 1]);
    return l;
  }

  // Kurva di antara garis lurus dipecah di titik sudut (cs) yang ada di dalamnya.
  function fitGap(Q, i0, i1, t1, t2, out, cs) {
    const pts = [i0];
    for (const c of cs) if (c > i0 && c < i1) pts.push(c);
    pts.push(i1);
    for (let k = 0; k < pts.length - 1; k++) {
      fitPiece(Q, pts[k], pts[k + 1], k === 0 ? t1 : null, k === pts.length - 2 ? t2 : null, out);
    }
  }

  function fitSmart(Q, a, b, tA, tB, out, cs = []) {
    const runs = findRuns(Q, a, b);
    if (!runs.length) { fitGap(Q, a, b, tA, tB, out, cs); return; }
    const dir = (r) => norm(r.p1[0] - r.p0[0], r.p1[1] - r.p0[1]);
    // Penajaman: dua garis yang dipisah lengkung pendek → bertemu di titik potong.
    const sharp = new Uint8Array(runs.length);
    for (let k = 0; k < runs.length - 1; k++) {
      const r1 = runs[k], r2 = runs[k + 1];
      if (arcLen(Q, r1.i1, r2.i0) > sharpGap) continue;
      // Hanya sisi lurus yang cukup panjang (kotak, kartu) — bukan faset bentuk organik.
      const l1 = Math.hypot(r1.p1[0] - r1.p0[0], r1.p1[1] - r1.p0[1]);
      const l2 = Math.hypot(r2.p1[0] - r2.p0[0], r2.p1[1] - r2.p0[1]);
      if (Math.min(l1, l2) < sharpMin) continue;
      const d1 = dir(r1), d2 = dir(r2);
      const ang = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      if (ang < sharpAng) continue;
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-6) continue;
      const wx = r2.p0[0] - r1.p0[0], wy = r2.p0[1] - r1.p0[1];
      const t = (wx * d2[1] - wy * d2[0]) / den;
      const X = [r1.p0[0] + t * d1[0], r1.p0[1] + t * d1[1]];
      if (Math.hypot(X[0] - r1.p1[0], X[1] - r1.p1[1]) > sharpGap || Math.hypot(X[0] - r2.p0[0], X[1] - r2.p0[1]) > sharpGap) continue;
      r1.p1 = X; r2.p0 = X; sharp[k] = 1;
    }
    // Dua garis yang bersambung tanpa sudut tajam = sebenarnya lengkungan →
    // kembalikan keduanya ke kurva (menghindari tampilan bersegi).
    const drop = new Uint8Array(runs.length);
    for (let k = 0; k < runs.length - 1; k++) {
      if (sharp[k]) continue;
      if (arcLen(Q, runs[k].i1, runs[k + 1].i0) <= sharpGap) { drop[k] = 1; drop[k + 1] = 1; }
    }
    for (let k = 0; k < runs.length; k++) {
      if (!drop[k]) continue;
      // garis yang ikut tertajamkan dengan tetangga lain tetap dipertahankan
      if ((k > 0 && sharp[k - 1]) || sharp[k]) drop[k] = 0;
    }
    const keep = [], keepSharp = [];
    for (let k = 0; k < runs.length; k++) {
      if (drop[k]) continue;
      keep.push(runs[k]);
      keepSharp.push(sharp[k] && k + 1 < runs.length && !drop[k + 1] ? 1 : 0);
    }
    if (!keep.length) { fitGap(Q, a, b, tA, tB, out, cs); return; }
    runs.length = 0; runs.push(...keep);
    sharp.set(keepSharp.concat(new Array(sharp.length - keepSharp.length).fill(0)));
    let cur = a;
    let curTan = tA;
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k], d = dir(r);
      if (r.i0 > cur && !(k > 0 && sharp[k - 1])) fitGap(Q, cur, r.i0, curTan, [-d[0], -d[1]], out, cs);
      lineTo(out, r.p1[0], r.p1[1]);
      cur = r.i1;
      curTan = d;
    }
    if (cur < b) fitGap(Q, cur, b, curTan, tB, out, cs);
  }

  function fitPiece(Q, a, b, tA, tB, out) {
    const cnt = b - a + 1;
    const ax = Q[a * 2], ay = Q[a * 2 + 1], bx = Q[b * 2], by = Q[b * 2 + 1];
    if (cnt <= 3) { lineTo(out, bx, by); return; }
    // Garis lurus?
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L > 1e-9) {
      let md = 0;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((Q[i * 2] - ax) * dy - (Q[i * 2 + 1] - ay) * dx) / L;
        if (d > md) { md = d; if (md > lineTol) break; }
      }
      if (md <= lineTol) { lineTo(out, bx, by); return; }
    }
    const m = Math.max(1, Math.min(4, (cnt - 1) >> 2));
    const t1 = tA || norm(Q[(a + m) * 2] - ax, Q[(a + m) * 2 + 1] - ay);
    const t2 = tB || norm(Q[(b - m) * 2] - bx, Q[(b - m) * 2 + 1] - by);
    fitCubic(Q, a, b, t1, t2, err * err, out, 0);
  }

  function fitCubic(Q, first, last, t1, t2, e2, out, depth) {
    const n = last - first + 1;
    const p0x = Q[first * 2], p0y = Q[first * 2 + 1], p3x = Q[last * 2], p3y = Q[last * 2 + 1];
    if (n === 2) {
      const d = Math.hypot(p3x - p0x, p3y - p0y) / 3;
      curveTo(out, p0x + t1[0] * d, p0y + t1[1] * d, p3x + t2[0] * d, p3y + t2[1] * d, p3x, p3y);
      return;
    }
    let u = chordParam(Q, first, last);
    let bz = genBezier(Q, first, last, u, t1, t2);
    let [maxE, split] = maxError(Q, first, last, bz, u);
    if (maxE < e2) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
    if (maxE < e2 * 4) {
      for (let it = 0; it < 4; it++) {
        u = reparam(Q, first, last, u, bz);
        bz = genBezier(Q, first, last, u, t1, t2);
        [maxE, split] = maxError(Q, first, last, bz, u);
        if (maxE < e2) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
      }
    }
    if (depth > 24 || n < 4) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
    split = Math.max(first + 1, Math.min(last - 1, split));
    const tc = norm(Q[(split - 1) * 2] - Q[(split + 1) * 2], Q[(split - 1) * 2 + 1] - Q[(split + 1) * 2 + 1]);
    fitCubic(Q, first, split, t1, tc, e2, out, depth + 1);
    fitCubic(Q, split, last, [-tc[0], -tc[1]], t2, e2, out, depth + 1);
  }

  function fitEllipse(Q, n) {
    let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = Q[i * 2], y0 = Q[i * 2 + 1], x1 = Q[j * 2], y1 = Q[j * 2 + 1];
      const cr = x0 * y1 - x1 * y0;
      A += cr;
      cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
      ixx += (x0 * x0 + x0 * x1 + x1 * x1) * cr;
      iyy += (y0 * y0 + y0 * y1 + y1 * y1) * cr;
      ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr;
    }
    A /= 2;
    if (Math.abs(A) < 4) return null;
    cx /= 6 * A; cy /= 6 * A;
    const mxx = ixx / (12 * A) - cx * cx, myy = iyy / (12 * A) - cy * cy, mxy = ixy / (24 * A) - cx * cy;
    const tr = mxx + myy, det = mxx * myy - mxy * mxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    if (l2 <= 0) return null;
    const ra = 2 * Math.sqrt(l1), rb = 2 * Math.sqrt(l2);
    if (rb < 1.5) return null;
    const th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
    const ct = Math.cos(th), st = Math.sin(th);
    const tol = err * 0.9;
    for (let i = 0; i < n; i++) {
      const dx = Q[i * 2] - cx, dy = Q[i * 2 + 1] - cy;
      const u = dx * ct + dy * st, v = -dx * st + dy * ct;
      const rho = Math.hypot(u / ra, v / rb);
      if (rho < 1e-9) return null;
      const dist = Math.abs(rho - 1) * (Math.hypot(u, v) / rho);
      if (dist > tol) return null;
    }
    const dir = A > 0 ? 1 : -1;
    const E = (t) => [cx + ra * Math.cos(t) * ct - rb * Math.sin(t) * st, cy + ra * Math.cos(t) * st + rb * Math.sin(t) * ct];
    const D = (t) => [-ra * Math.sin(t) * ct - rb * Math.cos(t) * st, -ra * Math.sin(t) * st + rb * Math.cos(t) * ct];
    const kq = (4 / 3) * Math.tan((dir * Math.PI) / 8);
    const p0 = E(0);
    const out = newPath(p0[0], p0[1]);
    for (let q = 0; q < 4; q++) {
      const ta = (dir * q * Math.PI) / 2, tb = (dir * (q + 1) * Math.PI) / 2;
      const a = E(ta), b = E(tb), da = D(ta), db = D(tb);
      curveTo(out, a[0] + kq * da[0], a[1] + kq * da[1], b[0] - kq * db[0], b[1] - kq * db[1], q === 3 ? p0[0] : b[0], q === 3 ? p0[1] : b[1]);
    }
    return finish(out);
  }

  return { open, closed };
}

function newPath(x, y) { return { p: [x, y], c: [] }; }
function lineTo(o, x, y) { o.c.push(0); o.p.push(x, y); }
function curveTo(o, a, b, c, d, e, f) { o.c.push(1); o.p.push(a, b, c, d, e, f); }
function finish(o) { return { p: Float32Array.from(o.p), c: Uint8Array.from(o.c) }; }
function norm(x, y) {
  const l = Math.hypot(x, y);
  return l < 1e-12 ? [1, 0] : [x / l, y / l];
}

// --- Schneider (Graphics Gems I, "An Algorithm for Automatically Fitting Digitized Curves")
function chordParam(Q, first, last) {
  const n = last - first + 1;
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = first + i - 1, b = first + i;
    u[i] = u[i - 1] + Math.hypot(Q[b * 2] - Q[a * 2], Q[b * 2 + 1] - Q[a * 2 + 1]);
  }
  const L = u[n - 1] || 1;
  for (let i = 1; i < n; i++) u[i] /= L;
  return u;
}

function genBezier(Q, first, last, u, t1, t2) {
  const p0x = Q[first * 2], p0y = Q[first * 2 + 1], p3x = Q[last * 2], p3y = Q[last * 2 + 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t;
    const a1x = t1[0] * b1, a1y = t1[1] * b1, a2x = t2[0] * b2, a2y = t2[1] * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const k = first + i;
    const tx = Q[k * 2] - (p0x * (b0 + b1) + p3x * (b2 + b3));
    const ty = Q[k * 2 + 1] - (p0y * (b0 + b1) + p3y * (b2 + b3));
    x0 += a1x * tx + a1y * ty;
    x1 += a2x * tx + a2y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const seg = Math.hypot(p3x - p0x, p3y - p0y);
  const eps = 1e-6 * seg;
  if (al < eps || ar < eps || al > seg * 2 || ar > seg * 2) { al = ar = seg / 3; }
  return [p0x, p0y, p0x + t1[0] * al, p0y + t1[1] * al, p3x + t2[0] * ar, p3y + t2[1] * ar, p3x, p3y];
}

function bez(b, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, c = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  return [a * b[0] + c * b[2] + d * b[4] + e * b[6], a * b[1] + c * b[3] + d * b[5] + e * b[7]];
}

function maxError(Q, first, last, b, u) {
  let maxD = 0, split = (first + last) >> 1;
  for (let i = 1; i < u.length - 1; i++) {
    const p = bez(b, u[i]), k = first + i;
    const d = (p[0] - Q[k * 2]) ** 2 + (p[1] - Q[k * 2 + 1]) ** 2;
    if (d >= maxD) { maxD = d; split = k; }
  }
  return [maxD, split];
}

function reparam(Q, first, last, u, b) {
  const out = new Float64Array(u.length);
  const q1 = [3 * (b[2] - b[0]), 3 * (b[3] - b[1]), 3 * (b[4] - b[2]), 3 * (b[5] - b[3]), 3 * (b[6] - b[4]), 3 * (b[7] - b[5])];
  const q2 = [2 * (q1[2] - q1[0]), 2 * (q1[3] - q1[1]), 2 * (q1[4] - q1[2]), 2 * (q1[5] - q1[3])];
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t, k = first + i;
    const p = bez(b, t);
    const d1x = mt * mt * q1[0] + 2 * mt * t * q1[2] + t * t * q1[4];
    const d1y = mt * mt * q1[1] + 2 * mt * t * q1[3] + t * t * q1[5];
    const d2x = mt * q2[0] + t * q2[2], d2y = mt * q2[1] + t * q2[3];
    const dx = p[0] - Q[k * 2], dy = p[1] - Q[k * 2 + 1];
    const num = dx * d1x + dy * d1y;
    const den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
    out[i] = Math.abs(den) < 1e-12 ? t : Math.max(0, Math.min(1, t - num / den));
  }
  return out;
}
