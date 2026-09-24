// `sloptimize report` / `issues` on a TIER-0 ledger, through the real binary
// (ticket 20cd5dc2): a tier-0 profile.json carries only what attach can
// measure, and the report must say what it has — never print "undefined" —
// and its counts must be the ledger's, not the read window's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));

function run(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const FNS = ['isTurnBanned', 'updateCrowd', 'buildNav'];

/** A tier-0 ledger: `n` attributed hitches over three causes, 2 s apart,
 *  with the gpu-create noise attach writes between them, and the
 *  profile.json the reporter pasted, verbatim. */
function tier0Dir(n = 142, profile = { type: 'profile', frame: { medianMs: 48.5 }, render: { calls: 79, triangles: 2329656 }, tier: 0, regime: 'unknown', at: iso(0) }) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cli-report-'));
  const lines = [{ type: 'armed', at: iso(0), url: 'app://index.html' }];
  for (let i = 0; i < n; i++) {
    lines.push({ type: 'gpu-create', at: iso(i * 2), fn: 'createShaderModule', ms: 0.2, stack: 'at x (a.js:1:1)' });
    lines.push({ type: 'hitch', at: iso(i * 2 + 1), frame: i, frameMs: 120 + i, medianMs: 48.5, longTaskMs: 100, tier: 0,
      classification: [{ guess: 'long-script', confidence: 'low', evidence: 'frame 120.0ms with only 0.0ms inside render' }],
      topFrames: [{ fn: FNS[i % 3], url: 'index-CNbvoNb_.js:1', selfMs: 90 }], profileWindow: 'rolling-chunk' });
  }
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (profile) writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
  return dir;
}

test('report on a tier-0 profile prints what was measured and never "undefined"', async () => {
  const { code, stdout } = await run(['report', '--dir', tier0Dir(10)]);
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /undefined/);
  assert.match(stdout, /frame median 48\.5ms/);
  assert.match(stdout, /calls 79 {2}triangles 2329656/);
  assert.doesNotMatch(stdout, /programs/);       // tier 0 has no program count: absent, not "undefined", not 0
  assert.doesNotMatch(stdout, /inside-render/);
  assert.match(stdout, /tier 0/);                 // a tier-0 approximation never poses as a tier-1 measurement
  // A full tier-1 profile still prints every field.
  const full = await run(['report', '--dir', tier0Dir(1, { at: iso(0), frame: { medianMs: 8, p95Ms: 12.5, fps: 125, insideRenderMs: 3 }, render: { calls: 300, triangles: 9000 }, memory: { programs: 40 } })]);
  assert.match(full.stdout, /frame median 8ms {2}p95 12\.5ms {2}\(~125fps\) {2}inside-render 3ms/);
  assert.match(full.stdout, /calls 300 {2}triangles 9000 {2}programs 40/);
});

test('report counts every hitch on the ledger and lists as many as it says it shows', async () => {
  const { stdout } = await run(['report', '--dir', tier0Dir(142)]);
  // 142 recorded — not the 80-line read window (the reporter's "80 hitches recorded").
  const m = /hitches recorded: (\d+) \(showing last (\d+)\)/.exec(stdout);
  assert.ok(m, stdout);
  assert.equal(Number(m[1]), 142);
  const listed = stdout.split('\n').filter((l) => l.startsWith('  · ')).length;
  assert.equal(Number(m[2]), listed);
  const few = await run(['report', '--dir', tier0Dir(3)]);
  assert.match(few.stdout, /hitches recorded: 3 \(showing last 3\)/);
  assert.equal(few.stdout.split('\n').filter((l) => l.startsWith('  · ')).length, 3);
});

test('issues on a tier-0 ledger: one row per cause, each with its function', async () => {
  const { code, stdout } = await run(['issues', '--json', '--dir', tier0Dir(142)]);
  assert.equal(code, 0);
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 3);
  assert.ok(!rows.some((r) => r.id === '2e566fc3'));
  assert.deepEqual(rows.map((r) => r.count).sort(), [47, 47, 48]);
  assert.deepEqual(rows.map((r) => r.label).sort(), FNS.map((f) => `hitch · long-script · ${f} (index.js)`).sort());
});

// Issue 5: counts per run are noisy samples of different lengths. The
// surfaces rate over RECORDED time and say how many runs a build stands on.
function write(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cli-runs-'));
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}
const beat = (s, extra) => ({ type: 'heartbeat', at: iso(s), medianFrameMs: 16, p95Ms: 30, tier: 0, ...extra });
const hit = (s, fn, extra) => ({ type: 'hitch', at: iso(s), frameMs: 150, medianMs: 16, tier: 0,
  classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], topFrames: [{ fn, url: 'index-CNbvoNb_.js:1', selfMs: 90 }], ...extra });
/** A run of `min` minutes: a beat a minute, `n` hitches of `fn` spread inside. */
function runOf(startS, min, n, fn, extra) {
  const out = [];
  for (let m = 0; m <= min; m++) out.push(beat(startS + m * 60, extra));
  for (let i = 0; i < n; i++) out.push(hit(startS + Math.floor((i + 0.5) * min * 60 / n), fn, extra));
  return out;
}

test('report and issues rate over recorded minutes', async () => {
  const dir = tier0Dir(142);                        // a hitch every 2 s: 283 s recorded
  const r = await run(['report', '--dir', dir]);
  assert.match(r.stdout, /hitches recorded: 142 \(showing last 5\) .*over 4\.7 min recorded \(30\.1\/min\)/);
  const i = await run(['issues', '--dir', dir]);
  assert.match(i.stdout, /^3 footprints · 4\.7 min recorded$/m);
  assert.match(i.stdout, /×48 {3}\(10\.18\/min\) hitch · long-script · isTurnBanned \(index\.js\)/);
});

test('issues --phase reads one phase at its own rate; --build one build', async () => {
  const dir = write([
    ...runOf(0, 5, 50, 'spawnUnits', { phase: 'spawn', build: 'b1', session: 's1' }),
    ...runOf(5 * 60 + 2, 1, 3, 'isTurnBanned', { phase: 'steady', build: 'b1', session: 's1' }),
  ]);
  const all = JSON.parse((await run(['issues', '--json', '--dir', dir])).stdout);
  assert.equal(all.length, 2);
  const steady = await run(['issues', '--phase', 'steady', '--dir', dir]);
  assert.match(steady.stdout, /^1 footprint · 1 min recorded · phase steady$/m);
  assert.match(steady.stdout, /×3 {4}\(3\/min\) hitch · long-script · isTurnBanned \(index\.js\)/);
  assert.doesNotMatch(steady.stdout, /spawnUnits/);
  const none = await run(['issues', '--build', 'b2', '--dir', dir]);
  assert.equal(none.code, 4);
});

test('history: a build recorded in several runs says n and the spread, and its rate is over recorded time', async () => {
  const day = 24 * 3600;
  const dir = write([
    ...runOf(0, 10, 20, 'f', { build: 'fixed', session: 's1' }),
    ...runOf(day, 10, 30, 'f', { build: 'fixed', session: 's2' }),
    ...runOf(2 * day, 10, 10, 'f', { build: 'next', session: 's3' }),
  ]);
  const { stdout } = await run(['history', '--dir', dir]);
  assert.match(stdout, /build fixed .*hitches 50 \(150\/h over 20 min · 2 runs 120–180\/h, worst 150ms/);
  assert.match(stdout, /build next .*hitches 10 \(60\/h over 10 min, worst 150ms/);
});
