// Real Chromium: Car.update, CarManager.update and TrainConsist.update all
// sample as `update`; the run file names them by class. Run: node test/qualify-e2e.mjs (~15 s).
import { attach } from '../src/attach.mjs';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e-qualify';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/classes.html', import.meta.url));
const session = await attach({ launch: url, headless: true, port: 9341, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 8000));
await session.close();
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const run = JSON.parse(readFileSync(`${DIR}/runs/${readdirSync(`${DIR}/runs`)[0]}`, 'utf8'));
const total = new Map();
// Inclusive samples: the time is spent in the shared spin() each one calls.
for (const p of Object.values(run.phases)) for (const [fn, , , , , n] of p.fns) total.set(fn, (total.get(fn) ?? 0) + n);
console.log(`  ${[...total].filter(([, s]) => s > 0).map(([f, s]) => `${f} ${s}`).join(' · ')}`);
check(['Car.update', 'CarManager.update', 'TrainConsist.update'].every((f) => total.has(f)), 'each update named by its class');
check(!total.has('update'), 'no bare `update` row left');
check((total.get('Car.update') ?? 0) > (total.get('CarManager.update') ?? 0), 'the 6 ms one is heavier than the 3 ms one');
const wk = new Map();
for (const p of Object.values(run.phases)) for (const [fn, , , , , n] of p.threads?.['worker[sim]']?.fns ?? []) wk.set(fn, (wk.get(fn) ?? 0) + n);
console.log(`  worker: ${[...wk].filter(([, s]) => s > 0).map(([f, s]) => `${f} ${s}`).join(' · ')}`);
check(wk.has('Agent.update') && wk.has('Spawner.update') && !wk.has('update'), 'the worker\'s two update()s named by class');
check(!run.qualify?.unread, `every source read (${JSON.stringify(run.qualify)})`);
process.exit(fail ? 1 : 0);
