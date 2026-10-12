// Real Chromium over a real git history: four commits of a page whose frame
// work goes 2 → 2 → 8 → 8 ms. `sloptimize timeline` checks out each, runs
// the build command, launches and attaches, and must call it a CLIFF at the
// third commit — naming the function that moved — then put HEAD back.
// Run: node test/timeline-e2e.mjs (~45 s).
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));
const repo = mkdtempSync(join(tmpdir(), 'slop-timeline-repo-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
const page = (lanesMs, i = 4) => `<!doctype html><body><script>
// commit ${i}
const spin = (ms) => { const u = performance.now() + ms; let x = 0; while (performance.now() < u) x += Math.sqrt(x + 1); return x; };
function moveCars() { return spin(2); }
function rebuildLanes() { return spin(${lanesMs}); }
function frame() { requestAnimationFrame(frame); moveCars(); rebuildLanes(); }
requestAnimationFrame(frame);
</script></body>`;
const shas = [];
for (const [i, ms] of [[1, 0.2], [2, 0.2], [3, 6], [4, 6]]) {
  writeFileSync(join(repo, 'game.html'), page(ms, i));
  git('add', '.'); git('commit', '-qm', i === 3 ? 'rebuild lanes every frame' : `commit ${i}`);
  shas.push(git('rev-parse', 'HEAD'));
}
writeFileSync(join(repo, '.gitignore'), 'dist.html\n.sloptimize/\n');
git('add', '.'); git('commit', '-qm', 'ignore build output');
const head = git('rev-parse', 'HEAD');
const DIR = join(repo, '.sloptimize');
const out = execFileSync(process.execPath, [BIN, 'timeline', '--commits', shas.join(','), '--repo', repo, '--build-cmd', 'cp game.html dist.html',
  '--launch', `file://${repo}/dist.html`, '--headless', '--port', '9344', '--settle', '2', '--duration', '5', '--dir', DIR], { encoding: 'utf8' });
console.log(out.split('\n').filter((l) => !l.startsWith('[timeline]')).join('\n'));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
check(new RegExp(`CLIFF at ${shas[2].slice(0, 10)}`).test(out), 'a cliff at the third commit');
check(/moved most \(ms\/frame\): .*rebuildLanes@dist\.html \+[5-7]\.\d+ incl\./.test(out), 'the step diff names rebuildLanes, by its inclusive time (its own time is in the shared spin())');
check(/main busy ms\/frame/.test(out), 'read as main-thread work per frame (the vsync-quantized frame would not move)');
check(git('rev-parse', 'HEAD') === head && /restored/.test(out), 'HEAD restored');
check(readFileSync(join(repo, 'game.html'), 'utf8') === page(6), 'the working tree is back at the last commit');
rmSync(repo, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
