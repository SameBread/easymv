const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const web = path.join(__dirname, '..'); const out = process.argv[2];
const wav = Buffer.alloc(64); wav.write('RIFF', 0);
const srv = http.createServer((q, s) => { const url = decodeURIComponent(q.url.split('?')[0]);
  const f = url.startsWith('/pkg/') ? path.join(__dirname, 'mock-pkg', url.slice(5)) : path.join(web, url === '/' ? 'index.html' : url);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : /woff2/.test(f) ? 'font/woff2' : 'text/html' }); s.end(d); }); }).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 })).newPage();
  pg.on('pageerror', (e) => console.log('pageerror', e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  await pg.waitForFunction(() => window.easymv && !document.getElementById('boot'));
  const E = (f, a) => pg.evaluate(f, a);
  const [fc] = await Promise.all([pg.waitForEvent('filechooser'), (async () => { await pg.click('.menu-btn:text-is("Audio")'); await pg.click('.menu-item:has(.mi-label:text-is("Choose song…"))'); })()]);
  await fc.setFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wav });
  await pg.waitForFunction(() => easymv.core.state.bridge && !document.querySelector('dialog[open]'));
  await E(() => easymv.core.addScriptDemo('lyrics'));
  await E(() => easymv.shell.showPanel('script'));
  const seek = async (t) => { await E((t) => easymv.core.seek(Math.round(t * easymv.core.state.project.videoFps)), t); await pg.waitForTimeout(900); };
  await seek(19.6); await pg.screenshot({ path: `${out}/lyrics-write.png` });
  for (const tab of ['Timing', 'Look', 'Scenes']) { await pg.click(`.panel-script .sp-tab:has-text("${tab}")`); await pg.waitForTimeout(300); await pg.screenshot({ path: `${out}/lyrics-${tab.toLowerCase()}.png` }); }
  await seek(37.8); await pg.screenshot({ path: `${out}/lyrics-t37.png` });
  await E(() => easymv.core.addScriptDemo('presentation'));
  await seek(6); await pg.screenshot({ path: `${out}/pres.png` });
  await b.close(); srv.close();
});
