import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfig, fetchIssues, pushFix } from '../src/cloud-client.js';

test('cloudConfig prefers flags over env and returns null when incomplete', () => {
  assert.deepEqual(cloudConfig({ SLOPTIMIZE_KEY: 'sk', SLOPTIMIZE_ENDPOINT: 'https://c/' }, []), { key: 'sk', endpoint: 'https://c' });
  assert.deepEqual(cloudConfig({ SLOPTIMIZE_KEY: 'sk', SLOPTIMIZE_ENDPOINT: 'https://c' }, ['--key', 'k2']), { key: 'k2', endpoint: 'https://c' });
  assert.equal(cloudConfig({ SLOPTIMIZE_KEY: 'sk' }, []), null);
});

test('fetchIssues maps cloud rows to the local issues shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => [{ id: 'abc', key: 'hitch|play|x', glyph: '⚡', label: 'hitch · x', kind: 'hitch', phase: 'play', source: 'client', ctx: '', count: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-02T00:00:00.000Z', builds: ['b1'], fixes: 1, daily: [], exact: true }] }; };
  const rows = await fetchIssues({ key: 'sk', endpoint: 'https://c' }, { preset: '7d', kind: 'hitch' }, fetchImpl, () => Date.parse('2026-09-02T01:00:00Z'));
  assert.equal(calls[0].url, 'https://c/v1/issues?preset=7d&kind=hitch');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk');
  assert.equal(rows[0].type, 'hitch'); assert.equal(rows[0].first, '2026-09-01T00:00:00.000Z'); assert.equal(rows[0].lastAgoMs, 3600e3); assert.equal(rows[0].fixCount, 1);
});

test('pushFix posts the fix and surfaces HTTP errors as a rejected promise', async () => {
  const ok = await pushFix({ key: 'sk', endpoint: 'https://c' }, { id: 'f', title: 't' }, async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) }));
  assert.deepEqual(ok, { id: 1 });
  await assert.rejects(() => pushFix({ key: 'sk', endpoint: 'https://c' }, { id: 'f' }, async () => ({ ok: false, status: 401, json: async () => ({ error: 'unknown or revoked key' }) })), /401/);
});
