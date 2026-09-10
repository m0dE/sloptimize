import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSourceMap, symbolicate } from '../src/node/sourcemap.js';

test('a self-profiling frame is symbolicated through a v3 map', () => {
  // Hand-built: generated line 1 col 0 → a.ts:1 (fn "alpha"); col 10 → b.ts:5 (no name);
  // line 2 col 4 → a.ts:3 (fn "beta"). VLQ: AAAAA = [0,0,0,0,0]; then relative.
  const map = { version: 3, sources: ['../src/a.ts', '../src/b.ts'], names: ['alpha', 'beta'], mappings: 'AAAAA,UCIA;IDFAC' };
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  const p = join(dir, 'x.map'); writeFileSync(p, JSON.stringify(map));
  const sm = loadSourceMap(p);
  assert.deepEqual(sm.original(1, 3), { file: 'src/a.ts', line: 1, name: 'alpha' });
  assert.deepEqual(sm.original(1, 10), { file: 'src/b.ts', line: 5, name: null });
  assert.deepEqual(sm.original(2, 4), { file: 'src/a.ts', line: 3, name: 'beta' });
  assert.equal(sm.original(9, 0), null);
  const s = symbolicate({ top: [{ name: 'o', where: 'game.min.js:2:4', self: 3, share: 1 }, { name: 'native', where: '(native)', self: 1, share: 0 }] }, sm);
  assert.deepEqual(s.top[0], { name: 'beta', where: 'src/a.ts:3', self: 3, share: 1 });
  assert.equal(s.top[1].where, '(native)');
});
