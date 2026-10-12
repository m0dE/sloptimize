// Real Chromium: a 70 ms timer every 3 s — below the attribution floor, so
// every occurrence is `unattributed (below-floor)` — is found by its cadence
// and attributed from the pooled samples. Run: node test/periodic-e2e.mjs (~30 s).
import { attach } from '../src/attach.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e-periodic';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/timer-hitch.html', import.meta.url));
const session = await attach({ launch: url, headless: true, port: 9340, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 26000));
await session.close();

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const lines = readFileSync(`${DIR}/perf.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const gated = lines.filter((r) => r.type === 'hitch' && r.unattributed === 'below-floor');
check(gated.length >= 5, `${gated.length} hitches below the floor, each unattributed`);
const pats = lines.filter((r) => r.type === 'hitch-pattern');
const p = pats.at(-1);
check(!!p, `a hitch-pattern record (${pats.length})`);
check(p && Math.abs(p.periodMs - 3000) <= 60, `period ${p?.periodMs} ms (3000)`);
check(p?.topFrames?.[0]?.fn === 'serializeWorld' && !p.unattributed, `pooled attribution: ${p?.topFrames?.[0]?.fn} ${p?.topFrames?.[0]?.share} over ${p?.pooled?.hitches} frames`);
const out = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url)), 'report', '--dir', DIR], { encoding: 'utf8' });
for (const l of out.split('\n').filter((x) => /↻/.test(x))) console.log(`  ${l.trim()}`);
check(/↻ hitches every 3\.\d\d s — timer-driven: .*top serializeWorld/.test(out), 'report: the cadence and its pooled cause');
process.exit(fail ? 1 : 0);
