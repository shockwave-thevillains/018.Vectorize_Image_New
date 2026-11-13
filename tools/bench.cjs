// bench.cjs <port> <outJson> [filter] [extraOptsJSON] — uji kualitas set gambar tetap.
const { chromium } = require('playwright');
const fs = require('fs');
const SET = [
  ['shake_src.jpg', { bgKey: 'magenta' }],
  ['bowl_src.jpg', { bgKey: 'magenta' }],
  ['food.png', { bgKey: 'magenta' }],
  ['map_src.png', { bgKey: 'magenta' }],
  ['robot_magenta.jpg', { bgKey: 'magenta' }],
  ['high_five.jpg', { bgKey: 'white' }],
  ['robot.webp', { bgKey: 'white' }],
  ['shake.png', { bgKey: 'white' }],
  ['mountain.png', { bgKey: 'white', mode: 'silhouette' }],
  ['stencil.jpg', { bgKey: 'white', mode: 'silhouette', silTones: 'binary' }],
  ['room.jpg', { bgKey: 'none' }],
];
(async () => {
  const [port, out, filter, extra] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(`http://localhost:${port}/tools/bench.html?${Date.now()}`);
  await p.waitForFunction(() => window.ready);
  const rows = {};
  for (const [img, o] of SET) {
    if (filter && !img.includes(filter)) continue;
    const opts = Object.assign({}, o, JSON.parse(extra || '{}'));
    if (opts.bgKey === 'none') opts.bgKey = null;
    const r = await p.evaluate(([img, o]) => window.bench(img, o), [img, opts]);
    fs.writeFileSync(`${out}.${img.split('.')[0]}.svg`, r.svg);
    delete r.svg;
    rows[img] = r;
    console.log(img.padEnd(18), JSON.stringify(r));
  }
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  await b.close();
})();
