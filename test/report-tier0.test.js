// `sloptimize report` and `issues` on exactly what a tier-0 attach writes:
// no field a tier does not measure prints as "undefined", the listing says
// how many it shows, and every attributed cause is its own issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');

function tier0Ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'slop-t0-'));
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const fn = i % 3 ? 'isTurnBanned' : 'buildWorld';
    lines.push(JSON.stringify({ type: 'hitch', at: new Date(Date.UTC(2026, 8, 25, 10, 0, i)).toISOString(), frame: i, frameMs: 120 + i, medianMs: 16.7,
      longTaskMs: 100, delta: { programs: 0 }, render: { calls: 306, triangles: 4480000 }, tier: 0, session: 'S', build: 'fixed',
      classification: [{ guess: 'long-script', confidence: 'medium', evidence: 'e' }],
      topFrames: [{ fn, url: 'index-CNbvoNb_.js:44', selfMs: 90 }], profileWindow: 'rolling-chunk',
      cluster: { key: `long-script|${fn}@index-CNbvoNb_.js:44`, count: 1, new: false } }));
  }
  lines.push(JSON.stringify({ type: 'heartbeat', at: '2026-09-25T10:01:00.000Z', tier: 0, programs: 0, session: 'S', build: 'fixed' }));   // a hidden page's beat: no frames
  writeFileSync(join(dir, 'perf.jsonl'), lines.join('\n') + '\n');
  // Exactly the fields a tier-0 profile carries (the field report's profile.json, plus the window's frames).
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', frame: { medianMs: 48.5 }, render: { calls: 79, triangles: 2329656, frames: 120 }, tier: 0, regime: 'unknown', at: '2026-09-25T10:02:00Z' }));
  return dir;
}
const run = (...argv) => execFileSync(process.execPath, [BIN, ...argv], { encoding: 'utf8', env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } });

test('report on a tier-0 ledger: no "undefined", an honest listing count, the top frame on each line', () => {
  const out = run('report', '--dir', tier0Ledger());
  assert.doesNotMatch(out, /undefined/);
  assert.match(out, /frame median 48\.5ms {2}p95 — {2}\(~—\) {2}inside-render —/);
  assert.match(out, /calls 79 {2}triangles 2329656 {2}programs — {2}\(tier 0: per frame, mean of 120 frames/);
  assert.match(out, /hitches in the last 80 ledger lines: 12 \(showing last 5\)/);
  assert.equal((out.match(/^ {2}· /gm) || []).length, 5);
  assert.match(out, /top isTurnBanned@index-CNbvoNb_\.js:44 90ms/);
  assert.match(out, /issues \(2 footprints/);
});

test('issues on a tier-0 ledger: one row per attributed cause, and --phase narrows', () => {
  const dir = tier0Ledger();
  const rows = JSON.parse(run('issues', '--json', '--dir', dir));
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [['hitch · long-script · isTurnBanned', 8], ['hitch · long-script · buildWorld', 4]]);
  assert.deepEqual(JSON.parse(run('issues', '--json', '--phase', '?', '--dir', dir)).length, 2);
  assert.deepEqual(JSON.parse(run('issues', '--json', '--phase', 'steady', '--dir', dir)), []);
});

test('report: a top frame carries its share; one under a tenth of the stall reads unattributed; two arms in a session are said', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-t0-'));
  const base = { type: 'hitch', medianMs: 29, tier: 0, session: 'S', classification: [{ guess: 'long-script', evidence: 'e' }] };
  writeFileSync(join(dir, 'perf.jsonl'), [
    { type: 'armed', at: '2026-09-25T10:00:00Z', session: 'S', url: 'app://x' },
    { type: 'armed', at: '2026-09-25T10:00:20Z', session: 'S', url: 'app://x' },
    // Written before the gate existed: no share, no unattributed — the report applies the bar itself.
    { ...base, at: '2026-09-25T10:00:30Z', frameMs: 687.5, topFrames: [{ fn: '_aStarLoop', url: 'index-BOkDWhGO.js:90926', selfMs: 11.2 }] },
    { ...base, at: '2026-09-25T10:00:31Z', frameMs: 700, unattributed: 'low-share', sampled: { jsMs: 12, gcMs: 30, programMs: 610, idleMs: 0 },
      topFrames: [{ fn: '_aStarLoop', url: 'index-BOkDWhGO.js:90926', selfMs: 12, share: 0.017 }] },
    { ...base, at: '2026-09-25T10:00:33Z', frameMs: 120, topFrames: [{ fn: 'buildWorld', url: 'index-BOkDWhGO.js:44', selfMs: 90, share: 0.75 }] },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', frame: { medianMs: 34.7 }, tier: 0, regime: 'unknown', at: '2026-09-25T10:02:00Z' }));
  const out = run('report', '--dir', dir);
  assert.match(out, /687\.5ms .* unattributed \(heaviest JS _aStarLoop@index-BOkDWhGO\.js:90926 11\.2ms = 1\.6% of the frame\)/);
  assert.match(out, /700ms .* unattributed \(heaviest JS _aStarLoop@\S+ 12ms = 1\.7% of the frame; the chunk's other time: native 610ms, gc 30ms\)/);
  assert.match(out, /top buildWorld@index-BOkDWhGO\.js:44 90ms \(75% of frame\)/);
  assert.doesNotMatch(out, /top _aStarLoop/);
  assert.match(out, /note: session S armed 2×/);
  assert.match(out, /compare only with other attached runs/);
});
