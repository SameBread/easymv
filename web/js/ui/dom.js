// Small DOM toolkit: element builder, Material icons, dense number fields,
// popup menus and dialogs. No framework.

import { ICONS } from '../icons.js';

/** h('div.class#id', { onclick, style:{}, dataset:{} , ...attrs }, ...children) */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m ? m[1] : tag);
  if (m?.[2]) for (const part of m[2].match(/[.#][\w-]+/g)) { if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k in el && k !== 'list' && k !== 'type' && k !== 'role') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `ic ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] ?? ICONS.help;
  return s;
}

/** Icon button (Material "standard" icon button). */
export function iconBtn(name, title, onclick, cls = '') {
  return h('button.icon-btn', { type: 'button', title, 'aria-label': title, onclick, class: cls }, icon(name));
}

export function btn(label, onclick, { icon: ic, variant = 'text', title, disabled } = {}) {
  return h(`button.btn.${variant}`, { type: 'button', onclick, title, disabled }, ic ? icon(ic) : null, label);
}

export const clear = (el) => { el.replaceChildren(); return el; };

// ---------- number field with drag-to-scrub ----------

/**
 * Dense numeric field. `value`, `min`, `max` and `step` are in UI units (what the user sees).
 * Dragging the label scrubs; the input accepts typing, arrow keys and mouse wheel is ignored
 * (so the panel can scroll). `onChange(value, final)` fires continuously while scrubbing
 * (final=false) and once at the end (final=true).
 */
export function numField({ label, value, min = -Infinity, max = Infinity, step = 1, suffix = '', decimals, onChange, title, width }) {
  const dec = decimals ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const fmt = (v) => `${Number(v.toFixed(dec))}`;
  const input = h('input.num-input', { type: 'text', inputMode: 'decimal', value: fmt(value), 'aria-label': label, title });
  const lab = h('span.num-label', { title: title ?? `Drag to change ${label}` }, label);
  const suf = suffix ? h('span.num-suffix', suffix) : null;
  const el = h('label.num', { style: width ? { width } : null }, lab, input, suf);
  let cur = value;
  const clampv = (v) => Math.min(max, Math.max(min, v));
  const set = (v, fire, final) => { cur = clampv(v); input.value = fmt(cur); if (fire) onChange?.(cur, final); };
  input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (Number.isFinite(v)) set(v, true, true); else input.value = fmt(cur); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(cur + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true, true); }
    if (e.key === 'Enter') input.blur();
  });
  let drag = null;
  lab.addEventListener('pointerdown', (e) => {
    lab.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, v: cur, moved: false };
    el.classList.add('scrubbing');
    e.preventDefault();
  });
  lab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 1) drag.moved = true;
    const speed = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
    set(drag.v + dx * step * 0.5 * speed, true, false);
  });
  const end = () => { if (!drag) return; const moved = drag.moved; drag = null; el.classList.remove('scrubbing'); if (moved) onChange?.(cur, true); };
  lab.addEventListener('pointerup', end);
  lab.addEventListener('pointercancel', end);
  lab.addEventListener('dblclick', () => { input.focus(); input.select(); });
  return { el, input, set: (v) => { if (document.activeElement !== input && !drag) { cur = v; input.value = fmt(v); } } };
}

export function selectField({ label, value, options, onChange, title }) {
  const sel = h('select.fld-select', { 'aria-label': label, title });
  for (const o of options) {
    const [v, text] = Array.isArray(o) ? o : [o, o];
    sel.add(new Option(text, v, false, v === value));
  }
  if (![...sel.options].some((o) => o.value === String(value))) sel.add(new Option(String(value), String(value), true, true));
  sel.value = String(value);
  sel.addEventListener('change', () => onChange?.(sel.value));
  return { el: h('label.fld', h('span.fld-label', label), sel), sel };
}

export function colorField({ label, value, onChange }) {
  const input = h('input.color', { type: 'color', value, 'aria-label': label });
  input.addEventListener('input', () => onChange?.(input.value, false));
  input.addEventListener('change', () => onChange?.(input.value, true));
  return { el: h('label.fld.inline', h('span.fld-label', label), input), input };
}

export function toggle({ label, value, onChange, title }) {
  const cb = h('input', { type: 'checkbox', checked: !!value, role: 'switch' });
  cb.addEventListener('change', () => onChange?.(cb.checked));
  return { el: h('label.switch', { title }, cb, h('span.track', h('span.thumb')), h('span.switch-label', label)), cb };
}

// ---------- popup menus ----------

let openPopup = null;

export function closeMenus() {
  openPopup?.close();
  openPopup = null;
}

/**
 * Show a menu. items: [{ label, icon, shortcut, run, disabled, checked, submenu, separator, header }]
 * Anchor: an element (opens below it) or {x, y}.
 */
export function showMenu(anchor, items, { onClose, align = 'start' } = {}) {
  closeMenus();
  const root = h('div.menu', { role: 'menu', tabIndex: -1 });
  const subs = []; // open submenu per depth
  const closeFrom = (d) => { while (subs.length > d) subs.pop().remove(); };
  const close = () => { closeFrom(0); root.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', close); onClose?.(); };
  const away = (e) => { if (!root.contains(e.target) && !subs.some((x) => x.contains(e.target))) { closeMenus(); } };
  const build = (list, host, depth) => {
    for (const it of list) {
      if (it.separator) { host.append(h('div.menu-sep', { role: 'separator' })); continue; }
      if (it.header) { host.append(h('div.menu-header', it.header)); continue; }
      const row = h('button.menu-item', { type: 'button', role: it.checked != null ? 'menuitemcheckbox' : 'menuitem', disabled: it.disabled, 'aria-checked': it.checked != null ? String(!!it.checked) : null },
        h('span.mi-icon', it.checked ? icon('check') : it.icon ? icon(it.icon) : null),
        h('span.mi-label', it.label),
        it.shortcut ? h('span.mi-key', it.shortcut) : null,
        it.submenu ? icon('chevron_right', 'mi-arrow') : null);
      if (it.submenu) {
        const openSub = () => {
          closeFrom(depth);
          const sm = h('div.menu.submenu', { role: 'menu' });
          subs[depth] = sm;
          build(it.submenu, sm, depth + 1);
          document.body.append(sm);
          const r = row.getBoundingClientRect();
          place(sm, r.right - 4, r.top - 4, r.left + 4);
        };
        row.addEventListener('click', openSub);
        row.addEventListener('pointerenter', () => { if (depth === 0) openSub(); });
      } else {
        row.addEventListener('pointerenter', () => { closeFrom(depth); });
        row.addEventListener('click', () => { closeMenus(); it.run?.(); });
      }
      host.append(row);
    }
  };
  const place = (el, x, y, altX) => {
    el.style.left = '0px'; el.style.top = '0px';
    const w = el.offsetWidth; const hgt = el.offsetHeight;
    let left = x; if (left + w > innerWidth - 4) left = Math.max(4, (altX ?? x) - w);
    let top = y; if (top + hgt > innerHeight - 4) top = Math.max(4, innerHeight - hgt - 4);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  };
  const key = (e) => {
    const els = [...root.querySelectorAll('.menu-item:not([disabled])')];
    const i = els.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'ArrowRight' && i >= 0 && els[i].querySelector('.mi-arrow')) { e.preventDefault(); els[i].click(); subs[0]?.querySelector('.menu-item')?.focus(); }
  };
  build(items, root, 0);
  document.body.append(root);
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    place(root, align === 'end' ? r.right - root.offsetWidth : r.left, r.bottom + 2);
  } else place(root, anchor.x, anchor.y);
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('blur', close);
  openPopup = { close };
  root.querySelector('.menu-item:not([disabled])')?.focus();
  return { close: closeMenus };
}

// ---------- dialogs ----------

/** Modal dialog built on <dialog>. Returns { dlg, close }. */
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const dlg = h('dialog.dlg', { class: wide ? 'wide' : '' },
    h('form', { method: 'dialog' },
      h('header.dlg-head', h('h2', title), iconBtn('close', 'Close', () => dlg.close())),
      h('div.dlg-body', body),
      h('footer.dlg-foot', actions.map((a) => h(`button.btn.${a.variant ?? 'text'}`, { type: 'button', onclick: async () => { const r = await a.run?.(); if (r !== false && !a.keep) dlg.close(); } }, a.label)))));
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('cancel', () => {});
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close: () => dlg.close() };
}

// ---------- toasts ----------

let toastEl = null; let toastTimer = 0;
export function showToast(msg, ms = 2400) {
  toastEl ??= document.body.appendChild(h('div.toast', { role: 'status', 'aria-live': 'polite', hidden: true }));
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/** Run `fn` at most once per animation frame (collapses bursts of events). */
export function rafThrottle(fn) {
  let queued = false;
  return (...args) => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...args); }); };
}
