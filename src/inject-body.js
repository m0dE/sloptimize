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
// The absolute floor for detection: a frame is a hitch above 2× the rolling
// median AND above this. 25 ms by default; `attach --min-hitch-ms N` raises
// it in the page, so sub-floor frames never cross the binding at all.
const MIN_HITCH_MS = Math.max(25, (typeof __sloptimizeOpts !== 'undefined' && +__sloptimizeOpts.minHitchMs) || 0);
const frameMsRing = new Float64Array(RING);
let head = 0, count = 0, frameNo = 0;
let lastRaf = -1;
let medianCache = 16.7, medianStale = 0;

// Per-frame graphics-API counters, reset at each rAF boundary.
const gpu = { draws: 0, triangles: 0, creates: 0, uploadKB: 0 };
let sessionCreates = 0;

function emit(obj) {
  try { __sloptimizeEmit(JSON.stringify(obj)); } catch { /* binding gone */ }
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
    // Program links: the WebGL half of "who compiled this?" — the same
    // creation ledger the WebGPU pipeline wraps keep, so a WebGL compile
    // stall classifies as shader-compile and names its call site.
    const link = p.linkProgram;
    if (typeof link === 'function' && !link.__sloptimize) {
      p.linkProgram = function (...a) {
        gpu.creates++; sessionCreates++;
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
// page — `window.__sloptimizePhase = 'steady'` — and every hitch, profile
// and heartbeat after it carries `phase`, so the footprint splits by it and
// `sloptimize issues --phase steady` reads one phase. Unset: no field.
function pagePhase() {
  const p = globalThis.__sloptimizePhase;
  return typeof p === 'string' && p ? p.replace(/[|,=\s]+/g, '_').slice(0, 40) : undefined;
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
const win = { frames: 0, draws: 0, tris: 0 };
const beat = { frames: 0, draws: 0, tris: 0 };
const BEAT_MS = 60_000;

// ── The frame loop: detection lives HERE (SPEC v2 §2) ───────────────────────
function tick(ts) {
  requestAnimationFrame(tick);
  if (lastRaf < 0) { lastRaf = ts; return; }
  const frameMs = ts - lastRaf;
  lastRaf = ts;
  frameMsRing[head] = frameMs;
  head = (head + 1) % RING;
  if (count < RING) count++;
  frameNo++;

  const draws = gpu.draws, tris = gpu.triangles, creates = gpu.creates, upKB = gpu.uploadKB;
  const lt = longTaskMs;
  gpu.draws = 0; gpu.triangles = 0; gpu.creates = 0; gpu.uploadKB = 0; longTaskMs = 0;
  win.frames++; win.draws += draws; win.tris += tris;
  beat.frames++; beat.draws += draws; beat.tris += tris;

  const median = rollingMedian();
  if (count > 60 && frameMs > Math.max(2 * median, MIN_HITCH_MS)) {
    emit({
      type: 'hitch', at: new Date().toISOString(), frame: frameNo,
      frameMs: +frameMs.toFixed(1), medianMs: +median.toFixed(2),
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
      tier: 0, phase: pagePhase(),
    });
  }
  if (frameNo % PROFILE_EVERY === 0) {
    const p95 = ringPct(0.95);
    emit({ type: 'profile', at: new Date().toISOString(),
      frame: { medianMs: +median.toFixed(2), p95Ms: p95 === undefined ? undefined : +p95.toFixed(2) },
      render: { calls: Math.round(win.draws / win.frames), triangles: Math.round(win.tris / win.frames), frames: win.frames },
      tier: 0, phase: pagePhase() });
    win.frames = 0; win.draws = 0; win.tris = 0;
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
    const rec = { type: 'heartbeat', at: new Date().toISOString(), tier: 0, programs: sessionCreates, phase: pagePhase() };
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
