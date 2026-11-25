// The saved project's version and the steps that bring an older file up to date. Pure, so it can be tested.
import { normTempo } from './tempo.js';

/** Bump when the saved model changes, and add a step to upgrade(). v6 adds `tempo`, v7 adds `markers`. */
export const PROJECT_VERSION = 7;

/** Fix up a loaded project in place: new fields, and references to layers that no longer exist. */
export function upgrade(p) {
  if ((p.version ?? 1) > PROJECT_VERSION) p._newer = true;       // made by a newer EasyMV: keep everything, warn once
  if ((p.version ?? 1) < 6) { p.tempo ??= null; p.version = 6; }
  if ((p.version ?? 1) < 7) p.version = 7;
  p.tempo = p.tempo ? normTempo(p.tempo) : null;
  p.markers = (Array.isArray(p.markers) ? p.markers : []).filter((m) => m && Number.isFinite(m.f)).map((m, i) => ({ id: String(m.id ?? `mk${i}`), f: Math.max(0, Math.round(m.f)), name: String(m.name ?? '') })).sort((a, b) => a.f - b.f);
  p.elements ??= [];
  const ids = new Set(p.elements.map((e) => e.id));
  for (const e of p.elements) {
    if (e.group && !ids.has(e.group)) delete e.group;
    if (e.type === 'deck' && e.deck) {
      e.deck.script = ids.has(e.deck.script) ? e.deck.script : null;
      for (const sl of e.deck.slides ?? []) { if (sl.art && !ids.has(sl.art)) sl.art = null; sl.objects = (sl.objects ?? []).filter((x) => ids.has(x)); }
    }
  }
  return p;
}
