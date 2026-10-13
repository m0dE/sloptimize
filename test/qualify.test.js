// Which `update`? V8 names a method by its own name, so Car.update,
// CarManager.update and TrainConsist.update sample as one `update` — and
// compare, keying by name and file across builds, read the three as one row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enclosingClasses, sharedNames, qualifiedName } from '../src/qualify.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';
import { compareSides, runMetrics } from '../src/compare.js';

const SRC = [
  '// class Fake { update() {} }',
  "const re = /[{}]/g, s = '{', t = `${ {a: 1}.a } }`;",
  'class Car extends Base {',
  '  update(dt) { if (x) { return a / 2; } }',
  '}',
  'class CarManager {',
  '  update() { for (const c of this.cars) c.update(1); }',
  '  static make() { return class { update() {} }; }',
  '}',
  'function update() {}',
  'export class TrainConsist{update(){return `${"}"}`}}',
].join('\n');
const at = (needle, line) => [line, SRC.split('\n')[line].indexOf(needle)];

test('enclosingClasses: the innermost class around each position — strings, templates, regexes and comments are not braces', () => {
  const pos = [at('update', 0), at('update', 3), at('update(', 6), at('update', 7), at('update', 9), at('update', 10)];
  assert.deepEqual(enclosingClasses(SRC, pos), [null, 'Car', 'CarManager', null, null, 'TrainConsist']);
  assert.equal(qualifiedName('update', 'Car', 3), 'Car.update');
  assert.equal(qualifiedName('update', null, 9), 'update:10');
});

test('sharedNames: only a name more than one function of one script answers to', () => {
  const m = sharedNames([[['update', 'a.js', 3, 2, 1, 1], ['update', 'a.js', 6, 2, 1, 1], ['draw', 'a.js', 20, 2, 1, 1], ['update', 'b.js', 1, 0, 1, 1]]]);
  assert.deepEqual([...m].map(([u, s]) => [u, [...s]]), [['a.js', ['update']]]);
});

const node = (id, fn, line, col) => ({ id, callFrame: { functionName: fn, url: 'https://x/assets/index-BU6aIbGf.js', lineNumber: line, columnNumber: col } });
const chunk = (rows) => {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)' } }, ...rows.map(([fn, line, col], i) => node(i + 2, fn, line, col))];
  const samples = rows.flatMap(([, , , n], i) => Array(n).fill(i + 2));
  return { nodes, samples, timeDeltas: samples.map(() => 10_000), startTime: 0, endTime: samples.length * 10_000 };
};

test('at stop, same-named functions are qualified from the script\'s source; compare then keeps them apart', async () => {
  const runs = [];
  for (const [session, carMs] of [['A', 30], ['B', 60]]) {
    const dir = mkdtempSync(join(tmpdir(), 'slop-qual-'));
    const send = async (method, params) => {
      if (method === 'Profiler.stop') return { profile: chunk([['update', ...at('update', 3), carMs / 10], ['update', ...at('update(', 6), 40], ['update', ...at('update', 10), 20]]) };
      if (method === 'Runtime.evaluate' && /^fetch\(/.test(params?.expression ?? '')) return { result: { type: 'string', value: SRC } };
      return {};
    };
    const p = createIncidentPipeline({ dir, send, log: () => {}, session, windowMs: 0 });
    await p.start();
    await p.stop();
    const run = JSON.parse(readFileSync(join(dir, 'runs', `${session}.json`), 'utf8'));
    runs.push(run);
  }
  const names = Object.values(runs[0].phases).flatMap((ph) => ph.fns.map((f) => f[0])).sort();
  assert.deepEqual(names, ['Car.update', 'CarManager.update', 'TrainConsist.update']);
  const r = compareSides({ label: 'A', runs: [runMetrics('A', [], runs[0])] }, { label: 'B', runs: [runMetrics('B', [], runs[1])] });
  const rows = r.rows.filter((x) => /^fn /.test(x.metric)).map((x) => x.metric);
  assert.ok(rows.includes('fn Car.update@index.js %js'), rows.join(' | '));
  assert.ok(rows.includes('fn CarManager.update@index.js %js'));
});

test('a source the page cannot hand over leaves the names by line, never merged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-qual-'));
  const send = async (method) => (method === 'Profiler.stop' ? { profile: chunk([['update', 3, 2, 5], ['update', 6, 2, 5]]) } : {});
  const p = createIncidentPipeline({ dir, send, log: () => {}, session: 'C', windowMs: 0 });
  await p.start();
  await p.stop();
  const run = JSON.parse(readFileSync(join(dir, 'runs', 'C.json'), 'utf8'));
  assert.deepEqual(Object.values(run.phases).flatMap((ph) => ph.fns.map((f) => f[0])).sort(), ['update:4', 'update:7']);
});

test('the source is read through the debugger of the session the script ran in; report names a mid-run hitch by its class', async () => {
  const { execFileSync } = await import('node:child_process');
  const { join: j, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'slop-qual-'));
  const calls = [];
  const withIds = () => { const c = chunk([['update', ...at('update', 3), 30], ['update', ...at('update(', 6), 40]]); for (const n of c.nodes) if (n.callFrame.url) n.callFrame.scriptId = '42'; return c; };
  const send = async (method, params) => {
    calls.push(method);
    if (method === 'Profiler.stop') return { profile: withIds() };
    if (method === 'Debugger.getScriptSource') return params.scriptId === '42' ? { scriptSource: SRC } : {};
    return {};   // a page that cannot fetch its own app:// bundle
  };
  const p = createIncidentPipeline({ dir, send, log: () => {}, session: 'D', windowMs: 0 });
  await p.start();
  await p.stop();
  assert.ok(calls.includes('Debugger.setSkipAllPauses') && calls.at(-1) === 'Debugger.disable', calls.join(' '));
  const run = JSON.parse(readFileSync(join(dir, 'runs', 'D.json'), 'utf8'));
  assert.deepEqual(Object.values(run.phases).flatMap((ph) => ph.fns.map((f) => f[0])).sort(), ['Car.update', 'CarManager.update']);
  assert.deepEqual(run.qualify, { shared: 1 });
  // A hitch the pipeline wrote mid-run, naming `update` as V8 did.
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', frame: { medianMs: 16.7 }, tier: 0, session: 'D', at: '2026-10-12T10:00:00Z' }));
  writeFileSync(join(dir, 'perf.jsonl'), JSON.stringify({ type: 'hitch', session: 'D', at: '2026-10-12T10:00:01Z', frameMs: 120, medianMs: 16.7, classification: [{ guess: 'long-script', evidence: 'e' }],
    topFrames: [{ fn: 'update', url: `index-BU6aIbGf.js:${at('update', 3)[0] + 1}`, selfMs: 100, share: 0.83 }] }) + '\n');
  const BIN = j(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
  const out = execFileSync(process.execPath, [BIN, 'report', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /top Car\.update@index-BU6aIbGf\.js:4 100ms/);
});

test('an inline <script>: its source is padded to where it starts in the document before classes are found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-qual-'));
  let p;
  const OFF = 10;   // the script starts on document line 10
  const send = async (method) => {
    if (method === 'Profiler.stop') {
      const c = chunk([['update', at('update', 3)[0] + OFF, at('update', 3)[1], 3], ['update', at('update(', 6)[0] + OFF, at('update(', 6)[1], 3]]);
      for (const n of c.nodes) if (n.callFrame.url) n.callFrame.scriptId = '7';
      return { profile: c };
    }
    if (method === 'Debugger.enable') { p.onEvent('Debugger.scriptParsed', { scriptId: '7', startLine: OFF, startColumn: 0 }); return {}; }
    if (method === 'Debugger.getScriptSource') return { scriptSource: SRC };
    return {};
  };
  p = createIncidentPipeline({ dir, send, log: () => {}, session: 'I', windowMs: 0 });
  await p.start();
  await p.stop();
  const run = JSON.parse(readFileSync(join(dir, 'runs', 'I.json'), 'utf8'));
  assert.deepEqual(Object.values(run.phases).flatMap((ph) => ph.fns.map((f) => f[0])).sort(), ['Car.update', 'CarManager.update']);
});
