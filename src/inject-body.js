// ============================================================
// inject-body.js — the tier-0 in-page recorder (SPEC-attach §3)
// ============================================================
// Runs INSIDE the target page, injected over CDP before any page script.
// Self-contained by construction: attach.mjs concatenates classify.js
// (exports stripped) above this file and wraps both in an IIFE — there are
// no imports here, and `classifyHitch` arrives from that concatenation.
// Everything fails soft: a page with no WebGPU, no WebGL, or no rAF still
// records frame timing; a page that never renders records nothing and
// costs nothing.
//
// Outbound edge: `__sloptimizeEmit(jsonLine)` — a CDP binding the attach
// process registered. One JSON record per call; the node side owns files,
// clustering, and the profiler.

/* global classifyHitch, __sloptimizeEmit, __sloptimizeOpts */

const RING = 600;
const PROFILE_EVERY = 120;   // frames between `profile` lines (profile.json)
// The absolute floor for detection: a frame is a hitch above 2× the rolling
// median AND above this. 25 ms by default; `attach --min-hitch-ms N` raises
// it in the page, so sub-floor frames never cross the binding at all.
const MIN_HITCH_MS = Math.max(25, (typeof __sloptimizeOpts !== 'undefined' && +__sloptimizeOpts.minHitchMs) || 0);
const frameMsRing = new Float64Array(RING);
// The per-frame counters beside the timing, so the profile line reports the
// window's MEDIAN frame (what a HUD reading renderer.info shows most of the
// time), not whichever frame happened to be the 120th.
const drawsRing = new Float64Array(RING), trisRing = new Float64Array(RING);
let head = 0, count = 0, frameNo = 0;
let lastRaf = -1;
let medianCache = 16.7, medianStale = 0;

// Per-frame graphics-API counters, reset at each rAF boundary.
const gpu = { draws: 0, triangles: 0, creates: 0, uploadKB: 0 };
let sessionCreates = 0;
let prevDraws = 0, prevTris = 0;   // the previous frame's, for `delta`

function emit(obj) {
  try { __sloptimizeEmit(JSON.stringify(obj)); } catch { /* binding gone */ }
}

// ── The page's own marks (optional): phase, situation, build ────────────────
// Zero integration stays the default. A page that wants its spawn flood read
// apart from its steady state says which is which — stamped on every hitch
// and profile line from the call on, as tier 1 stamps `phase` per frame:
//   __sloptimizeAttach.phase('steady')        ('' or null clears)
//   __sloptimizeAttach.context({ map: 'harbor', units: 'many' })   low-cardinality facets
//   __sloptimizeAttach.build('index-CNbvoNb_')   overrides `attach --build`
// Installed before any page script runs; the node side canonicalises the
// facets and heartbeats each phase change.
const marks = { phase: undefined, ctx: undefined, build: undefined };
const markText = (v) => (v === undefined || v === null || v === '' ? undefined : String(v).replace(/[|,\s]+/g, '_').slice(0, 40));
function stampMarks(rec) {
  if (marks.phase !== undefined) rec.phase = marks.phase;
  if (marks.ctx !== undefined) rec.ctx = marks.ctx;
  if (marks.build !== undefined) rec.build = marks.build;
  return rec;
}
try {
  globalThis.__sloptimizeAttach = {
    phase(name) { marks.phase = markText(name); },
    context(facets) {
      if (!facets || typeof facets !== 'object') { marks.ctx = undefined; return; }
      const c = {};
      for (const k of Object.keys(facets)) { const v = markText(facets[k]); if (v !== undefined) c[k] = v; }
      marks.ctx = Object.keys(c).length ? c : undefined;
    },
    build(id) { marks.build = id === undefined || id === null || id === '' ? undefined : String(id).slice(0, 80); },
  };
} catch { /* a frozen global: the marks are optional */ }

/** The value at quantile `q` of the first `n` slots of a ring. */
function quantile(ring, n, q) {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(ring[i]);
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * q))] : 0;
}

function rollingMedian() {
  if (--medianStale > 0) return medianCache;
  const vals = [];
  for (let i = 0; i < count; i++) vals.push(frameMsRing[i]);
  vals.sort((a, b) => a - b);
  medianCache = vals.length ? vals[Math.floor(vals.length / 2)] : 16.7;
  medianStale = 60;
  return medianCache;
}

// ── Graphics-API wraps: the engine-free counters ────────────────────────────
// Every entry point three.js (r160) draws through is counted, or tier 0
// under-reads the app's own renderer.info by the whole of its instancing
// (ticket 20cd5dc2: 79 calls here, 306 in renderer.info). Calls and
// triangles are counted as renderer.info counts them — one call per API
// call (a multi-draw is one), triangles by primitive mode × instances — so
// the two can be read side by side.

/** Triangles `n` vertices make in `mode`: TRIANGLES n/3, STRIP/FAN n−2,
 *  lines and points none (renderer.info counts those apart). */
function trianglesOf(mode, n) {
  return mode === 4 ? Math.floor(n / 3) : (mode === 5 || mode === 6) ? Math.max(n - 2, 0) : 0;
}
function countDraw(mode, n, instances) {
  gpu.draws++;
  gpu.triangles += trianglesOf(mode, n) * (instances === undefined ? 1 : instances);
}
/** A multi-draw: ONE call (as renderer.info counts it), the triangles of
 *  every sub-draw it carries. */
function countMulti(mode, counts, countsOffset, drawCount, instances, instancesOffset) {
  gpu.draws++;
  let t = 0;
  for (let i = 0; i < drawCount; i++) t += trianglesOf(mode, counts[countsOffset + i]) * (instances ? instances[instancesOffset + i] : 1);
  gpu.triangles += t;
}
/** Replace `obj[name]` with a pass-through that calls `before` first. */
function wrapCall(obj, name, before) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function () { before.apply(null, arguments); return orig.apply(this, arguments); };
}
/** A pipeline/program CREATION: counted into the frame, timed, and — rare,
 *  so a stack per creation is affordable — ledgered with the stack that
 *  asked for it: the engine-free answer to "who compiled this?". */
function wrapCreate(obj, fn, labelOf) {
  const orig = obj[fn];
  if (typeof orig !== 'function') return;
  obj[fn] = function () {
    gpu.creates++; sessionCreates++;
    const t0 = performance.now();
    try { return orig.apply(this, arguments); }
    finally {
      const ms = performance.now() - t0;
      if (sessionCreates <= 500) {
        const label = labelOf ? labelOf(arguments) : undefined;
        emit({ type: 'gpu-create', at: new Date().toISOString(), fn, ms: +ms.toFixed(2),
          label: label ? String(label).slice(0, 80) : undefined,
          stack: (new Error().stack || '').split('\n').slice(2, 7).join('\n') });
      }
    }
  };
}
// Extension objects are handed out by getExtension, never global: patch
// each one's prototype the first time the page asks for it.
const EXTENSION_DRAWS = {
  ANGLE_instanced_arrays: {
    drawArraysInstancedANGLE: (m, f, n, inst) => countDraw(m, n, inst),
    drawElementsInstancedANGLE: (m, n, t, o, inst) => countDraw(m, n, inst),
  },
  WEBGL_multi_draw: {
    multiDrawArraysWEBGL: (m, firsts, fo, counts, co, dc) => countMulti(m, counts, co, dc),
    multiDrawElementsWEBGL: (m, counts, co, t, offs, oo, dc) => countMulti(m, counts, co, dc),
    multiDrawArraysInstancedWEBGL: (m, firsts, fo, counts, co, insts, io, dc) => countMulti(m, counts, co, dc, insts, io),
    multiDrawElementsInstancedWEBGL: (m, counts, co, t, offs, oo, insts, io, dc) => countMulti(m, counts, co, dc, insts, io),
  },
};
const patchedExtensions = new WeakSet();
function patchExtension(name, ext) {
  const draws = EXTENSION_DRAWS[name];
  if (!draws || !ext || typeof ext !== 'object') return;
  const target = Object.getPrototypeOf(ext) ?? ext;
  if (patchedExtensions.has(target)) return;
  patchedExtensions.add(target);
  for (const fn of Object.keys(draws)) wrapCall(target, fn, draws[fn]);
}

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
      wrapCreate(dp, fn, (a) => (a[0] && a[0].label ? a[0].label : undefined));
    }
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
  // WebGL counters — same shape, older API. A program LINK is WebGL's
  // pipeline creation (three links one per material variant, in the frame
  // that first needs it), so `programs` and the creation ledger work here
  // as they do on WebGPU.
  for (const ctxName of ['WebGL2RenderingContext', 'WebGLRenderingContext']) {
    const C = globalThis[ctxName];
    if (!C) continue;
    const P = C.prototype;
    wrapCall(P, 'drawElements', (m, n) => countDraw(m, n));
    wrapCall(P, 'drawArrays', (m, f, n) => countDraw(m, n));
    wrapCall(P, 'drawElementsInstanced', (m, n, t, o, inst) => countDraw(m, n, inst));   // WebGL2
    wrapCall(P, 'drawArraysInstanced', (m, f, n, inst) => countDraw(m, n, inst));
    wrapCall(P, 'drawRangeElements', (m, start, end, n) => countDraw(m, n));
    wrapCreate(P, 'linkProgram');
    const ge = P.getExtension;
    if (typeof ge === 'function') {
      P.getExtension = function (name) {
        const ext = ge.call(this, name);
        try { patchExtension(name, ext); } catch { /* an extension we cannot patch still works */ }
        return ext;
      };
    }
  }
} catch (e) { emit({ type: 'wrap-error', error: String(e) }); }

// ── Long tasks: the JS half of attribution the profiler completes ───────────
let longTaskMs = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTaskMs += e.duration;
  }).observe({ type: 'longtask', buffered: true });
} catch { /* unsupported */ }

// ── The frame loop: detection lives HERE (SPEC v2 §2) ───────────────────────
function tick(ts) {
  requestAnimationFrame(tick);
  if (lastRaf < 0) {
    // (Re)seeding the clock: whatever was drawn before belongs to no frame.
    lastRaf = ts;
    gpu.draws = 0; gpu.triangles = 0; gpu.creates = 0; gpu.uploadKB = 0; longTaskMs = 0;
    return;
  }
  const frameMs = ts - lastRaf;
  lastRaf = ts;

  const draws = gpu.draws, tris = gpu.triangles, creates = gpu.creates, upKB = gpu.uploadKB;
  const lt = longTaskMs;
  gpu.draws = 0; gpu.triangles = 0; gpu.creates = 0; gpu.uploadKB = 0; longTaskMs = 0;

  frameMsRing[head] = frameMs;
  drawsRing[head] = draws;
  trisRing[head] = tris;
  head = (head + 1) % RING;
  if (count < RING) count++;
  frameNo++;

  const median = rollingMedian();
  if (count > 60 && frameMs > Math.max(2 * median, MIN_HITCH_MS)) {
    emit(stampMarks({
      type: 'hitch', at: new Date().toISOString(), frame: frameNo,
      frameMs: +frameMs.toFixed(1), medianMs: +median.toFixed(2),
      // insideRenderMs is unknowable at this tier without the engine; the
      // draw share and long-task ms are the honest stand-ins, and the node
      // side attaches profiler topFrames.
      longTaskMs: +lt.toFixed(1),
      // `render`: what this frame drew. `delta`: what changed against the
      // frame before, the meaning `delta` has at tier 1 (recorder.js) — and
      // `programs` is the links/pipelines created in this frame, which is
      // tier 1's programs delta too. Textures and geometries are not
      // visible from the API wraps: absent, never a measured zero.
      render: { calls: draws, triangles: tris },
      delta: { calls: draws - prevDraws, triangles: tris - prevTris, programs: creates },
      gpu: { uploadKB: +upKB.toFixed(1) },
      classification: classifyHitch({ frameMs, medianMs: median, insideRenderMs: 0, delta: { programs: creates }, spawned: 0 }),
      tier: 0,
    }));
  }
  prevDraws = draws; prevTris = tris;
  if (frameNo % PROFILE_EVERY === 0) {
    // The window is the whole ring (the same frames the hitch median is
    // taken over); insideRenderMs and programs stay absent — tier 0 does
    // not know them, and the report says what it has.
    const med = quantile(frameMsRing, count, 0.5);
    emit(stampMarks({ type: 'profile', at: new Date().toISOString(),
      frame: { medianMs: +med.toFixed(2), p95Ms: +quantile(frameMsRing, count, 0.95).toFixed(2), fps: med > 0 ? Math.round(1000 / med) : 0 },
      render: { calls: quantile(drawsRing, count, 0.5), triangles: quantile(trisRing, count, 0.5) },
      window: { frames: count }, tier: 0 }));
  }
}
requestAnimationFrame(tick);
// A hidden window (minimized Electron BrowserWindow, background tab) stops
// rAF entirely; without this the first frame back would report the whole
// hidden span as one hitch. Re-seed the clock on either edge.
try {
  document.addEventListener('visibilitychange', () => { lastRaf = -1; });
} catch { /* no document */ }
emit({ type: 'armed', at: new Date().toISOString(), url: location.href });
