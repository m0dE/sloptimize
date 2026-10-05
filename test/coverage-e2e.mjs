// Coverage run, executed against a browser: a subsystem that loads and sits
// idle must be named by FUNCTION (TrafficLight.update: 0 calls) though its
// module ran, and the run must refuse to be read as timings.
import { attach } from '../src/attach.mjs';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-cov-e2e';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/coverage/index.html', import.meta.url));
const s = await attach({ launch: url, headless: true, port: 9335, dir: DIR, coverage: true, build: 'cov' });
await new Promise((r) => setTimeout(r, 4000));
await s.close();
const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));
const cov = JSON.parse(execFileSync(process.execPath, [BIN, 'coverage', '--dir', DIR, '--json'], { encoding: 'utf8' }));
const traffic = cov.idle.find((m) => m.file.endsWith('fixtures/coverage/traffic.js'));
if (!traffic) { console.log('FAIL — traffic.js not reported as loaded-with-uncalled-functions', JSON.stringify(cov.idle.map((m) => m.file))); process.exit(1); }
const names = traffic.uncalled.map((f) => f.name);
console.log(`traffic.js: ${traffic.called}/${traffic.total} called; never called: ${names.join(', ')}`);
if (!names.includes('update') || names.includes('tick')) { console.log('FAIL — want update uncalled and tick called'); process.exit(1); }
console.log('PASS — the idle subsystem is named by function');
process.exit(0);
