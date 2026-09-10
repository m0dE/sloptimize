// ============================================================
// gpu.js — what the GPU took (SPEC §3.3, the `gpu-bound` verdict)
// ============================================================
// The one number the flight recorder could never get, and the reason its
// commonest verdict was a guess.
//
// `insideRenderMs` is wall time the CPU spent inside the render call. On a
// GPU-bound frame that is SMALL: the CPU queues commands and returns, and the
// cost lands afterwards in the driver. So a frame waiting on the GPU and a
// frame running a long script are the same shape from the CPU's side, and
// without this every one of them was classified `long-script`. In one field
// deployment 71% of recorded hitches were frames with 5-17 ms of the game's
// own work in them and nothing to say about the other 80.
//
// This is deliberately the smallest thing that answers it: one WebGL2
// extension, a short ring of queries, and a number or null. No three.js, no
// renderer, no per-frame allocation once it is running - a host that has a
// `gl` can have it in one line, and a host that has not is unaffected.
//
// ## Why the answer is always a few frames old
//
// The point of a timer query is that the CPU does not wait for the GPU.
// Asking for a result before the driver has it means blocking, which is the
// stall being measured - the instrument would become the fault. So queries
// are collected when they happen to be ready and the newest completed one is
// reported. For a profile that is exactly right; for a decision inside the
// frame it is useless, and nothing here makes decisions.
//
// ## Disjoint means throw it away
//
// A driver can preempt the GPU - another window, a mode switch, power
// management - and a timing that straddles that is nonsense rather than
// merely inaccurate. `GPU_DISJOINT_EXT` says so, and the honest response is
// to discard everything in flight, not to average it in. A frame rate that
// fluctuates because the driver keeps preempting is worth knowing; an
// invented number is not.
//
// ## Missing is not zero
//
// Browsers restrict this extension - it can be used for timing attacks - so
// it is often simply absent. Then `read()` is null and the classifier is told
// nothing, which leaves its verdicts exactly as they were. The one thing this
// must never do is report a fast GPU because nobody asked.

/** Queries in flight at once: enough to cover the latency, few enough to forget. */
const DEPTH = 4;

/**
 * A GPU clock over a WebGL2 context.
 *
 * @param {WebGL2RenderingContext} gl the context the game draws with
 * @returns {{mark: () => void, read: () => number|null, state: () => object}}
 */
export function createGpuClock(gl) {
  let ext = null;
  let status = 'unavailable';
  const pending = [];
  let open = null;
  let lastMs = null;
  let results = 0, disjoints = 0;

  if (gl && typeof gl.createQuery === 'function') {
    try { ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch { ext = null; }
    if (ext) status = 'ok';
  }

  function drop(q) { try { gl.deleteQuery(q); } catch { /* already gone */ } }

  function collect() {
    let lost = false;
    try { lost = !!gl.getParameter(ext.GPU_DISJOINT_EXT); } catch { lost = false; }
    if (lost) {
      disjoints++;
      status = 'disjoint';
      for (const q of pending) drop(q);
      pending.length = 0;
      lastMs = null;
      return;
    }
    if (status === 'disjoint') status = 'ok';   // it recovers; the gap is simply unmeasured
    while (pending.length) {
      const q = pending[0];
      let done = false;
      try { done = !!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); }
      catch { pending.shift(); drop(q); continue; }
      if (!done) break;                          // in order: nothing behind it is ready either
      pending.shift();
      try { lastMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; results++; }
      catch { /* keep the last good one */ }
      drop(q);
    }
  }

  return {
    /**
     * Once per frame, next to `frame(sample)`.
     *
     * Closes the query the previous mark opened and opens the next, so what
     * is timed is every GPU command issued between two marks - the frame,
     * however the host happens to draw it. One call, no bracketing, nothing
     * for the host to get wrong: a `begin`/`end` pair around the draw is more
     * precise and is one more thing to leave unbalanced, and a query left
     * open makes every `beginQuery` after it fail.
     */
    mark() {
      if (status !== 'ok' && status !== 'disjoint') return;
      if (open) {
        try { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); }
        catch { drop(open); }
        open = null;
      }
      collect();
      if (status !== 'ok' || pending.length >= DEPTH) return;
      let q = null;
      try {
        q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        open = q;
      } catch { if (q) drop(q); open = null; }
    },

    /** The newest GPU frame time that came back, in ms, or null if unknown. */
    read() { return status === 'ok' ? lastMs : null; },

    /** What this knows and why, for a report or a console. */
    state() {
      return { status, ms: lastMs, inFlight: pending.length, results, disjoints };
    },
  };
}
