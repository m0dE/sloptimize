// `--phase` (ticket e605e66b): a session with a load phase and a play phase
// is two workloads in one ledger, and read together the bigger one wins on
// volume alone — a 5-minute spawn flood outvoted a 60-second steady-state
// sample and named the wrong subsystem. The host already stamps `phase` on
// every record (tier 1); these tests hold the read side to it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePhases, onlyPhases, phaseCounts } from '../src/history.js';

const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const hitch = (min, ms, phase, build, guess = 'long-script') => ({
  type: 'hitch', at: iso(min), frameMs: ms, medianMs: 29, insideRenderMs: 0,
  classification: [{ guess, confidence: 'low', evidence: 'e' }], build, ...(phase ? { phase } : {}),
});
const beat = (min, p95, phase, build) => ({ type: 'heartbeat', at: iso(min), medianFrameMs: 29, p95Ms: p95, build, phase });

// Two builds, each a flood (many big hitches) then a short play sample.
function ledger() {
  const recs = [];
  for (const [build, off, playMs] of [['v1', 0, 90], ['v2', 100, 60]]) {
    for (let m = 0; m < 5; m++) recs.push(beat(off + m, 200, 'flood', build), hitch(off + m, 500, 'flood', build, 'spawn-burst'), hitch(off + m + 0.5, 450, 'flood', build, 'spawn-burst'));
    for (let m = 5; m < 7; m++) recs.push(beat(off + m, 40, 'play', build), hitch(off + m, playMs, 'play', build));
  }
  return recs;
}

test('parsePhases: a comma list, trimmed; absent or empty means no filter', () => {
  assert.deepEqual([...parsePhases('play, sample')], ['play', 'sample']);
  assert.equal(parsePhases(undefined), null);
  assert.equal(parsePhases(''), null);
  assert.equal(parsePhases(' , '), null);
});

test('onlyPhases keeps the named phases and drops records with no phase at all', () => {
  const recs = [...ledger(), hitch(300, 700, undefined, 'v2')];
  const play = onlyPhases(recs, parsePhases('play'));
  assert.ok(play.length > 0);
  assert.ok(play.every((r) => r.phase === 'play'));
  assert.equal(onlyPhases(recs, parsePhases('play,flood')).length, recs.length - 1);   // the unphased hitch is not in any phase
  assert.equal(onlyPhases(recs, null), recs);
});

test('phaseCounts: which phases the ledger carries, busiest first, and how many records carry none', () => {
  const c = phaseCounts([...ledger(), hitch(300, 700, undefined, 'v2')]);
  assert.deepEqual(c.phases, [['flood', 30], ['play', 8]]);
  assert.equal(c.unphased, 1);
});

// ── The CLI ──────────────────────────────────────────────────────────────────
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function ledgerDir(recs) {
  const d = mkdtempSync(join(tmpdir(), 'sloptimize-phase-'));
  dirs.push(d);
  writeFileSync(join(d, 'perf.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ at: iso(0), regime: 'hardware' }));
  return d;
}
function run(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('issues --phase: only that phase\'s rows — the flood no longer outvotes the sample', async () => {
  const dir = ledgerDir(ledger());
  const all = JSON.parse((await run(['issues', '--dir', dir, '--json'])).stdout);
  assert.equal(all[0].phase, 'flood');                          // unfiltered, volume wins
  const { code, stdout } = await run(['issues', '--dir', dir, '--phase', 'play', '--json']);
  assert.equal(code, 0);
  const rows = JSON.parse(stdout);
  assert.deepEqual(rows.map((r) => r.phase), ['play']);
  assert.equal(rows[0].count, 4);
});

test('an unknown phase exits 4 and names the phases the ledger does carry', async () => {
  const dir = ledgerDir(ledger());
  const { code, stdout } = await run(['issues', '--dir', dir, '--phase', 'sample']);
  assert.equal(code, 4);
  assert.match(stdout, /no records in phase sample/);
  assert.match(stdout, /flood ×30, play ×8/);
});

test('a ledger with no phase at all says so, and says where a phase comes from', async () => {
  const dir = ledgerDir(ledger().map(({ phase, ...r }) => r));
  const { code, stdout } = await run(['report', '--dir', dir, '--phase', 'play']);
  assert.equal(code, 4);
  assert.match(stdout, /no record on this ledger carries a phase/);
  assert.match(stdout, /frame\(\{ phase \}\)/);
});

test('report --phase: the hitch count and the issue head are that phase\'s alone', async () => {
  const dir = ledgerDir(ledger());
  const { code, stdout } = await run(['report', '--dir', dir, '--phase', 'play']);
  assert.equal(code, 0);
  assert.match(stdout, /phase: play/);
  assert.match(stdout, /hitches recorded: 4\b/);
  assert.doesNotMatch(stdout, /\[flood\]/);
});

test('history --phase: per-build windows measured from that phase only', async () => {
  const dir = ledgerDir(ledger());
  const h = JSON.parse((await run(['history', '--dir', dir, '--phase', 'play', '--json'])).stdout);
  assert.deepEqual(h.builds.map((b) => [b.build, b.hitches, b.p95Ms]), [['v1', 2, 40], ['v2', 2, 40]]);
});

test('fix --phase: before/after are that phase of each build, and the fix says which phase it measured', async () => {
  const dir = ledgerDir(ledger());
  const { code, stdout } = await run(['fix', '--dir', dir, '--phase', 'play', '--title', 'collision grid', '--commit', 'abc1234', '--json']);
  assert.equal(code, 0);
  const fix = JSON.parse(stdout);
  assert.equal(fix.phase, 'play');
  assert.equal(fix.before.worstMs, 90);
  assert.equal(fix.after.worstMs, 60);
  const stored = JSON.parse(readFileSync(join(dir, 'fixes.jsonl'), 'utf8').trim());
  assert.equal(stored.phase, 'play');
});

test('--phase with no name is refused (exit 2), not read as a phase called "--json"', async () => {
  const dir = ledgerDir(ledger());
  const { code, stderr } = await run(['issues', '--dir', dir, '--phase', '--json']);
  assert.equal(code, 2);
  assert.match(stderr, /--phase needs a name/);
});
