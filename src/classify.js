// ============================================================
// classify.js — the closed hitch-classification vocabulary (SPEC §3.3)
// ============================================================
// A guess without its reason is banned (principle 4): every entry returned
// carries `evidence`, and the set is closed — extending it is a spec change,
// not a code change.

/** @typedef {{guess:string, confidence:'low'|'medium'|'high', evidence:string}} Guess */

/**
 * Classify one hitch from its counter deltas and timing split.
 * Returns guesses ranked most-likely-first; always at least one.
 *
 * @param {object} h
 * @param {number} h.frameMs        whole frame delta
 * @param {number} h.medianMs       rolling median at the time of the hitch
 * @param {number} h.insideRenderMs wall time inside the render call
 * @param {object} h.delta          counter deltas vs previous frame
 * @param {number} [h.spawned]      entities spawned this frame (if known)
 * @param {boolean} [h.memorySampled] performance.memory was available
 * @returns {Guess[]}
 */
export function classifyHitch(h) {
  const out = [];
  const d = h.delta ?? {};
  if ((d.programs ?? 0) > 0) {
    out.push({
      guess: 'shader-compile',
      confidence: (d.programs ?? 0) >= 2 ? 'high' : 'medium',
      evidence: `programs +${d.programs} in the hitch frame`,
    });
  }
  if ((d.textures ?? 0) > 0 && (d.programs ?? 0) === 0) {
    out.push({
      guess: 'texture-upload',
      confidence: 'medium',
      evidence: `textures +${d.textures}, programs unchanged`,
    });
  }
  if ((h.spawned ?? 0) >= 3) {
    out.push({
      guess: 'spawn-burst',
      confidence: 'medium',
      evidence: `${h.spawned} entities spawned in the hitch frame`,
    });
  }
  const inside = h.insideRenderMs ?? 0;
  if (inside > 0 && inside >= h.frameMs * 0.6) {
    out.push({
      guess: 'long-render',
      confidence: 'high',
      evidence: `inside-render ${inside.toFixed(1)}ms of a ${h.frameMs.toFixed(1)}ms frame`,
    });
  } else if (h.frameMs > 0 && inside < h.frameMs * 0.25) {
    out.push({
      guess: 'long-script',
      confidence: inside > 0 ? 'medium' : 'low',
      evidence: `frame ${h.frameMs.toFixed(1)}ms with only ${inside.toFixed(1)}ms inside render`,
    });
  }
  if (out.length === 0) {
    out.push({
      guess: 'gc-or-upload-by-elimination',
      confidence: h.memorySampled ? 'medium' : 'low',
      evidence: 'no counter moved and the render share is inconclusive'
        + (h.memorySampled ? '' : ' (performance.memory unavailable, downgrading)'),
    });
  }
  return out;
}
