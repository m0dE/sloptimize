// ============================================================
// attach.mjs — tier 0: attach to a browser, inject, record (SPEC-attach)
// ============================================================
// Raw CDP over Node's built-in WebSocket — no dependencies, the package
// posture. Owns: target discovery, injection (classify.js + inject-body.js
// concatenated into one IIFE), the emit binding, and the transport. The
// profiler, incident CLUSTERING and the .sloptimize/ files live in
// incident-pipeline.mjs, shared with the Electron in-app attach.
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createIncidentPipeline } from './incident-pipeline.mjs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

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
export function pageKnobs({ headless, minHitchMs, slots, host, browser, drive } = {}) {
  return { ...(host ? { host } : {}), ...(typeof headless === 'boolean' ? { headless } : {}), ...(typeof browser === 'string' && browser ? { browser } : {}),
    ...(drive ? { drive } : {}),
    recorder: { minHitchMs: Math.max(25, Number(minHitchMs) > 0 ? Number(minHitchMs) : 0), slots: slots !== false } };
}

// ── Drive scripts (SPEC §3.13): what the run DOES, scripted ────────────────
// A harness that holds the camera still cannot see what only a moving camera
// shows — ghost instances drawn at stale positions survived every automated
// check of one field game and only a person saw them. Every game's camera and
// input are its own, so the script is the game's: a module exporting
// `default async function drive(api)`, run on the recording's timeline. The
// script decides the workload, so its hash joins the run's conditions and
// two different scripts never compare.

/** A drive script, loaded and identified before anything launches. */
export async function loadDrive(spec) {
  if (!spec) return null;
  const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
  if (typeof spec === 'function') return { fn: spec, meta: { name: spec.name || 'inline', hash: `fn:${sha(spec.toString())}` } };
  let src;
  try { src = readFileSync(spec); } catch (e) { throw new Error(`--drive ${spec}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }
  const mod = await import(pathToFileURL(resolve(spec)).href);
  if (typeof mod.default !== 'function') throw new Error(`--drive ${spec}: the module must \`export default async function drive(api)\``);
  return { fn: mod.default, meta: { name: basename(spec), hash: `sha256:${sha(src)}` } };
}

/** The api a drive script gets: the page, the clock, the input. */
export function driveApi(send, { log = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now();
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: String(expression), awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r?.result?.value;
  };
  const api = {
    /** Evaluate in the page (awaited; the value returned by value). */
    eval: evaluate,
    wait: (ms) => sleep(ms),
    /** Seconds since the drive began. */
    elapsed: () => (now() - t0) / 1000,
    /** Run `fn` at `sec` seconds into the drive (immediately if past). */
    at: async (sec, fn) => { const d = t0 + sec * 1000 - now(); if (d > 0) await sleep(d); return fn ? fn() : undefined; },
    /** Name the page's phase — every record after it carries it. */
    phase: (name) => evaluate(`window.__sloptimizePhase = ${JSON.stringify(String(name))}`),
    /** Poll a page expression until it is truthy. */
    until: async (expression, { timeoutMs = 30_000, everyMs = 100 } = {}) => {
      const end = now() + timeoutMs;
      for (;;) {
        if (await evaluate(expression)) return;
        if (now() > end) throw new Error(`until(${expression}): not true after ${timeoutMs} ms`);
        await sleep(everyMs);
      }
    },
    key: async (key, { code, modifiers = 0, holdMs = 0 } = {}) => {
      const text = String(key).length === 1 ? String(key) : undefined;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: code ?? key, modifiers, ...(text ? { text } : {}) });
      if (holdMs) await sleep(holdMs);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code ?? key, modifiers });
    },
    move: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    click: async (x, y, { button = 'left' } = {}) => {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
    },
    /** A drag from (x0,y0) to (x1,y1) over `ms`, in `steps` moves. */
    drag: async (x0, y0, x1, y1, { ms = 500, steps = 20, button = 'left' } = {}) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button, clickCount: 1 });
      for (let i = 1; i <= steps; i++) { await sleep(ms / steps); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button }); }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button, clickCount: 1 });
    },
    /** Any CDP call — the escape hatch. */
    cdp: (method, params) => send(method, params),
    log: (...a) => log('[drive]', ...a),
  };
  return api;
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

// ── A custom launcher (attach --exec) ──────────────────────────────────────
// `--launch <url>` opens a browser on a page; an Electron harness with a data
// dir and a spec file is not a URL. `--exec "<cmd>"` runs the app's own
// launch line for every run (and every sweep level), in a shell, with:
//   {port}   the DevTools port this run attaches on (--port, default 9222)
//   {tmp}    a fresh empty directory, removed after the run — a data dir
//            with no cache or save carried over from the last level
//   {value}  a sweep level's N (sweep --exec): the launcher can set it,
//            with no knob in the page
//   {commit} a timeline step's commit
// The whole process group is stopped at close: an Electron app is several
// processes, and one left holding the port fails the next run.

// Every process an attach started and has not yet stopped. Whatever ends
// this process — a signal while an attach is still starting, a verb's own
// process.exit — stops them on the way out: an --exec'd group is detached,
// so the terminal's Ctrl-C never reaches it, and one left behind holds the
// port the next run needs.
const liveChildren = new Map();   // child → { group }
let exitHooked = false;
function trackChild(child, group) {
  liveChildren.set(child, { group });
  child.once('exit', () => { if (!group) liveChildren.delete(child); });
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const [c, { group: g }] of liveChildren) { try { if (g) process.kill(-c.pid, 'SIGTERM'); else c.kill('SIGTERM'); } catch { /* gone */ } }
  });
}

/** The command with its placeholders filled; one with no value here is an error. */
export const EXEC_VARS = ['port', 'tmp', 'value', 'commit'];
export function fillExec(cmd, vars) {
  // Only the four names, and never a shell's own `${VAR}`.
  return String(cmd).replace(/(?<!\$)\{(port|tmp|value|commit)\}/g, (m, k) => {
    if (vars[k] === undefined) throw new Error(`--exec: {${k}} has no value here (known: ${Object.keys(vars).filter((x) => vars[x] !== undefined).map((x) => `{${x}}`).join(' ')})`);
    return String(vars[k]);
  });
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
 * @param {string|Function} [opts.drive] a drive script (SPEC §3.13): run with `runDrive()`
 * @param {{gc?:boolean, snapshots?:boolean}} [opts.heap] soak instruments (SPEC §3.14) — both pause the page
 * @param {boolean} [opts.coverage] a coverage run (SPEC §3.12): precise function coverage, no sampler
 * @param {boolean} [opts.workers]  false: the page's thread only, no worker samplers (default on, SPEC §3.18)
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
  // A bad drive script fails before a browser is launched.
  const drive = await loadDrive(opts.drive);
  let child = null, execTmp = null, execTail = '', execExit = null;
  if (opts.exec) {
    if (opts.launch) throw new Error('--exec and --launch are two ways to start the target: pick one');
    fillExec(opts.exec, { port, tmp: '-', ...(opts.execVars ?? {}) });   // a bad command fails before anything is created
    execTmp = /(?<!\$)\{tmp\}/.test(opts.exec) ? mkdtempSync(join(tmpdir(), 'sloptimize-exec-')) : null;
    const cmd = fillExec(opts.exec, { port, tmp: execTmp ?? undefined, ...(opts.execVars ?? {}) });
    child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    trackChild(child, process.platform !== 'win32');
    // The last of what it said, for the error when it dies before attaching.
    const keep = (b) => { execTail = (execTail + b.toString()).slice(-1500); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    execExit = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    child.once('error', (e) => { execTail += `\n${e.message}`; });
    log(`exec: ${cmd}`);
  } else if (opts.launch) {
    const bin = process.env.SLOPTIMIZE_BROWSER
      ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
    if (!bin) throw new Error('no browser found — set SLOPTIMIZE_BROWSER');
    child = spawn(bin, [`--remote-debugging-port=${port}`, '--no-first-run',
      ...(opts.headless ? ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
      opts.launch], { stdio: 'ignore' });
    trackChild(child, false);
    log(`launched ${bin} → ${opts.launch}`);
  }

  // A launched browser is gone before close() returns: the next run of
  // `--runs N` launches on the same port and must not find this one. A
  // child that already died of a signal has exitCode null and signalCode set.
  async function killChild() {
    const cleanup = () => { if (execTmp) { try { rmSync(execTmp, { recursive: true, force: true }); } catch { /* still held */ } execTmp = null; } };
    // An --exec'd group can outlive its leader (a launcher that backgrounds
    // the app): alive is "any process left in the group".
    const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    const leaderGone = !child || child.exitCode !== null || child.signalCode !== null;
    if (!child || (leaderGone && !(opts.exec && process.platform !== 'win32' && groupAlive()))) { cleanup(); return; }
    const exited = leaderGone ? Promise.resolve() : new Promise((r) => child.once('exit', r));
    // An --exec'd command is a process group (a shell, an Electron and its helpers).
    const kill = (sig) => { try { if (opts.exec && process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch { /* gone */ } };
    kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (!leaderGone && child.exitCode === null && child.signalCode === null) kill('SIGKILL');
    // The group's helpers outlive its leader by a moment and still write to
    // {tmp}: wait until none is left (bounded), then remove it.
    if (opts.exec && process.platform !== 'win32') {
      for (let i = 0; i < 30; i++) {
        try { process.kill(-child.pid, 0); } catch { break; }
        if (i === 20) kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    cleanup();
    liveChildren.delete(child);
  }
  let wsRef = null;   // the socket, once open: closed if what follows fails
  // Anything that fails from here on stops what was started: a launched
  // group left holding the port would be attached to by the next run.
  try {
  return await (async () => {
  let wsUrl;
  try {
    const found = opts.wsUrl ? Promise.resolve(opts.wsUrl) : waitForTarget(port, opts.waitMs ?? (opts.exec ? 60_000 : child ? 15_000 : 0));
    // An --exec'd app that exits before its endpoint appears is said as that.
    wsUrl = execExit ? await Promise.race([found, execExit.then(({ code, signal }) => {
      // Exit 0 with the group still alive: the launcher backgrounded the app — keep waiting.
      if (code === 0 && process.platform !== 'win32') { try { process.kill(-child.pid, 0); return found; } catch { /* the whole group is gone */ } }
      throw new Error(`the --exec command exited (${signal ?? `code ${code}`}) before a DevTools endpoint appeared on :${port}${execTail.trim() ? ` — it said: ${execTail.trim().split('\n').slice(-4).join(' | ')}` : ''}`);
    })]) : await found;
  } catch (e) { await killChild(); throw e; }
  // The browser's version, for the run's conditions — over HTTP, off the
  // CDP sequence; an explicit wsUrl has no endpoint to ask.
  let browser;
  if (!opts.wsUrl) { try { browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())?.Browser; } catch { /* unknown */ } }
  const ws = new WS(wsUrl);
  wsRef = ws;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  let open = true;
  // `sessionId`: a child session in flat mode — a worker the page started.
  const sendOn = (sessionId, method, params = {}) => new Promise((res, rej) => {
    if (!open) { rej(new Error('target gone')); return; }
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const send = (method, params) => sendOn(undefined, method, params);
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

  // The reloaded document announcing itself: a drive must not start against
  // the old one, which still answers `document.readyState === 'complete'`.
  let settleArmed;
  const armed = new Promise((r) => { settleArmed = r; });
  const pipeline = createIncidentPipeline({ dir, log, send, sendTo: sendOn, workers: opts.workers, regime: opts.headless ? 'software' : 'unknown', build: opts.build, attributeMinShare: opts.minShare, coverage: opts.coverage === true, heap: opts.heap,
    conditions: pageKnobs({ headless: !!opts.headless, minHitchMs: opts.minHitchMs, slots: opts.slots, browser, drive: drive?.meta }) });
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
      try {
        const rec = JSON.parse(msg.params.payload);
        if (rec?.type === 'armed') settleArmed();
        void onRecord(rec);
      } catch { /* one bad record */ }
    } else if (msg.method) pipeline.onEvent(msg.method, msg.params, msg.sessionId);
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
      try { if (open) await pipeline.stop(); }
      finally {
        try { ws.close(); } catch { /* done */ }
        await killChild();
      }
    },

    closed,
    /** Run the drive script to its end (throws what it threw). */
    runDrive: async () => {
      if (!drive) throw new Error('no drive script');
      const api = driveApi(send, { log });
      // One promise: a later close or timeout must not reject into nothing.
      let timer;
      await new Promise((res, rej) => {
        armed.then(res);
        closed.then(() => rej(new Error('target gone before the page armed')));
        timer = setTimeout(() => rej(new Error('the page never armed (60 s)')), 60_000);
      }).finally(() => clearTimeout(timer));
      await api.until('document.readyState === "complete"', { timeoutMs: 60_000 });
      const mark = (event, extra = {}) => onRecord({ type: 'drive', event, at: new Date().toISOString(), ...drive.meta, ...extra });
      await mark('start');
      try { await drive.fn(api); }
      catch (e) { await mark('error', { error: String(e?.message ?? e).slice(0, 300) }); throw e; }
      await mark('end', { seconds: +api.elapsed().toFixed(2) });
    },
    drive: drive?.meta,
    clusters: pipeline.clusters,
    session: pipeline.session,
    build: pipeline.build,
  };
  })();
  } catch (e) { try { wsRef?.close(); } catch { /* not open */ } await killChild(); throw e; }
}
