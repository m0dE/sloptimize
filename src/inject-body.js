// ============================================================
// inject-body.js — the tier-0 in-page recorder (SPEC-attach §3)
// ============================================================
// Runs INSIDE the target page, injected over CDP before any page script.
// Self-contained by construction: attach.mjs concatenates classify.js and
// instance-slots.js (exports stripped) above this file and wraps them in an
// IIFE — there are no imports here; `classifyHitch` and `createSlotWatch`
// arrive from that concatenation.
// Everything fails soft: a page with no WebGPU, no WebGL, or no rAF still
// records frame timing; a page that never renders records nothing and
// costs nothing.
//
// Outbound edge: `__sloptimizeEmit(jsonLine)` — a CDP binding the attach
// process registered. One JSON record per call; the node side owns files,
// clustering, and the profiler.

/* global classifyHitch, createSlotWatch, createRefreshTracker, browserDevice, __sloptimizeEmit, __sloptimizeOpts */

const RING = 600;
// The absolute floor for detection: a frame is a hitch above 2× the rolling
// median AND above this (or above ABS_HITCH_MS, below). 25 ms by default; `attach --min-hitch-ms N` raises
// it in the page, so sub-floor frames never cross the binding at all.
const MIN_HITCH_MS = Math.max(25, (typeof __sloptimizeOpts !== 'undefined' && +__sloptimizeOpts.minHitchMs) || 0);
// The absolute arm: a frame this long is a hitch whatever the median says and
// however few frames the ring holds. The relative arm alone was blind to a
// load: attach reloads the page, a boot-time restore spends its first seconds
// in a handful of multi-second frames, and a field report's 12-second city
// load (rows of 4489/1963/1305 ms) never put 60 frames in the ring — zero
// hitches, an empty ledger that read as "nothing went wrong". A phase slow
// for long enough also lifts the median past its own spikes; this bar never moves.
const ABS_HITCH_MS = Math.max(8 * 25, MIN_HITCH_MS);
const frameMsRing = new Float64Array(RING);
let head = 0, count = 0, frameNo = 0;
let lastRaf = -1;
let medianCache = 16.7, medianStale = 0;

// The page's half of the run's conditions (conditions.js): the display's
// refresh rate read off this ring (cadence.js), the device, and the GPU the
// game's own context runs on. Emitted when any of them changes — rarely.
const refresh = createRefreshTracker();
let glSeen = null, adapterSeen = null, gpuName, conditionsSent = '';

// Live GPU objects (SPEC §3.14): created − deleted − collected, per kind. A
// dispose a rebuild misses grows a kind monotonically and is invisible to
// every frame metric; on the heartbeat, a trend says so. Collected objects
// are counted out through a FinalizationRegistry, so a wrapper the page let
// go of is not a leak.
const live = { buffers: 0, textures: 0, programs: 0, shaders: 0, framebuffers: 0, renderbuffers: 0, vertexArrays: 0 };
const liveSet = new WeakSet();
let liveSeen = false;
const gone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((kind) => { live[kind]--; }) : null;
function born(kind, obj) {
  if (!obj || typeof obj !== 'object' || liveSet.has(obj)) return;
  liveSet.add(obj); live[kind]++; liveSeen = true;
  try { gone?.register(obj, kind, obj); } catch { /* not registrable */ }
}
function died(kind, obj) {
  if (!obj || !liveSet.has(obj)) return;
  liveSet.delete(obj); live[kind]--;
  try { gone?.unregister(obj); } catch { /* fine */ }
}
// three.js renderers, through the devtools hook (below): their own
// renderer.info.memory is the engine's count of the same leak.
const renderers = [];

// Per-frame graphics-API counters, reset at each rAF boundary.
const gpu = { draws: 0, triangles: 0, creates: 0, uploadKB: 0 };
let sessionCreates = 0;

function emit(obj) {
  // Stamped here, not at each call site: per-site stamping is how gpu-create,
  // gpu-queue-lag, wrap-error and armed all went out with no phase, and a
  // load — mostly creates — was invisible to `--phase load`.
  // A record that says its own phase keeps it: a closing `phase-span` is the
  // phase that ENDED, emitted from inside the assignment that left it.
  if (!('phase' in obj)) { const phase = pagePhase(); if (phase !== undefined) obj.phase = phase; }
  try { __sloptimizeEmit(JSON.stringify(obj)); } catch { /* binding gone */ }
}

function rollingMedian() {
  // Fresh every frame while the ring is young (≤60 values: cheap), so an
  // absolute-arm hitch in the first second reads the median of the frames
  // so far — not the first frame's, cached for sixty.
  if (count > 60 && --medianStale > 0) return medianCache;
  const vals = [];
  for (let i = 0; i < count; i++) vals.push(frameMsRing[i]);
  vals.sort((a, b) => a - b);
  medianCache = vals.length ? vals[Math.floor(vals.length / 2)] : 16.7;
  medianStale = 60;
  return medianCache;
}

// ── Graphics-API wraps: the engine-free counters ────────────────────────────
try {
  if (typeof GPURenderPassEncoder !== 'undefined') {
    const rp = GPURenderPassEncoder.prototype;
    const d = rp.draw, di = rp.drawIndexed;
    rp.draw = function (v, ...a) { gpu.draws++; gpu.triangles += Math.floor((v ?? 0) / 3) * ((a[0] ?? 1)); return d.call(this, v, ...a); };
    rp.drawIndexed = function (n, ...a) { gpu.draws++; gpu.triangles += Math.floor((n ?? 0) / 3) * ((a[0] ?? 1)); return di.call(this, n, ...a); };
  }
  if (typeof GPUDevice !== 'undefined') {
    const dp = GPUDevice.prototype;
    for (const fn of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createShaderModule']) {
      const orig = dp[fn];
      if (typeof orig !== 'function') continue;
      dp[fn] = function (...a) {
        gpu.creates++; sessionCreates++;
        const t0 = performance.now();
        try { return orig.apply(this, a); }
        finally {
          const ms = performance.now() - t0;
          // The creation LEDGER: rare, so a stack per creation is affordable,
          // and it is the engine-free answer to "who compiled this?" —
          // sourcemapped, it names the construction site.
          if (sessionCreates <= 500) {
            emit({ type: 'gpu-create', at: new Date().toISOString(), fn, ms: +ms.toFixed(2),
              label: a[0] && a[0].label ? String(a[0].label).slice(0, 80) : undefined,
              stack: (new Error().stack || '').split('\n').slice(2, 7).join('\n') });
          }
        }
      };
    }
  }
  if (typeof GPU !== 'undefined' && typeof GPU.prototype.requestAdapter === 'function') {
    const ra = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = function (...a) {
      const r = ra.apply(this, a);
      try { r.then((ad) => { if (ad && !adapterSeen) adapterSeen = ad; }, () => {}); } catch { /* not a promise */ }
      return r;
    };
  }
  if (typeof GPUQueue !== 'undefined') {
    const wb = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (...a) {
      const data = a[2];
      if (data && data.byteLength) gpu.uploadKB += data.byteLength / 1024;
      return wb.apply(this, a);
    };
    // Queue latency: submit→done wall time for the first 300 frames — seconds
    // here inside a frame gap = the GPU process is the stall.
    const sub = GPUQueue.prototype.submit;
    let probes = 0;
    GPUQueue.prototype.submit = function (...a) {
      const r = sub.apply(this, a);
      if (probes < 300 && typeof this.onSubmittedWorkDone === 'function') {
        probes++;
        const t0 = performance.now();
        try { this.onSubmittedWorkDone().then(() => {
          const ms = performance.now() - t0;
          if (ms > 50) emit({ type: 'gpu-queue-lag', at: new Date().toISOString(), ms: +ms.toFixed(1) });
        }); } catch { /* fine */ }
      }
      return r;
    };
  }
  // Live WebGPU objects: destroy() counts out, as collection does.
  if (typeof GPUDevice !== 'undefined') {
    for (const [fn, kind, Cls] of [['createBuffer', 'buffers', globalThis.GPUBuffer], ['createTexture', 'textures', globalThis.GPUTexture]]) {
      const orig = GPUDevice.prototype[fn];
      if (typeof orig !== 'function') continue;
      GPUDevice.prototype[fn] = function (...a) { const o = orig.apply(this, a); born(kind, o); return o; };
      const d = Cls?.prototype?.destroy;
      if (typeof d === 'function') Cls.prototype.destroy = function (...a) { died(kind, this); return d.apply(this, a); };
    }
  }
  // WebGL counters — same shape, older API. EVERY draw entry point three.js
  // uses, not just the two plain ones: an InstancedMesh draws through
  // drawElementsInstanced, a BatchedMesh through WEBGL_multi_draw, and a
  // WebGL1 context instances through ANGLE_instanced_arrays. The first field
  // report (a WebGL2 game full of instanced cars) read 79 calls where the
  // game's renderer.info read 306 — the instanced draws were invisible.
  // Counted the way renderer.info counts them, so the two can be compared:
  // one call per API call (a multi-draw is one), triangles by mode × instances.
  const wrap = (proto, name, count) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function' || orig.__sloptimize) return;
    // Positional, no rest array: this runs on every draw of every frame.
    const w = function () { try { count.apply(null, arguments); } catch { /* never the game's error */ } return orig.apply(this, arguments); };
    w.__sloptimize = true;
    proto[name] = w;
  };
  const sum = (list, off, n) => { let s = 0; for (let i = 0; i < n; i++) s += list[off + i] ?? 0; return s; };
  const sumProd = (xs, xo, ys, yo, n) => { let s = 0; for (let i = 0; i < n; i++) s += (xs[xo + i] ?? 0) * (ys[yo + i] ?? 0); return s; };
  const drew = (mode, n, inst = 1) => { gpu.draws++; gpu.triangles += trianglesOf(mode, n) * inst; };
  const drewMulti = (mode, verts) => { gpu.draws++; gpu.triangles += trianglesOf(mode, verts); };
  const extPatched = new Set();
  for (const ctxName of ['WebGL2RenderingContext', 'WebGLRenderingContext']) {
    const C = globalThis[ctxName];
    if (!C) continue;
    const p = C.prototype;
    wrap(p, 'drawArrays', (m, first, n) => drew(m, n));
    wrap(p, 'drawElements', (m, n) => drew(m, n));
    wrap(p, 'drawArraysInstanced', (m, first, n, inst) => drew(m, n, inst));
    wrap(p, 'drawElementsInstanced', (m, n, type, off, inst) => drew(m, n, inst));
    wrap(p, 'drawRangeElements', (m, start, end, n) => drew(m, n));
    // Live object counts: create* hands the object out, delete* takes it back.
    for (const [noun, kind] of [['Buffer', 'buffers'], ['Texture', 'textures'], ['Program', 'programs'], ['Shader', 'shaders'],
      ['Framebuffer', 'framebuffers'], ['Renderbuffer', 'renderbuffers'], ['VertexArray', 'vertexArrays']]) {
      const mk = p[`create${noun}`], rm = p[`delete${noun}`];
      if (typeof mk === 'function' && !mk.__sloptimize) { p[`create${noun}`] = function () { const o = mk.apply(this, arguments); born(kind, o); return o; }; p[`create${noun}`].__sloptimize = true; }
      if (typeof rm === 'function' && !rm.__sloptimize) { p[`delete${noun}`] = function (o) { died(kind, o); return rm.apply(this, arguments); }; p[`delete${noun}`].__sloptimize = true; }
    }
    // Program links: the WebGL half of "who compiled this?" — the same
    // creation ledger the WebGPU pipeline wraps keep, so a WebGL compile
    // stall classifies as shader-compile and names its call site.
    const link = p.linkProgram;
    if (typeof link === 'function' && !link.__sloptimize) {
      p.linkProgram = function (...a) {
        gpu.creates++; sessionCreates++;
        if (!glSeen) glSeen = this;
        const t0 = performance.now();
        try { return link.apply(this, a); }
        finally {
          if (sessionCreates <= 500) {
            emit({ type: 'gpu-create', at: new Date().toISOString(), fn: 'linkProgram', ms: +(performance.now() - t0).toFixed(2),
              stack: (new Error().stack || '').split('\n').slice(2, 7).join('\n') });
          }
        }
      };
      p.linkProgram.__sloptimize = true;
    }
    // Extension draws: the objects have no global interface to patch, so
    // their prototypes are patched as getExtension first hands one out.
    const getExt = p.getExtension;
    if (typeof getExt === 'function') {
      p.getExtension = function (name) {
        const ext = getExt.call(this, name);
        const ep = (name === 'ANGLE_instanced_arrays' || name === 'WEBGL_multi_draw') && ext ? Object.getPrototypeOf(ext) : null;
        if (ep && !extPatched.has(ep)) {
          extPatched.add(ep);
          if (name === 'ANGLE_instanced_arrays') {
            wrap(ep, 'drawArraysInstancedANGLE', (m, first, n, inst) => drew(m, n, inst));
            wrap(ep, 'drawElementsInstancedANGLE', (m, n, type, off, inst) => drew(m, n, inst));
          } else {
            wrap(ep, 'multiDrawArraysWEBGL', (m, fs, fo, cs, co, dc) => drewMulti(m, sum(cs, co, dc)));
            wrap(ep, 'multiDrawElementsWEBGL', (m, cs, co, type, os, oo, dc) => drewMulti(m, sum(cs, co, dc)));
            wrap(ep, 'multiDrawArraysInstancedWEBGL', (m, fs, fo, cs, co, is, io, dc) => drewMulti(m, sumProd(cs, co, is, io, dc)));
            wrap(ep, 'multiDrawElementsInstancedWEBGL', (m, cs, co, type, os, oo, is, io, dc) => drewMulti(m, sumProd(cs, co, is, io, dc)));
          }
        }
        return ext;
      };
    }
  }
} catch (e) { emit({ type: 'wrap-error', error: String(e) }); }

/** Triangles in a draw of `n` vertices/indices, by primitive mode — lines
 *  and points draw none (renderer.info counts them apart). */
function trianglesOf(mode, n) {
  n = Number(n) || 0;
  if (mode === 4) return Math.floor(n / 3);            // TRIANGLES
  if (mode === 5 || mode === 6) return Math.max(n - 2, 0);   // TRIANGLE_STRIP, TRIANGLE_FAN
  return 0;
}

// ── three.js scenes, through three's own devtools hook ──────────────────────
// Every Scene three.js constructs dispatches itself to `__THREE_DEVTOOLS__`
// when that global exists; defined here, before any page script, it hands
// tier 0 the scene graph with no game code — which is what the instance-slot
// watch (instance-slots.js) needs: stale slots inside an InstancedMesh's
// .count are invisible at the graphics API. A hook already present (the
// three.js devtools extension) is listened on, never replaced. `attach
// --no-slots` turns the whole thing off: no global defined, no checks.
const SLOTS_ON = !(typeof __sloptimizeOpts !== 'undefined' && __sloptimizeOpts.slots === false);
const slotWatch = createSlotWatch();
if (SLOTS_ON) try {
  let hook = globalThis.__THREE_DEVTOOLS__;
  if (!hook || typeof hook.addEventListener !== 'function') {
    hook = new EventTarget();
    globalThis.__THREE_DEVTOOLS__ = hook;
  }
  hook.addEventListener('observe', (e) => {
    try { if (e.detail?.isWebGLRenderer && renderers.length < 4 && typeof WeakRef === 'function') renderers.push(new WeakRef(e.detail)); } catch { /* not ours to break */ }
    try { slotWatch.observe(e.detail); } catch { /* not ours to break */ }
  });
} catch { /* no EventTarget: no scenes, nothing else changes */ }

// ── Long tasks: the JS half of attribution the profiler completes ───────────
let longTaskMs = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTaskMs += e.duration;
  }).observe({ type: 'longtask', buffered: true });
} catch { /* unsupported */ }

// ── The page's phase: the one knob a tier-0 page may turn ───────────────────
// Attach needs no game code, but a run whose workload has distinct phases
// (a spawn flood, then a steady state) is two measurements in one ledger,
// and the long phase dominates on volume alone. One optional line in the
// page — `window.__sloptimizePhase = 'steady'` — and every record after it
// (emit() stamps it) carries `phase`, so the footprint splits by it and
// `sloptimize issues --phase steady` reads one phase. Unset: no field.
function pagePhase() {
  return phaseName(globalThis.__sloptimizePhase);
}
function phaseName(p) {
  return typeof p === 'string' && p ? p.replace(/[|,=\s]+/g, '_').slice(0, 40) : undefined;
}

// ── Phase spans (SPEC §3.15): a phase's duration, its size, its sections ────
// The phase global is an accessor, so every assignment is timed where it
// happens — a load that sets 'load', runs 25 s inside one frame and sets
// 'play' is a 25 s span, though no rAF ever saw it. Two optional calls hang
// figures on the span the page is in:
//   __sloptimizeScale('roads', 1469)               what the phase worked on
//   __sloptimizeSection('createSidewalks', ms, n)  named work, with its call count
// (report a phase's sections before leaving it: they belong to the span
// that is open when they arrive). A span closes on the phase change; the
// open one is snapshotted with the profile window and the heartbeat.
const bootId = Date.now().toString(36);
let spanSeq = 0, phaseValue;
// Recent phase changes, [t, phase]: a hitch is filed under the phase that
// covered most of its frame. Stamped at emit time instead, a 2 s load whose
// last statement sets 'play' was a play hitch.
const phaseLog = [[-Infinity, undefined]];
function phaseOver(from, to) {
  // No accessor (a frozen global), or a game that replaced it with a plain
  // property: the log is stale, and the phase read now is all there is.
  if (phaseLog[phaseLog.length - 1][1] !== pagePhase()) return pagePhase();
  const cover = new Map();
  for (let i = 0; i < phaseLog.length; i++) {
    const a = Math.max(phaseLog[i][0], from), b = Math.min(i + 1 < phaseLog.length ? phaseLog[i + 1][0] : Infinity, to);
    if (b > a) cover.set(phaseLog[i][1], (cover.get(phaseLog[i][1]) ?? 0) + (b - a));
  }
  let best = pagePhase(), most = -1;
  for (const [p, ms] of cover) if (ms > most) { best = p; most = ms; }
  return best;
}
const newSpan = (phase) => ({ id: `${bootId}.${++spanSeq}`, phase, t0: performance.now(), scale: null, sections: null, dirty: false });
let openSpan = newSpan(undefined);
function spanRecord(s, open) {
  const rec = { type: 'phase-span', at: new Date().toISOString(), phase: s.phase, span: s.id, ms: +(performance.now() - s.t0).toFixed(1), tier: 0 };
  if (open) rec.open = true;
  if (s.scale) rec.scale = { ...s.scale };
  if (s.sections) rec.sections = Object.fromEntries([...s.sections].map(([k, v]) => [k, [+v[0].toFixed(3), v[1]]]));
  return rec;
}
function snapshotSpan() {
  if (!openSpan.dirty) return;
  openSpan.dirty = false;
  emit(spanRecord(openSpan, true));
}
try {
  Object.defineProperty(globalThis, '__sloptimizePhase', {
    configurable: true,
    get() { return phaseValue; },
    set(v) {
      phaseValue = v;
      const p = phaseName(v);
      if (p === openSpan.phase) return;
      const ended = openSpan;
      openSpan = newSpan(p);
      phaseLog.push([openSpan.t0, p]);
      if (phaseLog.length > 16) phaseLog.shift();
      // The unnamed boot span is only worth a record when the host hung something on it.
      if (ended.phase !== undefined || ended.scale || ended.sections) emit(spanRecord(ended, false));
    },
  });
} catch { /* a frozen global: the phase still reads, unspanned */ }
globalThis.__sloptimizeScale = function (unit, n) {
  const v = Number(n);
  if (typeof unit !== 'string' || !unit || !Number.isFinite(v) || v <= 0) return;
  (openSpan.scale ??= {})[unit.slice(0, 40)] = v;
  openSpan.dirty = true;
};
globalThis.__sloptimizeSection = function (name, ms, calls = 1) {
  const t = Number(ms), c = Number(calls);
  if (typeof name !== 'string' || !name || !Number.isFinite(t) || t < 0 || !Number.isFinite(c) || c < 0) return;
  const m = (openSpan.sections ??= new Map()), k = name.slice(0, 40);
  const e = m.get(k);
  if (e) { e[0] += t; e[1] += c; } else if (m.size < 200) m.set(k, [t, c]);
  openSpan.dirty = true;
};

/** The renderer the game's own context reports, once it has one. Read off
 *  the game's context, never a probe context of ours. */
function readGpuName() {
  try {
    if (glSeen) {
      const ext = glSeen.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? glSeen.getParameter(ext.UNMASKED_RENDERER_WEBGL) : glSeen.getParameter(glSeen.RENDERER);
      if (typeof r === 'string' && r) return r.slice(0, 160);
    }
    const info = adapterSeen && adapterSeen.info;
    if (info) {
      const s = [info.vendor, info.architecture, info.device, info.description].filter((x) => typeof x === 'string' && x).join(' ');
      if (s) return `WebGPU ${s}`.slice(0, 160);
    }
  } catch { /* a context lost or a browser that refuses */ }
  return undefined;
}

/** The last `n` intervals of the ring, oldest first. */
function lastIntervals(n) {
  const k = Math.min(n, count), out = new Array(k);
  for (let i = 0; i < k; i++) out[i] = frameMsRing[(head - k + i + RING) % RING];
  return out;
}

/** Observe one window; emit `conditions` if the page's half changed. */
function updateConditions() {
  refresh.observe(lastIntervals(PROFILE_EVERY));
  if (gpuName === undefined) gpuName = readGpuName();
  const display = refresh.state();
  const rec = { type: 'conditions', at: new Date().toISOString(), tier: 0 };
  if (display) rec.display = display;
  if (gpuName) rec.gpu = gpuName;
  if (!rec.display && !rec.gpu) return;
  // The device is read every window (a few property reads) so a resized
  // window or a moved-to-another-screen dpr lands in the run's block.
  try { rec.device = browserDevice(globalThis); } catch { /* no navigator */ }
  const d = rec.device ?? {};
  const sig = JSON.stringify([rec.display?.refreshHz, rec.display?.cadence, rec.display?.confirmed, rec.gpu, d.vw, d.vh, d.dpr]);
  if (sig === conditionsSent) return;
  conditionsSent = sig;
  emit(rec);
}

// ── Game counters (SPEC §3.11): the game's own throughput, and its clock ───
// `window.__sloptimizeCount('delivered', n)` counts what the game DID;
// `window.__sloptimizeClock('sim', simMs, 1000)` says how much game time
// passed (value, units per second). A rate over the game's clock is the only
// honest throughput: a faster build covers more game time per wall second.
// Totals per window ride the profile record; every name seen so far reports,
// zero included — a counter that stopped is the finding, not a gap.
const tally = new Map();
let clockName, clockScale = 1, clockStart, clockLast, clockReset = false;
globalThis.__sloptimizeCount = function (name, n = 1) {
  if (typeof name !== 'string' || !name) return;
  const v = Number(n);
  if (!Number.isFinite(v)) return;
  const k = name.slice(0, 40);
  tally.set(k, (tally.get(k) ?? 0) + v);
};
globalThis.__sloptimizeClock = function (name, t, perSecond = 1) {
  const v = Number(t), per = Number(perSecond);
  if (typeof name !== 'string' || !name || !Number.isFinite(v) || !(per > 0)) return;
  const k = name.slice(0, 40);
  if (k !== clockName) { clockName = k; clockScale = per; clockStart = v; clockLast = v; return; }
  if (v < clockLast) clockReset = true;   // a new game, a reload: this window has no honest denominator
  clockLast = v;
};

/** This window's counters (and clock advance), resetting both. */
function takeCounters() {
  if (!tally.size && clockName === undefined) return undefined;
  const out = { tally: Object.fromEntries(tally) };
  for (const k of tally.keys()) tally.set(k, 0);
  if (clockName !== undefined && clockStart !== undefined) {
    out.clock = { name: clockName, seconds: +((clockLast - clockStart) / clockScale).toFixed(4), ...(clockReset ? { reset: true } : {}) };
    clockStart = clockLast; clockReset = false;
  }
  return out;
}

/** The p-th percentile of the frame ring (rare: once per profile/beat). */
function ringPct(p) {
  if (count === 0) return undefined;
  const vals = Array.from(frameMsRing.subarray(0, count)).sort((a, b) => a - b);
  return vals[Math.min(count - 1, Math.floor(p * count))];
}

// Draw counters folded over a window, so a profile or a beat reports the
// MEAN frame, not whichever single frame the timer landed on.
const PROFILE_EVERY = 120;
// The slot watch, offset half a window from the profile so the two never
// share a frame.
const SLOTS_EVERY = 120, SLOTS_AT = 60;
const win = { frames: 0, draws: 0, tris: 0, ms: 0, max: 0, over: new Array(16).fill(0) };
// Frames over FIXED bars, per window: the absolute count a hitch budget needs.
// Detection is relative (2× the rolling median), so a build that is uniformly
// slower clears its own bar less often and reports FEWER hitches; a frame over
// 100 ms is over 100 ms whatever the median did (SPEC §7: frames_over_<N>ms).
const OVER_BARS = [50, 100, 200, 500, 1000];
const beat = { frames: 0, draws: 0, tris: 0 };
const BEAT_MS = 60_000;

// ── The frame loop: detection lives HERE (SPEC v2 §2) ───────────────────────
function tick(ts) {
  requestAnimationFrame(tick);
  if (lastRaf < 0) { lastRaf = ts; return; }
  const frameMs = ts - lastRaf, frameFrom = lastRaf;
  lastRaf = ts;
  frameMsRing[head] = frameMs;
  head = (head + 1) % RING;
  if (count < RING) count++;
  frameNo++;

  const draws = gpu.draws, tris = gpu.triangles, creates = gpu.creates, upKB = gpu.uploadKB;
  const lt = longTaskMs;
  gpu.draws = 0; gpu.triangles = 0; gpu.creates = 0; gpu.uploadKB = 0; longTaskMs = 0;
  win.frames++; win.draws += draws; win.tris += tris; win.ms += frameMs;
  if (frameMs > win.max) win.max = frameMs;
  for (let i = 0; i < OVER_BARS.length; i++) if (frameMs > OVER_BARS[i]) win.over[i]++;
  beat.frames++; beat.draws += draws; beat.tris += tris;

  const median = rollingMedian();
  if (frameMs > ABS_HITCH_MS || (count > 60 && frameMs > Math.max(2 * median, MIN_HITCH_MS))) {
    emit({
      type: 'hitch', at: new Date().toISOString(), frame: frameNo, phase: phaseOver(frameFrom, ts),
      frameMs: +frameMs.toFixed(1), medianMs: +median.toFixed(2),
      // The frame's interval on the page's performance.now() clock: attach
      // maps it onto the sampler's clock and attributes the hitch from the
      // samples inside it — its own profile, not a neighbour's.
      frameSpan: [+frameFrom.toFixed(1), +ts.toFixed(1)],
      // insideRenderMs is unknowable at this tier without the engine; the
      // draw share and long-task ms are the honest stand-ins, and the node
      // side attaches profiler topFrames.
      longTaskMs: +lt.toFixed(1),
      // `delta` is a CHANGE, as in tier 1 (programs created in this frame);
      // what the frame drew is a count, and rides as `render` — the same
      // name and meaning as a profile's. Textures and geometries are not
      // measured at this tier, so they are absent, not zero.
      delta: { programs: creates },
      render: { calls: draws, triangles: tris },
      gpu: { uploadKB: +upKB.toFixed(1) },
      classification: classifyHitch({ frameMs, medianMs: median, insideRenderMs: 0, delta: { programs: creates }, spawned: 0 }),
      tier: 0,
    });
  }
  if (frameNo % PROFILE_EVERY === 0) {
    const p95 = ringPct(0.95);
    const over = {};
    for (let i = 0; i < OVER_BARS.length; i++) over[OVER_BARS[i]] = win.over[i];
    emit({ type: 'profile', at: new Date().toISOString(),
      // maxMs: the window's longest frame — the exact worst, whatever the
      // relative hitch bar recorded.
      frame: { medianMs: +median.toFixed(2), p95Ms: p95 === undefined ? undefined : +p95.toFixed(2), maxMs: +win.max.toFixed(1) },
      render: { calls: Math.round(win.draws / win.frames), triangles: Math.round(win.tris / win.frames), frames: win.frames },
      // `seconds` is visible time: a hidden page re-seeds the clock and draws none.
      window: { frames: win.frames, seconds: +(win.ms / 1000).toFixed(3) }, over,
      ...(takeCounters() ?? {}),
      tier: 0 });
    win.frames = 0; win.draws = 0; win.tris = 0; win.ms = 0; win.max = 0; win.over.fill(0);
    updateConditions();
    snapshotSpan();
  }
  if (SLOTS_ON && frameNo % SLOTS_EVERY === SLOTS_AT) {
    let rows = [];
    try { rows = slotWatch.check(performance.now()); } catch { /* a mesh we could not read */ }
    for (const r of rows) emit({ type: 'instance-slots', at: new Date().toISOString(), ...r, tier: 0 });
  }
}

// ── Heartbeat (INTEGRATION.md §2): once a minute while attached ─────────────
// A quiet ledger then MEANS the session ended, and `history` measures a
// build's hitch rate over the minutes the feed was live — not over the gap
// between two runs of the same build. On a timer, not the rAF: a hidden page
// still beats (with no frame numbers, because it drew none).
try {
  setInterval(() => {
    // `programs` here is creations since the page loaded (links + pipelines);
    // tier 1's is the engine's live count. Both only grow when a compile ran.
    const rec = { type: 'heartbeat', at: new Date().toISOString(), tier: 0, programs: sessionCreates };
    if (liveSeen) rec.gpuLive = { ...live };
    // The engine's own count, if three.js handed us its renderer.
    for (const ref of renderers) {
      const r = ref.deref?.();
      const m = r?.info?.memory;
      if (m) { rec.three = { geometries: m.geometries, textures: m.textures, programs: Array.isArray(r.info.programs) ? r.info.programs.length : undefined }; break; }
    }
    if (beat.frames > 0) {
      const med = ringPct(0.5), p95 = ringPct(0.95);
      rec.medianFrameMs = med === undefined ? undefined : +med.toFixed(2);
      rec.p95Ms = p95 === undefined ? undefined : +p95.toFixed(2);
      rec.calls = Math.round(beat.draws / beat.frames);
      rec.triangles = Math.round(beat.tris / beat.frames);
      rec.frames = beat.frames;
    }
    beat.frames = 0; beat.draws = 0; beat.tris = 0;
    emit(rec);
    snapshotSpan();
  }, BEAT_MS);
} catch { /* no timers */ }
requestAnimationFrame(tick);
// A hidden window (minimized Electron BrowserWindow, background tab) stops
// rAF entirely; without this the first frame back would report the whole
// hidden span as one hitch. Re-seed the clock on either edge.
try {
  document.addEventListener('visibilitychange', () => { lastRaf = -1; });
} catch { /* no document */ }
emit({ type: 'armed', at: new Date().toISOString(), url: location.href });
