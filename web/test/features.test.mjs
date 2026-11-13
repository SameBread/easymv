import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../js/history.js';
import { peaksForWidth, valueAtFrame, isSilent } from '../js/meters.js';
import { itemQuad, pointInItem, hitTest, nudgeBase } from '../js/interact.js';
import { applyPreset, primaryElement, PRESETS, demoElementDefs } from '../js/presets.js';
import { packBundle, unpackBundle, referencedPaths, BUNDLE_JSON } from '../js/bundle.js';
import { estimateOutputBytes, avcLevelHex, vp9LevelCode } from '../js/exporter.js';
import { P } from '../js/animation.js';

// ---------- history ----------
test('undo/redo walks states and labels', () => {
  const h = new History(50);
  h.reset('A');
  assert.equal(h.canUndo, false);
  h.push('B', 'make B'); h.push('C', 'make C');
  assert.equal(h.undoLabel, 'make C');
  assert.deepEqual(h.undo(), { state: 'B', label: 'make C' });
  assert.equal(h.redoLabel, 'make C');
  assert.deepEqual(h.undo(), { state: 'A', label: 'make B' });
  assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), { state: 'B', label: 'make B' });
  assert.deepEqual(h.redo(), { state: 'C', label: 'make C' });
  assert.equal(h.redo(), null);
});

test('new edit after undo discards redo branch', () => {
  const h = new History(); h.reset('A');
  h.push('B', 'b'); h.push('C', 'c'); h.undo();
  h.push('D', 'd');
  assert.equal(h.canRedo, false);
  assert.equal(h.undo().state, 'B');
});

test('identical state is not recorded', () => {
  const h = new History(); h.reset('A');
  assert.equal(h.push('A', 'noop'), false);
  assert.equal(h.canUndo, false);
});

test('same-key edits within the window coalesce into one step; outside it they do not', () => {
  let t = 0;
  const h = new History(50, { coalesceMs: 600, now: () => t });
  h.reset('S0');
  h.push('S1', 'Move', 'drag:x'); t = 100;
  h.push('S2', 'Move', 'drag:x'); t = 200;
  h.push('S3', 'Move', 'drag:x');
  assert.equal(h.undo().state, 'S0'); // whole drag undone in one go
  assert.equal(h.canUndo, false);
  assert.equal(h.redo().state, 'S3');
  t = 5000; h.push('S4', 'Move', 'drag:x');
  assert.equal(h.undo().state, 'S3'); // far apart => separate step
});

test('different keys never coalesce; history limit drops oldest', () => {
  let t = 0;
  const h = new History(3, { now: () => t });
  h.reset('0');
  h.push('1', 'a', 'k1'); h.push('2', 'b', 'k2'); h.push('3', 'c'); h.push('4', 'd'); h.push('5', 'e');
  let n = 0; while (h.undo()) n++;
  assert.equal(n, 3);
});

// ---------- meters ----------
test('peaks keep transients; valueAtFrame matches engine pooling', () => {
  const s = new Float32Array(200); s[3] = 1;
  const peaks = peaksForWidth(s, 20);
  assert.equal(peaks[0], 1); assert.equal(peaks[1], 0);
  assert.equal(valueAtFrame(s, 200, 30, 0), 1); // window [0,6)
  assert.equal(valueAtFrame(s, 200, 30, 1), 0);
  assert.equal(valueAtFrame(new Float32Array(0), 200, 30, 5), 0);
  assert.equal(valueAtFrame(new Float32Array(100).fill(0.5), 100, 240, 100), 0.5); // fps > rate
  assert.ok(isSilent(new Float32Array(5)) && !isSilent(s));
});

// ---------- interaction ----------
const item = (def, props, w = 100, h = 50) => ({ asset: { def, width: w, height: h }, props: Float32Array.from(props) });
const base = () => [0.5, 0.5, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0.5, 0.5];

test('hit test: inside/outside, rotation, scale, z-order, invisible skipped', () => {
  const def = { id: 'a', type: 'spriteSheet' }; // natural fit
  const it = item(def, base());
  assert.ok(pointInItem(it, 500, 500, 1000, 1000));
  assert.ok(pointInItem(it, 549, 524, 1000, 1000));
  assert.ok(!pointInItem(it, 551, 500, 1000, 1000));
  const rot = item(def, base()); rot[0]; rot.props[P.rotation] = Math.PI / 2; // 100x50 rotated => 50 wide, 100 tall
  assert.ok(pointInItem(rot, 500, 549, 1000, 1000));
  assert.ok(!pointInItem(rot, 549, 500, 1000, 1000));
  const big = item(def, base()); big.props[P.scale] = 3;
  assert.ok(pointInItem(big, 640, 500, 1000, 1000));
  const top = item({ id: 'top', type: 'spriteSheet' }, base());
  const hidden = item({ id: 'hid', type: 'spriteSheet' }, base()); hidden.props[P.opacity] = 0;
  assert.equal(hitTest([it, top], 500, 500, 1000, 1000), top);
  assert.equal(hitTest([it, hidden], 500, 500, 1000, 1000), it);
  assert.equal(hitTest([it], 10, 10, 1000, 1000), null);
});

test('itemQuad corners for unrotated centred element', () => {
  const q = itemQuad(item({ id: 'a', type: 'spriteSheet' }, base()), 1000, 1000);
  assert.deepEqual(q.map(([x, y]) => [Math.round(x), Math.round(y)]), [[450, 475], [550, 475], [550, 525], [450, 525]]);
});

test('nudgeBase moves and scales with clamps', () => {
  const d = {};
  nudgeBase(d, 0.1, -0.2);
  assert.ok(Math.abs(d.base.positionX - 0.6) < 1e-9 && Math.abs(d.base.positionY - 0.3) < 1e-9);
  nudgeBase(d, 10, 10); assert.equal(d.base.positionX, 2);
  nudgeBase(d, 0, 0, 2); assert.equal(d.base.scaleX, 2); assert.equal(d.base.scaleY, 2);
  nudgeBase(d, 0, 0, 1e-9); assert.equal(d.base.scaleX, 0.01);
});

// ---------- presets ----------
const proj = (stems = []) => ({
  stems: stems.map((id) => ({ id })),
  elements: [{ id: 'bg', zIndex: -1 }, { id: 'hero', zIndex: 2 }, { id: 'other', zIndex: 2 }],
  connections: [],
});

test('primary element: highest non-negative z, first on tie', () => {
  assert.equal(primaryElement(proj()).id, 'hero');
  assert.equal(primaryElement({ elements: [{ id: 'bg', zIndex: -1 }] }), null);
});

test('every preset targets valid properties; drums stem used when present', () => {
  const props = ['positionX', 'positionY', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity', 'hueShift', 'saturation', 'brightness', 'contrast', 'blur'];
  for (const k of Object.keys(PRESETS)) {
    const p = proj(['drums']);
    assert.ok(applyPreset(p, k) > 0, k);
    for (const c of p.connections) { assert.ok(props.includes(c.property)); assert.equal(c.origin, 'user'); }
  }
  const p = proj(['drums']); applyPreset(p, 'punchy');
  assert.ok(p.connections.some((c) => c.source === 'drums'));
  const q = proj(); applyPreset(q, 'punchy');
  assert.ok(q.connections.every((c) => c.source === 'master'));
});

test('presets never create a second replace on the same target', () => {
  const p = proj();
  p.connections.push({ element: 'bg', property: 'blur', combine: 'replace' });
  applyPreset(p, 'dreamy');
  assert.equal(p.connections.filter((c) => c.combine === 'replace' && c.element === 'bg' && c.property === 'blur').length, 1);
});

test('demo defs get unique ids', () => {
  const ids = new Set(['demo_orb']);
  const defs = demoElementDefs(ids);
  assert.equal(defs[1].id, 'demo_orb_2'); assert.equal(defs[0].zIndex, -1);
});

// ---------- bundle ----------
test('bundle round-trips project and files byte-for-byte', async () => {
  const project = {
    version: 4, masterMix: { path: 'song.wav' }, stems: [{ id: 'drums', path: 'd.wav' }],
    elements: [{ id: 'a', type: 'static', path: 'a.png' }, { id: 's', type: 'frameSequence', zipPath: 'f.zip' }],
    connections: [],
  };
  const files = new Map([
    ['song.wav', new File([new Uint8Array([1, 2, 3, 4])], 'song.wav')],
    ['d.wav', new File([new Uint8Array([9, 9])], 'd.wav')],
    ['a.png', new File([new Uint8Array([7])], 'a.png')],
    ['f.zip', new File([new Uint8Array([5, 5, 5])], 'f.zip')],
  ]);
  assert.deepEqual(referencedPaths(project).sort(), ['a.png', 'd.wav', 'f.zip', 'song.wav']);
  const { blob, missing } = await packBundle(project, files);
  assert.deepEqual(missing, []);
  const out = await unpackBundle(blob);
  assert.deepEqual(out.project, project);
  assert.deepEqual([...new Uint8Array(await out.files.get('song.wav').arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(await out.files.get('f.zip').arrayBuffer())], [5, 5, 5]);
});

test('bundle reports missing files and rejects non-bundles', async () => {
  const project = { masterMix: { path: 'm.wav' }, stems: [], elements: [], connections: [] };
  const { missing } = await packBundle(project, new Map());
  assert.deepEqual(missing, ['m.wav']);
  await assert.rejects(unpackBundle(new Blob([new Uint8Array([1, 2, 3])])));
  assert.ok(BUNDLE_JSON.endsWith('.json'));
});

// ---------- exporter helpers ----------
test('output size estimate scales with duration; level selection', () => {
  const a = estimateOutputBytes({ width: 1280, height: 720, fps: 30, durationSec: 60 });
  const b = estimateOutputBytes({ width: 1280, height: 720, fps: 30, durationSec: 120 });
  assert.ok(Math.abs(b / a - 2) < 0.01);
  assert.equal(avcLevelHex(1920, 1080, 30), '29'); // 4.1
  assert.notEqual(avcLevelHex(1920, 1080, 60), '29');
  assert.equal(vp9LevelCode(1280, 720, 30), '40');
});
