// ============================================================
// attach.mjs — tier 0: attach to a browser, inject, record (SPEC-attach)
// ============================================================
// Raw CDP over Node's built-in WebSocket — no dependencies, the package
// posture. Owns: injection (classify.js + inject-body.js concatenated into
// one IIFE), the emit binding, the rolling sampling profiler, incident
// CLUSTERING (M-A1: one cause = one cluster, however often it fires), and
// the .sloptimize/ files.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SRC = dirname(fileURLToPath(import.meta.url));

export function buildInjectScript() {
  const classify = readFileSync(join(SRC, 'classify.js'), 'utf8').replace(/^export /gm, '');
  const body = readFileSync(join(SRC, 'inject-body.js'), 'utf8');
  return `(() => {\n${classify}\n${body}\n})();`;
}

/** M-A1 — incident identity. One CAUSE investigates once: cluster key is the
 *  classification plus the top attributed frame (or creation-stack head);
 *  repeats increment a count instead of re-waking anyone. */
export function clusterKey(rec, topFrame) {
  const guess = rec.classification && rec.classification[0] ? rec.classification[0].guess : rec.type;
  return `${guess}|${topFrame ?? ''}`;
}

/** Top self-time frames from a CDP Profiler.stop payload, idle/program
 *  filtered, heaviest first. Pure — unit-tested against a fixture. */
export function topFramesFromProfile(profile, limit = 5) {
  if (!profile || !profile.nodes) return [];
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const us = deltas[i] ?? 0;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + us);
  }
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame ?? {};
    if (f.functionName === '(idle)' || f.functionName === '(program)' || f.functionName === '(garbage collector)') continue;
    rows.push({
      fn: f.functionName || '(anonymous)',
      url: f.url ? `${f.url.split('/').slice(-1)[0]}:${(f.lineNumber ?? 0) + 1}` : '',
      selfMs: +(us / 1000).toFixed(1),
    });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  return rows.slice(0, limit);
}

async function discoverTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  if (!page) throw new Error('no page target — is a tab open?');
  return page.webSocketDebuggerUrl;
}

export async function attach(opts = {}) {
  const port = opts.port ?? 9222;
  const dir = opts.dir ?? '.sloptimize';
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  mkdirSync(dir, { recursive: true });

  let child = null;
  if (opts.launch) {
    const bin = process.env.SLOPTIMIZE_BROWSER
      ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
    if (!bin) throw new Error('no browser found — set SLOPTIMIZE_BROWSER');
    child = spawn(bin, [`--remote-debugging-port=${port}`, '--no-first-run',
      ...(opts.headless ? ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
      opts.launch], { stdio: 'ignore' });
    log(`launched ${bin} → ${opts.launch}`);
    for (let i = 0; i < 50; i++) {
      try { await discoverTarget(port); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }

  const wsUrl = await discoverTarget(port);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  // ── State: clusters + last profile chunk ──
  const clusters = new Map();   // key → {count, firstAt, lastAt, sample}
  let lastCreateStackHead = null;
  let profiling = false;

  async function rotateProfile() {
    if (!profiling) return null;
    try {
      const { profile } = await send('Profiler.stop');
      await send('Profiler.start');
      return profile;
    } catch { return null; }
  }

  async function onRecord(rec) {
    if (rec.type === 'gpu-create') {
      lastCreateStackHead = (rec.stack || '').split('\n')[0]?.trim() ?? null;
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
      return;
    }
    if (rec.type === 'profile') {
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...rec, regime: opts.headless ? 'software' : 'unknown', at: new Date().toISOString() }, null, 2));
      return;
    }
    if (rec.type === 'hitch') {
      // Attribute: grab the current profiler chunk and take the heaviest
      // frames. The chunk spans up to the rotation window, so a freeze that
      // dominated its window names itself; the caveat rides the record.
      const profile = await rotateProfile();
      rec.topFrames = topFramesFromProfile(profile);
      rec.profileWindow = 'rolling-chunk';
      const guess = rec.classification?.[0]?.guess;
      const top = guess === 'shader-compile' ? lastCreateStackHead
        : rec.topFrames[0] ? `${rec.topFrames[0].fn}@${rec.topFrames[0].url}` : null;
      let key = clusterKey(rec, top);
      // MERGE before minting (M-A1): if any existing cluster's identifying
      // frame appears anywhere in this hitch's top frames, this is the same
      // cause seen from a different leaf — V8 inlining moves the hot function
      // into its caller between occurrences (measured on the exit fixture:
      // freeze #1 named seededFreezeWork, freeze #2 arrived as its caller).
      // Inlining that erases the frame ENTIRELY still splits a cause in two;
      // stated in the spec as a standing limit, not papered over.
      if (!clusters.has(key)) {
        const names = new Set((rec.topFrames ?? []).slice(0, 3).map((f) => `${f.fn}@${f.url}`));
        for (const existing of clusters.keys()) {
          const frame = existing.split('|')[1];
          if (frame && names.has(frame)) { key = existing; break; }
        }
      }
      const c = clusters.get(key);
      if (c) {
        c.count++; c.lastAt = rec.at;
        rec.cluster = { key, count: c.count, new: false };
      } else {
        clusters.set(key, { count: 1, firstAt: rec.at, lastAt: rec.at, sample: rec });
        rec.cluster = { key, count: 1, new: true };
        // The PUSH edge: only a NEW cause reaches stdout (the agent's wake
        // line) — M-A1's exit criterion made mechanical.
        log(`INCIDENT ${key} — ${rec.frameMs}ms, top: ${top ?? 'unattributed'}`);
      }
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
      writeFileSync(join(dir, 'clusters.json'), JSON.stringify([...clusters.entries()].map(([k, v]) => ({ key: k, count: v.count, firstAt: v.firstAt, lastAt: v.lastAt })), null, 2));
      return;
    }
    appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
    if (rec.type === 'armed') log(`recorder armed in page: ${rec.url}`);
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__sloptimizeEmit') {
      try { void onRecord(JSON.parse(msg.params.payload)); } catch { /* one bad record */ }
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Runtime.addBinding', { name: '__sloptimizeEmit' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectScript() });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 500 });
  await send('Profiler.start');
  profiling = true;
  // The injection applies to NAVIGATIONS — a page that was already loading
  // when we attached (the --launch race) never runs it. One reload closes
  // that hole deterministically; dev pages reload for a living.
  if (opts.navigate) await send('Page.navigate', { url: opts.navigate });
  else await send('Page.reload', { ignoreCache: false });
  log(`attached on :${port} — recorder injected; profiler rolling`);

  return {
    close: async () => { try { ws.close(); } catch { /* done */ } if (child) child.kill(); },
    clusters,
  };
}
