// Drive scripts: the game's own camera/input script on the recording's
// timeline. Its hash is a condition — two scripts are two workloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDrive, driveApi, pageKnobs } from '../src/attach.mjs';
import { compareConditions } from '../src/conditions.js';

test('loadDrive: a module exporting default drive(api), identified by its content hash; anything else fails before a launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-drive-'));
  writeFileSync(join(dir, 'a.mjs'), 'export default async function drive(api) { await api.wait(1); }\n');
  writeFileSync(join(dir, 'b.mjs'), 'export default async function drive(api) { await api.wait(2); }\n');
  writeFileSync(join(dir, 'bad.mjs'), 'export const x = 1;\n');
  const a = await loadDrive(join(dir, 'a.mjs')), a2 = await loadDrive(join(dir, 'a.mjs')), b = await loadDrive(join(dir, 'b.mjs'));
  assert.equal(a.meta.name, 'a.mjs');
  assert.match(a.meta.hash, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a.meta.hash, a2.meta.hash);
  assert.notEqual(a.meta.hash, b.meta.hash);
  await assert.rejects(loadDrive(join(dir, 'bad.mjs')), /must `export default async function drive\(api\)`/);
  await assert.rejects(loadDrive(join(dir, 'none.mjs')), /no such file/);
  assert.equal(await loadDrive(undefined), null);
  assert.match((await loadDrive(async function orbit() {})).meta.hash, /^fn:/);
});

test('two drive scripts never compare; one script against none does not either', () => {
  const c = (drive) => ({ instrument: 'attach', ...pageKnobs({ drive }) });
  assert.equal(compareConditions([c({ name: 'a.mjs', hash: 'sha256:1' })], [c({ name: 'a.mjs', hash: 'sha256:2' })]).comparable, false);
  assert.equal(compareConditions([c({ name: 'a.mjs', hash: 'sha256:1' })], [c(undefined)]).mismatches[0].key, 'drive');
  assert.equal(compareConditions([c({ name: 'a.mjs', hash: 'sha256:1' })], [c({ name: 'renamed.mjs', hash: 'sha256:1' })]).comparable, true, 'the content, not the name');
});

test('driveApi: page eval, phases, keys and drags over CDP; at() on the drive\'s clock; until() polls and times out', async () => {
  let t = 0, ready = false;
  const sent = [];
  const send = async (method, params) => {
    sent.push([method, params]);
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'boom') return { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom' } } };
      if (params.expression === 'ready') return { result: { value: ready } };
      if (params.expression === 'false') return { result: { value: false } };
      return { result: { value: 42 } };
    }
    return {};
  };
  const api = driveApi(send, { now: () => t, sleep: async (ms) => { t += ms; if (t >= 300) ready = true; } });
  assert.equal(await api.eval('1 + 41'), 42);
  await assert.rejects(api.eval('boom'), /page threw: ReferenceError: boom/);
  await api.phase('orbit');
  assert.equal(sent.at(-1)[1].expression, 'window.__sloptimizePhase = "orbit"');
  await api.key('w', { holdMs: 100 });
  assert.deepEqual(sent.slice(-2).map(([m, p]) => [m, p.type, p.key, p.text]), [['Input.dispatchKeyEvent', 'keyDown', 'w', 'w'], ['Input.dispatchKeyEvent', 'keyUp', 'w', undefined]]);
  await api.drag(0, 0, 100, 50, { steps: 4, ms: 40 });
  assert.deepEqual(sent.slice(-6).map(([, p]) => [p.type, p.x, p.y]), [['mousePressed', 0, 0], ['mouseMoved', 25, 12.5], ['mouseMoved', 50, 25], ['mouseMoved', 75, 37.5], ['mouseMoved', 100, 50], ['mouseReleased', 100, 50]]);
  const before = t;
  await api.at(1, () => 'x');
  assert.equal(t, 1000, 'at(1) waits until one second into the drive');
  assert.ok(before < 1000);
  await api.until('ready');
  await assert.rejects(api.until('false', { timeoutMs: 200 }), /until\(false\): not true after 200 ms/);
  assert.equal(api.elapsed() > 1, true);
});
