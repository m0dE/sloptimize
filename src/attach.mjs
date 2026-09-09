// ============================================================
// attach.mjs — tier 0: attach to a browser, inject, record (SPEC-attach)
// ============================================================
// Raw CDP over Node's built-in WebSocket — no dependencies, the package
// posture. Owns: target discovery, injection (classify.js + inject-body.js
// concatenated into one IIFE), the emit binding, and the transport. The
// profiler, incident CLUSTERING and the .sloptimize/ files live in
// incident-pipeline.mjs, shared with the Electron in-app attach.
import { readFileSync, existsSync } from 'node:fs';
import { createIncidentPipeline } from './incident-pipeline.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SRC = dirname(fileURLToPath(import.meta.url));

export function buildInjectScript() {
  const classify = readFileSync(join(SRC, 'classify.js'), 'utf8').replace(/^export /gm, '');
  const body = readFileSync(join(SRC, 'inject-body.js'), 'utf8');
  return `(() => {\n${classify}\n${body}\n})();`;
}

export { clusterKey, topFramesFromProfile } from './incident-pipeline.mjs';

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

  const pipeline = createIncidentPipeline({ dir, log, send, regime: opts.headless ? 'software' : 'unknown' });
  const onRecord = pipeline.onRecord;

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
  await pipeline.start();
  // The injection applies to NAVIGATIONS — a page that was already loading
  // when we attached (the --launch race) never runs it. One reload closes
  // that hole deterministically; dev pages reload for a living.
  if (opts.navigate) await send('Page.navigate', { url: opts.navigate });
  else await send('Page.reload', { ignoreCache: false });
  log(`attached on :${port} — recorder injected; profiler rolling`);

  return {
    close: async () => { try { ws.close(); } catch { /* done */ } if (child) child.kill(); },
    clusters: pipeline.clusters,
  };
}
