// Add native Shape / Chart / Table layers to an empty project and screenshot the preview (argv[2] = out dir).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const web = path.join(__dirname, '..'); const out = process.argv[2] || '/tmp/vs';
fs.mkdirSync(out, { recursive: true });
const srv = http.createServer((q, s) => { const url = decodeURIComponent(q.url.split('?')[0]);
  const f = url.startsWith('/pkg/') ? path.join(__dirname, 'mock-pkg', url.slice(5)) : path.join(web, url === '/' ? 'index.html' : url);
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : /woff2/.test(f) ? 'font/woff2' : 'text/html' }); s.end(d); }); }).listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
  const errs = [];
  pg.on('pageerror', (e) => { errs.push(e.message); console.log('pageerror', e.message); }); pg.on('console', (m) => { if (m.type() === 'error') { errs.push(m.text()); console.log('console', m.text()); } });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  await pg.waitForFunction(() => window.easymv && !document.getElementById('boot'));
  const scenes = {
    shapes: async (c) => {
      const kinds = ['roundRect', 'ellipse', 'star5', 'heart', 'rightArrow', 'hexagon', 'cloud', 'wedgeRoundRectCallout', 'donut', 'pie', 'can', 'cube', 'smileyFace', 'lightningBolt', 'chevron', 'mathMultiply'];
      let i = 0;
      for (const k of kinds) {
        const id = await c.addShape(k, { w: 0.18, h: 0.2, text: i % 4 === 0 ? '<b>Bold</b> <i>it</i>' : '', fillMode: i % 3 === 0 ? 'gradient' : 'solid', color: ['#4e79a7', '#e15759', '#59a14f', '#edc948'][i % 4], lineW: i % 2 ? 6 : 0, shadow: 0.5 });
        await c.setProperty(id, 'positionX', 0.14 + (i % 4) * 0.24); await c.setProperty(id, 'positionY', 0.16 + Math.floor(i / 4) * 0.23); i++;
      }
      const ln = await c.addShape('line', { w: 0.3 }); await c.setProperty(ln, 'positionX', 0.5); await c.setProperty(ln, 'positionY', 0.96);
    },
    charts: async (c) => {
      const kinds = ['column', 'bar', 'line', 'area', 'pie', 'doughnut'];
      let i = 0;
      for (const k of kinds) { const id = await c.addChart(k, { w: 0.32, h: 0.46, title: k.toUpperCase(), labels: i % 2 === 0, grouping: k === 'column' ? 'stacked' : 'clustered' }); await c.setProperty(id, 'positionX', 0.17 + (i % 3) * 0.33); await c.setProperty(id, 'positionY', 0.27 + Math.floor(i / 3) * 0.5); i++; }
    },
    table: async (c) => {
      const id = await c.addTable([['Quarter {2x1}', '', 'Revenue'], ['Q1', '<b>Strong</b>', '1,200'], ['Q2', '<i>Flat</i>', '<s>900</s> 950'], ['Q3 {1x2}', '<u>Rising</u>', '1,500'], ['', 'Peak', '2,000']], { w: 0.8, h: 0.6 });
      await c.setProperty(id, 'positionX', 0.5); await c.setProperty(id, 'positionY', 0.5);
    },
  };
  for (const [name, fn] of Object.entries(scenes)) {
    await pg.evaluate(`(${scenes[name].toString()})(easymv.core)`);
    await pg.evaluate(() => easymv.core.select(null));
    await pg.waitForTimeout(1500);
    await (await pg.$('.stage canvas')).screenshot({ path: `${out}/${name}.png` });
    await pg.evaluate(async () => { const c = easymv.core; await c.removeLayers(c.state.project.elements.map((e) => e.id)); });
  }
  console.log(errs.length ? 'ERRORS' : 'clean'); await b.close(); srv.close();
});
