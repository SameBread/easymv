import test from 'node:test';
import assert from 'node:assert/strict';
import { listLines, setLineTime, setDir, getDir, lrcToScript, scriptToLrc, scriptToLines, linesToScript, fmtT } from '../js/scripttext.js';
import { parseScript } from '../js/kinetic.js';

const T = '@pack punchy\n\n# Title\nsub line\n\n[0:05.5] second **scene**\n- bullet';
test('listLines enumerates content lines with times', () => {
  const l = listLines(T);
  assert.equal(l.length, 4); assert.equal(l[2].t, 5.5); assert.equal(l[2].text, 'second scene'); assert.equal(l[3].text, 'bullet');
});
test('setLineTime writes and clears tags; round-trips through the parser', () => {
  let x = setLineTime(T, 0, { t: 1.25, t1: 4 });
  assert.match(x, /\[0:01\.25-0:04\.00\] # Title/);
  assert.equal(parseScript(x).scenes[0].t, 1.25);
  x = setLineTime(x, 0, { t: null, t1: null });
  assert.ok(!/\[0:01/.test(x));
  x = setLineTime(T, 3, { t: 9 }); assert.match(x, /\[0:09\.00\] - bullet/);
  assert.equal(parseScript(x).scenes[1].lines[1].t, 9);
});
test('setDir adds, replaces, removes a scene setting', () => {
  let x = setDir(T, 1, 'layout', 'stack'); assert.equal(getDir(x, 1, 'layout'), 'stack'); assert.equal(getDir(x, 0, 'layout'), null);
  x = setDir(x, 1, 'layout', 'split'); assert.equal(getDir(x, 1, 'layout'), 'split'); assert.equal((x.match(/::layout/g) || []).length, 1);
  x = setDir(x, 1, 'layout', ''); assert.equal(getDir(x, 1, 'layout'), null);
});
test('LRC to script and back', () => {
  const s = lrcToScript('[00:02.10]hello\n[00:03.00]world\n[00:10.00]far away');
  const l = listLines(s);
  assert.equal(l.length, 3); assert.ok(Math.abs(l[0].t - 2.1) < 0.01); assert.ok(l[2].t1 > l[2].t);
  assert.equal(parseScript(s).scenes.length, 2);
  assert.match(scriptToLrc(s), /^\[00:02\.10\]hello/);
});
test('scriptToLines and linesToScript agree', () => {
  const lines = scriptToLines('[0:01] a\n[0:02-0:03] b');
  assert.deepEqual(lines.map((x) => [x.t0, x.t1, x.text]), [[1, undefined, 'a'], [2, 3, 'b']]);
  assert.equal(fmtT(61.5), '1:01.50');
  assert.ok(linesToScript(lines).includes('b'));
});
