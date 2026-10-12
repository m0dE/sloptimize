// Real Chromium through a custom launcher: `attach --exec` and `sweep --exec`
// start the target from a command line ({port}, a fresh {tmp} data dir, the
// level's {value}) instead of a URL, and stop its whole process group.
// Run: node test/exec-e2e.mjs (~45 s).
import { attach, fillExec } from '../src/attach.mjs';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));
const CHROME = process.env.SLOPTIMIZE_BROWSER ?? '/usr/bin/chromium';
const page = 'file://' + fileURLToPath(new URL('./fixtures/knobless.html', import.meta.url));
const launch = `${CHROME} --headless=new --no-sandbox --disable-dev-shm-usage --use-angle=swiftshader --no-first-run --remote-debugging-port={port} --user-data-dir={tmp} '${page}?cars={value}'`;
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };

check(fillExec('a {port} {tmp}', { port: 1, tmp: '/t' }) === 'a 1 /t', 'placeholders filled');
try { fillExec('{commit}', { port: 1 }); check(false, 'an unknown placeholder is refused'); } catch (e) { check(/\{commit\} has no value here/.test(e.message), 'an unknown placeholder is refused'); }

// attach --exec: the run, then the process group gone and the data dir removed.
const DIR = '/tmp/sloptimize-e2e-exec';
rmSync(DIR, { recursive: true, force: true });
let tmpSeen;
const s = await attach({ exec: launch, execVars: { value: 2000 }, port: 9342, dir: DIR, log: (m) => { const t = /--user-data-dir=(\S+)/.exec(String(m)); if (t) tmpSeen = t[1]; } });
await new Promise((r) => setTimeout(r, 5000));
await s.close();
const run = JSON.parse(readFileSync(`${DIR}/runs/${readdirSync(`${DIR}/runs`)[0]}`, 'utf8'));
check(Object.values(run.phases).some((p) => p.fns.some((f) => f[0] === 'stepCars' && f[4] > 0)), 'attach --exec recorded the launched page');
check(tmpSeen && !existsSync(tmpSeen), `{tmp} was a fresh dir, removed after the run (${tmpSeen})`);
let up = true;
try { await fetch('http://127.0.0.1:9342/json/version'); } catch { up = false; }
check(!up, 'the launched process group is gone: the port is free for the next run');

// A launcher that dies before its endpoint: said as that.
try { await attach({ exec: 'echo no electron here >&2; exit 3', port: 9343, dir: DIR, log: () => {} }); check(false, 'a dead launcher fails the attach'); }
catch (e) { check(/the --exec command exited \(code 3\) before a DevTools endpoint appeared on :9343 — it said: no electron here/.test(e.message), `a dead launcher is said: ${e.message.slice(0, 120)}`); }

// sweep --exec with {value}: no knob in the page, the launch line sets N.
const SDIR = '/tmp/sloptimize-e2e-exec-sweep';
rmSync(SDIR, { recursive: true, force: true });
const out = execFileSync(process.execPath, [BIN, 'sweep', '--knob', 'cars', '--values', '20000,40000,80000', '--exec', launch, '--port', '9342', '--runs', '1', '--settle', '1', '--duration', '4', '--dir', SDIR], { encoding: 'utf8' });
for (const l of out.split('\n').filter((x) => /stepCars|sweep |frame ms/.test(x))) console.log(`  ${l.trim()}`);
const m = out.match(/fn stepCars@knobless\.html ms\/frame\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
check(m && +m[3] > +m[1] * 2, `stepCars grows with the launched N: ${m ? m.slice(1).join(' → ') : 'no row'}`);
process.exit(fail ? 1 : 0);
