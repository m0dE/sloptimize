// The footprint (SPEC §3.7): the identity of a bottleneck apart from its
// occurrence. Pinned here: what goes INTO a key per record type and what must
// never (time, frame, build, exact size), that ids are stable across runs and
// versions are honoured, and that non-incidents have none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintOf, footprintKey, fnv1a32, describeFootprint, canonicalContext, contextOfKey, FOOTPRINT_VERSION } from '../src/footprint.js';

const hitch = (extra = {}) => ({
  type: 'hitch', at: '2026-09-01T23:21:21.473Z', frame: 8412, frameMs: 100, medianMs: 8.3, insideRenderMs: 0,
  classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], phase: 'boot:shaders', build: 'v1', ...extra,
});
const jitter = (extra = {}) => ({
  type: 'jitter', at: '2026-09-01T23:24:05.597Z', track: 'unit', kind: 'snap', frame: 700, jump: [-0.091, 0.007, -0.048], units: 0.103,
  dtMs: 24.9, speed: 9.76, classification: [{ guess: 'snap', confidence: 'high', evidence: 'e' }], phase: 'play', build: 'v1', ...extra,
});

test('the same cause on another build, another frame, another size has the same footprint', () => {
  const a = footprintOf(hitch());
  const b = footprintOf(hitch({ at: '2026-09-02T01:00:00.000Z', frame: 9, frameMs: 391.8, medianMs: 16.7, build: 'v2', insideRenderMs: 3 }));
  assert.equal(a.id, b.id);
  assert.equal(a.key, 'hitch|boot:shaders|long-script');
  assert.equal(a.v, FOOTPRINT_VERSION);
  assert.match(a.id, /^[0-9a-f]{8}$/);
  const j1 = footprintOf(jitter()), j2 = footprintOf(jitter({ units: 0.339, jump: [-0.254, 0.009, -0.224], dtMs: 16.4, speed: 29.2, build: 'v3' }));
  assert.equal(j1.id, j2.id);
  assert.equal(j1.key, 'jitter|unit|snap|play|snap|horizontal');
});

test('what distinguishes causes distinguishes footprints: phase, verdict, mint sites, track, kind, axis', () => {
  const base = footprintOf(hitch()).id;
  assert.notEqual(footprintOf(hitch({ phase: 'play' })).id, base);
  assert.notEqual(footprintOf(hitch({ classification: [{ guess: 'long-render', evidence: 'e' }] })).id, base);
  const minted = footprintOf(hitch({ mints: [{ material: 'house-dark', object: 'Mesh', ms: 1 }, { material: 'launch-brake-hazard', object: 'Mesh', ms: 2 }] }));
  assert.notEqual(minted.id, base);
  assert.equal(minted.key, 'hitch|boot:shaders|long-script|house-dark@Mesh,launch-brake-hazard@Mesh');
  // Mint ORDER and duplicates are not identity.
  const reordered = footprintOf(hitch({ mints: [{ material: 'launch-brake-hazard', object: 'Mesh' }, { material: 'house-dark', object: 'Mesh' }, { material: 'house-dark', object: 'Mesh' }] }));
  assert.equal(reordered.id, minted.id);
  const j = footprintOf(jitter()).id;
  assert.notEqual(footprintOf(jitter({ track: 'camera' })).id, j);
  assert.notEqual(footprintOf(jitter({ kind: 'oscillation' })).id, j);
  assert.notEqual(footprintOf(jitter({ jump: [0, 0.636, 0] })).id, j);           // vertical
  assert.equal(footprintKey(jitter({ jump: [0, 0.636, 0] })), 'jitter|unit|snap|play|snap|vertical');
  assert.notEqual(footprintOf(jitter({ classification: [{ guess: 'long-frame-catch-up', evidence: 'e' }] })).id, j);
});

test('a long-script hitch keys on the host\'s own SECTION when it carries one, and mints win over sections', () => {
  const bare = footprintOf(hitch({ classification: [{ guess: 'long-script' }] }));
  const greenery = footprintOf(hitch({ classification: [{ guess: 'long-script' }], sections: [{ label: 'sim.world.greenery', excessMs: 41.2, baselineMs: 1.1 }, { label: 'terrain', excessMs: 9.6, baselineMs: 0.4 }] }));
  const terrain = footprintOf(hitch({ classification: [{ guess: 'long-script' }], sections: [{ label: 'terrain', excessMs: 30, baselineMs: 0.4 }] }));
  assert.notEqual(greenery.id, bare.id);
  assert.notEqual(greenery.id, terrain.id);
  assert.equal(greenery.key.split('|')[3], 'section:sim.world.greenery');
  // The second section is a witness, never part of the identity.
  const greeneryAlone = footprintOf(hitch({ classification: [{ guess: 'long-script' }], sections: [{ label: 'sim.world.greenery', excessMs: 20, baselineMs: 1.1 }] }));
  assert.equal(greeneryAlone.id, greenery.id);
  // A compile that also carries a section is still the material's row.
  const minted = footprintOf(hitch({ mints: [{ material: 'house-dark', object: 'Mesh', ms: 1 }], sections: [{ label: 'render', excessMs: 30, baselineMs: 5 }] }));
  assert.equal(minted.key.split('|')[3], 'house-dark@Mesh');
  // A label carrying the key's own separators cannot break the key.
  const odd = footprintOf(hitch({ classification: [{ guess: 'long-script' }], sections: [{ label: 'a|b,c', excessMs: 1, baselineMs: 0 }] }));
  assert.equal(odd.key.split('|').length, 4);
});

// Ticket 20cd5dc2: tier 0 (attach) carries its attribution as profiler
// `topFrames`, none of the host's sources — and every tier-0 hitch in every
// project keyed `hitch|?|long-script` (id 2e566fc3), one row for all causes.
const t0 = (topFrames, extra = {}) => ({
  type: 'hitch', at: '2026-09-20T10:00:00.000Z', frame: 900, frameMs: 180, medianMs: 48.5, longTaskMs: 150, tier: 0,
  classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], topFrames, profileWindow: 'rolling-chunk', ...extra,
});

test('a tier-0 hitch keys on its top profiler frame: one row per cause, not one row per project', () => {
  const banned = footprintOf(t0([{ fn: 'isTurnBanned', url: 'index-CNbvoNb_.js:1', selfMs: 2022 }, { fn: 'step', url: 'index-CNbvoNb_.js:1', selfMs: 40 }]));
  const crowd = footprintOf(t0([{ fn: 'updateCrowd', url: 'index-CNbvoNb_.js:1', selfMs: 300 }]));
  assert.notEqual(banned.id, crowd.id);
  assert.notEqual(banned.id, '2e566fc3');
  assert.equal(banned.key, 'hitch|?|long-script|frame:isTurnBanned@index.js');
  // The occurrence stays out: another build's hash, another line, another
  // self time, another runner-up — the same cause.
  const rebuilt = footprintOf(t0([{ fn: 'isTurnBanned', url: 'index-Dq3xZ9_a.js:4812', selfMs: 90 }], { frameMs: 97 }));
  assert.equal(rebuilt.id, banned.id);
  // Same function name in another file is another site (three's `update` is not the game's).
  assert.notEqual(footprintOf(t0([{ fn: 'update', url: 'three.module.js:3' }])).id, footprintOf(t0([{ fn: 'update', url: 'game.js:3' }])).id);
  // A native frame has no url; separators in a name cannot break the key.
  assert.equal(footprintKey(t0([{ fn: 'bufferSubData', url: '', selfMs: 8 }])), 'hitch|?|long-script|frame:bufferSubData');
  assert.equal(footprintKey(t0([{ fn: 'a|b,c', url: 'x.js:1' }])).split('|').length, 4);
  // A gated hitch (below the floor, in the cooldown) or a failed rotation has
  // no frames: its own honest row, apart from every attributed cause.
  assert.equal(footprintKey(t0([], { unattributed: 'cooldown' })), 'hitch|?|long-script|unattributed');
  assert.equal(footprintKey(t0([])), 'hitch|?|long-script|unattributed');
  // A host's own sources still win over the profiler's guess.
  assert.equal(footprintKey(t0([{ fn: 'x', url: 'y.js:1' }], { sections: [{ label: 'sim', excessMs: 9, baselineMs: 1 }] })), 'hitch|?|long-script|section:sim');
  // Tier-1 records (no topFrames at all) are unchanged.
  assert.equal(footprintKey(hitch()), 'hitch|boot:shaders|long-script');
});

test('no version bump for the tier-0 site: every other id is unchanged, and an old attach ledger re-derives whole', () => {
  assert.equal(FOOTPRINT_VERSION, 1);
  // The id of a key string is what it was: tier-1 keys, and even the
  // degenerate tier-0 key itself, hash as before.
  assert.equal(footprintOf({ type: 'hitch', classification: [{ guess: 'long-script' }] }).id, '2e566fc3');
  // But no tier-0 record derives to it any more: attach stamps no footprint,
  // so a line 0.5.2 wrote — attributed, gated, or with no sampler — re-derives
  // on read to a per-cause (or honestly unattributed) row.
  const written052 = [
    t0([{ fn: 'isTurnBanned', url: 'index-CNbvoNb_.js:1', selfMs: 2022 }]),
    t0([], { unattributed: 'below-floor', profileWindow: 'none' }),
    t0([], { unattributed: 'cooldown', profileWindow: 'none' }),
    t0([]),
  ];
  for (const rec of written052) {
    assert.equal(rec.footprint, undefined);
    assert.notEqual(footprintOf(rec).id, '2e566fc3');
  }
});

test('build hashes come off bundle names; ordinary names are kept', () => {
  const file = (url) => footprintKey(t0([{ fn: 'f', url }])).split('@')[1];
  assert.equal(file('index-CNbvoNb_.js:1'), 'index.js');           // vite/rollup
  assert.equal(file('vendor-DX8k-2Lq.mjs:1'), 'vendor.mjs');
  assert.equal(file('app.3f2a9b1c4d5e6f708192.js:9'), 'app.js');     // webpack contenthash
  assert.equal(file('main.3f2a9b1c.chunk.js:9'), 'main.chunk.js');
  assert.equal(file('chunk-ABCD1234.js:1'), 'chunk.js');             // esbuild
  assert.equal(file('game.min.js:1'), 'game.min.js');
  assert.equal(file('three.module.js:1'), 'three.module.js');
  assert.equal(file('game-renderer.js:1'), 'game-renderer.js');
});

test('every incident type has a footprint; heartbeats, arm-probes and settled waits have none', () => {
  assert.equal(footprintKey({ type: 'warm', tag: 'post', kind: 'batched', phase: 'boot:shaders', worstBatchMs: 2350 }), 'warm|post|batched|boot:shaders');
  assert.equal(footprintKey({ type: 'gpu-stall', phase: 'page-load', queueDoneMs: 878 }), 'gpu-stall|page-load');
  assert.equal(footprintKey({ type: 'gpu-settle', tag: 'hangar-reveal', settled: false, ms: 3000 }), 'gpu-settle|hangar-reveal');
  assert.equal(footprintOf({ type: 'gpu-settle', tag: 'hangar-reveal', settled: true, ms: 3000 }), null);
  assert.equal(footprintKey({ type: 'usermark', phase: 'play', worstFrames: [{ frameMs: 725, classification: [{ guess: 'long-script' }] }] }), 'usermark|play|long-script');
  assert.equal(footprintOf({ type: 'heartbeat', at: 'T' }), null);
  assert.equal(footprintOf({ type: 'arm-probe', at: 'T' }), null);
  assert.equal(footprintOf(null), null);
});

test('a footprint already stamped by the writer stands; an older version is re-derived', () => {
  const stamped = { ...jitter(), footprint: { v: FOOTPRINT_VERSION, id: 'deadbeef', key: 'whatever the writer said' } };
  assert.equal(footprintOf(stamped).id, 'deadbeef');
  const old = { ...jitter(), footprint: { v: 0, id: 'deadbeef', key: 'old' } };
  assert.equal(footprintOf(old).id, footprintOf(jitter()).id);
});

test('fnv1a32 is the documented function: known vector, 8 hex chars', () => {
  assert.equal(fnv1a32(''), '811c9dc5');
  assert.equal(fnv1a32('a'), 'e40c292c');
  assert.equal(fnv1a32('v1:hitch|boot:shaders|long-script'), footprintOf(hitch()).id);
});

test('the host\'s situation facets are part of the cause: same hitch, different hull or crew, different footprint', () => {
  const solo = footprintOf(hitch({ ctx: 'crew=solo,hull=walker,stance=helm' }));
  const copilot = footprintOf(hitch({ ctx: 'crew=copilot,hull=walker,stance=helm' }));
  const titan = footprintOf(hitch({ ctx: 'crew=solo,hull=titan,stance=helm' }));
  assert.notEqual(solo.id, copilot.id);
  assert.notEqual(solo.id, titan.id);
  assert.equal(solo.key, 'hitch|boot:shaders|long-script|ctx:crew=solo,hull=walker,stance=helm');
  // …and the same facets on another day, build or frame are the same issue.
  assert.equal(footprintOf(hitch({ ctx: 'crew=solo,hull=walker,stance=helm', build: 'v9', at: '2027-01-01T00:00:00Z', frameMs: 900 })).id, solo.id);
  // An object is canonicalised the same way the runtime does it: sorted keys, scrubbed separators.
  assert.equal(canonicalContext({ stance: 'helm', crew: 'co pilot', hull: 'walker|mk2', empty: '', gone: undefined }), 'crew=co_pilot,hull=walker_mk2,stance=helm');
  assert.equal(footprintOf(hitch({ ctx: { stance: 'helm', hull: 'walker', crew: 'solo' } })).id, solo.id);
  assert.deepEqual(contextOfKey(solo.key), { crew: 'solo', hull: 'walker', stance: 'helm' });
  assert.deepEqual(contextOfKey('hitch|play|long-script'), {});
  assert.deepEqual(describeFootprint(solo.key).ctx, { crew: 'solo', hull: 'walker', stance: 'helm' });
  assert.equal(describeFootprint(solo.key).label, 'hitch · long-script');
});

test('describeFootprint gives each type its glyph and a short label', () => {
  assert.deepEqual(describeFootprint('jitter|unit|snap|play|snap|horizontal'), { glyph: '↯', label: 'jitter · unit snap · snap · horizontal', phase: 'play', ctx: {} });
  assert.deepEqual(describeFootprint('hitch|boot:shaders|long-script|a@b,c@d'), { glyph: '⚡', label: 'hitch · long-script · 2 mint site(s)', phase: 'boot:shaders', ctx: {} });
  assert.deepEqual(describeFootprint('hitch|play|long-script|section:sim.world.greenery'), { glyph: '⚡', label: 'hitch · long-script · sim.world.greenery', phase: 'play', ctx: {} });
  assert.deepEqual(describeFootprint('hitch|?|long-script|frame:isTurnBanned@index.js'), { glyph: '⚡', label: 'hitch · long-script · isTurnBanned (index.js)', phase: '?', ctx: {} });
  assert.equal(describeFootprint('hitch|?|long-script|frame:bufferSubData').label, 'hitch · long-script · bufferSubData');
  assert.equal(describeFootprint('hitch|?|long-script|unattributed').label, 'hitch · long-script · unattributed');
  assert.equal(describeFootprint('warm|post|batched|boot:shaders').glyph, '🔥');
  assert.equal(describeFootprint('gpu-stall|page-load').label, 'gpu-process stall');
});
