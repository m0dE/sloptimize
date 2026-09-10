// The agent asks the tab (SPEC §3.9): a request is a line in ask.jsonl, the
// answer is a record in perf.jsonl, and the CLI matches them by id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAsk, pendingAsks, ASK_KINDS } from '../src/ask.js';
import { writeAsk, awaitAnswer } from '../src/ask-files.js';

test('an ask is one of the closed kinds, with an id and a stamp; the arg rides only when given', () => {
  const a = makeAsk('capture', '10');
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(a.kind, 'capture'); assert.equal(a.arg, '10');
  assert.equal(makeAsk('profile').arg, undefined);
  assert.throws(() => makeAsk('reboot'), /ask kind must be one of/);
  assert.deepEqual(ASK_KINDS, ['profile', 'capture', 'cpuprofile', 'eval']);
});

test('pending = written, not yet answered, not stale', () => {
  const now = Date.parse('2026-09-10T10:00:00.000Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const asks = [
    { id: 'aaaa0001', kind: 'profile', at: at(5) },
    { id: 'aaaa0002', kind: 'capture', arg: '10', at: at(3) },
    { id: 'aaaa0003', kind: 'eval', arg: '1+1', at: at(600) },      // two minutes past: stale
  ].map((a) => JSON.stringify(a)).join('\n') + '\n';
  const ledger = [
    { type: 'heartbeat', at: at(4) },
    { type: 'answer', id: 'aaaa0001', ok: true, result: {} },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{"type":"hit';   // a partial last line
  assert.deepEqual(pendingAsks(asks, ledger, now).map((a) => a.id), ['aaaa0002']);
  assert.deepEqual(pendingAsks('', '', now), []);
});

test('awaitAnswer resolves the answer record by id, and null past the timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-ask-'));
  const ask = makeAsk('eval', '1+1');
  writeAsk(dir, ask);
  assert.ok(readFileSync(join(dir, 'ask.jsonl'), 'utf8').includes(ask.id));
  setTimeout(() => appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify({ type: 'answer', id: ask.id, ok: true, result: 2 }) + '\n'), 60);
  const ans = await awaitAnswer(dir, ask.id, 3000, 20);
  assert.equal(ans.result, 2);
  assert.equal(await awaitAnswer(dir, 'never', 100, 20), null);
});

test('an answer written in two chunks, with multi-byte glyphs before it, is still found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-ask-'));
  const p = join(dir, 'perf.jsonl');
  // A ledger with non-ASCII records already in it: byte offsets ≠ char offsets.
  for (let i = 0; i < 50; i++) appendFileSync(p, JSON.stringify({ type: 'usermark', note: '★ ⚡ ↯ keyframe ' + i }) + '\n');
  const ask = makeAsk('profile');
  const line = JSON.stringify({ type: 'answer', id: ask.id, ok: true, result: { sections: { render: 4 } } }) + '\n';
  const half = Math.floor(line.length / 2);
  setTimeout(() => appendFileSync(p, line.slice(0, half)), 30);
  setTimeout(() => appendFileSync(p, line.slice(half)), 90);
  const ans = await awaitAnswer(dir, ask.id, 3000, 20);
  assert.deepEqual(ans?.result, { sections: { render: 4 } });
});
