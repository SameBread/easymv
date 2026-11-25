import test from 'node:test';
import assert from 'node:assert/strict';
import { videoBitrate, estimateOutputBytes, QUALITY } from '../js/exporter.js';

test('quality presets scale the bitrate in order and stay within limits', () => {
  const b = (q) => videoBitrate(1920, 1080, 30, q);
  assert.ok(b('draft') < b('standard') && b('standard') < b('high') && b('high') < b('max'));
  assert.equal(videoBitrate(1280, 720, 30), videoBitrate(1280, 720, 30, 'standard'));
  assert.equal(videoBitrate(1280, 720, 30, 'nonsense'), videoBitrate(1280, 720, 30));
  for (const q of Object.keys(QUALITY)) { const v = videoBitrate(3840, 2160, 60, q); assert.ok(v >= 1_000_000 && v <= 80_000_000); }
  assert.ok(estimateOutputBytes({ width: 1280, height: 720, fps: 30, durationSec: 60, quality: 'high' }) > estimateOutputBytes({ width: 1280, height: 720, fps: 30, durationSec: 60, quality: 'draft' }));
});
