// Real Chromium, the many-agent features end to end (~2 min):
//   equivalence — the same seeded sim twice is identical; a build with a
//                 nudge from tick 300 diverges AT tick 300, in `agents`;
//   sweep       — four levels of the `cars` knob: collision reads linear,
//                 junction super-linear.
import { attach } from '../src/attach.mjs';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e-agents';
rmSync(DIR, { recursive: true, force: true });
const page = 'file://' + fileURLToPath(new URL('./fixtures/agents.html', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));
const cli = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [BIN, ...a, '--dir', DIR], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };

const sessions = [];
for (const [build, q] of [['good', ''], ['good', ''], ['nudged', '?bug=300']]) {
  const s = await attach({ launch: page + q, headless: true, port: 9337, dir: DIR, build, log: () => {} });
  await new Promise((r) => setTimeout(r, 9000));
  await s.close();
  sessions.push(s.session);
}
const same = cli('equivalence', sessions[0], sessions[1], '--ticks', '400');
console.log(same.out.trim().split('\n').map((l) => '  ' + l).join('\n'));
const diff = cli('equivalence', 'good', 'nudged');
console.log(diff.out.trim().split('\n').map((l) => '  ' + l).join('\n'));
check(diff.code === 1 && /first divergence at tick 300 \(identical through 299\)/.test(diff.out), 'the nudged build diverges at tick 300');
check(/differs: agents {3}\(identical: rng\)/.test(diff.out), 'and says which part');
check(same.code === 0 && /identical through tick 400/.test(same.out), `two runs of one build are identical through 400 ticks (exit ${same.code})`);

const sw = cli('sweep', '--knob', 'cars', '--values', '500,1000,2000,4000', '--launch', page, '--headless', '--port', '9338', '--runs', '2', '--settle', '1', '--duration', '3');
console.log(sw.out.trim().split('\n').map((l) => '  ' + l).join('\n'));
const shape = (name) => sw.out.split('\n').find((l) => l.includes(`section ${name} ms/call`)) ?? '';
check(sw.code === 0, 'the sweep ran');
check(/linear/.test(shape('collision')) && !/SUPER|QUADRATIC/.test(shape('collision')), 'collision reads linear');
check(/SUPER-LINEAR|QUADRATIC/.test(shape('junction')), 'junction reads super-linear');
process.exit(fail ? 1 : 0);
