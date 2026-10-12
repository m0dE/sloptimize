// Shared by the report tests: a ledger dir with one run file, and the CLI.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'sloptimize.mjs');
export const runCli = (...argv) => execFileSync(process.execPath, [BIN, ...argv], { encoding: 'utf8', env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } });

/** A ledger dir with profile.json, perf.jsonl lines and one run file. */
export function runDir({ run = {}, lines = [], profile = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-run-'));
  mkdirSync(join(dir, 'runs'));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', frame: { medianMs: 16.7 }, tier: 0, regime: 'hardware', at: '2026-10-12T10:01:00Z', session: 'S', ...profile }));
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify({ session: 'S', ...l })).join('\n') + (lines.length ? '\n' : ''));
  writeFileSync(join(dir, 'runs', 'S.json'), JSON.stringify({ type: 'run', v: 1, session: 'S', intervalUs: 10000, from: '2026-10-12T10:00:00.000Z', to: '2026-10-12T10:01:40.000Z',
    phases: { '?': { samples: 1000, idle: 9000, program: 0, gc: 0, fns: [], busyMs: 10000, wallMs: 100000, frame: { windows: 50, medianMs: 16.7 } } }, ...run }));
  return dir;
}

