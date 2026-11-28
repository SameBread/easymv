// Compiled effect scripts, kept so a frame costs a table lookup and not a re-parse.
// Keyed by the script text and the tempo (bar times and beat lengths depend on it).

import { compileFx, sampleFx } from './fxscript.js';
import { getScriptTempo } from './kinetic.js';

const cache = new Map();

export function compileEffectScript(text) {
  if (!text || !text.trim()) return null;
  const tempo = getScriptTempo();
  const key = `${JSON.stringify(tempo)}\u0000${text}`;
  let c = cache.get(key);
  if (!c) { c = compileFx(text, { tempo }); cache.set(key, c); if (cache.size > 24) cache.delete(cache.keys().next().value); }
  return c;
}

export { sampleFx };
