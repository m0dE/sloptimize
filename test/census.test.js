// The census contract (SPEC §4.1): per-entity mesh/triangle/material counts,
// shared-geometry groups, the closed hint vocabulary, and the rule that a
// runtime fact the walk cannot know is null — never a guessed number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCensus } from '../src/census.js';

// Minimal three-shaped fakes: the walker reads only structural fields.
let ids = 0;
function geo(tris) { return { uuid: `g${++ids}`, index: { count: tris * 3 }, attributes: { position: { count: tris * 3 } } }; }
function mat(name = 'm') { return { uuid: `m${++ids}`, name, type: 'MeshStandardMaterial', color: { getHex: () => 0xff0000 }, map: null, roughness: 0.5, metalness: 0 }; }
function mesh(g, m, cast = false) { return { isMesh: true, geometry: g, material: m, castShadow: cast, visible: true, children: [] }; }
function group(name, children) { return { name, children, visible: true }; }

test('counts meshes/triangles per entity and finds shared-geometry groups', () => {
  const g = geo(100); const m = mat();
  const town = group('town', Array.from({ length: 50 }, () => mesh(g, m)));
  const hero = group('hero', [mesh(geo(500), mat())]);
  const c = buildCensus({ entities: [ { id: 'town', root: town }, { id: 'hero', root: hero } ] });
  const t = c.entities.find((e) => e.id === 'town');
  assert.equal(t.meshes, 50);
  assert.equal(t.triangles, 5000);
  assert.equal(t.sharedGeometryGroups[0].count, 50);
  assert.equal(t.sharedGeometryGroups[0].instanced, false);
  assert.equal(c.totals.calls, null);      // runtime fact — the census must not pretend
  assert.equal(c.totals.meshes, 51);
});

test('instancing-candidate hint fires with an estimate, not a promise', () => {
  const g = geo(10); const m = mat();
  const forest = group('forest', Array.from({ length: 200 }, () => mesh(g, m)));
  const c = buildCensus({ entities: [{ id: 'forest', root: forest }] });
  const hint = c.hints.find((h) => h.kind === 'instancing-candidate' && h.entity === 'forest');
  assert.ok(hint);
  assert.match(hint.detail, /200 meshes/);
  assert.equal(hint.estimate.callsSavedAtLeast, 199);
});

test('material-dedup-candidate fires on N identical-parameter materials', () => {
  const mats = Array.from({ length: 12 }, () => mat('bark'));
  const g = geo(10);
  const trees = group('trees', mats.map((m) => mesh(g, m)));
  const c = buildCensus({ entities: [{ id: 'trees', root: trees }] });
  assert.ok(c.hints.some((h) => h.kind === 'material-dedup-candidate' && h.entity === 'trees'));
});

test('undisposed-suspect compares against a previous census', () => {
  const c1 = { at: '', totals: { geometries: 100, textures: 10 } };
  const g = geo(1);
  const world = group('world', Array.from({ length: 300 }, () => mesh(geo(1), mat())));
  const c2 = buildCensus({ entities: [{ id: 'world', root: world }], previousTotals: { geometries: 100, textures: 10 } });
  assert.ok(c2.hints.some((h) => h.kind === 'undisposed-suspect'));
});

test('an InstancedMesh counts once and is not an instancing candidate', () => {
  const im = { isMesh: true, isInstancedMesh: true, count: 500, geometry: geo(10), material: mat(), castShadow: false, visible: true, children: [] };
  const c = buildCensus({ entities: [{ id: 'rocks', root: group('rocks', [im]) }] });
  assert.equal(c.entities[0].meshes, 1);
  assert.equal(c.entities[0].instancedMeshes, 1);
  assert.ok(!c.hints.some((h) => h.kind === 'instancing-candidate'));
});
