// Inspector sections for the native Shape, Chart and Table layers.

import * as core from '../../core.js';
import { h, icon, numField, selectField, colorField, toggle } from '../dom.js';
import { fontField } from '../fontpicker.js';
import { SHAPE_GROUPS, shapeLabel, CHART_TYPES, CHART_PALETTE, parseDelimited, chartFromRows, rowsFromChart, normChart } from '../../vector.js';
import { vectorSettings, SHAPE_DEFAULTS } from '../../vectorlayer.js';

const rows2text = (rows) => rows.map((r) => r.map((c) => (typeof c === 'object' && c ? (c.t ?? '') : String(c ?? ''))).join('\t')).join('\n');

export function createVectorSections(section) {
  const kind = (def) => ({ shape: 'shape', chart: 'chart', table: 'table' })[def.type];
  const set = (def, patch, label, key) => core.updateLayer(def.id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [`${kind(def)}.${k}`, v])), label, key ?? `edit:${def.id}:${Object.keys(patch).join(',')}`);
  const num = (def, k, label, { min = 0, max = 1, step = 0.01, mul = 1, suffix = '' } = {}) => {
    const s = vectorSettings(def);
    return numField({ label, value: (s[k] ?? 0) * mul, min: min * mul, max: max * mul, step: step * mul, suffix, onChange: (v) => set(def, { [k]: v / mul }, `Edit ${label}`) }).el;
  };
  const sel = (def, k, label, options) => selectField({ label, value: vectorSettings(def)[k] ?? options[0][0], options, onChange: (v) => set(def, { [k]: v }, `Edit ${label}`) }).el;
  const col = (def, k, label) => colorField({ label, value: String(vectorSettings(def)[k] || '#000000').slice(0, 7), onChange: (v) => set(def, { [k]: v }, `Edit ${label}`) }).el;
  const tog = (def, k, label) => toggle({ label, value: !!vectorSettings(def)[k], onChange: (v) => set(def, { [k]: v }, `Edit ${label}`) }).el;
  const font = (def) => fontField({ label: 'Font', value: vectorSettings(def).font || 'Inter', onChange: (v) => set(def, { font: v }, 'Edit font'), toast: core.toast }).el;
  const size = (def) => h('div.row', num(def, 'w', 'Width', { min: 0.02, max: 1.6, step: 0.01, mul: 100, suffix: '%' }), num(def, 'h', 'Height', { min: 0.0, max: 1.6, step: 0.01, mul: 100, suffix: '%' }));
  const text = (def, k, label, rows = 3, ph = '') => {
    const ta = h('textarea.script-text', { rows, spellcheck: false, 'aria-label': label, placeholder: ph, value: vectorSettings(def)[k] ?? '' });
    ta.addEventListener('input', () => set(def, { [k]: ta.value }, `Edit ${label}`));
    return h('label.fld.col', h('span.fld-label', label), ta);
  };
  const styleHint = h('div.note', 'Styles: ', h('b', '**bold**'), ' or <b>…</b>, ', h('i', '<i>italic</i>'), ', ', h('u', '<u>underline</u>'), ', ', h('s', '<s>strike</s>'), '.');

  function shapeSection(def) {
    const s = vectorSettings(def);
    const kinds = SHAPE_GROUPS.flatMap((g) => g.kinds.map((k) => [k, `${g.label}: ${shapeLabel(k)}`]));
    const pick = selectField({ label: 'Shape', value: s.prst, options: kinds, onChange: (v) => set(def, { prst: v, adj: {} }, 'Change shape') }).el;
    const adj = (name, label, d) => numField({ label, value: (s.adj?.[name] ?? d) / 1000, min: 0, max: 100, step: 1, suffix: '', onChange: (v) => set(def, { adj: { ...s.adj, [name]: v * 1000 } }, `Edit ${label}`) }).el;
    const isLine = ['line', 'arc'].includes(s.prst);
    const heads = [['none', 'None'], ['triangle', 'Triangle'], ['arrow', 'Open arrow'], ['stealth', 'Stealth'], ['oval', 'Dot'], ['diamond', 'Diamond']];
    return [
      section('Shape', 'category', pick, size(def),
        h('div.row', adj('adj', 'Adjust 1', 25000), adj('adj1', 'Adjust 2', 25000)),
        h('div.note', 'Adjust changes corner radius, arrow width, star points and similar, depending on the shape.')),
      section('Fill & outline', 'palette',
        isLine ? null : sel(def, 'fillMode', 'Fill', [['solid', 'Solid'], ['gradient', 'Gradient'], ['none', 'None']]),
        isLine ? null : h('div.row', col(def, 'color', 'Colour'), s.fillMode === 'gradient' ? col(def, 'color2', 'Colour 2') : null),
        isLine || s.fillMode !== 'gradient' ? null : num(def, 'angle', 'Angle', { min: 0, max: 360, step: 1, suffix: '°' }),
        isLine ? null : num(def, 'opacity', 'Fill opacity', { min: 0, max: 1, step: 0.01, mul: 100, suffix: '%' }),
        h('div.row', col(def, 'lineColor', 'Outline'), num(def, 'lineW', 'Width', { min: 0, max: 80, step: 1, suffix: 'px' })),
        sel(def, 'dash', 'Dash', [['solid', 'Solid'], ['dash', 'Dashed'], ['sysDot', 'Dotted'], ['lgDash', 'Long dash']]),
        isLine ? h('div.row', sel(def, 'head', 'Start', heads), sel(def, 'tail', 'End', heads)) : null,
        num(def, 'shadow', 'Shadow', { min: 0, max: 1, step: 0.05, mul: 100, suffix: '%' })),
      section('Text in shape', 'title', text(def, 'text', 'Text', 3, 'Type here (or leave empty)'), styleHint,
        h('div.row', col(def, 'textColor', 'Colour'), num(def, 'textSize', 'Size', { min: 0.03, max: 0.8, step: 0.01, mul: 100, suffix: '%' })),
        h('div.row', sel(def, 'align', 'Align', [['l', 'Left'], ['ctr', 'Centre'], ['r', 'Right']]), sel(def, 'anchor', 'Vertical', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])),
        tog(def, 'bold', 'Bold'), font(def)),
      h('div.sect-flat', h('div.note', icon('bolt'), ' The ', h('b', 'Reveal'), ' property below grows the shape in. Key it, or link it to the music.')),
    ];
  }

  function dataEditor(def, kindName) {
    const isChart = kindName === 'chart';
    const s = vectorSettings(def);
    const current = isChart ? rows2text(rowsFromChart(s)) : rows2text(s.data);
    const ta = h('textarea.script-text', { rows: 8, spellcheck: false, 'aria-label': 'Data', value: current, style: { fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre' } });
    const err = h('div.note');
    const apply = () => {
      const rows = parseDelimited(ta.value);
      if (!rows.length) { err.textContent = 'Add at least one row.'; return; }
      err.textContent = '';
      if (isChart) {
        const t = vectorSettings(def).type;
        const f = chartFromRows(rows, { type: t });
        if (!f.series?.length) { err.textContent = 'A chart needs a header row and at least one value column.'; return; }
        const keep = vectorSettings(def).series ?? [];
        f.series.forEach((x, i) => { if (keep[i]?.color) x.color = keep[i].color; });
        set(def, f, 'Edit chart data');
      } else set(def, { data: rows }, 'Edit table data');
    };
    ta.addEventListener('input', apply);
    ta.addEventListener('paste', () => setTimeout(apply, 0));
    return [
      h('label.fld.col', h('span.fld-label', isChart ? 'Data (first row = series names, first column = categories)' : 'Cells (one row per line, tab or comma separated)'), ta), err,
      h('div.note', isChart ? 'Paste straight from a spreadsheet. For a scatter chart the first column is X.' : 'Add {2x1} to the end of a cell to merge it across 2 columns and 1 row. Style text with **bold**, <i>, <u>, <s>.'),
    ];
  }

  function chartSection(def) {
    const s = normChart(vectorSettings(def));
    const title = h('input.text-input', { type: 'text', value: s.title ?? '', 'aria-label': 'Chart title', placeholder: 'Chart title' });
    title.addEventListener('input', () => set(def, { title: title.value }, 'Edit chart title'));
    const pie = s.type === 'pie' || s.type === 'doughnut';
    return [
      section('Chart', 'insert_chart',
        h('label.fld.col', h('span.fld-label', 'Title'), title),
        sel(def, 'type', 'Type', CHART_TYPES),
        ['column', 'bar', 'area'].includes(s.type) ? sel(def, 'grouping', 'Grouping', [['clustered', 'Side by side'], ['stacked', 'Stacked'], ['percent', 'Stacked 100%']]) : null,
        size(def), ...dataEditor(def, 'chart')),
      section('Chart look', 'palette',
        sel(def, 'legend', 'Legend', [['bottom', 'Bottom'], ['right', 'Right'], ['top', 'Top'], ['left', 'Left'], ['none', 'Hidden']]),
        h('div.row', tog(def, 'labels', 'Value labels'), pie ? null : tog(def, 'grid', 'Gridlines')),
        s.type === 'line' || s.type === 'area' ? h('div.row', tog(def, 'smooth', 'Smooth'), s.type === 'line' ? tog(def, 'markers', 'Markers') : null) : null,
        s.type === 'doughnut' ? num(def, 'hole', 'Hole', { min: 0.2, max: 0.85, step: 0.01, mul: 100, suffix: '%' }) : null,
        h('div.row', col(def, 'fg', 'Text'), colorField({ label: 'Background', value: (s.bg || '#000000').slice(0, 7), onChange: (v) => set(def, { bg: v }, 'Edit background') }).el,
          h('button.btn.text', { type: 'button', onclick: () => set(def, { bg: '' }, 'Clear background') }, 'None')),
        num(def, 'size', 'Text size', { min: 0.4, max: 3, step: 0.05, mul: 100, suffix: '%' }), font(def),
        pie ? null : h('div.series-colors', s.series.map((x, i) => colorField({ label: x.name || `Series ${i + 1}`, value: x.color, onChange: (v) => { const ser = normChart(vectorSettings(def)).series.map((q, j) => (j === i ? { ...q, color: v } : q)); set(def, { series: ser }, 'Edit series colour'); } }).el))),
      h('div.sect-flat', h('div.note', icon('bolt'), ' ', h('b', 'Reveal'), ' (below) draws the chart in: bars rise, lines sweep, pies spin open. Key it or link it to the music.')),
    ];
  }

  function tableSection(def) {
    const s = vectorSettings(def);
    return [
      section('Table', 'table_chart', size(def), ...dataEditor(def, 'table'), styleHint,
        h('div.row', tog(def, 'header', 'Header row'), tog(def, 'banded', 'Banded rows'), tog(def, 'firstCol', 'Bold first column'))),
      section('Table look', 'palette',
        h('div.row', col(def, 'accent', 'Header'), col(def, 'fg', 'Text')),
        h('div.row', colorField({ label: 'Cell fill', value: (s.bg || '#000000').slice(0, 7), onChange: (v) => set(def, { bg: v }, 'Edit cell fill') }).el, h('button.btn.text', { type: 'button', onclick: () => set(def, { bg: '' }, 'Clear fill') }, 'None')),
        h('div.row', col(def, 'border', 'Borders'), num(def, 'borderW', 'Line', { min: 0, max: 8, step: 0.5, suffix: 'px' })),
        h('div.row', sel(def, 'valign', 'Vertical', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]), num(def, 'size', 'Text size', { min: 0.4, max: 3, step: 0.05, mul: 100, suffix: '%' })),
        font(def)),
      h('div.sect-flat', h('div.note', icon('bolt'), ' ', h('b', 'Reveal'), ' (below) fades the rows in one after another.')),
    ];
  }
  return { shapeSection, chartSection, tableSection, CHART_PALETTE, SHAPE_DEFAULTS };
}
