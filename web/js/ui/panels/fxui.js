// The Effect section of the inspector. Three tabs, ordered by how often you reach for them:
//   Look    pick the effect (a scrollable box of buttons), then size, colours, area
//   Motion  the steady settings: speed, wind (sideways and up/down), sway
//   Events  the effect script: gusts, bursts, flashes at exact moments, with a graph, quick-add buttons and ready-made scripts

import * as core from '../../core.js';
import { state, layerName } from '../../core.js';
import { h, icon, selectField } from '../dom.js';
import { FX_KINDS, FX_IDS, fxSettings } from '../../effects.js';
import { compileFx, graphFx, FX_TEMPLATES, FX_VERBS } from '../../fxscript.js';
import { clockText } from '../../deck.js';
import { scriptEditor } from '../scripteditor.js';

const tabOf = new Map();       // layer id -> 'look' | 'motion' | 'events' (remembered while you work)

export function createEffectSection({ section, grid, bindNum, bindColor, build, liveRef }) {
  const fmt = (s) => clockText(Math.max(0, s)).replace(/^0:/, '0:');

  function kindBox(def, fx) {
    const box = h('div.fx-box', { role: 'radiogroup', 'aria-label': 'Effect type' });
    for (const id of FX_IDS) {
      box.append(h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(fx.kind === id), class: fx.kind === id ? 'on' : '', title: FX_KINDS[id].label,
        onclick: () => {
          const d = FX_KINDS[id].defaults;
          core.updateLayer(def.id, { 'fx.kind': id, 'fx.area': d.area, 'fx.c1': d.c1, 'fx.c2': d.c2, 'fx.size': d.size, 'fx.count': d.count, 'fx.pixel': d.pixel ?? 0, visualBlend: d.blend,
            name: layerName(def) === FX_KINDS[fx.kind].label ? FX_KINDS[id].label : layerName(def), ...(d.y != null ? { 'base.positionY': d.y } : {}) }, `Effect: ${FX_KINDS[id].label}`);
        } }, icon(FX_KINDS[id].icon), h('span', FX_KINDS[id].label)));
    }
    // keep the chosen one in view when the box is rebuilt
    requestAnimationFrame(() => box.querySelector('.chip.on')?.scrollIntoView({ block: 'nearest' }));
    return h('div.fx-boxwrap', box, h('div.fx-fade'), h('div.note', `${FX_IDS.length} effects. Scroll for more.`));
  }

  function lookTab(def, fx) {
    const fire = fx.kind === 'pixelFire';
    return [
      grid(
        fire ? null : bindNum(def, 'fx.count', { label: 'Particles', step: 5, min: 1, max: 4000, def: fx.count }),
        bindNum(def, 'fx.size', { label: fire ? 'Pixel size' : 'Size', step: 0.5, min: 1, max: 200, def: fx.size }),
        bindNum(def, 'fx.area.0', { label: 'Width', step: 0.01, min: 0.05, max: 2, mul: 100, suffix: '%', def: fx.area[0] }),
        bindNum(def, 'fx.area.1', { label: 'Height', step: 0.01, min: 0.05, max: 2, mul: 100, suffix: '%', def: fx.area[1] }),
        bindNum(def, 'fx.seed', { label: 'Random seed', step: 1, min: 0, max: 9999, def: fx.seed })),
      grid(bindColor(def, 'fx.c1', fire ? 'Hot color' : 'Color A'), bindColor(def, 'fx.c2', fire ? 'Cool color' : 'Color B')),
      fire ? null : grid(bindNum(def, 'fx.pixel', { label: 'Lo-fi pixels', step: 1, min: 0, max: 64, suffix: 'px', def: fx.pixel, title: '0 = smooth. Above 0 snaps particles to a pixel grid and a low frame rate for a retro look.' }),
        fx.pixel > 0 ? bindNum(def, 'fx.fps', { label: 'Lo-fi fps', step: 1, min: 1, max: 60, def: fx.fps }) : null),
    ];
  }

  function motionTab(def, fx) {
    return [
      grid(
        bindNum(def, 'fx.speed', { label: 'Speed', step: 0.01, min: 0, max: 5, mul: 100, suffix: '%', def: fx.speed }),
        bindNum(def, 'fx.wind', { label: 'Wind (sideways)', step: 0.01, min: -2, max: 2, mul: 100, suffix: '%', def: fx.wind, title: 'Negative blows left, positive right.' }),
        bindNum(def, 'fx.windY', { label: 'Wind (up / down)', step: 0.01, min: -2, max: 2, mul: 100, suffix: '%', def: fx.windY, title: 'Negative blows up, positive blows down.' }),
        bindNum(def, 'fx.turb', { label: 'Sway', step: 0.01, min: 0, max: 4, mul: 100, suffix: '%', def: fx.turb, title: 'How much each particle wobbles and drifts on its own.' })),
      h('div.note', 'These are the steady settings. To make wind gust, speed change or bursts happen at exact moments, use the Events tab.'),
    ];
  }

  // ---------- events ----------

  let ed = null;           // the script editor of the layer being shown
  const graphCache = { text: null, tempo: null, c: null };
  const compiled = (text) => {
    const tempo = core.getTempo();
    const k = JSON.stringify(tempo);
    if (graphCache.text !== text || graphCache.tempo !== k) { graphCache.c = compileFx(text, { tempo }); graphCache.text = text; graphCache.tempo = k; }
    return graphCache.c;
  };

  function graph(def) {
    const cv = h('canvas.fx-graph', { width: 640, height: 96, role: 'img', 'aria-label': 'Wind and speed over the song, with your events marked' });
    const draw = () => {
      const fx = fxSettings(def);
      const g = cv.getContext('2d'); const W = cv.width; const H = cv.height;
      const songSec = state.bridge ? core.totalFrames() / state.project.videoFps : 0;
      const c = compiled(fx.script);
      const secs = Math.max(8, songSec || c.endT + 5);
      const style = getComputedStyle(cv);
      const col = (n, d) => style.getPropertyValue(n).trim() || d;
      g.clearRect(0, 0, W, H);
      g.fillStyle = col('--md-surface-container-highest', '#222'); g.fillRect(0, 0, W, H);
      const pts = graphFx(c, { speed: fx.speed, wind: fx.wind, windY: fx.windY }, FX_KINDS[fx.kind].grav, secs, 200);
      const maxW = Math.max(1, ...pts.map((p) => Math.abs(p.wx)));
      const maxS = Math.max(2, ...pts.map((p) => p.speed));
      const mid = H * 0.5;
      g.strokeStyle = col('--md-outline-variant', '#444'); g.lineWidth = 1; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
      // wind: filled around the middle line (right = up)
      g.fillStyle = 'rgba(90,170,255,.45)'; g.beginPath(); g.moveTo(0, mid);
      pts.forEach((p, i) => g.lineTo((i / (pts.length - 1)) * W, mid - (p.wx / maxW) * (H * 0.42)));
      g.lineTo(W, mid); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,170,60,.95)'; g.lineWidth = 1.5; g.beginPath();
      pts.forEach((p, i) => { const y = H - 6 - (p.speed / maxS) * (H - 12); if (i) g.lineTo((i / (pts.length - 1)) * W, y); else g.moveTo(0, y); }); g.stroke();
      for (const e of c.events) {
        const x = (e.t0 / secs) * W; if (x < 0 || x > W) continue;
        g.fillStyle = e.type === 'burst' ? '#ff6b9d' : e.type === 'flash' ? '#ffffff' : e.type === 'tint' ? '#af52de' : e.type === 'pulse' ? '#5ac8fa' : 'rgba(255,255,255,.35)';
        g.fillRect(x - 1, e.type === 'burst' || e.type === 'flash' ? 2 : H - 8, 2, e.type === 'burst' || e.type === 'flash' ? 12 : 6);
      }
      const px = (state.frame / state.project.videoFps / secs) * W;
      g.fillStyle = '#ff4d4d'; g.fillRect(px - 1, 0, 2, H);
    };
    draw();
    liveRef().push({ graph: draw });
    return h('div.fx-graphwrap', cv, h('div.fx-legend', h('span.lg.w', 'wind'), h('span.lg.s', 'speed'), h('span.lg.b', 'burst'), h('span.lg.f', 'flash')));
  }

  const lineAt = (verb) => {
    const t = state.frame / state.project.videoFps;
    const tempo = core.getTempo(); const g = state.prefs.grid;
    const ts = tempo && g && g !== 'off' && g !== 'auto' ? core.snapSeconds(t, tempo, g) : t;
    return `[${fmt(ts)}] ${verb}`;
  };
  const QUICK = [
    ['Gust ←', 'air', 'gust left 1 for 2s'], ['Gust →', 'air', 'gust right 1 for 2s'], ['Gust ↑', 'north', 'gust up 1 for 1.5s'],
    ['Burst', 'celebration', 'burst 80 at 0.5,0.7 up'], ['Flash', 'flash_on', 'flash white'], ['Calm', 'spa', 'calm over 2s'], ['Speed ×2', 'speed', 'speed 2 over 1s'],
  ];

  function eventsTab(def, fx) {
    const setText = (text) => { core.updateLayer(def.id, { 'fx.script': text }, 'Edit effect script', `fxs:${def.id}`); };
    let timer = 0;
    ed = scriptEditor({
      text: fx.script, lang: 'fx', rows: 9, placeholder: '[0:12] gust right 0.8 for 2s\n[0:20] burst 120 at 0.5,0.8 up\n[@17] flash white',
      getContext: () => ({ songSec: state.bridge ? core.totalFrames() / state.project.videoFps : 0, tempo: core.getTempo() }),
      onInput: (v) => { clearTimeout(timer); timer = setTimeout(() => setText(v), 250); },
    });
    const addLine = (rest) => {
      const cur = ed.ta.value.replace(/\s+$/, '');
      const v = `${cur}${cur ? '\n' : ''}${lineAt(rest)}\n`;
      ed.set(v); setText(v);
      ed.ta.focus(); ed.ta.setSelectionRange(v.length, v.length);
    };
    const tpl = selectField({ label: 'Add a ready-made script', value: '', options: [['', 'Choose…'], ...FX_TEMPLATES.map((t) => [t.id, t.name])],
      onChange: (id) => { const t = FX_TEMPLATES.find((x) => x.id === id); if (!t) return; const cur = ed.ta.value.replace(/\s+$/, ''); const v = `${cur}${cur ? '\n\n' : ''}${t.text}\n`; ed.set(v); setText(v); if (id === 'beat' && !core.getTempo()) core.toast('This one follows the beat. Set a tempo in Audio > Tempo & beat grid.', 4000); } }).el;
    const help = h('details.fx-help', h('summary', 'What can I write?'),
      h('div.note', 'One event per line: [time] action words {options}. Times are 0:12.5, or [@17] / [@17.3] for bar 17 / bar 17 beat 3 (needs a tempo). Lines starting with // are notes to yourself.'),
      h('dl.fx-verbs', ...Object.entries(FX_VERBS).flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
      h('div.note', 'Directions: left, right, up, down or 45deg. Lengths: 2s, 500ms, 2 beats, 1 bar, 1/8. Examples: gust right 0.8 for 2s · wind left 0.4 over 3s · burst 120 at 0.5,0.8 up · tint blue 0.5 for 4s · pulse size 0.5 every beat'));
    return [
      h('div.note', `Playhead ${fmt(state.frame / state.project.videoFps)}. These buttons add an event there:`),
      h('div.chips.fx-quick', ...QUICK.map(([label, ic, rest]) => h('button.chip', { type: 'button', title: `Add “${rest}” at the playhead`, onclick: () => addLine(rest) }, icon(ic), h('span', label)))),
      graph(def),
      ed.el, tpl, help,
    ];
  }

  return function effectSection(def) {
    const fx = fxSettings(def);
    const tab = tabOf.get(def.id) ?? 'look';
    const tabs = h('div.fx-tabs', { role: 'tablist' },
      ...[['look', 'Look', 'palette'], ['motion', 'Motion', 'air'], ['events', 'Events', 'timeline']].map(([id, label, ic]) =>
        h('button.fx-tab', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), class: tab === id ? 'on' : '', onclick: () => { tabOf.set(def.id, id); build(); } }, icon(ic), label,
          id === 'events' && fx.script.trim() ? h('span.fx-dot', { title: 'This effect has events' }) : null)));
    const body = tab === 'look' ? lookTab(def, fx) : tab === 'motion' ? motionTab(def, fx) : eventsTab(def, fx);
    return section('Effect', 'auto_awesome', kindBox(def, fx), tabs, h('div.fx-body', body),
      h('div.note', 'Effects are deterministic: the same frame always looks the same, so scrubbing and export match the preview.'));
  };
}

export const fxTabOf = (id) => tabOf.get(id) ?? 'look';
