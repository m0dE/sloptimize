// Real Chromium: on a ~400 MB heap the recorder must not become the frame.
// The page's own probe (rAF intervals, its own work) against attach's report,
// and the run file's account of what the recorder cost. Run: node
// test/heavy-heap-e2e.mjs [path-to-a-sloptimize-checkout] (~60 s).
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const { attach } = await import(`${root}/src/attach.mjs`);
const DIR = '/tmp/sloptimize-e2e-heap';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/heavy-heap.html', import.meta.url));
const PORT = 9339;
const session = await attach({ launch: url, headless: true, port: PORT, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 30000));
// The page's own probe, over a second DevTools client.
const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const probe = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result.result.value); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '(() => { const med = (a) => { const s = a.slice(-300).sort((x, y) => x - y); return s[s.length >> 1]; }; return { frames: __probe.intervals.length, rafMs: med(__probe.intervals), workMs: med(__probe.work) }; })()', returnByValue: true } })); });
ws.close();
await session.close();
const run = JSON.parse(readFileSync(`${DIR}/runs/${readdirSync(`${DIR}/runs`)[0]}`, 'utf8'));
const hitches = readFileSync(`${DIR}/perf.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.type === 'hitch');
console.log(`page probe: ${probe.frames} frames, rAF median ${probe.rafMs?.toFixed(1)} ms, own work median ${probe.workMs?.toFixed(1)} ms`);
console.log(`recorder: ${JSON.stringify(run.recorder ?? 'not recorded (older sloptimize)')} · ${hitches.length} hitches`);
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
check(probe.rafMs < probe.workMs * 1.5 + 17, `attached frames stay the page's own (rAF ${probe.rafMs?.toFixed(1)} vs work ${probe.workMs?.toFixed(1)} ms)`);
check(run.recorder?.anchored === true, 'the profiler is anchored');
check(run.recorder?.maxRestartMs < 50, `no restart walks the heap (longest ${run.recorder?.maxRestartMs} ms)`);
process.exit(fail ? 1 : 0);
