// Drives the real UI in headless Chromium against test/mock-pkg (no WASM build needed).
//   node test/app-smoke.cjs   (needs playwright)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const web = path.join(__dirname, '..');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed++; };

const wav = Buffer.alloc(64); wav.write('RIFF', 0);
const srv = http.createServer((q, s) => {
  const url = decodeURIComponent(q.url.split('?')[0]);
  const f = url.startsWith('/pkg/') ? path.join(__dirname, 'mock-pkg', url.slice(5)) : path.join(web, url);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : 'text/html' }); s.end(d); });
}).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ acceptDownloads: true });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  const n = (sel) => pg.locator(sel).count();
  const until = (fn, arg) => pg.waitForFunction(fn, arg, { timeout: 15000 });
  const undoTitle = () => pg.locator('#undo').getAttribute('title');
  try {
    await pg.waitForTimeout(300);
    check('boots without fatal banner', await pg.locator('#fatal').isHidden());

    // Quick start: demo visuals + analysis + auto mode + playback
    await pg.setInputFiles('#master', { name: 'song.wav', mimeType: 'audio/wav', buffer: wav });
    await pg.click('#quick');
    await until(() => document.querySelectorAll('.el').length === 2 && document.getElementById('analyze').textContent === 'Re-analyze');
    check('quick start added demo elements', (await n('.el')) === 2);
    check('quick start applied automatic routing', (await n('.conn')) === 1);
    check('signal meters shown', (await n('#signals canvas')) === 1 && await pg.locator('#signalsPanel').isVisible());
    const px = await pg.evaluate(() => { const c = document.createElement('canvas'); const v = document.getElementById('view'); c.width = v.width; c.height = v.height; const g = c.getContext('2d'); g.drawImage(v, 0, 0); return Array.from(g.getImageData(10, 10, 1, 1).data); });
    check('preview renders demo background', px[0] + px[1] + px[2] > 20, JSON.stringify(px));
    check('no fatal error after quick start', await pg.locator('#fatal').isHidden(), await pg.locator('#fatal').textContent());
    await pg.click('#play'); // pause
    check('history recorded steps', /Quick start/.test(await undoTitle()), await undoTitle());

    // Undo / redo via keyboard
    await pg.keyboard.press('Control+z');
    await until(() => document.querySelectorAll('.conn').length === 0);
    check('undo removes auto connection', (await n('.el')) === 2);
    await pg.keyboard.press('Control+z');
    await until(() => document.querySelectorAll('.el').length === 0);
    check('undo removes demo elements', true);
    check('undo disabled at start of history', await pg.locator('#undo').isDisabled());
    await pg.keyboard.press('Control+Shift+z');
    await pg.keyboard.press('Control+y');
    await until(() => document.querySelectorAll('.el').length === 2 && document.querySelectorAll('.conn').length === 1);
    check('redo (both shortcuts) restores state', true);
    check('redo disabled at end of history', await pg.locator('#redo').isDisabled());

    // Drag in the preview: select by click, move, one undo step
    const box = await pg.locator('#view').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await pg.mouse.move(cx, cy); await pg.mouse.down();
    for (let i = 1; i <= 8; i++) await pg.mouse.move(cx + i * 6, cy + i * 3);
    await pg.mouse.up();
    check('click selects element under pointer', /demo_orb/.test(await pg.locator('.el.selected h3').textContent()));
    check('drag recorded as a single undo step', /^Undo: Move demo_orb/.test(await undoTitle()), await undoTitle());
    await pg.keyboard.press('Control+z');
    await until(() => /Undo: Quick start/.test(document.getElementById('undo').title));
    check('one undo reverts the entire drag', true);
    await pg.keyboard.press('Control+Shift+z');
    await until(() => /Undo: Move/.test(document.getElementById('undo').title));

    // Scrub to another time: meters + preview follow
    await pg.fill('#scrub', '60');
    await pg.dispatchEvent('#scrub', 'input');
    await until(() => document.getElementById('time').textContent.startsWith('0:02'));
    check('scrubbing updates time readout', true);

    // Preset
    await pg.selectOption('#presetSel', 'bouncy'); await pg.click('#presetApply');
    check('preset adds connections', (await n('.conn')) === 4, String(await n('.conn')));
    await pg.keyboard.press('Control+z');
    await until(() => document.querySelectorAll('.conn').length === 1);
    check('preset is one undo step', true);

    // Frame sequence: thumbnails + reorder dialog
    const dataUrls = await pg.evaluate(() => ['#f00', '#0f0', '#00f'].map((col) => { const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 16, 16); return c.toDataURL('image/png').split(',')[1]; }));
    const { zipSync } = await import(path.join(web, 'vendor/fflate.js'));
    const zip = Buffer.from(zipSync(Object.fromEntries(dataUrls.map((d, i) => [`f_${i + 1}.png`, Buffer.from(d, 'base64')]))));
    await pg.setInputFiles('#addEl', { name: 'anim.zip', mimeType: 'application/zip', buffer: zip });
    await until(() => document.querySelectorAll('.thumbs canvas').length === 3);
    check('sequence thumbnail strip shows first/middle/last', true);
    await pg.click('text=Reorder frames…');
    check('reorder dialog opens with 3 tiles', await pg.locator('#reorder').evaluate((d) => d.open) && (await n('#reorderGrid .tile')) === 3);
    await pg.locator('#reorderGrid .tile').first().locator('button', { hasText: '▶' }).click();
    check('arrow button moves a tile', (await pg.locator('#reorderGrid .tile .lbl').first().textContent()).includes('was 2'));
    await pg.click('#reorderApply');
    await until(() => /Reorder frames of anim/.test(document.getElementById('undo').title));
    check('reorder applied, stored as frameOrder, undoable', /custom order/.test(await pg.locator('#elements').textContent()));
    await pg.keyboard.press('Control+z');
    await until(() => !/custom order/.test(document.getElementById('elements').textContent));
    check('undo reverts reorder', true);
    await pg.keyboard.press('Control+Shift+z');
    await until(() => /custom order/.test(document.getElementById('elements').textContent));

    // Bundle round trip
    const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#saveBundle')]);
    const bundlePath = path.join(os.tmpdir(), `easymv-test-${Date.now()}.zip`);
    await dl.saveAs(bundlePath);
    check('bundle downloads', fs.statSync(bundlePath).size > 100);
    await pg.locator('.el button', { hasText: '✕' }).first().click(); // state now differs from the bundle
    await until(() => document.querySelectorAll('.el').length === 2);
    await pg.setInputFiles('#loadProj', bundlePath);
    await until(() => document.querySelectorAll('.el').length === 3 && document.getElementById('undo').disabled && document.getElementById('analyze').textContent === 'Re-analyze');
    check('bundle reloads elements and re-analyzes without re-selecting files', /custom order/.test(await pg.locator('#elements').textContent()));
    check('loading a bundle resets undo history', await pg.locator('#undo').isDisabled());
    fs.unlinkSync(bundlePath);

    // Remove with Delete key is undoable
    await pg.locator('.el h3').first().click();
    await pg.keyboard.press('Delete');
    await until(() => document.querySelectorAll('.el').length === 2);
    await pg.keyboard.press('Control+z');
    await until(() => document.querySelectorAll('.el').length === 3);
    check('delete selected element, then undo restores it', true);
  } catch (e) { check('flow completed', false, e.message.split('\n')[0]); }
  check('no page errors', errors.filter((e) => !/GPU stall|ReadPixels/.test(e)).length === 0, errors.join(' | '));
  await b.close(); srv.close();
  process.exit(failed ? 1 : 0);
});
