// Import a .pptx (argv[2]) and screenshot the preview at several times (argv[4], comma-separated seconds) into argv[3].
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const web = path.join(__dirname, '..'); const file = process.argv[2]; const out = process.argv[3]; const times = (process.argv[4] || '1').split(',').map(Number); const mode = process.argv[5] || 'keep';
const srv = http.createServer((q, s) => { const url = decodeURIComponent(q.url.split('?')[0]);
  const f = url.startsWith('/pkg/') ? path.join(__dirname, 'mock-pkg', url.slice(5)) : path.join(web, url === '/' ? 'index.html' : url);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : /woff2/.test(f) ? 'font/woff2' : 'text/html' }); s.end(d); }); }).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
  pg.on('pageerror', (e) => console.log('pageerror', e.message)); pg.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  await pg.waitForFunction(() => window.easymv && !document.getElementById('boot'));
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await pg.evaluate(async ([b64, mode]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed = await easymv.core.inspectPptx(new File([bytes], 'deck.pptx'));
    const t0 = performance.now();
    await easymv.core.importPptx(parsed, { name: 'deck', backgrounds: mode });
    const st = easymv.core.state;
    return { ms: Math.round(performance.now() - t0), layers: st.project.elements.map((e) => e.id), len: st.project.lengthSec, slides: parsed.slides.map((s) => ({ items: s.items.length, blocks: s.blocks.length })), script: st.project.elements.find((e) => e.type === 'script')?.script.text };
  }, [b64, mode]);
  console.log(JSON.stringify({ ...res, script: undefined })); fs.writeFileSync(`${out}/script.txt`, res.script || '');
  await pg.evaluate(() => easymv.core.select(null)); await pg.click('.pv-tools .edit-toggle').catch(() => {});
  for (const t of times) { await pg.evaluate((t) => easymv.core.seek(Math.round(t * easymv.core.state.project.videoFps)), t); await pg.waitForTimeout(900); await (await pg.$('.stage canvas')).screenshot({ path: `${out}/p-${t}.png` }); }
  await b.close(); srv.close();
});
