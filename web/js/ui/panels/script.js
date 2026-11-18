// Script: type an outline, get animated, automatically laid-out scenes. One layer that works as a
// presentation, a lyric video, or captions over a background. Four tabs keep each job small:
//   Write (text + mode), Timing (tap to sync, start/end times), Look (style, background, fonts), Scenes (per-scene locks).
// The script text is the only source of truth: every control rewrites it, so nothing can drift.

import * as core from '../../core.js';
import { state, on, layerById, fmtTimeMs } from '../../core.js';
import { fontField } from '../fontpicker.js';
import { h, icon, clear, numField, selectField, colorField, toggle, rafThrottle, showMenu } from '../dom.js';
import { scriptSettings, compileFor, MODES, applyMode } from '../../script.js';
import { PACKS, PACK_IDS, LAYOUT_IDS, TRANSITION_IDS, summarize } from '../../kinetic.js';
import { listLines, setLineTime, getDir, setDir, sceneRows, scriptToLrc, lrcToScript } from '../../scripttext.js';
import { parseLrc } from '../../lyrics.js';

const TABS = [['write', 'Write', 'edit'], ['timing', 'Timing', 'timeline'], ['look', 'Look', 'palette'], ['scenes', 'Scenes', 'slideshow']];
const MODE_HELP = {
  presentation: 'Full-screen scenes, each with its own animated background. Good for explainers and slides.',
  lyrics: 'Transparent: it sits on top of your background layers. Words appear one by one in the lower third.',
};

export function createScriptPanel(shell) {
  const element = h('div.panel-script');
  let tab = 'write'; let lastSig = ''; let timer = 0;
  let tapIdx = 0; let holdMode = false; let holdLine = null;
  let fontTarget = null; let rowEls = [];

  const target = () => {
    const sel = state.selected && layerById(state.selected);
    if (sel?.type === 'script') return sel;
    return state.project.elements.find((e) => e.type === 'script') ?? null;
  };
  const fps = () => state.project.videoFps;
  const now = () => state.frame / fps();
  const edit = (def, fn, label, key) => core.setScript(def.id, fn, label, key);
  const editText = (def, fn, label, key) => edit(def, (x) => { x.text = fn(x.text); }, label, key);
  const compiled = (def) => { const [w, h2] = state.project.resolution; return compileFor(def, w, h2, core.totalFrames() / fps()); };
  const parseTime = (s) => { const m = /^\s*(?:(\d+):)?(\d+(?:[.,]\d+)?)\s*$/.exec(s); return m ? Number(m[1] ?? 0) * 60 + Number(m[2].replace(',', '.')) : null; };

  // ---------- small widgets ----------

  const seg = (options, value, onChange, label) => h('div.seg', { role: 'radiogroup', 'aria-label': label },
    options.map(([v, text, title]) => h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', title, onclick: () => onChange(v) }, text)));
  const card = (title, ic, ...body) => h('section.sp-card', h('h3', icon(ic), title), ...body);
  const note = (text) => h('p.sp-note', text);

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

  // ---------- tap to sync ----------

  function tap() {
    const def = target(); if (!def) return;
    const t = now(); const k = tapIdx;
    const lines = listLines(scriptSettings(def).text);
    if (k >= lines.length) return;
    holdLine = k;
    editText(def, (txt) => {
      let out = setLineTime(txt, k, { t, t1: null });
      const prev = lines[k - 1];
      if (prev && prev.t1 != null && prev.t1 > t) out = setLineTime(out, k - 1, { t1: null });
      return out;
    }, 'Tap script line', `tap:${def.id}`);
    tapIdx = Math.min(lines.length, k + 1);
    if (!holdMode) holdLine = null;
  }
  function holdEnd() {
    const def = target(); const k = holdLine; holdLine = null;
    if (!def || k == null) return;
    const t = now();
    const ln = listLines(scriptSettings(def).text)[k];
    if (ln && ln.t != null && t > ln.t + 0.15) editText(def, (txt) => setLineTime(txt, k, { t1: t }), 'Set line length', `hold:${def.id}`);
  }

  // ---------- tabs ----------

  function writeTab(def, s) {
    const ta = h('textarea.script-text', { rows: 16, spellcheck: false, 'aria-label': 'Script text',
      oninput: () => { clearTimeout(timer); timer = setTimeout(() => edit(def, (x) => { x.text = ta.value; }, 'Edit script', `scr:${def.id}:text`), 250); } });
    ta.value = s.text;
    const lrcIn = h('input', { type: 'file', accept: '.lrc,.txt,text/plain', hidden: true, onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const txt = await f.text();
      if (!parseLrc(txt).length) { core.toast('No timed lines found in that file. Plain text can be pasted into the box instead.'); return; }
      edit(def, (x) => { x.text = lrcToScript(txt); applyMode(x, 'lyrics'); }, 'Import LRC'); tapIdx = 0;
      core.toast('Imported. Style set to "Lyrics over a background"; change it in the Look tab.');
    } });
    return [
      card('What are you making?', 'auto_fix_high',
        seg(Object.entries(MODES).map(([k, m]) => [k, m.label.split(' / ')[0].replace(' over a background', '')]), s.mode, (v) => edit(def, (x) => applyMode(x, v), `Script mode: ${MODES[v].label}`), 'Mode'),
        note(MODE_HELP[s.mode])),
      card('Script', 'edit', ta,
        h('div.row',
          h('button.btn.tonal', { type: 'button', onclick: () => lrcIn.click() }, icon('file_upload'), 'Import LRC'),
          h('button.btn.text', { type: 'button', disabled: !listLines(s.text).some((l) => l.t != null), onclick: () => core.download(new Blob([scriptToLrc(s.text)], { type: 'text/plain' }), `${def.id}.lrc`) }, icon('file_download'), 'Export LRC'),
          h('button.btn.text', { type: 'button', title: 'Make a closed-captions layer with the same lines', onclick: async () => { const id = await core.scriptToCaptions(def.id); if (id) { core.toast('Captions layer created.'); shell.showPanel('lyrics'); } } }, icon('closed_caption'), 'To captions')),
        lrcIn,
        h('details.script-help', h('summary', 'Syntax cheat sheet'),
          h('pre', '# Title       ## Subtitle\n- bullet      > quote   -- author\n**word**     emphasise (CAPS and numbers too)\nblank line or ---   next scene\n[0:12.5] line         starts at 12.5 s\n[0:12.5-0:15] line    starts and ends\n::dur 4  ::layout stack  ::trans push\n::reveal word  ::style retro  ::bg #123456'))),
    ];
  }

  function timingTab(def, s) {
    const lines = listLines(s.text);
    const next = lines[tapIdx];
    const tapBtn = h('button.btn.filled.tap-btn', { type: 'button', disabled: !lines.length,
      title: 'Tap on the beat of each line while the song plays. Shortcut: T', 'aria-keyshortcuts': 'T',
      onclick: (e) => { if (!holdMode || e.detail === 0) tap(); },
      onpointerdown: () => { if (holdMode) tap(); }, onpointerup: () => { if (holdMode) holdEnd(); }, onpointercancel: () => { if (holdMode) holdEnd(); } },
    icon('bolt'), holdMode ? 'Hold while line shows' : 'Tap next line');
    const rows = h('div.line-grid', { role: 'list' });
    rowEls = [];
    h2head(rows);
    lines.forEach((l, i) => {
      const start = h('input.time-input', { value: l.t == null ? '' : fmtTimeMs(l.t), placeholder: '--:--', 'aria-label': `Line ${i + 1} start`,
        onchange: (e) => { const v = e.target.value.trim() === '' ? null : parseTime(e.target.value); editText(def, (t) => setLineTime(t, i, { t: v, ...(v == null ? { t1: null } : {}) }), 'Set line start'); } });
      const end = h('input.time-input', { value: l.t1 == null ? '' : fmtTimeMs(l.t1), placeholder: 'auto', title: 'When it disappears. Empty = when the next scene starts.', 'aria-label': `Line ${i + 1} end`,
        onchange: (e) => { const v = e.target.value.trim() === '' ? null : parseTime(e.target.value); editText(def, (t) => setLineTime(t, i, { t1: v }), 'Set line end'); } });
      const row = h('div.line-row', { role: 'listitem', class: `${i === tapIdx ? 'next' : ''}`,
        onclick: (e) => { if (e.target.tagName === 'INPUT' || e.target.closest('button')) return; tapIdx = i; if (l.t != null) core.seek(Math.round(l.t * fps())); build(); } },
      h('span.row-n', String(i + 1)), start, end, h('span.line-text', { title: l.text }, l.text),
      h('button.icon-btn.sm', { type: 'button', title: 'Clear times', 'aria-label': 'Clear times', onclick: () => editText(def, (t) => setLineTime(t, i, { t: null, t1: null }), 'Clear line time') }, icon('close')));
      rowEls.push({ el: row, l });
      rows.append(row);
    });
    return [
      card('Tap along to the song', 'bolt',
        h('div.tap-bar', tapBtn, h('span.grow'),
          h('button.btn.text.sm', { type: 'button', onclick: () => { tapIdx = 0; build(); } }, icon('refresh'), 'Restart')),
        h('div.row', toggle({ label: 'Hold to set length', value: holdMode, title: 'Press and hold the tap button for as long as the line should stay on screen. Releasing sets its end time.', onChange: (v) => { holdMode = v; build(); } }).el),
        note(next ? `Next: “${next.text.slice(0, 40)}${next.text.length > 40 ? '…' : ''}”.  Press play in the preview, then tap each line as it begins (or press T).` : lines.length ? 'Every line has been tapped. Click a row to re-tap it.' : 'Add some lines in the Write tab first.')),
      card(`Lines (${lines.length})`, 'timeline', lines.length ? rows : note('No lines yet.'),
        h('div.row', h('button.btn.text', { type: 'button', disabled: !lines.length, onclick: () => editText(def, (t) => { let out = t; let at = now(); lines.forEach((_, i) => { out = setLineTime(out, i, { t: at }); at += 3; }); return out; }, 'Space lines evenly'), title: 'Put every line 3 seconds apart, starting at the playhead' }, icon('timeline'), 'Space evenly from playhead'),
          h('button.btn.text', { type: 'button', disabled: !lines.some((l) => l.t != null || l.t1 != null), onclick: () => editText(def, (t) => { let out = t; lines.forEach((_, i) => { out = setLineTime(out, i, { t: null, t1: null }); }); return out; }, 'Clear all times') }, icon('delete'), 'Clear all times')),
        note('Lines without a time use reading time. Set an end to make a line disappear before the next one starts.')),
    ];
  }
  function h2head(rows) { rows.append(h('div.line-head', h('span'), h('span', 'Start'), h('span', 'End'), h('span', 'Line'), h('span'))); }

  function lookTab(def, s) {
    const set = (k, label) => (v) => edit(def, (x) => { x[k] = v; }, `Script ${label}`, `scr:${def.id}:${k}`);
    const fileIn = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true, onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const r = await core.addFontFile(f); if (!r) return;
      edit(def, (x) => { x.fontFiles = { ...x.fontFiles, [r.name]: r.path }; if (fontTarget === 'head') x.fontHead = r.name; else if (fontTarget === 'body') x.fontBody = r.name; else { x.fontHead = r.name; x.fontBody = r.name; } }, 'Use custom font');
    } });
    const fontF = (which, label, val) => fontField({ label, value: val, toast: core.toast, onLoadFile: () => { fontTarget = which; fileIn.click(); },
      onChange: (v) => edit(def, (x) => { x[which === 'head' ? 'fontHead' : 'fontBody'] = v; }, 'Script font') }).el;
    const customColor = (key, label, fallback) => h('div.row.color-row', colorField({ label, value: s[key] || fallback, onChange: (v) => set(key, label)(v) }).el,
      h('button.btn.text.sm', { type: 'button', disabled: !s[key], onclick: () => set(key, label)('') }, 'Auto'));
    return [
      card('Style', 'palette',
        selectField({ label: 'Style', value: s.pack, options: PACK_IDS.map((k) => [k, PACKS[k].label]), onChange: set('pack', 'style') }).el,
        numField({ label: 'Energy', value: s.energy * 100, min: 0, max: 100, step: 1, suffix: '%', title: 'Calm to punchy: speed, bounce and how loud the layouts are', onChange: (v) => set('energy', 'energy')(v / 100) }).el,
        h('div.row', numField({ label: 'Seed', value: s.seed, min: 1, max: 99999, step: 1, onChange: set('seed', 'seed') }).el,
          h('button.btn.tonal', { type: 'button', title: 'Pick a new random arrangement', onclick: () => set('seed', 'shuffle')(1 + Math.floor(Math.random() * 9999)) }, icon('refresh'), 'Shuffle'))),
      card('Background', 'layers',
        seg([['scenes', 'Animated', 'Each scene draws its own background'], ['solid', 'Solid', 'One colour'], ['none', 'None', 'Transparent: text only, over the layers below']], s.bgMode, set('bgMode', 'background'), 'Background'),
        s.bgMode === 'solid' ? colorField({ label: 'Colour', value: s.bgColor, onChange: (v) => set('bgColor', 'colour')(v) }).el : null,
        s.bgMode === 'none' ? note('Transparent. Put image, effect or visualizer layers underneath, and keep this layer on top in the Layers panel.') : null),
      card('Text', 'text_fields',
        selectField({ label: 'Appear', value: s.reveal, options: [['auto', 'Springy, quick stagger'], ['word', 'Word by word across the line'], ['line', 'Whole line at once']], onChange: set('reveal', 'reveal') }).el,
        selectField({ label: 'Position', value: s.place, options: [['full', 'Full screen'], ['lower', 'Lower third'], ['middle', 'Middle band'], ['upper', 'Upper third']], onChange: set('place', 'position') }).el,
        selectField({ label: 'Layouts', value: s.layouts, options: [['all', 'All (varied, dynamic)'], ['calm', 'Calm (centre, left, diagonal)']], onChange: set('layouts', 'layouts') }).el,
        numField({ label: 'Shadow', value: s.shadow * 100, min: 0, max: 100, step: 5, suffix: '%', title: 'Soft dark shadow behind the text, for busy backgrounds', onChange: (v) => set('shadow', 'shadow')(v / 100) }).el,
        customColor('fg', 'Text colour', '#ffffff'), customColor('accent', 'Accent', '#ff3d71'),
        selectField({ label: 'Timing', value: s.fit, options: [['script', 'From the text (times or reading speed)'], ['project', 'Stretch to project length']], onChange: set('fit', 'timing') }).el),
      card('Fonts', 'text_fields', fontF('head', 'Heading font', s.fontHead || PACKS[s.pack].head), fontF('body', 'Text font', s.fontBody || PACKS[s.pack].body),
        h('div.row',
          h('button.btn.text', { type: 'button', onclick: () => edit(def, (x) => { x.fontBody = x.fontHead || PACKS[x.pack].head; x.fontHead = x.fontBody; }, 'One font for both') }, 'Use heading font for both'),
          h('button.btn.text', { type: 'button', onclick: () => { fontTarget = 'both'; fileIn.click(); } }, icon('upload_file'), 'Load font file…'),
          h('button.btn.text', { type: 'button', onclick: () => edit(def, (x) => { x.fontHead = ''; x.fontBody = ''; }, 'Reset fonts') }, 'Style fonts')), fileIn),
    ];
  }

  function scenesTab(def, s) {
    const c = compiled(def);
    const sum = summarize(c); const rows = sceneRows(s.text);
    const list = h('div.scene-cards', { role: 'list' });
    sum.forEach((sc, i) => {
      const dir = (key) => getDir(s.text, i, key) ?? '';
      const sel = (key, label, ids, auto) => {
        const el = h('select.fld-select', { 'aria-label': `Scene ${i + 1} ${label}`, onchange: (e) => editText(def, (t) => setDir(t, i, key, e.target.value), `Set scene ${label}`) },
          new Option(auto, ''), ...ids.map((k) => new Option(k, k)));
        el.value = dir(key);
        return h('label.sc-sel', h('span', label), el);
      };
      list.append(h('div.scene-card', { role: 'listitem', onclick: (e) => { if (e.target.tagName !== 'SELECT') core.seek(Math.round((sc.t0 + 0.05) * fps())); } },
        h('div.sc-head', h('span.row-n', String(i + 1)), h('span.sc-time', `${fmtTimeMs(sc.t0)}`), h('span.sc-auto', `${sc.layout} · ${sc.motion}${sc.trans && i + 1 < sum.length ? ` · → ${sc.trans}` : ''}`)),
        h('div.sc-text', rows[i]?.text ?? ''),
        h('div.sc-opts', sel('layout', 'Layout', LAYOUT_IDS, `auto (${sc.layout})`), i > 0 ? sel('trans', 'Comes in with', TRANSITION_IDS, 'auto') : null, sel('reveal', 'Appear', ['auto', 'word', 'line'], 'default'))));
    });
    return [card(`Scenes (${sum.length}, ${c.total.toFixed(1)}s)`, 'slideshow', list, note('Everything shows what the engine picked automatically. Choose a value to lock it for that scene; “auto” gives it back.'))];
  }

  // ---------- build ----------

  function build() {
    clear(element); lastSig = sig();
    const def = target();
    if (!def) {
      element.append(h('div.empty-note', icon('slideshow'), h('p', 'Turn text into animated scenes: presentations, lyric videos or captions. No AI: layout, emphasis and motion are automatic.'),
        h('button.btn.filled', { type: 'button', onclick: () => core.addScript(undefined, 'presentation') }, icon('slideshow'), 'New presentation'),
        h('button.btn.tonal', { type: 'button', onclick: () => core.addScript(undefined, 'lyrics') }, icon('lyrics'), 'New lyrics'),
        h('div.row', h('button.btn.text', { type: 'button', onclick: () => core.addScriptDemo('presentation') }, icon('auto_fix_high'), 'Demo: presentation'),
          h('button.btn.text', { type: 'button', onclick: () => core.addScriptDemo('lyrics') }, icon('auto_fix_high'), 'Demo: lyrics'))));
      return;
    }
    const s = scriptSettings(def);
    const menu = (e) => showMenu(e.currentTarget, [
      { label: 'Convert to closed captions', icon: 'closed_caption', run: async () => { const id = await core.scriptToCaptions(def.id); if (id) shell.showPanel('lyrics'); } },
      { label: 'Duplicate layer', icon: 'content_copy', run: () => core.duplicateLayer(def.id) },
    ]);
    element.append(
      h('div.sp-head', h('span.sp-title', icon('slideshow'), h('b', def.name ?? def.id)),
        h('button.btn.filled.sm', { type: 'button', onclick: present, title: 'Full screen, step with click or arrow keys' }, icon('play_arrow'), 'Present'),
        h('button.icon-btn', { type: 'button', title: 'More', 'aria-label': 'More', onclick: menu }, icon('more_vert'))),
      h('div.sp-tabs', { role: 'tablist' }, TABS.map(([id, label, ic]) => h('button.sp-tab', { type: 'button', role: 'tab', 'aria-selected': String(id === tab), class: id === tab ? 'on' : '', onclick: () => { tab = id; build(); } }, icon(ic), h('span', label)))));
    const body = h('div.sp-body', { role: 'tabpanel' }, ...({ write: writeTab, timing: timingTab, look: lookTab, scenes: scenesTab }[tab])(def, s));
    element.append(body);
    markNow();
  }

  function markNow() {
    if (tab !== 'timing') return;
    const t = now(); let cur = -1;
    rowEls.forEach((r, i) => { if (r.l.t != null && t >= r.l.t) cur = i; });
    rowEls.forEach((r, i) => r.el.classList.toggle('now', i === cur));
  }

  const sig = () => { const d = target(); return d ? JSON.stringify([d.id, d.name, d.script, state.project.resolution, tab, tapIdx, holdMode]) : 'none'; };
  const refresh = rafThrottle(() => {
    if (element.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (sig() !== lastSig) build();
  });
  on('project', refresh); on('selection', refresh);
  on('frame', rafThrottle(markNow));
  build();
  return { element, title: 'Script', present, tap, stopPresent: () => presenting?.() };
}
