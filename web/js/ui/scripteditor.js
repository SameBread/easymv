// The script text box with help built in: colours for each kind of thing you can type, a list of problems with
// one-click fixes, and a suggestion bar that offers instructions, options and values as you type.

import { h, icon } from './dom.js';
import { lintScript, applyFix, suggest } from '../lint.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Per-character classes for one line. */
function classify(line) {
  const cls = new Array(line.length).fill('');
  const mark = (a, b, c) => { for (let i = a; i < Math.min(b, line.length); i++) cls[i] = cls[i] ? `${cls[i]} ${c}` : c; };
  const t = line.trim(); const lead = line.length - line.trimStart().length;
  if (/^\/\//.test(t)) { mark(0, line.length, 'k-comment'); return cls; }
  if (/^(-{3,}|\+{3,})$/.test(t)) { mark(0, line.length, 'k-sep'); return cls; }
  let m;
  if ((m = /^(\s*)(@\w+)(\s*)(.*)$/.exec(line))) { mark(m[1].length, m[1].length + m[2].length, 'k-opt'); mark(m[1].length + m[2].length, line.length, 'k-val'); return cls; }
  if ((m = /^(\s*)(::\w+)(\s*)(.*)$/.exec(line))) { mark(m[1].length, m[1].length + m[2].length, 'k-dir'); mark(m[1].length + m[2].length, line.length, 'k-val'); return cls; }
  let i = lead;
  const tm = /^\s*\[[^\]]*\]\s*/.exec(line); if (tm) { mark(lead, tm[0].trimEnd().length, 'k-time'); i = tm[0].length; }
  const mk = /^(#{1,2}\s+|[-*•]\s+|\d+[.)]\s+|>\s*|--\s*)/.exec(line.slice(i)); if (mk) mark(i, i + mk[0].length, 'k-mark');
  const re = /\*\*[^*]+\*\*|\{[^}]*\}?/g; let x;
  while ((x = re.exec(line))) {
    if (x[0].startsWith('**')) mark(x.index, x.index + x[0].length, 'k-emph');
    else { mark(x.index, x.index + x[0].length, 'k-mods'); const kr = /([a-zA-Z]+)(?==)/g; let y; while ((y = kr.exec(x[0]))) mark(x.index + y.index, x.index + y.index + y[0].length, 'k-key'); }
  }
  return cls;
}

export function scriptEditor({ text, onInput, getContext, toast }) {
  const ta = h('textarea.script-text.se-ta', { rows: 16, spellcheck: false, 'aria-label': 'Script text', autocapitalize: 'off', autocomplete: 'off' });
  ta.value = text;
  const pre = h('pre.se-hl', { 'aria-hidden': 'true' });
  const issuesEl = h('div.se-issues');
  const bar = h('div.se-suggest', { hidden: true, role: 'listbox', 'aria-label': 'Suggestions' });
  let issues = []; let lintTimer = 0;

  function paint() {
    const lines = ta.value.split('\n');
    const byLine = new Map(); for (const i of issues) { if (!byLine.has(i.line)) byLine.set(i.line, []); byLine.get(i.line).push(i); }
    const html = lines.map((ln, n) => {
      const cls = classify(ln);
      for (const is of byLine.get(n) ?? []) for (let k = is.from; k < Math.min(is.to ?? ln.length, ln.length); k++) cls[k] = `${cls[k]} se-${is.severity}`.trim();
      let out = ''; let i = 0;
      while (i < ln.length) { let j = i + 1; while (j < ln.length && cls[j] === cls[i]) j++; out += cls[i] ? `<span class="${cls[i]}">${esc(ln.slice(i, j))}</span>` : esc(ln.slice(i, j)); i = j; }
      return out;
    }).join('\n');
    pre.innerHTML = `${html}\n`;     // trailing newline keeps the last empty line in step with the textarea
    pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft;
  }

  function jump(line, from = 0, to = null) {
    const lines = ta.value.split('\n'); let pos = 0; for (let i = 0; i < line; i++) pos += lines[i].length + 1;
    ta.focus(); ta.setSelectionRange(pos + from, pos + (to ?? lines[line].length));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18; ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
    pre.scrollTop = ta.scrollTop;
  }

  function renderIssues() {
    issuesEl.replaceChildren();
    const real = issues.filter((i) => i.severity !== 'info'); const infos = issues.length - real.length;
    if (!issues.length) { issuesEl.append(h('div.se-ok', icon('done'), 'No problems found.')); return; }
    issuesEl.append(h('div.se-head', `${real.length} problem${real.length === 1 ? '' : 's'}${infos ? ` · ${infos} note${infos === 1 ? '' : 's'}` : ''}`));
    for (const is of issues.slice(0, 30)) {
      issuesEl.append(h('div.se-issue', { class: is.severity },
        h('button.se-go', { type: 'button', title: 'Show this line', onclick: () => jump(is.line, is.from, is.to) }, icon(is.severity === 'error' ? 'warning' : is.severity === 'warn' ? 'warning' : 'lightbulb'), h('span.se-ln', `line ${is.line + 1}`), h('span', is.msg)),
        is.fix ? h('button.btn.tonal.sm', { type: 'button', onclick: () => { ta.value = applyFix(ta.value, is); onInput(ta.value); refresh(); } }, is.fix.label) : null));
    }
    if (issues.length > 30) issuesEl.append(h('div.se-more', `…and ${issues.length - 30} more`));
  }

  function refresh() { issues = lintScript(ta.value, getContext?.() ?? {}); paint(); renderIssues(); }
  function suggestions() {
    const pos = ta.selectionStart; const before = ta.value.slice(0, pos); const ln = before.split('\n').length - 1; const col = pos - (before.lastIndexOf('\n') + 1);
    const line = ta.value.split('\n')[ln] ?? '';
    const s = ta.selectionStart === ta.selectionEnd ? suggest(line, col) : null;
    bar.replaceChildren();
    if (!s || !s.items.length || (s.items.length === 1 && s.items[0].insert === s.replace)) { bar.hidden = true; bar._s = null; return; }
    bar._s = s; bar.hidden = false;
    for (const it of s.items.slice(0, 12)) bar.append(h('button.se-chip', { type: 'button', role: 'option', onmousedown: (e) => e.preventDefault(), onclick: () => accept(it) }, it.label));
    bar.append(h('span.se-tab', 'Tab to accept'));
  }
  function accept(it) {
    const s = bar._s; if (!s) return;
    const pos = ta.selectionStart; const start = pos - s.replace.length;
    ta.setRangeText(it.insert, start, pos, 'end');
    onInput(ta.value); paint(); suggestions(); scheduleLint(); ta.focus();
  }
  const scheduleLint = () => { clearTimeout(lintTimer); lintTimer = setTimeout(refresh, 250); };

  ta.addEventListener('input', () => { paint(); onInput(ta.value); scheduleLint(); suggestions(); });
  ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
  ta.addEventListener('keyup', (e) => { if (!['Tab', 'Enter'].includes(e.key)) suggestions(); });
  ta.addEventListener('click', suggestions);
  ta.addEventListener('blur', () => setTimeout(() => { bar.hidden = true; }, 150));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !bar.hidden && bar._s?.items.length) { e.preventDefault(); accept(bar._s.items[0]); }
    else if (e.key === 'Escape' && !bar.hidden) { bar.hidden = true; }
  });
  new ResizeObserver(() => { pre.style.height = `${ta.clientHeight}px`; }).observe(ta);

  refresh();
  const el = h('div.se', h('div.se-wrap', pre, ta), bar, issuesEl);
  return { el, ta, jump, refresh, set(v) { ta.value = v; refresh(); } };
}
