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
  r.push(expect('array order: later layers paint on top', o.bgOnTop, [255, 255, 255, 255]));
  const flag = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); return ok; };
  const g = [
    flag('visualizer draws pixels', o.visLit > 200, o.visLit),
    flag('visualizer circle leaves the centre empty', o.visCenterDark[0] + o.visCenterDark[1] + o.visCenterDark[2] < 30, o.visCenterDark),
    flag('visualizer is deterministic after scrubbing', o.visDeterministic),
    flag('triangle spikes draw and differ from circle bars', o.triLit > 100 && o.triDiffers, o.triLit),
    flag('square waveform draws', o.waveLit > 50, o.waveLit),
    flag('snow draws', o.snowLit > 30, o.snowLit),
    flag('snow moves over time', o.snowMoves),
    flag('snow is deterministic after scrubbing', o.snowDeterministic),
    flag('pixel fire draws', o.fireLit > 200, o.fireLit),
    flag('lo-fi glitter draws', o.lofiLit > 5, o.lofiLit),
    flag('lyrics render text', o.lyricsLit > 100, o.lyricsLit),
    flag('script layer draws scenes', o.scriptLit > 500, o.scriptLit),
    flag('script scene 2 draws', o.scriptLit2 > 500, o.scriptLit2),
    flag('lyrics disappear after their window', o.lyricsGone < 5, o.lyricsGone),
    flag('hidden layer draws exactly like no layer', o.cullEqual),
    flag('hidden layer is dropped from the plan', o.visFlagCulled),
  ];
  process.exit(r.every(Boolean) && soft && g.every(Boolean) ? 0 : 1);
});
