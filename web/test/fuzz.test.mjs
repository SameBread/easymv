import test from 'node:test'; import assert from 'node:assert';
import { lintScript, applyFix, suggest } from '../js/lint.js';
import { beatAt, timeAt, snapSeconds, gridLines, detectTempo, tapTempo, parseBarTag } from '../js/tempo.js';
const pieces=['[0:01]','[@3.2]','::fx','::deco','@fx','{','}','**','---','+++','//','\n','\n\n','# ','- ','hello','{fx=wave,amp=2}','::out cut','[1:2:3]','[-5]','::layout','\t','é','::sync beat','[0:05-0:02]'];
let seed=7; const r=()=> (seed=(seed*1664525+1013904223)>>>0)/2**32;
test('lint never throws, fixes never throw, suggest never throws',()=>{
  for(let n=0;n<3000;n++){ let s=''; const k=1+Math.floor(r()*14); for(let i=0;i<k;i++) s+=pieces[Math.floor(r()*pieces.length)]+(r()<.5?' ':'');
    const issues=lintScript(s,{songSec:r()<.5?0:60,tempo:r()<.5?null:{bpm:120,offset:0,sig:4,changes:[]}});
    for(const is of issues){ assert(is.line>=0&&is.from>=0); if(is.fix){ const o=applyFix(s,is); assert.equal(typeof o,'string'); } }
    const lines=s.split('\n'); suggest(lines[0], Math.floor(r()*(lines[0].length+1))); }
});
test('tempo math is a bijection with changes',()=>{
  for(let n=0;n<500;n++){ const tp={bpm:60+r()*140,offset:r()*3-1,sig:2+Math.floor(r()*6),changes:[{t:5+r()*20,bpm:60+r()*140},{t:30+r()*20,bpm:60+r()*140}]};
    const t=r()*60-3; assert(Math.abs(timeAt(beatAt(t,tp),tp)-t)<1e-6,'roundtrip');
    const s=snapSeconds(t,tp,['bar','1/4','1/8','1/16T'][n%4]); assert(Number.isFinite(s));
    assert(gridLines(tp,0,10,'1/16').length<5000); }
  assert.equal(parseBarTag('@0',{bpm:120,offset:0,sig:4,changes:[]})!==null,true);
});
test('detect finds synthetic click tracks',()=>{
  for(const bpm of [80,100,120,128,140,150]){ const rate=200,len=40*rate,on=new Float32Array(len); const per=60/bpm*rate; for(let b=0;b*per<len;b++){const i=Math.round(0.3*rate+b*per); for(let j=0;j<6&&i+j<len;j++) on[i+j]=1-j/6;}
    const d=detectTempo(on,rate); assert(d,`null ${bpm}`); const ok=[1,2,.5].some(m=>Math.abs(d.bpm*m-bpm)<bpm*.015); assert(ok,`bpm ${bpm} got ${d.bpm}`); }
  assert.equal(detectTempo(new Float32Array(10000),200),null);
  assert.equal(tapTempo([1]),null);
});
import { parseScript, compileScript, frameAt } from '../js/kinetic.js';
const measure = (s, f, w, px) => s.length * px * 0.55;
test('compile + frames never throw or give NaN on garbage scripts',()=>{
  const extra=['::fx wave','::deco box','{sync=beat}','[@2.1]','::out 9','::trans zoom','::next 3','::tempo 90','[0:00-0:00]','[0:03]','::layout stack','::enter 2'];
  for(let n=0;n<400;n++){ let s=''; const k=1+Math.floor(r()*14); for(let i=0;i<k;i++) s+=(r()<.3?extra[Math.floor(r()*extra.length)]:pieces[Math.floor(r()*pieces.length)])+(r()<.5?' ':'');
    let c; try{ c=compileScript(parseScript(s),{W:1280,H:720,measure}); }catch(e){ assert.fail(`compile threw on ${JSON.stringify(s)}: ${e.message}`); }
    for(const t of [0,1,2.5,7,29,31]){ let f; try{ f=frameAt(c,t); }catch(e){ assert.fail(`frameAt(${t}) threw on ${JSON.stringify(s)}: ${e.stack.split('\n').slice(0,3).join(' | ')}`); }
      const bad=(o,p='')=>{ if(typeof o==='number') return Number.isFinite(o)?null:p; if(o&&typeof o==='object') for(const k in o){ const b=bad(o[k],p+'.'+k); if(b) return b; } return null; }; const b=bad(f); assert(!b,`non-finite ${b} at t=${t} in ${JSON.stringify(s)}`); }
  }
});
