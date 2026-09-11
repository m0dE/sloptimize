// The raw-WebSocket half of tier 0 over a fake socket: the session ends when
// the target goes away (ticket 2c11481d: an orphaned attach sat on a
// never-settling await with the profiler still running in the page), close()
// stops the sampler before the socket, and a rotation the target never
// answers cannot hang the record chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attach } from '../src/attach.mjs';

class FakeWS {
  static last = null;
  constructor(url) {
    FakeWS.last = this;
    this.url = url; this.sent = []; this.closed = false; this.answer = true;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(s) {
    const m = JSON.parse(s);
    this.sent.push(m.method);
    if (!this.answer) return;
    const result = m.method === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) }), 0);
  }
  close() { this.closed = true; setTimeout(() => this.onclose?.({ code: 1000 }), 0); }
  // The target vanished: the socket closes under us.
  drop() { setTimeout(() => this.onclose?.({ code: 1006 }), 0); }
  binding(rec) { this.onmessage?.({ data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: '__sloptimizeEmit', payload: JSON.stringify(rec) } }) }); }
}
const tmp = () => mkdtempSync(join(tmpdir(), 'slop-attach-'));
const open = (over = {}) => attach({ wsUrl: 'ws://fake/devtools/page/1', WebSocket: FakeWS, dir: tmp(), log: () => {}, ...over });

test('attach over an explicit wsUrl runs the CDP sequence and exposes `closed`', async () => {
  const s = await open();
  assert.deepEqual(FakeWS.last.sent, ['Runtime.enable', 'Page.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument',
    'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Page.reload']);
  assert.ok(s.closed instanceof Promise);
  await s.close();
});

test('the target going away settles `closed` with the reason', async () => {
  const s = await open();
  FakeWS.last.drop();
  const why = await s.closed;
  assert.equal(why.code, 1006);
});

test('close() stops the sampler before the socket, and settles `closed`', async () => {
  const s = await open();
  await s.close();
  assert.equal(FakeWS.last.sent.at(-1), 'Profiler.stop');
  assert.ok(FakeWS.last.closed);
  await s.closed;
});

test('a rotation the target never answers is rejected when the socket closes, and the record still lands', async () => {
  const dir = tmp();
  const s = await open({ dir });
  const ws = FakeWS.last;
  ws.answer = false;
  ws.binding({ type: 'hitch', at: '2026-09-09T00:00:00Z', frameMs: 300, classification: [{ guess: 'long-script' }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ws.sent.at(-1), 'Profiler.stop', 'the rotation is in flight, unanswered');
  ws.drop();
  await s.closed;
  await new Promise((r) => setTimeout(r, 5));
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].topFrames, []);
});
