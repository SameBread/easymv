// The saved project's version and the steps that bring an older file up to date. Pure, so it can be tested.
import { normTempo } from './tempo.js';

/** Bump when the saved model changes, and add a step to upgrade(). v6 adds `tempo`. */
export const PROJECT_VERSION = 6;

/** Fix up a loaded project in place: new fields, and references to layers that no longer exist. */
export function upgrade(p) {
  if ((p.version ?? 1) > PROJECT_VERSION) p._newer = true;       // made by a newer EasyMV: keep everything, warn once
  if ((p.version ?? 1) < 6) { p.tempo ??= null; p.version = 6; }
  p.tempo = p.tempo ? normTempo(p.tempo) : null;
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
