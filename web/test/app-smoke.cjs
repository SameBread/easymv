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
  const f = url.startsWith('/pkg/') ? path.join(__dirname, 'mock-pkg', url.slice(5)) : path.join(web, url === '/' ? 'index.html' : url);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : 'text/html' }); s.end(d); });
}).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 860 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  const n = (sel) => pg.locator(sel).count();
  const until = (fn, arg) => pg.waitForFunction(fn, arg, { timeout: 15000 });
  const E = (fn, arg) => pg.evaluate(fn, arg);
  const menu = async (top, item) => { await pg.click(`.menu-btn:text-is("${top}")`); await pg.click(`.menu-item:has(.mi-label:text-is("${item}"))`); };
  const names = () => E(() => easymv.core.state.project.elements.map((e) => e.name ?? e.id));
  try {
    await until(() => window.easymv && document.querySelector('.menubar') && !document.getElementById('boot'));
    check('boots without fatal banner', await pg.locator('.banner.err').isHidden());
    check('menu bar has the nine menus', (await n('.menu-btn')) === 9);
    check('default workspace shows the panels', (await n('.dv-panel-wrap')) >= 4, String(await n('.dv-panel-wrap')));
    check('preview, layers, inspector, timeline exist', (await n('.panel-preview')) === 1 && (await n('.panel-layers')) === 1 && (await n('.panel-inspector')) === 1 && (await n('.panel-timeline')) === 1);

    // Choose a song via the Audio menu, then Quick start
    const [fc] = await Promise.all([pg.waitForEvent('filechooser'), menu('Audio', 'Choose song…')]);
    await fc.setFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wav });
    await until(() => easymv.core.state.bridge && !document.querySelector('dialog[open]'));
    check('song loaded and analyzed', await E(() => !!easymv.core.state.engine));
    await menu('Audio', 'Quick start');
    await until(() => easymv.core.state.project.elements.length === 2 && !document.querySelector('dialog[open]'));
    check('quick start added demo layers', (await n('.layer-row')) === 2, String(await n('.layer-row')));
    check('quick start applied automatic routing', await E(() => easymv.core.state.project.connections.length) === 1);
    await E(() => easymv.core.stop());
    await until(() => easymv.core.state.lastPlan?.length > 0);
    const px = await E(() => { easymv.core.state.renderer && 0; const v = easymv.core.state.canvas; const c = document.createElement('canvas'); c.width = v.width; c.height = v.height; const g = c.getContext('2d'); g.drawImage(v, 0, 0); return Array.from(g.getImageData(10, 10, 1, 1).data); });
    check('preview renders the demo background', px[0] + px[1] + px[2] > 20, JSON.stringify(px));

    check('selection overlay does not cover the preview', await E(() => { const svg = document.querySelector('.stage svg'); const cs = getComputedStyle(svg); return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.pointerEvents === 'none'; }));
    await E(() => easymv.core.seek(1)); await pg.waitForTimeout(800);
    const box = await pg.locator('.stage').boundingBox(); const shot = await pg.screenshot({ clip: box }); fs.writeFileSync('/tmp/shot.png', shot);
    check('preview is visibly painted (centre differs from the corner)', await E(async (b64) => { const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, img.width, img.height).data; const a = [d[0], d[1], d[2]]; const m = ((img.height >> 1) * img.width + (img.width >> 1)) * 4; const b = [d[m], d[m + 1], d[m + 2]]; return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 10; }, shot.toString('base64')));

    // Add a visualizer from the Layer menu
    await menu('Layer', 'New layer');
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Visualizer"))');
    await pg.click('.submenu >> nth=1 >> .menu-item >> nth=2');
    await until(() => easymv.core.state.project.elements.length === 3);
    const vid = await E(() => easymv.core.state.selected);
    check('visualizer layer added and selected', await E(() => easymv.core.layerById(easymv.core.state.selected).type) === 'visualizer');
    await until(() => document.querySelectorAll('.panel-inspector .chip.shape').length >= 7);
    check('inspector shows shape presets for the visualizer', true);
    await pg.click('.panel-inspector .chip.shape[title="Square"]');
    await until(() => easymv.core.layerById(easymv.core.state.selected).vis.shape === 'square');
    check('choosing a shape updates the layer', true);
    await pg.click('.panel-inspector .chip.shape[title="Heart"]');
    await until(() => easymv.core.layerById(easymv.core.state.selected).vis.shape === 'heart');
    check('shape change is undoable', true);
    await pg.keyboard.press('Control+z');
    await until(() => easymv.core.layerById(easymv.core.state.selected).vis.shape === 'square');
    await pg.keyboard.press('Control+Shift+z');
    await until(() => easymv.core.layerById(easymv.core.state.selected).vis.shape === 'heart');
    check('visualizer is drawn into the preview', await E(() => easymv.core.state.lastPlan?.some((i) => i.kind === 'visualizer')));

    // Effects and lyrics
    await menu('Layer', 'New layer');
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Effect"))');
    await pg.click('.submenu >> nth=1 >> .menu-item:has(.mi-label:text-is("Glitter"))');
    await until(() => easymv.core.state.project.elements.length === 4);
    check('glitter effect added with starter sound links', await E(() => easymv.core.state.project.connections.filter((c) => easymv.core.layerById(c.element)?.type === 'effect').length) >= 1);
    check('inspector shows effect kinds', (await n('.panel-inspector .chip')) >= 8);
    await menu('Layer', 'New layer');
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Lyrics"))');
    await until(() => easymv.core.state.project.elements.length === 5);

    // Lyrics panel: add lines, tap one, export LRC
    await E(() => easymv.shell.showPanel('lyrics'));
    await pg.fill('.panel-lyrics textarea.paste', 'first line\nsecond line\nthird line');
    await pg.click('.panel-lyrics button:has-text("Add lines")');
    await until(() => easymv.core.layerById(easymv.core.state.selected).lyrics.lines.length === 3);
    await until(() => document.querySelectorAll('.panel-lyrics .lyric-row').length === 3);
    check('lyrics lines added', true);
    await E(() => easymv.core.seek(12));
    await pg.click('.panel-lyrics .tap-btn');
    await until(() => easymv.core.layerById(easymv.core.state.selected).lyrics.lines[0].t0 != null);
    check('tap stamps the current time', await E(() => Math.abs(easymv.core.layerById(easymv.core.state.selected).lyrics.lines[0].t0 - 12 / easymv.core.state.project.videoFps) < 1e-6));
    await pg.keyboard.press('t'); // keyboard tap too (focus must not be in an input)
    await pg.locator('.panel-preview').click({ position: { x: 5, y: 5 } });
    await pg.keyboard.press('t');
    await until(() => easymv.core.layerById(easymv.core.state.selected).lyrics.lines[1].t0 != null);
    check('T key taps the next line', true);
    await E(() => easymv.core.seek(0));

    // Timeline rows and visibility
    check('timeline has a row per layer', (await n('.panel-timeline .tl-row:not(.tl-ruler):not(.sub)')) === 5, String(await n('.panel-timeline .tl-row:not(.tl-ruler):not(.sub)')));
    await E((id) => { const c = easymv.core; c.setVisibility(id, [[30, 60]]); }, vid);
    await until((id) => document.querySelector(`.panel-timeline .vis-bar[data-id="${id}"]`), vid);
    check('visibility bar appears in the timeline', true);
    await E(() => easymv.core.seek(10));
    await until((id) => !easymv.core.state.lastPlan?.some((i) => i.asset.def.id === id), vid);
    check('hidden layer is not in the render plan', true);
    await E(() => easymv.core.seek(40));
    await until((id) => easymv.core.state.lastPlan?.some((i) => i.asset.def.id === id), vid);
    check('layer reappears inside its visible span', true);
    // drag the bar's right edge in the UI
    await E(() => easymv.shell.showPanel('timeline'));
    await pg.locator(`.vis-bar[data-id="${vid}"]`).scrollIntoViewIfNeeded();
    const grip = await pg.locator(`.vis-bar[data-id="${vid}"] .grip.r`).boundingBox();
    const hit = await pg.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return `${e.className}|${e.dataset.role}`; }, [grip.x + 3, grip.y + 6]);
    await pg.mouse.move(grip.x + 3, grip.y + 6); await pg.mouse.down(); await pg.mouse.move(grip.x + 63, grip.y + 6, { steps: 4 }); await pg.mouse.up();
    check('dragging the bar end extends the span', await E((id) => easymv.core.visibilitySpans(id)[0][1], vid) > 60, JSON.stringify(await E((id) => easymv.core.visibilitySpans(id), vid)) + JSON.stringify(grip) + hit);
    await pg.keyboard.press('Control+z');

    // Inspector: keyframe diamond, track mode, order field
    await E(() => easymv.shell.showPanel('inspector'));
    const first = await E(() => easymv.core.state.project.elements[0].id);
    await pg.locator('.panel-layers .layer-row').last().click(); // bottom row = back layer
    check('clicking a layer selects it', await E((id) => easymv.core.state.selected === id, first));
    const nTracks = () => E(() => easymv.core.state.project.tracks.length);
    const before = await nTracks();
    await pg.locator('.panel-inspector .prop[data-prop="rotation"] .key').click();
    check('diamond adds a keyframe at the playhead', (await nTracks()) === before + 1);
    check('timeline shows the keyframe when expanded', true);
    await pg.locator(`.panel-timeline .tl-row[data-layer="${first}"] .twirl`).click();
    await until(() => document.querySelector('.panel-timeline .tl-row.sub .kf'));
    check('expanding a layer lists its keyframed property', (await n('.panel-timeline .kf')) >= 1);
    await pg.keyboard.press('Control+z');
    check('keyframe is one undo step', (await nTracks()) === before);
    await pg.keyboard.press('Control+Shift+z');

    await until((b4) => easymv.core.state.project.tracks.length === b4 + 1, before);
    await pg.waitForTimeout(400);
    const order = pg.locator('.panel-inspector .num:has(.num-label:text-is("Order")) input');
    await order.fill('5'); await order.press('Enter');
    await until((id) => easymv.core.layerIndex(id) === 4, first);
    check('typing an Order number moves the layer to the front', true);
    await pg.keyboard.press('Control+z');
    await until((id) => easymv.core.layerIndex(id) === 0, first);
    check('order change is undoable', true);

    // Signals panel + link a sound
    await E(() => easymv.shell.showPanel('signals'));
    check('signals panel lists master features', (await n('.panel-signals .feat')) === 6, String(await n('.panel-signals .feat')));
    await E(() => easymv.shell.showPanel('inspector'));
    const nc = await E(() => easymv.core.state.project.connections.length);
    await pg.locator('.panel-inspector .prop[data-prop="rotation"] .link').click();
    await pg.click('.menu-item:has(.mi-label:text-is("Master mix"))');
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Volume"))');
    await until((c) => easymv.core.state.project.connections.length === c + 1, nc);
    check('link menu adds a sound connection', true);
    await until(() => document.querySelectorAll('.panel-inspector .prop[data-prop="rotation"] .sig-chip').length === 1);
    check('connection chip shown on the property', true);
    await pg.locator('.panel-inspector .prop[data-prop="rotation"] .sig-chip').click();
    check('chip expands to the mapping editor with a graph', (await n('.panel-inspector canvas.curve')) === 1);
    // drag-and-drop a signal onto a property
    const nc2 = await E(() => easymv.core.state.project.connections.length);
    await E(() => easymv.shell.showPanel('signals'));
    await E(() => easymv.shell.showPanel('inspector'));
    await E(() => {
      const row = document.querySelector('.panel-inspector .prop[data-prop="positionX"]');
      const dt = new DataTransfer(); dt.setData('application/x-easymv-signal', JSON.stringify({ source: 'master', feature: 'low' }));
      row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await until((c) => easymv.core.state.project.connections.length === c + 1, nc2);
    check('dropping a signal on a property connects it', true);

    // Timeline modes: override vs blend
    await E((id) => { const c = easymv.core; c.setProperty(id, 'rotation', 0.5); if (!c.trackOf(id, 'rotation')) c.toggleKeyAtPlayhead(id, 'rotation'); }, first);
    await E((id) => easymv.core.setTrackMode(id, 'rotation', 'mix', 0.25), first);
    check('track blend mode can be changed', await E((id) => easymv.core.trackOf(id, 'rotation').mode === 'mix', first));

    // Workspaces
    await menu('Window', 'Animate');
    await until(() => document.querySelector('.ws-select').value === 'Animate');
    check('switching workspace keeps all panels', (await n('.panel-timeline')) === 1 && (await n('.panel-inspector')) === 1);
    await menu('Window', 'Save workspace as…');
    await pg.fill('dialog .text-input', 'Test layout');
    await pg.click('dialog button:has-text("Save")');
    check('named workspace is saved to localStorage', await E(() => !!JSON.parse(localStorage.getItem('easymv.workspaces'))['Test layout']));
    await menu('Window', 'Mix');
    await menu('Window', 'Test layout');
    await until(() => document.querySelector('.ws-select').value === 'Test layout');
    check('saved workspace can be restored', (await n('.panel-preview')) === 1);
    await pg.reload();
    await until(() => window.easymv && !document.getElementById('boot'));
    check('last workspace is remembered across reloads', await pg.locator('.ws-select').inputValue() === 'Test layout');

    // Save / load bundle
    await E(() => easymv.core.addDemo());
    await until(() => easymv.core.state.project.elements.length >= 2);
    const count = await E(() => easymv.core.state.project.elements.length);
    const [dl] = await Promise.all([pg.waitForEvent('download'), menu('File', 'Save bundle with media (.zip)')]);
    const bundlePath = path.join(os.tmpdir(), `easymv-test-${Date.now()}.zip`);
    await dl.saveAs(bundlePath);
    check('bundle downloads', fs.statSync(bundlePath).size > 100);
    await E(() => easymv.core.removeLayers([easymv.core.state.project.elements[0].id]));
    const [fc2] = await Promise.all([pg.waitForEvent('filechooser'), menu('File', 'Open project…')]);
    await fc2.setFiles(bundlePath);
    await until((c) => easymv.core.state.project.elements.length === c, count);
    check('bundle reloads layers', true);
    await until(() => !easymv.core.canUndo());
    check('loading a bundle resets undo history', await pg.locator('.topbar .icon-btn[aria-label^="Undo"]').isDisabled());
    fs.unlinkSync(bundlePath);

    // Phone layout
    await pg.setViewportSize({ width: 390, height: 800 });
    await until(() => document.body.classList.contains('phone'));
    check('phone mode shows bottom navigation', await pg.locator('.phone-nav').isVisible() && (await n('.phone-nav .nav-btn')) === 6);
    check('phone preview sits on top', await pg.locator('.phone-stage .panel-preview').isVisible());
    await pg.click('.phone-nav .nav-btn[data-id="timeline"]');
    check('one panel at a time', (await n('.phone-body .panel-timeline')) === 1 && (await n('.phone-body .panel-layers')) === 0);
    const bw = await pg.locator('.phone-nav .nav-btn').first().boundingBox();
    check('touch targets are at least 44px tall', bw.height >= 44, String(bw.height));
    check('no horizontal page overflow on phone', await E(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await pg.click('.phone-nav .nav-btn[data-id="inspector"]');
    await pg.setViewportSize({ width: 1400, height: 860 });
    await until(() => !document.body.classList.contains('phone'));
    check('back to desktop restores the dock', (await n('.dv-panel-wrap')) >= 4, String(await n('.dv-panel-wrap')));

    // Delete key removes the selected layer, undo restores it
    await E(() => easymv.core.select(easymv.core.state.project.elements[0].id));
    const cnt = await E(() => easymv.core.state.project.elements.length);
    await pg.locator('.panel-preview').click({ position: { x: 5, y: 5 } });
    await pg.keyboard.press('Delete');
    await until((c) => easymv.core.state.project.elements.length === c - 1, cnt);
    await pg.keyboard.press('Control+z');
    await until((c) => easymv.core.state.project.elements.length === c, cnt);
    check('delete selected layer, then undo restores it', true);

    // Export dialog opens and mentions size
    await E(async () => { if (!easymv.core.state.bridge) { easymv.core.setMaster(new File([new Uint8Array(64)], 's.wav', { type: 'audio/wav' })); await easymv.core.analyze(); } });
    await until(() => easymv.core.state.bridge);
    await menu('File', 'Export video…');
    check('export dialog opens', await pg.locator('dialog[open]:has-text("Export video")').isVisible());
    await pg.keyboard.press('Escape');
  } catch (e) { check('flow completed', false, e.message.split('\n')[0]); if (process.env.DEBUG) { console.log(await pg.evaluate(() => JSON.stringify({ sel: easymv.core.state.selected, ids: easymv.core.state.project.elements.map((e) => e.id), ord: document.querySelector('.panel-inspector .num:has(.num-label) input')?.value, props: [...document.querySelectorAll('.panel-inspector .prop')].map((p) => p.dataset.prop), insp: document.querySelector('.panel-inspector')?.innerText.slice(0, 300) }))); await pg.screenshot({ path: '/tmp/fail.png' }); } }
  check('no page errors', errors.filter((e) => !/GPU stall|ReadPixels|WebCodecs/.test(e)).length === 0, errors.join(' | '));
  await b.close(); srv.close();
  process.exit(failed ? 1 : 0);
});
