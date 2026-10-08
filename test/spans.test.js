// Phases as spans (SPEC §3.15): the page times every phase assignment, the
// host hangs a scale and sections with call counts on the span it is in,
// and report/compare/check read duration, cost per unit, and WHICH factor
// of a section moved — the call count or the time per call.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInjectScript } from '../src/attach.mjs';
import { phaseSpans, spanTable, sectionVerdict, oneOf } from '../src/spans.js';
import { runMetrics, compareSides } from '../src/compare.js';
import { parseBudgets, runPhaseMetrics, judgeBudgets, worseDirection } from '../src/gate.js';

function page() {
  const rafs = [], emitted = [];
  let now = 0;
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    setInterval: () => 1,
    PerformanceObserver: class { observe() {} },
    performance: { now: () => now },
    location: { href: 'app://index.html' },
    document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  // rAF timestamps and performance.now() are one clock, as in a browser.
  const frame = (dt, during) => { if (during) { now += dt - 1; vm.runInContext(during, ctx); now += 1; } else now += dt; const cb = rafs.pop(); rafs.length = 0; cb(now); };
  return { ctx, frame, advance: (ms) => { now += ms; }, of: (type) => emitted.filter((e) => e.type === type), run: (src) => vm.runInContext(src, ctx) };
}

test('the page times each phase as a span, exactly at the assignment, with its scale and sections', () => {
  const p = page();
  p.run("__sloptimizePhase = 'load'");
  p.advance(9000);   // one long synchronous load — no rAF saw it
  p.run("__sloptimizeScale('roads', 1469); __sloptimizeSection('createSidewalks', 700, 3700); __sloptimizeSection('createSidewalks', 37, 62); __sloptimizeSection('bad', 'x')");
  p.run("__sloptimizePhase = 'load'");   // the same phase again: no new span
  p.run("__sloptimizePhase = 'play'");
  const spans = p.of('phase-span');
  assert.equal(spans.length, 1, 'the unnamed boot span, with nothing on it, is not a record');
  const s = spans[0];
  assert.equal(s.phase, 'load', 'a closing span carries the phase that ended, not the one just set');
  assert.equal(s.ms, 9000);
  assert.equal(s.open, undefined);
  assert.deepEqual(s.scale, { roads: 1469 });
  assert.deepEqual(s.sections, { createSidewalks: [737, 3762] });
  assert.equal(p.run('__sloptimizePhase'), 'play', 'the phase still reads back');
  // Every other record still carries the phase it was emitted in.
  for (let i = 0; i < 70; i++) p.frame(16);
  p.frame(400);
  assert.equal(p.of('hitch')[0].phase, 'play');
  assert.deepEqual(p.of('hitch')[0].frameSpan, [10120, 10520], 'the frame\'s interval on the page clock');
});

test('a long frame that ends by changing the phase is filed under the phase that covered it', () => {
  const p = page();
  p.run("__sloptimizePhase = 'settle'");
  for (let i = 0; i < 70; i++) p.frame(16);
  p.run("__sloptimizePhase = 'load'");
  p.frame(2000, "__sloptimizePhase = 'play'");   // the load's last statement sets the next phase
  p.frame(16);
  const h = p.of('hitch');
  assert.equal(h.length, 1);
  assert.equal(h[0].phase, 'load', 'not play: play covered 1 ms of a 2000 ms frame');
  assert.equal(p.of('phase-span').find((s) => s.phase === 'load').ms, 1999);
});

test('a game that replaces the phase accessor with a plain property still stamps its phase', () => {
  const p = page();
  p.run("__sloptimizePhase = 'load'; delete globalThis.__sloptimizePhase; globalThis.__sloptimizePhase = 'play'");
  for (let i = 0; i < 70; i++) p.frame(16);
  p.frame(400);
  assert.equal(p.of('hitch')[0].phase, 'play');
});

test('the open span is snapshotted with the profile window, and only when something changed', () => {
  const p = page();
  p.run("__sloptimizePhase = 'play'; __sloptimizeSection('ai', 5, 10)");
  for (let i = 0; i < 240; i++) p.frame(16);
  const open = p.of('phase-span');
  assert.equal(open.length, 1, 'the second window had nothing new');
  assert.equal(open[0].open, true);
  assert.equal(open[0].phase, 'play');
  assert.deepEqual(open[0].sections, { ai: [5, 10] });
});

test('phaseSpans keeps the newest record per span, and a closed span is never replaced by a snapshot', () => {
  const recs = [
    { type: 'phase-span', session: 'S', span: 'a.1', phase: 'load', ms: 100, open: true, at: '1' },
    { type: 'phase-span', session: 'S', span: 'a.1', phase: 'load', ms: 9000, scale: { roads: 1469 }, at: '2' },
    { type: 'phase-span', session: 'S', span: 'a.1', phase: 'load', ms: 9100, open: true, at: '3' },
    { type: 'phase-span', session: 'S', span: 'a.2', phase: 'play', ms: 5000, open: true, sections: { ai: [50, 100] }, at: '4' },
  ];
  const spans = phaseSpans(recs);
  assert.equal(spans.length, 2);
  assert.equal(spans.find((s) => s.span === 'a.1').ms, 9000);
  const t = spanTable(spans);
  assert.equal(t.get('load').ms, 9000);
  assert.deepEqual(t.get('load').perUnit, { roads: 6.127 });
  assert.equal(t.get('play').ms, undefined, 'an open span is a lower bound, never the phase duration');
  assert.deepEqual(t.get('play').sections.get('ai'), { ms: 50, calls: 100, perCall: 0.5 });
});

test('a phase run twice reads as its mean span; per unit is total ms over total units', () => {
  const t = spanTable(phaseSpans([
    { type: 'phase-span', span: '1', phase: 'load', ms: 1000, scale: { tiles: 100 }, sections: { nav: [400, 10] } },
    { type: 'phase-span', span: '2', phase: 'load', ms: 3000, scale: { tiles: 300 }, sections: { nav: [1200, 30] } },
  ])).get('load');
  assert.equal(t.spans, 2);
  assert.equal(t.ms, 2000);
  assert.equal(t.perUnit.tiles, 10);
  assert.deepEqual(t.sections.get('nav'), { ms: 800, calls: 20, perCall: 40 });
});

test('the verdict says which factor moved: per call, call count, both, neither', () => {
  // The field case: identical call count, 31x the time.
  const v = sectionVerdict({ ms: 737, calls: 3762 }, { ms: 23060, calls: 3747 });
  assert.equal(v.moved, 'per-call');
  assert.match(v.text, /same call count, 31x ms\/call → the work PER CALL changed/);
  const c = sectionVerdict({ ms: 737, calls: 3762 }, { ms: 23500, calls: 120000 });
  assert.equal(c.moved, 'calls');
  assert.match(c.text, /same ms\/call, 32x calls → it is CALLED more/);
  assert.equal(sectionVerdict({ ms: 100, calls: 10 }, { ms: 600, calls: 20 }).moved, 'both');
  assert.equal(sectionVerdict({ ms: 100, calls: 10 }, { ms: 104, calls: 10 }).moved, 'none');
  assert.equal(sectionVerdict({ ms: 100, calls: 0 }, { ms: 104, calls: 10 }).moved, 'unknown');
  assert.doesNotMatch(sectionVerdict({ ms: 0, calls: 5 }, { ms: 104, calls: 10 }).text, /NaN|Infinity/);
  assert.equal(oneOf('roads'), 'road'); assert.equal(oneOf('entities'), 'entity'); assert.equal(oneOf('mesh'), 'mesh');
});

const span = (session, phase, ms, extra = {}) => ({ type: 'phase-span', session, span: `${session}.1`, phase, ms, at: '2026-10-08T00:00:00Z', ...extra });

test('compare: phase duration, ms per unit, section rows and the which-factor verdict', () => {
  const A = { label: 'A', runs: [runMetrics('a1', [span('a1', 'load', 9000, { scale: { roads: 1469 }, sections: { createSidewalks: [737, 3762] } })], null)] };
  const B = { label: 'B', runs: [runMetrics('b1', [span('b1', 'load', 32000, { scale: { roads: 1469 }, sections: { createSidewalks: [23060, 3747] } })], null)] };
  assert.equal(A.runs[0].metrics['phase load ms'], 9000);
  assert.equal(A.runs[0].metrics['phase load ms/road'], 6.127);
  assert.equal(A.runs[0].metrics['section load/createSidewalks calls'], 3762);
  const c = compareSides(A, B);
  const s = c.sections.find((x) => x.name === 'load/createSidewalks');
  assert.equal(s.moved, 'per-call');
  assert.equal(s.unlike, undefined);
  assert.ok(!c.rows.some((r) => r.verdict === 'unlike'));
  assert.equal(worseDirection('phase load ms/road'), 1, 'a cost per unit that rises is a regression');
  assert.equal(worseDirection('section createSidewalks ms/call'), 1);
  assert.equal(worseDirection('section createSidewalks calls'), 0);
});

test('compare: two different sizes mark the absolute rows unlike, and the verdict reads per unit', () => {
  const A = { label: 'small', runs: [runMetrics('a1', [span('a1', 'load', 1100, { scale: { roads: 286 }, sections: { createSidewalks: [150, 730] } })], null)] };
  const B = { label: 'big', runs: [runMetrics('b1', [span('b1', 'load', 9000, { scale: { roads: 1469 }, sections: { createSidewalks: [737, 3762] } })], null)] };
  const c = compareSides(A, B);
  const row = (m) => c.rows.find((r) => r.metric === m);
  assert.equal(row('phase load ms').verdict, 'unlike');
  assert.equal(row('section load/createSidewalks total ms').verdict, 'unlike');
  assert.equal(row('section load/createSidewalks calls').verdict, 'unlike');
  assert.notEqual(row('phase load ms/road').verdict, 'unlike', 'per unit is the comparison');
  assert.ok(c.warnings.some((w) => /phase load: the sides worked on different sizes: roads 286 vs 1469/.test(w) && /ms\/road is the comparison/.test(w)));
  const s = c.sections[0];
  assert.equal(s.moved, 'none', 'a bigger city calls it more per city, not per road');
  assert.match(s.text, /^per road: /);
});

test('compare: a size declared on one side only is said', () => {
  const A = { label: 'A', runs: [runMetrics('a1', [span('a1', 'load', 1100)], null)] };
  const B = { label: 'B', runs: [runMetrics('b1', [span('b1', 'load', 9000, { scale: { roads: 1469 } })], null)] };
  assert.ok(compareSides(A, B).warnings.some((w) => /only B declared its size in roads/.test(w)));
});

test('check: a phase budget on duration and on ms per unit', () => {
  const { rows, errors } = parseBudgets({ 'perf.budget.load.ms_per.road': 8, 'perf.budget.load.phase_ms': 10000, 'perf.budget.load.ms_per.': 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name the unit/);
  const good = judgeBudgets(rows, [runPhaseMetrics([span('a', 'load', 9000, { scale: { roads: 1469 } })])]);
  assert.equal(good.breached, 0);
  assert.equal(good.results.find((r) => r.metric === 'ms_per').value, 6.127);
  const bad = judgeBudgets(rows, [runPhaseMetrics([span('a', 'load', 32000, { scale: { roads: 1469 } })])]);
  assert.equal(bad.breached, 2);
  // A cost per unit far under 0.01 ms is judged as it is, not rounded to 0.
  const tiny = judgeBudgets(parseBudgets({ 'perf.budget.load.ms_per.tile': 0.003 }).rows, [runPhaseMetrics([span('a', 'load', 49, { scale: { tiles: 10000 } })])]);
  assert.equal(tiny.results[0].value, 0.0049);
  assert.equal(tiny.breached, 1);
});

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const cli = (...argv) => execFileSync(process.execPath, [BIN, ...argv], { encoding: 'utf8', env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } });

test('report prints the phase spans, per-unit cost and sections; compare prints the verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-spans-'));
  const lines = [
    span('A', 'load', 9000, { build: 'a', scale: { roads: 1469 }, sections: { createSidewalks: [737, 3762] } }),
    span('B', 'load', 32000, { build: 'b', scale: { roads: 1469 }, sections: { createSidewalks: [23060, 3747] } }),
    { ...span('B', 'play', 4000, { build: 'b', open: true }), span: 'B.2' },
  ];
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', tier: 0, session: 'B', frame: { medianMs: 16.7 }, at: '2026-10-08T00:00:00Z' }));
  const rep = cli('report', '--dir', dir);
  assert.match(rep, /phases: load 32000 ms · 1469 roads → 21\.78 ms\/road {2}\| {2}play \(still open\)/);
  assert.match(rep, /sections in load: createSidewalks 23060 ms x3747 \(6\.154 ms\/call\)/);
  const cmp = cli('compare', 'a', 'b', '--phase', 'load', '--dir', dir);
  assert.match(cmp, /section load\/createSidewalks {3}737 -> 23060 ms {3}x3762 -> x3747/);
  assert.match(cmp, /same call count, 31x ms\/call → the work PER CALL changed/);
});
