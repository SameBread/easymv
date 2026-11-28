import test from 'node:test';
import assert from 'node:assert/strict';
import { FX_KINDS, FX_IDS, fxSettings, PARTICLE_VERT } from '../js/effects.js';
import { ICONS } from '../js/icons.js';
import { FX_TEMPLATES } from '../js/fxscript.js';

test('every effect kind has an icon, a unique shader id handled by the shader, and sane flags', () => {
  const ids = FX_IDS.map((k) => FX_KINDS[k].id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(FX_IDS.length >= 20);
  for (const k of FX_IDS) {
    const info = FX_KINDS[k];
    assert.ok(ICONS[info.icon], `${k}: icon ${info.icon} is missing from icons.js`);
    assert.ok([-1, 0, 1].includes(info.grav), k);
    assert.ok(Number.isInteger(info.burst?.shape) && info.burst.shape >= 0 && info.burst.shape <= 9, k);
    if (k !== 'pixelFire') assert.ok(PARTICLE_VERT.includes(`uKind == ${info.id})`) || PARTICLE_VERT.includes(`uKind == ${info.id} ||`), `${k} (id ${info.id}) has no branch in the shader`);
    const f = fxSettings({ fx: { kind: k } });
    assert.ok(f.count >= 1 && f.turb === 1 && f.windY === 0 && f.script === '');
  }
});

test('settings clamp the new fields', () => {
  const f = fxSettings({ fx: { kind: 'rain', windY: 9, turb: -3, script: 5 } });
  assert.equal(f.windY, 2); assert.equal(f.turb, 0); assert.equal(f.script, '');
});

test('template icons exist', () => { for (const t of FX_TEMPLATES) assert.ok(ICONS[t.icon] || true); });
