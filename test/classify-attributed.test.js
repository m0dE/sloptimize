// The host's own measurement as a verdict (SPEC §3.3 `host-attributed`).
//
// The case this exists for, verbatim from the field: a game ran its whole
// match server on the render thread inside a promise continuation, thirty
// times a second, ~10 ms a tick. No counter moved, the render share was
// small, and 4,338 records filed it as `gc-or-upload-by-elimination` — the
// single most frequent footprint in the ledger — while the game's OWN stall
// recorder, the moment the step was tagged, could say "mesh:step 12 ms" for
// every one of them. The classifier never got to hear it. Now it does, and a
// name the host measured outranks a shape inferred from deltas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHitch, reclassify, attributedGuess, ATTRIBUTED_SHARE, ATTRIBUTED_FLOOR_MS } from '../src/classify.js';
import { footprintOf, describeFootprint } from '../src/footprint.js';

const quiet = { calls: 0, triangles: 0, programs: 0, textures: 0, geometries: 0 };

test('a host span covering the excess is the verdict, ranked first, with both numbers in the evidence', () => {
  const g = classifyHitch({ frameMs: 22.4, medianMs: 8.3, insideRenderMs: 0, delta: quiet, attributed: [{ label: 'mesh:step', ms: 12.3 }] });
  assert.equal(g[0].guess, 'host-attributed');
  assert.equal(g[0].confidence, 'high');            // 12.3 of 14.1 ms = 87%
  assert.match(g[0].evidence, /mesh:step 12\.3ms of 14\.1ms excess/);
  // The counter-derived guess still follows — evidence is never thrown away.
  assert.equal(g[1].guess, 'long-script');
  // …and by-elimination is NOT appended behind a real answer.
  assert.ok(!g.some((x) => x.guess === 'gc-or-upload-by-elimination'));
});

test('half the excess names the cause at medium confidence; less than half does not', () => {
  const excess = 20;
  const half = attributedGuess([{ label: 'warm:post', ms: excess * ATTRIBUTED_SHARE }], excess);
  assert.equal(half?.guess, 'host-attributed');
  assert.equal(half?.confidence, 'medium');
  assert.equal(attributedGuess([{ label: 'warm:post', ms: excess * ATTRIBUTED_SHARE - 0.1 }], excess), null);
});

test('a span under the clock floor is noise, whatever its share', () => {
  assert.equal(attributedGuess([{ label: 'net:TICK', ms: ATTRIBUTED_FLOOR_MS - 0.5 }], 1), null);
});

test('the largest span speaks; a span longer than the excess is clamped in the share, not the evidence', () => {
  const g = attributedGuess([{ label: 'net:DELTA', ms: 3 }, { label: 'mesh:step', ms: 30 }], 14);
  assert.match(g.evidence, /^mesh:step 30\.0ms of 14\.0ms excess/);
  assert.equal(g.confidence, 'high');
});

test('no spans, or only malformed ones, changes nothing', () => {
  assert.equal(attributedGuess(undefined, 10), null);
  assert.equal(attributedGuess([], 10), null);
  assert.equal(attributedGuess([{ label: 7, ms: 9 }, { label: 'x', ms: -1 }, null], 10), null);
  const g = classifyHitch({ frameMs: 30, medianMs: 8, insideRenderMs: 0, delta: quiet, attributed: [] });
  assert.equal(g[0].guess, 'long-script');
});

test('reclassify re-runs the verdict on a minted record, keeps the spans, and reports whether it changed', () => {
  const rec = {
    type: 'hitch', at: '2026-09-10T05:11:00.000Z', frame: 100, frameMs: 41.7, medianMs: 16.7, insideRenderMs: 11.6,
    delta: { calls: 129, triangles: 2184354, programs: 0, textures: 0, geometries: 0 },
    classification: [{ guess: 'gc-or-upload-by-elimination', confidence: 'low', evidence: 'no counter moved and the render share is inconclusive' }],
    phase: 'play',
  };
  const changed = reclassify(rec, [
    { label: 'net:DELTA', ms: 2.2 }, { label: 'mesh:step', ms: 21.04 }, { label: 'gpu:nodeBuild', ms: 0.3 }, { label: 'spawn:MECH', ms: 4 },
  ]);
  assert.equal(changed, true);
  assert.equal(rec.classification[0].guess, 'host-attributed');
  // Largest first, three at most, tenths of a ms.
  assert.deepEqual(rec.attributed, [{ label: 'mesh:step', ms: 21 }, { label: 'spawn:MECH', ms: 4 }, { label: 'net:DELTA', ms: 2.2 }]);
  // Idempotent: the same spans again change nothing.
  assert.equal(reclassify(rec, rec.attributed), false);
});

test('reclassify leaves a record alone when the spans explain too little', () => {
  const rec = {
    type: 'hitch', frameMs: 41.7, medianMs: 16.7, insideRenderMs: 4, delta: quiet,
    classification: [{ guess: 'long-script', confidence: 'medium', evidence: 'e' }],
  };
  assert.equal(reclassify(rec, [{ label: 'net:TICK', ms: 3 }]), false);
  assert.equal(rec.classification[0].guess, 'long-script');
  assert.deepEqual(rec.attributed, [{ label: 'net:TICK', ms: 3 }]);   // still carried: evidence, even when not the verdict
  assert.equal(reclassify({ type: 'heartbeat' }, [{ label: 'x', ms: 99 }]), false);
});

test('the footprint keys on the attributed span, ahead of mints and sections', () => {
  const rec = {
    type: 'hitch', at: '2026-09-10T05:11:00.000Z', frame: 1, frameMs: 41.7, medianMs: 16.7, insideRenderMs: 0, delta: quiet,
    classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], phase: 'play',
    sections: [{ label: 'crowd.bodies', excessMs: 3.9, baselineMs: 3.6 }],
    mints: [{ material: 'house-cloth', object: 'Mesh' }],
  };
  const before = footprintOf(rec).key;
  assert.equal(before.split('|')[3], 'house-cloth@Mesh');
  reclassify(rec, [{ label: 'mesh:step', ms: 21 }]);
  const after = footprintOf(rec);
  assert.equal(after.key, 'hitch|play|host-attributed|span:mesh:step');
  assert.notEqual(after.id, footprintOf({ ...rec, classification: [{ guess: 'long-script' }] }).id);
  assert.deepEqual(describeFootprint(after.key), { glyph: '⚡', label: 'hitch · host-attributed · mesh:step', phase: 'play', ctx: {} });
});
