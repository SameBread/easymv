// Signals: the sounds in the project and what each one drives. Drag a feature onto a
// property in the Inspector (or onto a layer row) to connect it.

import * as core from '../../core.js';
import { state, on, sources, layerById, layerName } from '../../core.js';
import { h, icon, iconBtn, clear, rafThrottle, showMenu } from '../dom.js';
import { FEATURES, FEATURE_LABELS, PROP_BY_NAME } from '../../props.js';
import { valueAtFrame } from '../../meters.js';

export function createSignalsPanel(shell) {
  const element = h('div.panel-signals');
  const open = new Set(['master']);
  let meters = [];
  let lastSig = '';

  const usage = (src, feature) =>
    state.project.connections.filter((c) => c.source === src && c.feature === feature && !c.muted)
      .map((c) => ({ c, def: layerById(c.element) })).filter((u) => u.def);

  const sigOf = () => JSON.stringify([sources(), !!state.engine, [...open],
    state.project?.connections.map((c) => [c.element, c.property, c.source, c.feature, !!c.muted])]);

  function featureRow(src, f, fi) {
    const fill = h('span.meter-fill');
    const uses = usage(src, f);
    const row = h('div.feat', { draggable: 'true', title: `Drag onto a property to link ${FEATURE_LABELS[f]}`,
      ondragstart: (e) => {
        e.dataTransfer.setData('application/x-easymv-signal', JSON.stringify({ source: src, feature: f }));
        e.dataTransfer.effectAllowed = 'copy';
      } },
    icon('drag_indicator', 'grip'), h('span.feat-name', FEATURE_LABELS[f]), h('span.meter.wide', fill),
    h('span.uses', uses.slice(0, 3).map(({ c, def }) =>
      h('button.use-tag', { type: 'button', title: `${layerName(def)} · ${PROP_BY_NAME[c.property]?.label ?? c.property}`,
        onclick: () => { core.select(def.id); shell.showPanel('inspector'); } }, `${layerName(def)}·${PROP_BY_NAME[c.property]?.label ?? c.property}`)),
    uses.length > 3 ? h('span.muted', `+${uses.length - 3}`) : null));
    // tap to link on touch: link to the selected layer's chosen property
    row.addEventListener('dblclick', () => linkToSelected(src, f));
    meters.push({ fill, src, fi });
    return row;
  }

  function linkToSelected(src, f) {
    const def = state.selected && layerById(state.selected);
    if (!def) { core.toast('Select a layer first.'); return; }
    import('../../props.js').then(({ propsFor }) => {
      showMenu({ x: innerWidth / 2 - 90, y: innerHeight / 3 }, [{ header: `Link ${FEATURE_LABELS[f]} to…` },
        ...propsFor(def.type).filter((p) => !p.toggle).map((p) => ({ label: p.label, run: () => { core.addConnection(def.id, p.name, src, f); core.structural(); shell.showPanel('inspector'); } }))]);
    });
  }

  function sourceCard(src) {
    const isMaster = src === 'master';
    const stem = state.stemFiles.find((s) => s.id === src);
    const isOpen = open.has(src);
    const wave = h('canvas.mini-wave', { height: 36, 'aria-label': 'Waveform, click to seek' });
    const head = h('div.src-head',
      h('button.src-toggle', { type: 'button', 'aria-expanded': String(isOpen), onclick: () => { if (open.has(src)) open.delete(src); else open.add(src); build(); } },
        icon(isOpen ? 'expand_less' : 'expand_more'), icon(isMaster ? 'music_note' : 'equalizer'),
        h('span.src-name', isMaster ? (state.masterFile?.name ?? 'Master mix') : src)),
      isMaster ? null : iconBtn('more_vert', 'Stem options', (e) => showMenu(e.currentTarget, [
        { label: 'Rename', icon: 'edit', run: () => { const n = prompt('Name', src); if (n) core.renameStem(src, n); } },
        { label: 'Remove', icon: 'delete', run: () => core.removeStem(src) }], { align: 'end' }), 'sm'));
    const card = h('section.src-card', head);
    if (isMaster && !state.masterFile) {
      card.append(h('div.empty-note', h('p', 'No song loaded.'),
        h('button.btn.filled', { type: 'button', onclick: () => shell.pickAudio() }, icon('music_note'), 'Choose a song…'),
        h('button.btn.tonal', { type: 'button', onclick: () => shell.quickStart() }, icon('auto_fix_high'), 'Quick start')));
      return card;
    }
    if (isOpen) {
      card.append(wave);
      if (state.engine) FEATURES.forEach((f, fi) => card.append(featureRow(src, f, fi)));
      else card.append(h('div.note', 'Analyze the song to see live signals.'),
        h('button.btn.tonal', { type: 'button', onclick: () => core.analyze() }, icon('refresh'), 'Analyze'));
      meters.push({ wave, src });
    }
    return card;
  }

  function build() {
    clear(element); meters = []; lastSig = sigOf();
    const bar = h('div.panel-toolbar',
      h('button.btn.tonal.sm', { type: 'button', onclick: () => shell.pickAudio() }, icon('music_note'), 'Song'),
      h('button.btn.tonal.sm', { type: 'button', title: 'Add separate stems (drums, bass, vocals…) to drive layers individually', onclick: () => stemInput.click() }, icon('add'), 'Stems'),
      h('span.grow'),
      h('button.btn.text.sm', { type: 'button', onclick: (e) => showMenu(e.currentTarget, [
        { header: 'Automatic links (image layers)' },
        { label: 'Run Automatic mode', icon: 'auto_fix_high', run: () => { core.runAuto(); core.toast('Automatic links added to image layers.'); } },
        { label: 'Preset: Punchy', run: () => core.toast(`${core.applyRoutingPreset('punchy')} links added`) },
        { label: 'Preset: Smooth', run: () => core.toast(`${core.applyRoutingPreset('smooth')} links added`) }], { align: 'end' }) }, icon('auto_fix_high'), 'Auto'));
    element.append(bar);
    for (const s of sources()) element.append(sourceCard(s));
    element.append(h('p.muted.hint', 'Drag a signal onto a property in the Inspector, or double-click it to pick a property for the selected layer.'));
    drawWaves(); refresh();
  }

  const stemInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true,
    onchange: (e) => { core.addStems([...e.target.files]); e.target.value = ''; } });
  element.append(stemInput);

  function drawWaves() {
    for (const m of meters) {
      if (!m.wave) continue;
      const c = m.wave; const w = c.clientWidth || 260; const dpr = devicePixelRatio || 1;
      c.width = Math.round(w * dpr); c.height = Math.round(36 * dpr);
      const g = c.getContext('2d'); g.scale(dpr, dpr);
      const css = getComputedStyle(c);
      const series = state.engine ? core.getSeries(m.src, 0) : null;
      g.fillStyle = css.getPropertyValue('--md-surface-container-highest') || '#333'; g.fillRect(0, 0, w, 36);
      if (series?.length) {
        g.fillStyle = css.getPropertyValue('--md-primary') || '#f69';
        for (let x = 0; x < w; x++) {
          const i = Math.floor((x / w) * series.length);
          const v = series[Math.min(series.length - 1, i)];
          const hh = Math.max(1, v * 34);
          g.fillRect(x, 18 - hh / 2, 1, hh);
        }
      }
      c.onpointerdown = (e) => { const r = c.getBoundingClientRect(); core.seek(Math.round(((e.clientX - r.left) / r.width) * core.totalFrames())); };
    }
  }

  function refresh() {
    if (!state.engine) return;
    const rate = state.engine.analysis_rate(); const fps = state.project.videoFps;
    const total = core.totalFrames();
    for (const m of meters) {
      if (m.fill) m.fill.style.width = `${Math.round(valueAtFrame(core.getSeries(m.src, m.fi), rate, fps, state.frame) * 100)}%`;
      if (m.wave) {
        const c = m.wave; const w = c.clientWidth || 260;
        c.style.setProperty('--ph', `${(state.frame / Math.max(1, total)) * 100}%`);
        void w;
      }
    }
  }

  const structural = rafThrottle(() => { if (sigOf() !== lastSig) build(); else refresh(); });
  on('project', structural); on('engine', structural);
  on('frame', rafThrottle(refresh));
  build();
  return { element, title: 'Signals' };
}
