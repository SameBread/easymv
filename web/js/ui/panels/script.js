// Script: type or paste an outline, get automatically laid-out kinetic scenes.
// Edits the selected script layer (or the first one). Present steps through scenes.

import * as core from '../../core.js';
import { state, on, layerById } from '../../core.js';
import { fontField } from '../fontpicker.js';
import { h, icon, clear, numField, selectField, rafThrottle } from '../dom.js';
import { scriptSettings, compileFor } from '../../script.js';
import { PACKS, PACK_IDS, LAYOUT_IDS, TRANSITION_IDS, summarize } from '../../kinetic.js';

export function createScriptPanel(shell) {
  const element = h('div.panel-script');
  let lastSig = '';
  let timer = 0;
  const target = () => {
    const sel = state.selected && layerById(state.selected);
    if (sel?.type === 'script') return sel;
    return state.project.elements.find((e) => e.type === 'script') ?? null;
  };
  const edit = (def, fn, label, key) => core.setScript(def.id, fn, label, key);
  const section = (title, ic, ...body) => h('details.sect', { open: true }, h('summary', icon(ic), h('span', title), icon('expand_more', 'chev')), h('div.sect-body', body));
  const fps = () => state.project.videoFps;

  const compiled = (def) => {
    const [w, h2] = state.project.resolution;
    return compileFor(def, w, h2, core.totalFrames() / fps());
  };

  // ---------- present ----------

  let presenting = null;
  function present() {
    const def = target(); if (!def) return;
    const stage = state.canvas?.closest('.stage') ?? state.canvas?.parentElement; if (!stage) return;
    const scenes = () => compiled(def).scenes;
    const cur = () => { const t = state.frame / fps(); let i = 0; scenes().forEach((s, k) => { if (t >= s.t0 - 0.001) i = k; }); return i; };
    const go = (i) => { const s = scenes()[Math.max(0, Math.min(scenes().length - 1, i))]; if (s) core.seek(Math.round((s.t0 + 0.05) * fps())); };
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(cur() + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur() - 1); }
      else if (e.key === 'Home') go(0);
    };
    const onClick = (e) => { if (e.target.closest('button')) return; go(cur() + 1); };
    const onFs = () => { if (!document.fullscreenElement) end(); };
    const end = () => {
      document.removeEventListener('keydown', onKey, true); stage.removeEventListener('click', onClick);
      document.removeEventListener('fullscreenchange', onFs); presenting = null; stage.classList.remove('presenting');
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
    presenting = end;
    stage.classList.add('presenting');
    document.addEventListener('keydown', onKey, true); stage.addEventListener('click', onClick);
    document.addEventListener('fullscreenchange', onFs);
    go(0);
    stage.requestFullscreen?.().catch(() => core.toast('Full screen was blocked; stepping still works with the arrow keys.'));
    core.toast('Presenting: click, space or arrow keys to step. Esc to exit.');
  }

  // ---------- sections ----------

  function textSection(def, s) {
    const ta = h('textarea.script-text', { rows: 14, spellcheck: false, 'aria-label': 'Script text', value: s.text,
      oninput: () => { clearTimeout(timer); timer = setTimeout(() => edit(def, (x) => { x.text = ta.value; }, 'Edit script', `scr:${def.id}:text`), 250); } });
    ta.value = s.text;
    const help = h('details.script-help', h('summary', 'Syntax'),
      h('pre', '# Title        ## Subtitle\n- bullet       > quote  -- Author\n**word**  emphasis (also CAPS, numbers)\nblank line or ---  = next scene\n[0:12] text   start time\n::dur 4  ::style retro  ::layout stack\n::trans push  ::bg #123456  ::pal 2\n@pack punchy  @energy 0.8  @seed 3'));
    return section('Script', 'lyrics', ta, help,
      h('div.row', h('button.btn.filled', { type: 'button', onclick: present }, icon('play_arrow'), 'Present'),
        h('button.btn.tonal', { type: 'button', title: 'Pick a new random arrangement', onclick: () => edit(def, (x) => { x.seed = 1 + Math.floor(Math.random() * 9999); }, 'Shuffle script') }, icon('refresh'), 'Shuffle')));
  }

  function styleSection(def, s) {
    const set = (k, label) => (v) => edit(def, (x) => { x[k] = v; }, `Script ${label}`, `scr:${def.id}:${k}`);
    const pack = selectField({ label: 'Style', value: s.pack, options: PACK_IDS.map((k) => [k, PACKS[k].label]), onChange: set('pack', 'style') });
    const energy = numField({ label: 'Energy', value: s.energy * 100, min: 0, max: 100, step: 1, suffix: '%', onChange: (v) => set('energy', 'energy')(v / 100) });
    const seed = numField({ label: 'Seed', value: s.seed, min: 1, max: 99999, step: 1, onChange: set('seed', 'seed') });
    const fit = selectField({ label: 'Timing', value: s.fit, options: [['script', 'Reading time per scene'], ['project', 'Stretch to project length']], onChange: set('fit', 'timing') });
    const fh = fontField({ label: 'Heading font', value: s.fontHead || PACKS[s.pack].head, onChange: set('fontHead', 'font'), onLoadFile: (f) => core.addFontFile(f).then((r) => r?.name), toast: core.toast });
    const fb = fontField({ label: 'Body font', value: s.fontBody || PACKS[s.pack].body, onChange: set('fontBody', 'font'), onLoadFile: (f) => core.addFontFile(f).then((r) => r?.name), toast: core.toast });
    return section('Look', 'palette', pack.el, energy.el, seed.el, fit.el, fh.el, fb.el,
      h('div.row', h('button.btn.text', { type: 'button', onclick: () => edit(def, (x) => { x.fontHead = ''; x.fontBody = ''; }, 'Reset fonts') }, icon('refresh'), 'Use style fonts')));
  }

  function scenesSection(def) {
    const c = compiled(def);
    const list = h('div.scene-list', { role: 'list' });
    summarize(c).forEach((s, i) => {
      const lay = h('select.fld-select.sm', { 'aria-label': `Scene ${i + 1} layout`, onchange: (e) => setDir(def, i, 'layout', e.target.value) },
        new Option('auto layout', ''), ...LAYOUT_IDS.map((k) => new Option(k, k, false, false)));
      lay.value = lineDir(def, i, 'layout') ?? '';
      const tr = h('select.fld-select.sm', { 'aria-label': `Scene ${i + 1} transition`, onchange: (e) => setDir(def, i + 1, 'trans', e.target.value) },
        new Option('auto transition', ''), ...TRANSITION_IDS.map((k) => new Option(k, k, false, false)));
      tr.value = lineDir(def, i + 1, 'trans') ?? '';
      if (i + 1 >= c.scenes.length) tr.disabled = true;
      list.append(h('div.scene-row', { role: 'listitem', onclick: (e) => { if (e.target.tagName !== 'SELECT') core.seek(Math.round((s.t0 + 0.05) * fps())); } },
        h('span.row-n', String(i + 1)), h('span.scene-t', `${s.t0.toFixed(1)}s`),
        h('span.scene-info', `${s.layout} · ${s.motion}`), lay, tr));
    });
    return section(`Scenes (${c.scenes.length}, ${c.total.toFixed(1)}s)`, 'timeline', list,
      h('p.muted', 'Auto choices are shown. Pick a layout or transition to lock it for that scene.'));
  }

  // scene directives live in the script text as ::lines (the single source of truth)
  function sceneBlocks(text) {
    const blocks = []; let cur = []; 
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim() || /^-{3,}$/.test(l.trim())) { if (cur.length) blocks.push(cur); cur = []; } else cur.push(l);
    }
    if (cur.length) blocks.push(cur);
    return blocks;
  }
  const isContent = (l) => !/^::|^@/.test(l.trim());
  function lineDir(def, i, key) {
    const b = sceneBlocks(scriptSettings(def).text).filter((bl) => bl.some(isContent))[i]; if (!b) return null;
    const m = b.map((l) => new RegExp(`^::${key}\\s+(\\S+)`).exec(l.trim())).find(Boolean);
    return m ? m[1] : null;
  }
  function setDir(def, i, key, value) {
    edit(def, (x) => {
      const blocks = sceneBlocks(x.text);
      const opt = []; const sc = [];
      for (const b of blocks) (b.every((l) => /^@/.test(l.trim())) ? opt : sc).push(b);
      const b = sc[i]; if (!b) return;
      const idx = b.findIndex((l) => new RegExp(`^::${key}\\b`).test(l.trim()));
      if (idx >= 0) b.splice(idx, 1);
      if (value) b.push(`::${key} ${value}`);
      x.text = [...opt, ...sc].map((bl) => bl.join('\n')).join('\n\n');
    }, `Set scene ${key}`);
  }

  function build() {
    clear(element); lastSig = sig();
    const def = target();
    if (!def) {
      element.append(h('div.empty-note', icon('lyrics'), h('p', 'Turn text into an animated video or presentation. No AI: layout, emphasis and motion are automatic.'),
        h('button.btn.filled', { type: 'button', onclick: () => core.addScript() }, icon('add'), 'Add script layer')));
      return;
    }
    const s = scriptSettings(def);
    element.append(h('div.panel-toolbar', h('span.muted', `Editing “${def.name ?? def.id}”`)), textSection(def, s), styleSection(def, s), scenesSection(def));
  }

  const sig = () => { const d = target(); return d ? JSON.stringify([d.id, d.script, state.project.resolution]) : 'none'; };
  const refresh = rafThrottle(() => {
    if (element.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (sig() !== lastSig) build();
  });
  on('project', refresh); on('selection', refresh);
  build();
  return { element, title: 'Script', present, stopPresent: () => presenting?.() };
}
