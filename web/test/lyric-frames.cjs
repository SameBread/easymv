const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'); const out = process.argv[2];
const srv = http.createServer((q, s) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.woff2$/.test(f) ? 'font/woff2' : 'text/html' }); s.end(d); }); }).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 1300, height: 740 } });
  pg.on('pageerror', (e) => console.log('pageerror', e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/test/demo-render.html`);
  await pg.waitForFunction(() => window.ready);
  const { DEMO_LYRICS } = await pg.evaluate(async () => (await import('../js/script.js')));
  const m = await pg.evaluate(async () => { const s = await import('../js/script.js'); return { text: s.DEMO_LYRICS, mode: s.MODES.lyrics }; });
  await pg.evaluate(async ([text, mode]) => { await window.setup({ text, ...mode, seed: 3 }, 24, 96); window.__r.duration = 60; }, [m.text, m.mode]);
  for (const t of (process.argv[3] || "3.2,19.5").split(",").map(Number)) {
    const b64 = await pg.evaluate((f) => window.render(f), Math.round(t * 24));
    fs.writeFileSync(`${out}/lf-${t}.png`, Buffer.from(b64, 'base64'));
  }
  await b.close(); srv.close();
});
