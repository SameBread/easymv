import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../js/history.js';
import { upgrade, PROJECT_VERSION } from '../js/projectmodel.js';
import { ACTIONS, buildMap } from '../js/keymap.js';

test('history entries list every step and mark the current one', () => {
  const h = new History(); h.reset('a', 'Start'); h.push('b', 'one'); h.push('c', 'two'); h.push('d', 'three');
  assert.deepEqual(h.entries().map((e) => e.label), ['Start', 'one', 'two', 'three']);
  assert.equal(h.entries().findIndex((e) => e.current), 3);
  h.undo(); h.undo();
  const e = h.entries(); assert.equal(e.findIndex((x) => x.current), 1); assert.equal(e.length, 4);
  assert.equal(h.offsetTo(3), 2); assert.equal(h.offsetTo(0), -1);
  for (let i = 0; i < 2; i++) h.redo();
  assert.equal(h.present.state, 'd');
});

test('upgrade adds and cleans markers', () => {
  const p = upgrade({ version: 6, elements: [], markers: [{ id: 'x', f: 50.4, name: 'Drop' }, { f: 'bad' }, null, { id: 'y', f: 10 }] });
  assert.equal(p.version, PROJECT_VERSION);
  assert.deepEqual(p.markers.map((m) => [m.f, m.name]), [[10, ''], [50, 'Drop']]);
  assert.deepEqual(upgrade({ elements: [] }).markers, []);
});

test('new key actions have unique default combos', () => {
  const combos = ACTIONS.map((a) => a.key).filter(Boolean);
  assert.equal(new Set(combos).size, combos.length);
  assert.equal(buildMap().get('Shift+M'), 'marker');
});
