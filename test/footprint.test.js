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
  assert.equal(describeFootprint('warm|post|batched|boot:shaders').glyph, '🔥');
  assert.equal(describeFootprint('gpu-stall|page-load').label, 'gpu-process stall');
});
