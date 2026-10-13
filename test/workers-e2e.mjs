// Real Chromium: a simulation Worker is auto-attached, sampled as its own
// thread, and `report` reads it as the ceiling — worker-bound — while the
// main thread looks healthy. Run: node test/workers-e2e.mjs (~20 s).
import { attach } from '../src/attach.mjs';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e-workers';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/sim-worker.html', import.meta.url));
const session = await attach({ launch: url, headless: true, port: 9336, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 14000));
await session.close();

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const run = JSON.parse(readFileSync(`${DIR}/runs/${readdirSync(`${DIR}/runs`)[0]}`, 'utf8'));
const threads = Object.values(run.phases).flatMap((p) => Object.entries(p.threads ?? {}));
const sim = threads.find(([n]) => n === 'worker[sim]')?.[1];
check(!!sim, `the worker is a thread of the run: ${threads.map(([n]) => n).join(', ') || 'none'}`);
check(sim && sim.busyMs / sim.wallMs > 0.75, `worker[sim] busy ${sim ? Math.round(100 * sim.busyMs / sim.wallMs) : '?'}%`);
check(sim?.fns?.[0]?.[0] === 'stepAgents' || sim?.fns?.some((f) => f[0] === 'stepAgents' && f[4] > 0), 'its heaviest function is the sim step');
check(JSON.stringify(run.conditions?.sampler?.workers) === '["worker[sim]"]', `the run's conditions say the worker was sampled: ${JSON.stringify(run.conditions?.sampler)}`);
const out = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url)), 'report', '--dir', DIR], { encoding: 'utf8' });
const lines = out.split('\n').filter((l) => /threads:|→ |worker\[sim\] heaviest/.test(l));
for (const l of lines) console.log(`  ${l.trim()}`);
check(/worker-bound: worker\[sim\]/.test(out), 'report: worker-bound');
check(/worker\[sim\] heaviest: stepAgents/.test(out), 'report names the worker\'s heaviest function');

// A decoupled sim on its own loop: 57 ms a tick every 75 ms. Read per task,
// and with no game clock the verdict must not read its idle time as headroom.
const DIR2 = `${DIR}-decoupled`;
rmSync(DIR2, { recursive: true, force: true });
const s2 = await attach({ launch: `${url}?step=57&every=75&marks=1`, headless: true, port: 9336, dir: DIR2, log: () => {} });
await new Promise((r) => setTimeout(r, 14000));
await s2.close();
const out2 = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url)), 'report', '--dir', DIR2], { encoding: 'utf8' });
for (const l of out2.split('\n').filter((x) => /threads:|→ /.test(x))) console.log(`  ${l.trim()}`);
// The sampled tasks, from the run file (no marks needed)…
const { runBucket } = await import('../src/runs.js');
const { threadRows } = await import('../src/threads.js');
const run2 = JSON.parse(readFileSync(`${DIR2}/runs/${readdirSync(`${DIR2}/runs`)[0]}`, 'utf8'));
const task = threadRows(runBucket(run2), 16.7).find((r) => r.name === 'worker[sim]')?.task;
check(task && Math.abs(task.p50Ms - 57) <= 12, `the worker's sampled tasks (${task?.p50Ms ?? '?'} ms; 57 ms a tick)`);
// …and the game's own tick marks, which the report prefers.
const m = out2.match(/worker\[sim\] (\d+(?:\.\d+)?) ms\/tick.*?× ([\d.]+)\/s \(the game's marks\)/);
check(m && Math.abs(Number(m[1]) - 57) <= 5 && Math.abs(Number(m[2]) - 13.3) <= 2, `report: the game's tick marks (${m?.[1] ?? '?'} ms × ${m?.[2] ?? '?'}/s; 57 ms every 75 ms)`);
check(!/worker\[sim\] [\d.]+ ms\/frame/.test(out2), 'report: no ms/frame for a worker');
check(/cannot judge sim-behind: no __sloptimizeClock/.test(out2), 'report: cannot judge sim-behind without a clock');
process.exit(fail ? 1 : 0);
