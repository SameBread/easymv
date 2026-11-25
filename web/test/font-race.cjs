// Regression: text measured before its font finished loading is spaced by a stand-in font. It must not be cached.
const { chromium } = require('playwright'); const http=require('http'),fs=require('fs'),path=require('path');
const web='/home/claude/easymv/web';
const srv=http.createServer((q,s)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=u.startsWith('/pkg/')?path.join(web,'test/mock-pkg',u.slice(5)):path.join(web,u==='/'?'index.html':u);fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end();return}s.writeHead(200,{'content-type':/\.m?js$/.test(f)?'text/javascript':/\.css$/.test(f)?'text/css':'text/html'});s.end(d)})}).listen(0,async()=>{
const b=await chromium.launch();const pg=await b.newPage();
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`).catch(()=>{});
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);await pg.waitForFunction(()=>window.easymv&&!document.getElementById('boot'));
const r=await pg.evaluate(async()=>{
 const sm=await import('/js/script.js'); const fm=await import('/js/fonts.js');
 const def={script:{text:'@pack smooth\n[0:01] Every dull memories',pack:'smooth'}};
 const w=(c)=>{const f=c.scenes.length?require:0;return 0;};
 const width=(c)=>{const fr=(window.__kin||null);return null;};
 const kin=await import('/js/kinetic.js');
 const get=(c)=>kin.frameAt(c,3).passes[0].runs.map(r=>Math.round(r.w)).join(',');
 const early=sm.compileFor(def,1280,720,60); const eW=get(early);
 const early2=sm.compileFor(def,1280,720,60);
 await Promise.all(sm.scriptFonts(def).map(f=>fm.loadBundled(fm.migrateFont(f))));
 const late=sm.compileFor(def,1280,720,60);
 return {eW, lateW:get(late), cachedEarly: early===early2, fresh: late!==early};
});
console.log(JSON.stringify(r)); if (r.cachedEarly || !r.fresh || r.eW === r.lateW) { console.error('FAIL font race: text measured before its font loaded was kept'); process.exit(1); } console.log('PASS measured-too-early text is not cached');await b.close();srv.close();});
