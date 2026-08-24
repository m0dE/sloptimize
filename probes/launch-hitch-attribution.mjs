#!/usr/bin/env node
// ============================================================
// probes/launch-hitch-attribution.mjs — tier-0 attach driven end-to-end
// ============================================================
// Drives a real page under the tier-0 CDP attach for a fixed window and
// prints the cluster table: which file:line families the hitches belong to.
// Written for launch-sequence attribution (the game boots into a match on
// ?play and runs its launch automatically), but generic: any URL works.
//
// The stock `attach --launch --headless` path launches with swiftshader —
// correct for a GPU-less box, catastrophically wrong for timing on a machine
// with a real GPU (measured 2 orders of magnitude off). This driver launches
// the browser ITSELF with real-GPU flags and hands attach() the already-open
// CDP port, so the tool's record/cluster pipeline is exercised unmodified.
//
//   node probes/launch-hitch-attribution.mjs \
//     --url http://127.0.0.1:4479/?play --secs 100 \
//     --dir /tmp/run1 --cdp-port 9223 [--min-ms 100]
//
// Output: the attach outputs land in --dir (perf.jsonl, clusters.json,
// profile.json); a summary table prints to stdout. Exit 0 always (this is an
// instrument, not a gate).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { attach } from '../src/attach.mjs';

const args = process.argv.slice(2);
const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const URL_ = get('--url');
const SECS = Number(get('--secs', '100'));
const DIR = get('--dir');
const CDP = Number(get('--cdp-port', '9223'));
const MIN_MS = Number(get('--min-ms', '100'));
if (!URL_ || !DIR) { console.error('need --url and --dir'); process.exit(2); }

mkdirSync(DIR, { recursive: true });
const profileDir = join(DIR, 'chrome-profile'); // fresh per --dir: cold pipeline caches

const BIN = process.env.CHROME_BIN || '/usr/bin/chromium';
const chrome = spawn(BIN, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profileDir}`,
  // Real GPU. NO angle/swiftshader overrides — those force a software
  // rasterizer and every timing conclusion under them is wrong.
  '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--window-size=1280,800',
  URL_,
], { stdio: 'ignore' });

// Wait for the CDP endpoint, then attach. attach() reloads the page, which is
// also what guarantees the injected recorder runs from frame zero.
const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline) {
  try { await fetch(`http://127.0.0.1:${CDP}/json/version`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 300)); }
}
if (!up) { console.error('CDP port never answered'); chrome.kill(); process.exit(2); }

const session = await attach({ port: CDP, dir: DIR });
console.log(`[driver] attached; riding ${SECS}s of ${URL_}`);

// Second CDP client for console capture (the game narrates its warm/boot work
// as [perf] lines). The page target allows one WS client — attach holds it —
// so this rides the BROWSER endpoint and a flattened session.
try {
  const ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bseq = 1000;
  const bpend = new Map();
  const bsend = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++bseq; bpend.set(id, { res, rej });
    bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const consoleLog = [];
  bws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && bpend.has(m.id)) { const p = bpend.get(m.id); bpend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/\[perf\]|warm|pipeline|sweep|sloptimize/i.test(text)) consoleLog.push(`${new Date().toISOString()} ${text.slice(0, 220)}`);
    }
  };
  const { targetInfos } = await bsend('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await bsend('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await bsend('Runtime.enable', {}, sessionId);
  globalThis.__consoleLog = consoleLog;
} catch (e) { console.log('[driver] console capture unavailable:', e.message); }
await new Promise((r) => setTimeout(r, SECS * 1000));
await session.close();
chrome.kill('SIGKILL');
if (globalThis.__consoleLog?.length) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(DIR, 'console.log'), globalThis.__consoleLog.join('\n') + '\n');
  console.log(`[driver] ${globalThis.__consoleLog.length} console lines → ${join(DIR, 'console.log')}`);
}

// ── Summary table from the attach outputs ──
const lines = readFileSync(join(DIR, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const armed = lines.find((r) => r.type === 'armed');
const t0 = armed ? Date.parse(armed.at) : NaN;
const rel = (r) => Number.isNaN(t0) ? '?' : ((Date.parse(r.at) - t0) / 1000).toFixed(1);

const hitches = lines.filter((r) => r.type === 'hitch' && r.frameMs >= MIN_MS);
const byCluster = new Map();
for (const h of hitches) {
  const key = h.cluster?.key ?? 'unclustered';
  const c = byCluster.get(key) ?? { count: 0, worst: 0, at: [], top: null, guess: null };
  c.count++; c.worst = Math.max(c.worst, h.frameMs);
  c.at.push(`+${rel(h)}s:${Math.round(h.frameMs)}ms`);
  c.top ??= h.topFrames?.slice(0, 3).map((f) => `${f.fn}@${f.url} self=${f.selfMs}ms`) ?? [];
  c.guess ??= h.classification?.[0]?.guess;
  byCluster.set(key, c);
}
const lag = lines.filter((r) => r.type === 'gpu-queue-lag');
console.log(`\n=== ${DIR} — ${hitches.length} hitches ≥${MIN_MS}ms across ${byCluster.size} clusters ===`);
for (const [key, c] of [...byCluster.entries()].sort((a, b) => b[1].worst - a[1].worst)) {
  console.log(`\n[${key}] count=${c.count} worst=${Math.round(c.worst)}ms guess=${c.guess}`);
  console.log(`  when: ${c.at.slice(0, 12).join(' ')}${c.at.length > 12 ? ' …' : ''}`);
  for (const f of c.top ?? []) console.log(`  frame: ${f}`);
}
console.log(`\ngpu-queue-lag samples >50ms: ${lag.length}${lag.length ? ' — worst ' + Math.max(...lag.map((l) => l.ms)) + 'ms at +' + rel(lag.reduce((a, b) => (a.ms > b.ms ? a : b))) + 's' : ''}`);
if (existsSync(join(DIR, 'clusters.json'))) {
  console.log('clusters.json:', readFileSync(join(DIR, 'clusters.json'), 'utf8'));
}
