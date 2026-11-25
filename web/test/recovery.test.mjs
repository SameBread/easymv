import test from 'node:test';
import assert from 'node:assert/strict';
import { hasContent, quiet, FILE_LIMIT } from '../js/autosave.js';
import { PROJECT_VERSION, upgrade } from '../js/projectmodel.js';

test('hasContent', () => {
  assert.equal(hasContent(null), false);
  assert.equal(hasContent({ project: { elements: [], masterMix: { path: '' } } }), false);
  assert.equal(hasContent({ project: { elements: [{}], masterMix: { path: '' } } }), true);
  assert.equal(hasContent({ project: { elements: [], masterMix: { path: 'song.mp3' } } }), true);
});
test('quiet debounces but never starves', async () => {
  let n = 0; const f = quiet(() => { n++; }, 30, 80);
  for (let i = 0; i < 6; i++) { f(); await new Promise((r) => setTimeout(r, 20)); }
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(n >= 1 && n <= 3, `ran ${n} times`);
});
test('file limit is sane and project version is current', () => { assert.ok(FILE_LIMIT > 1e8); assert.equal(PROJECT_VERSION, 6); });

test('upgrade brings a v5 project to v6 and drops dangling folder references', () => {
  const p = { version: 5, elements: [{ id: 'a', group: 'gone' }, { id: 'm', type: 'deck', deck: { script: 'x', slides: [{ art: 'a', objects: ['a', 'nope'] }, { art: 'zzz', objects: [] }] } }] };
  upgrade(p);
  assert.equal(p.version, 6); assert.equal(p.tempo, null); assert.equal(p.elements[0].group, undefined);
  assert.equal(p.elements[1].deck.script, null); assert.deepEqual(p.elements[1].deck.slides[0].objects, ['a']); assert.equal(p.elements[1].deck.slides[1].art, null);
});
test('upgrade normalises tempo and flags newer files', () => {
  const p = upgrade({ version: 6, tempo: { bpm: '128', offset: '0.5' }, elements: [] });
  assert.equal(p.tempo.bpm, 128); assert.equal(p.tempo.sig, 4);
  assert.equal(upgrade({ version: 99, elements: [] })._newer, true);
});
