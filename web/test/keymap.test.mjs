import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCombo, eventCombo, buildMap, conflictFor, comboOf, ACTIONS } from '../js/keymap.js';

test('normalize', () => {
  assert.equal(normalizeCombo('shift+ctrl+z'), 'Ctrl+Shift+Z');
  assert.equal(normalizeCombo('cmd+s'), 'Ctrl+S');
  assert.equal(normalizeCombo('left'), 'ArrowLeft');
  assert.equal(normalizeCombo(''), '');
});
test('event combos', () => {
  assert.equal(eventCombo({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z');
  assert.equal(eventCombo({ key: ' ', code: 'Space' }), 'Space');
  assert.equal(eventCombo({ key: 'Shift', shiftKey: true }), '');
});
test('defaults have no duplicate combos', () => {
  const seen = new Set();
  for (const a of ACTIONS) { const c = normalizeCombo(a.key); assert.ok(!seen.has(c), `${a.id} duplicates ${c}`); seen.add(c); }
});
test('overrides, disabling and conflicts', () => {
  const m = buildMap({ play: 'K', tap: '' });
  assert.equal(m.get('K'), 'play'); assert.ok(!m.has('Space')); assert.ok(![...m.values()].includes('tap'));
  assert.equal(conflictFor('tap', 'V')?.id, 'toolSelect');
  assert.equal(comboOf('play', { play: 'k' }), 'K');
});
