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

/* global classifyHitch, __sloptimizeEmit */

const RING = 600;
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
  // WebGL fallback counters — same shape, older API.
  for (const ctxName of ['WebGL2RenderingContext', 'WebGLRenderingContext']) {
    const C = globalThis[ctxName];
    if (!C) continue;
    const de = C.prototype.drawElements, da = C.prototype.drawArrays;
    C.prototype.drawElements = function (m, n, ...a) { gpu.draws++; gpu.triangles += Math.floor(n / 3); return de.call(this, m, n, ...a); };
    C.prototype.drawArrays = function (m, f, n) { gpu.draws++; gpu.triangles += Math.floor(n / 3); return da.call(this, m, f, n); };
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

  const median = rollingMedian();
  if (count > 60 && frameMs > Math.max(2 * median, 25)) {
    emit({
      type: 'hitch', at: new Date().toISOString(), frame: frameNo,
      frameMs: +frameMs.toFixed(1), medianMs: +median.toFixed(2),
      // insideRenderMs is unknowable at this tier without the engine; the
      // draw share and long-task ms are the honest stand-ins, and the node
      // side attaches profiler topFrames.
      longTaskMs: +lt.toFixed(1),
      delta: { calls: draws, triangles: tris, programs: creates, textures: 0, geometries: 0 },
      gpu: { uploadKB: +upKB.toFixed(1) },
      classification: classifyHitch({ frameMs, medianMs: median, insideRenderMs: 0, delta: { programs: creates }, spawned: 0 }),
      tier: 0,
    });
  }
  if (frameNo % 120 === 0) {
    emit({ type: 'profile', at: new Date().toISOString(),
      frame: { medianMs: +median.toFixed(2) },
      render: { calls: draws, triangles: tris }, tier: 0 });
  }
}
requestAnimationFrame(tick);
emit({ type: 'armed', at: new Date().toISOString(), url: location.href });
