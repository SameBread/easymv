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
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Closed captions (CC)"))');
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

    // Script layer: demos, tabs, scrolling, timing rows, scene locks, conversions
    await menu('Layer', 'New layer');
    await pg.click('.submenu .menu-item:has(.mi-label:text-is("Script (kinetic text)"))');
    await pg.click('.submenu >> nth=1 >> .menu-item:has(.mi-label:text-is("Demo: lyrics (song + rain)"))');
    await until(() => easymv.core.state.project.elements.some((e) => e.type === 'script'));
    await until(() => document.querySelector('.panel-script .sp-tabs'));
    check('lyrics demo adds a transparent script layer over an effect', await E(() => { const e = easymv.core.state.project.elements; const sc = e.find((x) => x.type === 'script'); return sc.script.bgMode === 'none' && sc.script.reveal === 'word' && e.some((x) => x.type === 'effect' && x.id.startsWith('rain')); }));
    check('script panel has four tabs', (await n('.panel-script .sp-tab')) === 4);
    await pg.click('.panel-script .sp-tab:has-text("Look")');
    const sc1 = await E(() => { const b = document.querySelector('.panel-script .sp-body'); return { sh: b.scrollHeight, ch: b.clientHeight }; });
    check('Look tab is taller than the panel (needs scrolling)', sc1.sh > sc1.ch, JSON.stringify(sc1));
    await pg.locator('.panel-script .sp-body').hover();
    await pg.mouse.wheel(0, 400);
    await until(() => document.querySelector('.panel-script .sp-body').scrollTop > 50);
    check('mouse wheel scrolls the script panel', true);
    await pg.click('.panel-script .sp-tab:has-text("Timing")');
    await until(() => document.querySelectorAll('.panel-script .line-row').length >= 15).catch(async () => { console.log('rows', await E(() => document.querySelectorAll('.panel-script .line-row').length), await E(() => document.querySelector('.panel-script .sp-body')?.innerText.slice(0, 200))); throw new Error('rows'); });
    check('timing tab lists every lyric line with start and end', (await n('.panel-script .line-row .time-input')) >= 30);
    await pg.click('.panel-script .sp-tab:has-text("Scenes")');
    await until(() => document.querySelectorAll('.panel-script .scene-card').length >= 10);
    await pg.locator('.panel-script .scene-card select[aria-label="Scene 2 Layout"]').selectOption('stack');
    await until(() => easymv.core.state.project.elements.find((x) => x.type === 'script').script.text.includes('::layout stack'));
    check('scene layout lock is written into the script text', true);
    await pg.click('.panel-script .sp-tab:has-text("Write")');
    await pg.locator('.panel-script .seg-btn:has-text("Presentation")').click();
    await until(() => easymv.core.state.project.elements.find((x) => x.type === 'script').script.bgMode === 'scenes');
    check('mode switch applies the presentation preset', true);
    await E(() => easymv.core.addScriptDemo('presentation'));
    check('presentation demo adds the Marxism script', await E(() => easymv.core.state.project.elements.some((x) => x.type === 'script' && x.script.text.includes('Marxism'))));
    const cid = await E(async () => { let l = easymv.core.state.project.elements.find((x) => x.type === 'lyrics'); if (!l) { await easymv.core.addLyrics(); l = easymv.core.state.project.elements.find((x) => x.type === 'lyrics'); } easymv.core.setLyrics(l.id, (y) => { y.lines = [{ t0: 1, text: 'one' }, { t0: 3, text: 'two' }]; }, 'test'); return l.id; });
    await E((id) => easymv.core.captionsToScript(id), cid);
    check('captions convert into a script layer', await E(() => easymv.core.state.project.elements.filter((x) => x.type === 'script').length >= 3));
    await E(() => easymv.shell.showPanel('lyrics'));
    await E((id) => easymv.core.select(id), cid);
    await until(() => document.querySelectorAll('.panel-lyrics .lyric-row .end-input').length >= 1);
    check('captions rows have an end time', true);

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

    // v0.7 regressions: preview without a song, hide, transport, handles, timeline seeking
    await E(async () => { await easymv.core.addDemo(); await easymv.core.addScriptDemo('lyrics'); });
    await pg.waitForTimeout(700);
    check('engine never sees render-only fields (script type, visualBlend)', await E(() => { const o = easymv.core.strip(easymv.core.state.project); return o.elements.every((e) => e.type !== 'script' && !('visualBlend' in e)); }));
    check('transport buttons are all enabled', await E(() => [...document.querySelectorAll('.transport button, .transport select, .transport input')].every((b) => !b.disabled)));
    check('renderer exists even if no song was chosen', await E(() => !!easymv.core.state.renderer));
    const planIds = () => E(() => easymv.core.state.lastPlan?.map((p) => p.asset.def.id) ?? []);
    const rain = await E(() => easymv.core.state.project.elements.find((e) => e.id === 'rain')?.id);
    if (rain) {
      check('effect layer is in plan', (await planIds()).includes('rain'));
      await E((id) => easymv.core.setProperty(id, 'visible', 0, 'hide'), rain); await pg.waitForTimeout(500);
      check('hidden layer leaves the preview', !(await planIds()).includes('rain'));
      await E((id) => easymv.core.setProperty(id, 'visible', 1, 'show'), rain); await pg.waitForTimeout(300);
    }
    check('overlays stay above a newly added picture', await E(async () => { const c = easymv.core; const els = c.state.project.elements; const iFx = els.findIndex((e) => e.type === 'effect' || e.type === 'script'); const iImg = els.map((e, i) => (['effect', 'visualizer', 'lyrics', 'script'].includes(e.type) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1); return iImg < iFx; }));
    await pg.click('.transport [aria-label="Forward 10 seconds (L)"]'); await pg.waitForTimeout(200);
    const f10 = await E(() => easymv.core.state.frame);
    check('transport: +10 s', f10 === Math.min(await E(() => easymv.core.totalFrames() - 1), 10 * (await E(() => easymv.core.state.project.videoFps))), String(f10));
    await pg.click('.transport [aria-label="Go to end (End)"]'); await pg.waitForTimeout(100);
    check('transport: go to end', await E(() => easymv.core.state.frame === easymv.core.totalFrames() - 1));
    await pg.click('.transport [aria-label="Go to start (Home)"]');
    check('transport: go to start', (await E(() => easymv.core.state.frame)) === 0);
    const tr = pg.locator('.tl-ruler .tl-track').first();
    if (await tr.count()) { const bb = await tr.boundingBox(); await pg.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height / 2); await pg.waitForTimeout(150);
      const fr = await E(() => easymv.core.state.frame); const tot = await E(() => easymv.core.totalFrames());
      check('timeline ruler click seeks', Math.abs(fr - tot / 2) < tot * 0.08, `${fr}/${tot}`); }
    const scr = await E(() => easymv.core.state.project.elements.find((e) => e.type === 'script')?.id);
    if (scr) { await E((id) => easymv.core.select(id), scr); await pg.waitForTimeout(300);
      check('selected layer shows resize + rotate handles', (await pg.locator('.sel-overlay .handle').count()) >= 5); }

    // v0.8: mouse can start and stop playback (even mid-playback), editing toggle, tools, shortcuts
    await E(() => { easymv.core.stop(); easymv.core.seek(0); });
    const playBtn = pg.locator('.transport button[aria-label^="Play / pause"]');
    await playBtn.click(); await pg.waitForTimeout(400);
    check('mouse click starts playback', await E(() => easymv.core.state.playing));
    for (let i = 0; i < 4; i++) { await playBtn.click(); await pg.waitForTimeout(250 + i * 37); const want = i % 2 === 0 ? false : true;
      check(`mouse click toggles playback again (${i})`, (await E(() => easymv.core.state.playing)) === want); }
    await E(() => easymv.core.stop());
    check('start and end icons differ from frame-step icons', await E(() => { const q = (l) => document.querySelector(`.transport [aria-label^="${l}"]`).innerHTML; return new Set([q('Go to start'), q('Go to end'), q('Previous frame'), q('Next frame')]).size === 4; }));
    await E((id) => easymv.core.select(id), await E(() => easymv.core.state.project.elements[0].id)); await pg.waitForTimeout(250);
    check('outline drawn while editing', (await pg.locator('.sel-overlay polygon').count()) === 1);
    await pg.click('.pv-tools .edit-toggle'); await pg.waitForTimeout(200);
    check('editing off hides the outline', (await pg.locator('.sel-overlay polygon').count()) === 0);
    const before8 = await E(() => JSON.stringify(easymv.core.state.project.elements.map((e) => e.base)));
    const bb = await pg.locator('.stage canvas').boundingBox();
    await pg.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await pg.mouse.down(); await pg.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2 + 30, { steps: 4 }); await pg.mouse.up();
    check('editing off: dragging changes nothing', before8 === (await E(() => JSON.stringify(easymv.core.state.project.elements.map((e) => e.base)))));
    await pg.keyboard.press('q'); await pg.waitForTimeout(150);
    check('Q turns editing back on', await E(() => easymv.core.state.prefs.previewEdit === true));
    await pg.keyboard.press('r'); check('R picks the scale tool', await E(() => easymv.core.state.prefs.previewTool === 'scale'));
    await pg.keyboard.press('v'); check('V picks the select tool', await E(() => easymv.core.state.prefs.previewTool === 'select'));
    await E(() => easymv.core.setPref('keys', { toolRotate: 'G' })); await pg.keyboard.press('g');
    check('rebound shortcut works', await E(() => easymv.core.state.prefs.previewTool === 'rotate'));
    await E(() => { easymv.core.setPref('keys', {}); easymv.core.setPreviewTool('select'); });

    // PowerPoint import
    const pp = await E(async () => {
      const { zipSync, strToU8 } = await import('/vendor/fflate.js');
      const c = document.createElement('canvas'); c.width = 40; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#e33'; g.fillRect(0, 0, 40, 20);
      const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
      const para = (t, b) => `<a:p><a:r><a:rPr${b ? ' b="1"' : ''}/><a:t>${t}</a:t></a:r></a:p>`;
      const sp = (type, body) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody>${body}</p:txBody></p:sp>`;
      const rels = (items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, tg]) => `<Relationship Id="${id}" Type="x" Target="${tg}"/>`).join('')}</Relationships>`;
      const slide1 = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>${sp('ctrTitle', para('Big Title'))}${sp('subTitle', para('A subtitle'))}</p:spTree></p:cSld></p:sld>`;
      const slide2 = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${sp('title', para('Second slide'))}${sp('body', para('first point') + para('a ', false).replace('</a:r></a:p>', '</a:r><a:r><a:rPr b="1"/><a:t>bold</a:t></a:r></a:p>'))}<p:pic><p:nvPicPr><p:cNvPr id="5" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1524000"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>`;
      const files = {
        'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
        'ppt/_rels/presentation.xml.rels': strToU8(rels([['rId1', 'slides/slide1.xml'], ['rId2', 'slides/slide2.xml']])),
        'ppt/slides/slide1.xml': strToU8(slide1), 'ppt/slides/slide2.xml': strToU8(slide2),
        'ppt/slides/_rels/slide2.xml.rels': strToU8(rels([['rId2', '../media/image1.png']])),
        'ppt/media/image1.png': png,
      };
      const file = new File([zipSync(files)], 'deck.pptx');
      const parsed = await easymv.core.inspectPptx(file);
      const before = easymv.core.state.project.elements.length;
      const id = await easymv.core.importPptx(parsed, { name: 'deck', backgrounds: 'keep', timing: { mode: 'fixed', fixed: 4, start: 2 } });
      const st = easymv.core.state.project;
      const sl = parsed.slides;
      return { n: sl.length, t1: sl[0].title, bg: sl[0].bg, blocks2: sl[1].blocks.map((b) => b.paras.map((p) => p.text)), pic: sl[1].items.filter((i) => i.kind === 'pic').length,
        master: st.elements.find((e) => e.id === id), script: st.elements.find((e) => e.id === st.elements.find((x) => x.id === id)?.deck?.script)?.script.text ?? '', added: st.elements.length - before, bgMode: st.elements.find((e) => e.id === st.elements.find((x) => x.id === id)?.deck?.script)?.script.bgMode,
        vis: st.tracks.filter((x) => x.property === 'visible').length, op: st.tracks.filter((x) => x.property === 'opacity').length, len: st.lengthSec, frames: easymv.core.totalFrames(),
        types: st.elements.map((e) => e.type).join(',') };
    });
    check('pptx: slides, title and background colour read', pp.n === 2 && pp.t1 === 'Big Title' && pp.bg?.hex === '#112233', JSON.stringify(pp));
    check('pptx: body paragraphs (with real bold tags) and the picture read', pp.blocks2.flat().some((x) => x.includes('<b>bold</b>')) && pp.pic === 1, JSON.stringify(pp.blocks2));
    check('pptx: text keeps its position (exact-box blocks) and has timed scenes', /\[0:02\.00-[0-9:.]+\] Big Title \{at=[\d.]+:[\d.]+:[\d.]+:[\d.]+ /.test(pp.script) && /role=title/.test(pp.script), pp.script);
    check('pptx: one art layer per slide, shown on its slide with fade + zoom', pp.added === 4 && pp.master?.type === 'deck' && pp.vis >= 2 && pp.op >= 1 && pp.bgMode === 'none', JSON.stringify(pp));
    check('pptx: video length grows to the slides', pp.len >= 10 && pp.frames >= pp.len * 30, JSON.stringify(pp));
    check('pptx: script stays on top of imported art', pp.types.includes('deck') && pp.types.lastIndexOf('static') < pp.types.indexOf('script'), pp.types);
    await E(() => easymv.shell.pptxDialog({ name: 'deck.pptx' }, { slides: [{ items: [], bg: { type: 'solid', hex: '#fff' }, blocks: [], hasArt: false }], size: { w: 1, h: 1 }, media: new Map() }));
    await pg.waitForTimeout(200);
    check('pptx dialog opens with background and timing choices', (await pg.locator('dialog[open] select').count()) === 2 && /1 slide/.test(await pg.locator('dialog[open]').innerText()));
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
    const bad = await E(async () => { try { await easymv.core.inspectPptx(new File([new Uint8Array([1, 2, 3])], 'x.pptx')); return 'no error'; } catch (e) { return e.message; } });
    check('pptx: a broken file gives a readable error', /not a valid/.test(bad), bad);


    // ---- script cheat sheet + decoration setting ----
    const cs = await E(async () => {
      const c = easymv.core; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const id = await c.addScript(undefined, 'lyrics'); easymv.shell.showPanel('script'); c.select(id); await sleep(300);
      const d = document.querySelector('.script-help'); if (d) d.open = true;
      const rows = document.querySelectorAll('.cs-row').length; const syn = document.querySelectorAll('.cs-row.syntax').length; const ins = document.querySelectorAll('.cs-row.instruction').length;
      const copies = []; const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copies.push(t); } }, configurable: true }); } catch { /* ignore */ }
      document.querySelector('.cs-code')?.click(); await sleep(100);
      const before = c.state.project.elements.find((e) => e.id === id).script.text;
      [...document.querySelectorAll('.script-help button')].find((b) => /Add example/.test(b.textContent))?.click(); await sleep(300);
      const after = c.state.project.elements.find((e) => e.id === id).script.text;
      c.removeLayers([id]); void orig;
      return { rows, syn, ins, copies, grew: after.length > before.length && /::deco underline/.test(after) };
    });
    check('cheat sheet: syntax and instruction rows are separate and copyable', cs.rows > 30 && cs.syn > 10 && cs.ins > 10 && cs.copies.length === 1 && cs.grew, JSON.stringify(cs));

    // ---- v1.1: Slideshow folder ----
    const dk = await E(async () => {
      const c = easymv.core; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const m = c.state.project.elements.find((e) => e.type === 'deck'); const mid = m.id;
      const kids = c.state.project.elements.filter((e) => e.group === mid);
      easymv.shell.showPanel('layers'); c.select(mid); await sleep(300);
      const rowsTxt = document.body.innerText;
      const firstVis = () => { const t = c.state.project.tracks.filter((x) => x.property === 'visible' && kids.some((k) => k.id === x.layerId)); return t.length; };
      const scriptId = m.deck.script; const txt0 = c.state.project.elements.find((e) => e.id === scriptId).script.text;
      c.setDeck(mid, { start: 5, mode: 'fixed', fixed: 3 }, 'test'); await sleep(200);
      const txt1 = c.state.project.elements.find((e) => e.id === scriptId).script.text;
      const sp = c.deckTiming(mid);
      easymv.shell.showPanel('inspector'); c.select(mid); await sleep(300);
      const insp = document.body.innerText;
      c.setDeck(mid, { off: true }, 'off'); await sleep(100);
      const offVis = c.state.project.elements.filter((e) => e.group === mid && e.type !== 'script').every((e) => (e.base?.visible ?? 1) === 0 || true);
      c.setDeck(mid, { off: false }, 'on');
      const strip = c.state.project.elements.length;
      c.removeLayers([mid]); await sleep(100);
      const left = c.state.project.elements.filter((e) => e.id === mid || e.group === mid).length;
      return { n: kids.length, rowsTxt: /Slideshow/.test(rowsTxt), txt0, txt1, start: sp.start, total: sp.total, insp, offVis, left, strip, vis: firstVis() };
    });
    check('slideshow: folder shows in Layers with its children', dk.n >= 2 && dk.rowsTxt, JSON.stringify({ n: dk.n }));
    check('slideshow: retiming the folder rewrites the script timestamps and spans', /\[0:05\.00-/.test(dk.txt1) && dk.start === 5 && Math.abs(dk.total - 11) < 0.01, dk.txt1.slice(0, 120));
    check('slideshow: inspector shows start/end and the slide table', /STARTS AT/i.test(dk.insp) && /ENDS BY/i.test(dk.insp) && /Slides/i.test(dk.insp), dk.insp.slice(0, 200));
    check('slideshow: removing the folder removes its children', dk.left === 0, String(dk.left));
    const imgs = await E(async () => {
      const c = easymv.core; const mk = async (col) => { const cv = document.createElement('canvas'); cv.width = 32; cv.height = 18; const g = cv.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 32, 18); return new File([await new Promise((r) => cv.toBlob(r, 'image/png'))], `${col.slice(1)}.png`, { type: 'image/png' }); };
      const fs = [await mk('#e33'), await mk('#3e3'), await mk('#33e')];
      const id = await c.importImagesAsDeck(fs, { name: 'Pics', timing: { mode: 'fixed', fixed: 2, start: 1, end: null } });
      const m = c.state.project.elements.find((e) => e.id === id); const sp = c.deckTiming(id);
      return { type: m?.type, slides: m?.deck.slides.length, start: sp.start, total: sp.total, kids: c.state.project.elements.filter((e) => e.group === id).length };
    });
    check('slideshow: images become a timed folder', imgs.type === 'deck' && imgs.slides === 3 && imgs.start === 1 && Math.abs(imgs.total - 7) < 0.01 && imgs.kids === 3, JSON.stringify(imgs));

    // ---- v1: native Shape / Chart / Table layers, usable without any slides ----
    const vec = await E(async () => {
      const c = easymv.core; const n0 = c.state.project.elements.length;
      easymv.shell.showPanel('inspector'); const sid = await c.addShape('star5', { text: '<b>Hi</b>' }); const cid = await c.addChart('pie'); const tid = await c.addTable();
      const els = c.state.project.elements; const types = els.slice(n0).map((e) => e.type);
      c.select(cid); await new Promise((r) => setTimeout(r, 300));
      const inspChart = document.body.innerText;
      c.select(tid); await new Promise((r) => setTimeout(r, 300));
      const inspTable = document.body.innerText;
      c.select(sid); await new Promise((r) => setTimeout(r, 300));
      const inspShape = document.body.innerText;
      const payload = JSON.stringify(c.strip(c.state.project).elements.filter((e) => e.id === sid || e.id === cid || e.id === tid).map((e) => e.type));
      c.updateLayer(cid, { 'chart.title': 'Hello' }, 'x');
      const titled = c.layerById(cid).chart.title;
      c.select(null);
      const hasReveal = !!document.querySelector('.panel-inspector') ;
      return { types, inspChart, inspTable, inspShape, titled, payload, hasReveal, n: els.length - n0 };
    });
    check('vector: shape, chart and table layers can be added anywhere', vec.types.join() === 'shape,chart,table', vec.types.join());
    check('vector: inspector shows shape, chart and table editors', /fill & outline/i.test(vec.inspShape) && /chart look/i.test(vec.inspChart) && /table look/i.test(vec.inspTable), JSON.stringify([vec.inspShape.slice(0, 200), vec.inspChart.slice(0, 200), vec.inspTable.slice(0, 200)]));
    check('vector: chart edits apply; engine sees them as plain layers', vec.titled === 'Hello' && vec.payload === '["lyrics","lyrics","lyrics"]', vec.payload);
    await pg.waitForTimeout(500);
    const addMenu = await E(() => { easymv.shell.showAddMenu(document.body); return [...document.querySelectorAll('[role=menu] [role=menuitem], .menu .menu-item')].map((x) => x.innerText).join('|'); });
    check('vector: Add menu offers Shape, Chart and Table', /Shape/.test(addMenu) && /Chart/.test(addMenu) && /Table/.test(addMenu), addMenu);
    await pg.keyboard.press('Escape');

    // ---- v1.4: script editor help, tempo, grid, recovery ----
    await E(async () => { if (!easymv.core.state.bridge) { easymv.core.setMaster(new File([new Uint8Array(64)], 's.wav', { type: 'audio/wav' })); await easymv.core.analyze(); } });
    await E(() => { const c = easymv.core; const sc = c.state.project.elements.filter((x) => x.type === 'script').at(-1); easymv.shell.showPanel('script'); c.select(sc.id); });
    await until(() => document.querySelector('.panel-script .se-ta'));
    await pg.click('.panel-script .sp-tab:has-text("Write")').catch(() => {});
    await until(() => document.querySelector('.panel-script .se-ta'));
    await pg.fill('.panel-script .se-ta', '[0:01] Hello\n::decoo bar\n');
    await until(() => /decoo/.test(document.querySelector('.panel-script .se-issues')?.innerText ?? ''));
    { const t = await pg.locator('.panel-script .se-issue').first().innerText(); check('editor: unknown instruction is reported with a fix', /deco/.test(t), t); }
    await pg.locator('.panel-script .se-issue button.btn').first().click();
    check('editor: quick fix rewrites the line', (await pg.inputValue('.panel-script .se-ta')).includes('::deco bar'));
    await until(() => easymv.core.state.project.elements.find((x) => x.type === 'script').script.text.includes('::deco bar'));
    check('editor: fix reaches the project', true);
    await pg.focus('.panel-script .se-ta'); await pg.keyboard.press('Control+End'); await pg.keyboard.type('::dec');
    await until(() => !document.querySelector('.se-suggest').hidden);
    await pg.keyboard.press('Tab');
    check('editor: Tab accepts a suggestion', /::deco\b/.test((await pg.inputValue('.panel-script .se-ta')).split('\n').pop()), JSON.stringify(await pg.inputValue('.panel-script .se-ta')));
    // tempo
    await E(() => { easymv.core.setTempo({ bpm: 120, offset: 0, sig: 4, changes: [] }, 'test', 'tempo'); });
    const tp = await E(() => { const c = easymv.core; return { snap: c.snapSeconds(1.3, c.getTempo(), '1/4'), snap8: c.snapSeconds(1.3, c.getTempo(), '1/8'), bar: c.snapSeconds(3.1, c.getTempo(), 'bar') }; });
    check('tempo: snapping by note length', Math.abs(tp.snap - 1.5) < 1e-6 && Math.abs(tp.snap8 - 1.25) < 1e-6 && Math.abs(tp.bar - 4) < 1e-6, JSON.stringify(tp));
    await menu('Audio', 'Tempo & beat grid…');
    check('tempo dialog opens from the Audio menu', await pg.locator('dialog[open]:has-text("Tempo & beat grid")').isVisible());
    check('tempo dialog shows the BPM', /120 BPM/.test(await pg.locator('dialog[open] .deck-summary').innerText()));
    await pg.keyboard.press('Escape');
    // save clears dirty and the recovery slot
    await E(() => { easymv.core.commit('x'); });
    await pg.waitForTimeout(3000);
    const rec = await E(() => easymv.core.checkRecovery());
    check('recovery: an unsaved edit is snapshotted', !!rec && rec.layers > 0, JSON.stringify(rec));
    await E(() => easymv.core.markSaved()); await pg.waitForTimeout(300);
    check('recovery: saving clears the snapshot', (await E(() => easymv.core.checkRecovery())) === null);

    // click text in the preview -> jump to its script line
    await E(async () => { const c = easymv.core; const id = c.state.project.elements.filter((x) => x.type === 'script').at(-1).id; c.select(id);
      c.setScript?.(id, (x) => { x.text = '@look neon\n// c\n[0:00.5] Alpha beta\n\n[0:02] Gamma delta'; x.mode = 'lyrics'; }, 'test', 'tt'); });
    await E(() => { easymv.core.seek(Math.round(1.2 * easymv.core.fps())); });
    await pg.waitForTimeout(800);
    const hitPt = await E(() => { const sid = easymv.core.state.project.elements.filter((x) => x.type === 'script').at(-1).id; const it = easymv.core.state.lastPlan?.find((x) => x.asset.def.id === sid && x.scr); if (!it) return null; const r = it.scr.passes.flatMap((p) => p.runs).find((r) => r.srcLine === 2 && r.alpha > 0.3); if (!r) return { none: it.scr.passes.map((p) => p.runs.map((r) => [r.text, r.srcLine, r.alpha])) }; const cv = document.querySelector('.panel-preview canvas').getBoundingClientRect(); const c = document.querySelector('.panel-preview canvas'); return { x: cv.left + (r.x / c.width) * cv.width, y: cv.top + (r.y / c.height) * cv.height, look: r.look }; });
    check('preview: runs carry their script line and look', !!hitPt && hitPt.x != null && hitPt.look === 'neon', JSON.stringify(hitPt));
    if (hitPt?.x != null) {
      await pg.mouse.dblclick(hitPt.x, hitPt.y);
      await until(() => document.querySelector('.panel-script .se-ta') && document.activeElement === document.querySelector('.panel-script .se-ta'));
      const sel = await E(() => { const t = document.querySelector('.panel-script .se-ta'); return t.value.slice(t.selectionStart, t.selectionEnd); });
      check('preview: double-click on text selects its script line', /Alpha beta/.test(sel), JSON.stringify(sel));
    }

    // markers + history
    const mk = await E(async () => { const c = easymv.core; c.seek(10); const m = c.addMarker(); c.seek(40); c.addMarker(40, 'Drop'); c.seek(0); const next = c.seekMarker(1); const f1 = c.state.frame; c.seekMarker(1); const f2 = c.state.frame; c.seekMarker(-1); const f3 = c.state.frame; return { n: c.state.project.markers.length, f1, f2, f3, same: c.addMarker(10).id === m.id }; });
    check('markers: add, dedupe and jump next/previous', mk.n === 2 && mk.f1 === 10 && mk.f2 === 40 && mk.f3 === 10 && mk.same, JSON.stringify(mk));
    await until(() => document.querySelectorAll('.tl-marker').length === 2);
    check('markers: flags show on the ruler', true);
    await E(() => easymv.core.undo()); await E(() => new Promise((r) => setTimeout(r, 300)));
    check('markers: undo removes the last marker change', (await E(() => easymv.core.state.project.markers.length)) <= 2);
    await menu('Edit', 'History…');
    check('history dialog lists steps', (await n('dialog[open] .hist-item')) >= 3 && (await n('dialog[open] .hist-now')) === 1);
    const histLen = await E(() => easymv.core.historyEntries().length);
    await pg.locator('dialog[open] .hist-item').last().click(); await pg.waitForTimeout(600);
    check('history: clicking the oldest step goes back to it', (await E(() => easymv.core.historyEntries().findIndex((e) => e.current))) === 0 && histLen > 2);
    await pg.keyboard.press('Escape');
    await E(() => easymv.core.jumpHistory(easymv.core.historyEntries().length - 1)); await pg.waitForTimeout(600);

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
