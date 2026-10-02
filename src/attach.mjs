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

/** @param {{minHitchMs?: number, slots?: boolean}} [opts]  page-side knobs, inlined as `__sloptimizeOpts`;
 *  `slots: false` leaves `__THREE_DEVTOOLS__` alone and skips the instance-slot watch */
export function buildInjectScript(opts = {}) {
  const classify = readFileSync(join(SRC, 'classify.js'), 'utf8').replace(/^export /gm, '');
  const slots = readFileSync(join(SRC, 'instance-slots.js'), 'utf8').replace(/^export /gm, '');
  const cadence = readFileSync(join(SRC, 'cadence.js'), 'utf8').replace(/^export /gm, '');
  const device = readFileSync(join(SRC, 'device.js'), 'utf8').replace(/^export /gm, '');
  const body = readFileSync(join(SRC, 'inject-body.js'), 'utf8');
  const page = { minHitchMs: Number(opts.minHitchMs) > 0 ? Number(opts.minHitchMs) : undefined, slots: opts.slots === false ? false : undefined };
  return `(() => {\nconst __sloptimizeOpts = ${JSON.stringify(page)};\n${classify}\n${slots}\n${cadence}\n${device}\n${body}\n})();`;
}

export { clusterKey, topFramesFromProfile } from './incident-pipeline.mjs';

/** The recorder settings a run's conditions carry (conditions.js): the
 *  hitch floor decides which frames count, the slot watch costs a little. */
export function pageKnobs({ headless, minHitchMs, slots, host, browser } = {}) {
  return { ...(host ? { host } : {}), ...(typeof headless === 'boolean' ? { headless } : {}), ...(typeof browser === 'string' && browser ? { browser } : {}),
    recorder: { minHitchMs: Math.max(25, Number(minHitchMs) > 0 ? Number(minHitchMs) : 0), slots: slots !== false } };
}

/** A port with nothing on it is its own failure, said as one: back-to-back
 *  Electron runs collide on a fixed debugging port, and Chromium that could
 *  not bind it starts anyway without an endpoint — a field report lost three
 *  runs to an error that read like "attached, no data". */
export class NothingListening extends Error {
  constructor(port) {
    super(`nothing is listening on 127.0.0.1:${port} — start the app with --remote-debugging-port=${port} (and check no other instance holds that port), or pass --wait <s> to wait for it`);
    this.port = port;
  }
}

async function discoverTarget(port, fetchImpl = fetch) {
  let res;
  try { res = await fetchImpl(`http://127.0.0.1:${port}/json/list`); }
  catch (e) {
    const code = e?.cause?.code ?? e?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EADDRNOTAVAIL') throw new NothingListening(port);
    throw new Error(`127.0.0.1:${port} did not answer /json/list: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  let targets;
  try { targets = await res.json(); } catch { throw new Error(`127.0.0.1:${port} answered, but not as a DevTools endpoint (no /json/list) — is that port the app's --remote-debugging-port?`); }
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  if (!page) throw new Error(`the DevTools endpoint on :${port} has no page target yet (${targets.length} target(s)) — is a window open?`);
  return page.webSocketDebuggerUrl;
}

/** Discover, retrying until `waitMs` has passed — for an app still starting. */
export async function waitForTarget(port, waitMs = 0, { fetch: fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const until = now() + waitMs;
  for (;;) {
    try { return await discoverTarget(port, fetchImpl); }
    catch (e) { if (now() >= until) throw e; await sleep(300); }
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.launch]     URL to open in a spawned browser
 * @param {number} [opts.port]       remote-debugging port (default 9222)
 * @param {string} [opts.wsUrl]      an explicit target socket; skips discovery
 * @param {number} [opts.waitMs]     keep retrying discovery this long (an app still starting)
 * @param {string} [opts.dir]        .sloptimize/ directory
 * @param {boolean} [opts.headless]
 * @param {number} [opts.minHitchMs] absolute detection floor in the page (default 25)
 * @param {number} [opts.minShare]   the share of a frame a function needs to be named its cause (default 0.1)
 * @param {boolean} [opts.slots]     false: no instance-slot watch, no __THREE_DEVTOOLS__ (default on)
 * @param {string} [opts.build]      the bundle's identity, stamped on every record — several
 *   runs of one build are then one build with n runs in `history`, not n builds
 * @param {typeof WebSocket} [opts.WebSocket]  injectable transport (tests)
 * @returns {Promise<{close:()=>Promise<void>, closed:Promise<{code?:number, reason?:string}>, clusters:Map, session:string, build?:string}>}
 *   `closed` settles when the socket does — the target went away, or close()
 *   ran. The CLI awaits it and exits: an attach that outlives its target has
 *   nothing to record and (ticket 2c11481d) once sat for 25 minutes on a
 *   never-settling await with the sampler still running in the page.
 */
export async function attach(opts = {}) {
  const port = opts.port ?? 9222;
  const dir = opts.dir ?? '.sloptimize';
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  let child = null;
  if (opts.launch) {
    const bin = process.env.SLOPTIMIZE_BROWSER
      ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
    if (!bin) throw new Error('no browser found — set SLOPTIMIZE_BROWSER');
    child = spawn(bin, [`--remote-debugging-port=${port}`, '--no-first-run',
      ...(opts.headless ? ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
      opts.launch], { stdio: 'ignore' });
    log(`launched ${bin} → ${opts.launch}`);
  }

  const wsUrl = opts.wsUrl ?? await waitForTarget(port, opts.waitMs ?? (child ? 15_000 : 0));
  // The browser's version, for the run's conditions — over HTTP, off the
  // CDP sequence; an explicit wsUrl has no endpoint to ask.
  let browser;
  if (!opts.wsUrl) { try { browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())?.Browser; } catch { /* unknown */ } }
  const ws = new WS(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  let open = true;
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (!open) { rej(new Error('target gone')); return; }
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  // The socket closing settles every in-flight call: a rotation the target
  // never answers must fail its record, not hang the chain behind it.
  let settleClosed;
  const closed = new Promise((r) => { settleClosed = r; });
  ws.onclose = (ev) => {
    open = false;
    for (const { rej } of pending.values()) rej(new Error('target gone'));
    pending.clear();
    settleClosed({ code: ev?.code, reason: ev?.reason });
  };
  ws.onerror = () => { /* onclose follows */ };

  const pipeline = createIncidentPipeline({ dir, log, send, regime: opts.headless ? 'software' : 'unknown', build: opts.build, attributeMinShare: opts.minShare,
    conditions: pageKnobs({ headless: !!opts.headless, minHitchMs: opts.minHitchMs, slots: opts.slots, browser }) });
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectScript({ minHitchMs: opts.minHitchMs, slots: opts.slots }) });
  await pipeline.start();
  // The injection applies to NAVIGATIONS — a page that was already loading
  // when we attached (the --launch race) never runs it. One reload closes
  // that hole deterministically; dev pages reload for a living.
  if (opts.navigate) await send('Page.navigate', { url: opts.navigate });
  else await send('Page.reload', { ignoreCache: false });
  log(`attached on :${port} — recorder injected; profiler rolling`);

  return {
    // The sampler stops BEFORE the socket: a page left with the profiler
    // running pays for it until the session is torn down.
    close: async () => {
      if (open) await pipeline.stop();
      try { ws.close(); } catch { /* done */ }
      if (child) child.kill();
    },
    closed,
    clusters: pipeline.clusters,
    session: pipeline.session,
    build: pipeline.build,
  };
}
