// Cloud footprint identity (SPEC cloud §5): error, server-hitch, server-stall
// records recompute the same base key and id a client-side incident would —
// so a service that only ever sees these three types can dedupe on the same
// vocabulary as the in-page debugger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintOf, footprintKey, describeFootprint, normalizeErrorMessage, topFrameSite } from '../src/footprint.js';

test('error messages normalize numbers, hex ids, quoted strings, whitespace, and length', () => {
  assert.equal(normalizeErrorMessage('Cannot read properties of undefined (reading \'mesh_1f2a\')'), 'Cannot read properties of undefined (reading "…")');
  assert.equal(normalizeErrorMessage('Timeout after 1500ms for request 0xdeadbeef'), 'Timeout after #ms for request #');
  assert.equal(normalizeErrorMessage('  a   b\n c '), 'a b c');
  assert.equal(normalizeErrorMessage('x'.repeat(200)).length, 120);
  assert.equal(normalizeErrorMessage('a|b'), 'a¦b');
});

test('the top frame site drops origin, query, hash, line and column', () => {
  assert.equal(topFrameSite(['at render (https://game.example/assets/main.js?v=3:120:45)']), '/assets/main.js#render');
  assert.equal(topFrameSite('TypeError: x\n    at https://game.example/a.js:1:2'), '/a.js#anonymous');
  assert.equal(topFrameSite(['at step (/srv/game/dist/world.js:10:5)']), '/srv/game/dist/world.js#step');
  assert.equal(topFrameSite([]), 'unknown');
});

test('error footprints: same cause across builds and ids, different across sites', () => {
  const e = (over = {}) => ({ type: 'error', at: '2026-09-02T00:00:00Z', source: 'client', name: 'TypeError', message: 'Cannot read properties of undefined (reading \'x_12\')', stack: ['at render (https://g/a.js:1:1)'], ...over });
  assert.equal(footprintOf(e()).id, footprintOf(e({ at: '2026-09-03T00:00:00Z', message: 'Cannot read properties of undefined (reading \'x_99\')', stack: ['at render (https://g/a.js?v=9:200:7)'] })).id);
  assert.notEqual(footprintOf(e()).id, footprintOf(e({ stack: ['at update (https://g/a.js:1:1)'] })).id);
  assert.notEqual(footprintOf(e()).id, footprintOf(e({ source: 'server' })).id);
  assert.equal(footprintKey(e({ ctx: { stance: 'helm' } })), 'error|client|TypeError|Cannot read properties of undefined (reading "…")|/a.js#render|ctx:stance=helm');
  assert.deepEqual(describeFootprint(footprintKey(e())), { glyph: '✖', label: 'error · TypeError · Cannot read properties of undefined (reading "…")', phase: '', ctx: {} });
});

test('server-hitch and server-stall footprints name the phase and top self-time frame', () => {
  const h = { type: 'server-hitch', at: '2026-09-02T00:00:00Z', phase: 'match', tickMs: 40, budgetMs: 16, frames: [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }] };
  assert.equal(footprintKey(h), 'server-hitch|match|/srv/world.js#step');
  assert.equal(footprintKey({ ...h, frames: [], attribution: 'off' }), 'server-hitch|match|unattributed');
  assert.equal(footprintKey({ type: 'server-stall', at: '2026-09-02T00:00:00Z', phase: 'lobby', p99Ms: 80, frames: [{ file: '/srv/db.js', fn: 'query', selfMs: 60 }] }), 'server-stall|lobby|/srv/db.js#query');
  assert.deepEqual(describeFootprint(footprintKey(h)), { glyph: '▣', label: 'server tick over budget · /srv/world.js#step', phase: 'match', ctx: {} });
});
