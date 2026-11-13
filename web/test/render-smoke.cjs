// Headless-Chromium renderer smoke test: `node test/render-smoke.cjs` (needs playwright).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const expect = (name, got, want, tol = 3) => {
  const ok = got.every((v, i) => Math.abs(v - want[i]) <= tol);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got [${got}] want [${want}]`);
  return ok;
};
const srv = http.createServer((q, s) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : 'text/html' }); s.end(d); });
}).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage();
  pg.on('pageerror', (e) => console.log('pageerror:', e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/test/render-smoke.html`);
  await pg.waitForFunction(() => window.__out, { timeout: 30000 });
  const o = await pg.evaluate(() => window.__out);
  await b.close(); srv.close();
  if (o.error) { console.log(o.error); process.exit(1); }
  const r = [
    expect('sprite cell 1 is green', o.greenCenter, [0, 255, 0, 255]),
    expect('background visible', o.whiteCorner, [255, 255, 255, 255]),
    expect('sprite cell 2 is blue', o.blueCenter, [0, 0, 255, 255]),
    expect('opacity .5 over white', o.halfRed, [255, 128, 128, 255]),
    expect('hue +120deg red->green', o.hue120, [0, 255, 0, 255], 8),
    expect('blur softens edge', o.blurEdge.map((v, i) => (i === 1 ? 255 : v)), [255, 255, 255, 255], 255),
    expect('translate: sprite moved left', o.moved[0], [255, 0, 0, 255]),
    expect('translate: right side empty', o.moved[1], [255, 255, 255, 255]),
  ];
  const soft = o.blurEdge[1] > 10 && o.blurEdge[1] < 245; console.log(`${soft ? 'PASS' : 'FAIL'} blur edge is intermediate: ${o.blurEdge}`);
  process.exit(r.every(Boolean) && soft ? 0 : 1);
});
