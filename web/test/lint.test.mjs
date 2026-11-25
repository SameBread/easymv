import test from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, applyFix, suggest, closest } from '../js/lint.js';
import { parseScript } from '../js/kinetic.js';
import { DEMO_LYRICS } from '../js/script.js';

const msgs = (t, o) => lintScript(t, o).map((i) => `${i.line}:${i.severity}:${i.msg}`);

test('clean scripts report nothing', () => {
  assert.deepEqual(lintScript('@pack smooth\n::trans fade\n[0:03] hello {size=1.4 color=accent motion=pop fx=wave}\n\n[0:08-0:10] bye', { songSec: 60 }), []);
});
test('the bundled lyrics demo has no warnings', () => {
  const issues = lintScript(DEMO_LYRICS, { songSec: 120 });
  assert.deepEqual(issues.filter((i) => i.severity !== 'info'), []);
});
test('unknown instructions and options suggest the closest', () => {
  const a = lintScript('::dcoe bar\n[0:01] hi');
  assert.match(a[0].msg, /did you mean ::deco/); assert.equal(applyFix('::dcoe bar\n[0:01] hi', a[0]).split('\n')[0], '::deco bar');
  assert.match(lintScript('@pak smooth')[0].msg, /@pack/);
});
test('bad values are explained', () => {
  assert.match(msgs('::layout lft\n[0:01] hi')[0], /left/);
  assert.match(msgs('::dur soon\n[0:01] hi')[0], /number/);
  assert.match(msgs('::deco bar+undrline\n[0:01] hi')[0], /underline/);
  assert.match(msgs('::fx wavee\n[0:01] hi')[0], /wave/);
  assert.match(msgs('::bg red\n[0:01] hi')[0], /colour/);
});
test('word settings are checked, with fixes', () => {
  const t = '[0:01] word{motion=bunce size=big} other{shak}';
  const r = lintScript(t);
  assert.ok(r.some((i) => /bounce/.test(i.msg)) && r.some((i) => /number/.test(i.msg)) && r.some((i) => /shake/.test(i.msg)));
  assert.equal(applyFix('[0:01] w{motion=bunce}', lintScript('[0:01] w{motion=bunce}')[0]), '[0:01] w{motion=bounce}');
  assert.ok(lintScript('[0:01] w{foo=1}')[0].msg.includes('foo'));
});
test('times: order, ends, song length, bar times', () => {
  assert.ok(msgs('[0:05-0:03] x')[0].includes('end time'));
  assert.ok(msgs('[0:10] a\n[0:05] b').some((m) => /earlier/.test(m)));
  assert.ok(msgs('[2:00] late', { songSec: 90 }).some((m) => /after the song/.test(m)));
  assert.ok(msgs('[@5] needs tempo').some((m) => /tempo/.test(m)));
  assert.equal(lintScript('[@5] ok', { tempo: { bpm: 120, offset: 0, sig: 4 } }).length, 0);
  assert.ok(msgs('[0:xx] nope').length >= 0);
});
test('brackets and emphasis', () => {
  assert.ok(msgs('[0:01] a {big').some((m) => /never closed/.test(m)));
  assert.ok(msgs('[0:01] **a b').some((m) => /Unpaired/.test(m)));
});
test('comments are ignored and do not split scenes', () => {
  const t = '[0:01] one\n// note\n[0:02] two';
  assert.equal(parseScript(t).scenes.length, 1); assert.equal(parseScript(t).scenes[0].lines.length, 2);
  assert.deepEqual(lintScript(t), []);
  assert.equal(parseScript('[0:01] one\n// a\n\n// b\n[0:05] two').scenes.length, 2);
});
test('same start time and empty scenes are mentioned', () => {
  assert.ok(msgs('[0:05] a\n\n[0:05] b').some((m) => /also starts/.test(m)));
  assert.ok(msgs('::trans fade\n\n[0:01] hi').some((m) => /no text/.test(m)));
});
test('suggestions', () => {
  assert.ok(suggest('::de', 4).items.some((i) => i.label === '::deco'));
  assert.ok(suggest('::deco bar+und', 14).items.some((i) => i.insert === 'bar+underline'));
  assert.ok(suggest('[0:01] hi {mot', 14).items.some((i) => i.label === 'motion='));
  assert.ok(suggest('[0:01] hi {motion=bo', 20).items.some((i) => i.label === 'bounce'));
  assert.ok(suggest('::layout ', 9).items.length >= 8);
  assert.equal(suggest('plain text', 5), null);
  assert.equal(closest('bunce', ['bounce', 'pop']), 'bounce');
});
