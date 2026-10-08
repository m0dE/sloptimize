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
process.exit(fail ? 1 : 0);
