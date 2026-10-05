// ============================================================
// classify.js — the closed hitch-classification vocabulary (SPEC §3.3)
// ============================================================
// A guess without its reason is banned (principle 4): every entry returned
// carries `evidence`, and the set is closed — extending it is a spec change,
// not a code change.

/** @typedef {{guess:string, confidence:'low'|'medium'|'high', evidence:string}} Guess */
/** A span the HOST measured inside the hitch's gap, by its own instrument:
 *  a loop section over its baseline, a tagged activity that ran off-loop
 *  (a worker-less server tick, a shader warm), an attributed long task. */
/** @typedef {{label:string, ms:number}} AttributedSpan */

/** The share of the hitch's excess a host span must explain to be the verdict,
 *  and the share at which the verdict is confident. A span covering half the
 *  excess names the cause; one covering four fifths leaves nothing to argue. */
export const ATTRIBUTED_SHARE = 0.5;
export const ATTRIBUTED_CONFIDENT_SHARE = 0.8;
/** Below this many ms a span is noise beside the clock, whatever its share. */
export const ATTRIBUTED_FLOOR_MS = 2;

/**
 * The host's own attribution as a verdict, or null when no span explains
 * enough of the excess. Ranked ahead of every counter-derived guess by the
 * caller, because a name the host MEASURED beats a shape inferred from
 * deltas: a 14 ms frame whose host tag says "mesh:step 12 ms" is not
 * "gc-or-upload-by-elimination", whatever the counters failed to move.
 *
 * `excessMs` is the frame past its median — the part that needs explaining.
 * A span longer than the excess (a tag that overlaps the whole frame) is
 * clamped to it; the evidence prints both numbers so a reader can tell.
 *
 * @param {AttributedSpan[]|undefined} spans
 * @param {number} excessMs
 * @returns {Guess|null}
 */
export function attributedGuess(spans, excessMs) {
  if (!Array.isArray(spans) || spans.length === 0 || !(excessMs > 0)) return null;
  let top = null;
  for (const s of spans) {
    if (!s || typeof s.label !== 'string' || !(s.ms > 0)) continue;
    if (top === null || s.ms > top.ms) top = s;
  }
  if (top === null || top.ms < ATTRIBUTED_FLOOR_MS) return null;
  const share = Math.min(1, top.ms / excessMs);
  if (share < ATTRIBUTED_SHARE) return null;
  return {
    guess: 'host-attributed',
    confidence: share >= ATTRIBUTED_CONFIDENT_SHARE ? 'high' : 'medium',
    evidence: `${top.label} ${top.ms.toFixed(1)}ms of ${excessMs.toFixed(1)}ms excess, host-instrumented`,
  };
}

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
 * @param {AttributedSpan[]} [h.attributed] what the host's own instruments
 *   measured inside the gap — usually absent at mint time (a host seals its
 *   attribution after the frame) and supplied through `reclassify` later
 * @param {number} [h.gpuMs]        GPU time for the frame, if the driver said
 *                                  (src/gpu.js). ABSENT means unmeasured and
 *                                  is never read as zero.
 * @returns {Guess[]}
 */
export function classifyHitch(h) {
  const out = [];
  const d = h.delta ?? {};
  const excess = (h.frameMs ?? 0) - (h.medianMs ?? 0);
  const attributed = attributedGuess(h.attributed, excess);
  if (attributed) out.push(attributed);
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
  // What the GPU took, if anybody counted. This has to be decided BEFORE the
  // render share, because the two are not independent: `insideRenderMs` is
  // wall time the CPU spent inside the render call, and on a GPU-bound frame
  // that is small - the CPU queues the commands and returns, and the cost
  // lands afterwards in the driver. So a frame waiting on the GPU and a frame
  // running a long script are the SAME SHAPE from the CPU's side, and without
  // this number every one of them was called `long-script`.
  const gpu = typeof h.gpuMs === 'number' && h.gpuMs >= 0 ? h.gpuMs : null;
  const gpuBound = gpu !== null && h.frameMs > 0 && gpu >= h.frameMs * 0.6;
  if (gpuBound) {
    out.push({
      guess: 'gpu-bound',
      confidence: 'high',
      evidence: `GPU ${gpu.toFixed(1)}ms of a ${h.frameMs.toFixed(1)}ms frame`,
    });
  }
  const inside = h.insideRenderMs ?? 0;
  if (inside > 0 && inside >= h.frameMs * 0.6) {
    out.push({
      guess: 'long-render',
      confidence: 'high',
      evidence: `inside-render ${inside.toFixed(1)}ms of a ${h.frameMs.toFixed(1)}ms frame`,
    });
  } else if (h.frameMs > 0 && inside < h.frameMs * 0.25 && !gpuBound) {
    // Knowing the GPU was IDLE is what makes this verdict worth acting on:
    // the frame is long, the render call was short, and the drawing was not
    // the reason - so it really is script, or something outside the loop.
    // Unmeasured, it stays the low-confidence guess it always was.
    out.push({
      guess: 'long-script',
      confidence: gpu !== null ? 'high' : (inside > 0 ? 'medium' : 'low'),
      evidence: `frame ${h.frameMs.toFixed(1)}ms with only ${inside.toFixed(1)}ms inside render`
        + (gpu !== null ? `, and ${gpu.toFixed(1)}ms on the GPU` : ''),
    });
  }
  // By elimination ONLY when nothing — counters or host — said anything. An
  // attributed verdict alone is a complete answer, not a gap to fill.
  if (out.length === 0) {
    out.push({
      guess: 'gc-or-upload-by-elimination',
      confidence: h.memorySampled ? 'medium' : 'low',
      evidence: 'no counter moved and the render share is inconclusive'
        // Only RULE THE DRAWING OUT when the GPU was genuinely small. A
        // frame of 125 ms with 56 ms on the GPU is not gpu-bound by the
        // threshold above and is certainly not evidence that drawing was
        // innocent - saying so was a confident sentence pointing the reader
        // away from nearly half the frame. Above that, report the number and
        // draw no conclusion from it, which is what the honest version of
        // "inconclusive" looks like.
        + (gpu === null ? ''
          // An idle GPU rules out the GPU, not the CPU's own render work: say
          // which, when the render call itself took a real share.
          : gpu < h.frameMs * 0.25 ? (inside < h.frameMs * 0.25 ? `; the GPU took ${gpu.toFixed(1)}ms, so the drawing was not it`
            : `; the GPU took ${gpu.toFixed(1)}ms, so the GPU was not it — ${inside.toFixed(1)}ms of the frame was the CPU inside the render call`)
            : `; the GPU took ${gpu.toFixed(1)}ms of it, which is neither small nor most of the frame`)
        + (h.memorySampled ? '' : ' (performance.memory unavailable, downgrading)'),
    });
  }
  return out;
}

/** Spans carried on a record — enough to name the cause and its runner-up. */
export const ATTRIBUTED_PER_RECORD = 3;

/**
 * Re-run a hitch record's verdict with the host's attribution, in place.
 *
 * A host seals its own attribution AFTER the frame the recorder minted the
 * record in — the loop's section table closes at the end of the body, the
 * browser's long-task and long-animation-frame entries arrive a drain or two
 * later — so the verdict stamped at mint time never had it. This is the
 * second look, at drain time: the record's own counters and timing, plus
 * what the host measured, through the same classifier. The spans are kept
 * on the record (`attributed`, largest first) so a reader sees what the
 * verdict rests on, and the footprint keys on the top one.
 *
 * Idempotent, and a no-op for anything that is not a hitch or carries no
 * spans: a record that gains nothing keeps the verdict it had.
 *
 * @param {object} rec  a `hitch` record from the recorder
 * @param {AttributedSpan[]} spans
 * @returns {boolean} whether the verdict changed
 */
export function reclassify(rec, spans) {
  if (!rec || rec.type !== 'hitch' || !Array.isArray(spans)) return false;
  const kept = spans
    .filter((s) => s && typeof s.label === 'string' && s.ms > 0)
    .map((s) => ({ label: s.label.slice(0, 80), ms: Math.round(s.ms * 10) / 10 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, ATTRIBUTED_PER_RECORD);
  if (kept.length === 0) return false;
  rec.attributed = kept;
  const before = rec.classification?.[0]?.guess;
  rec.classification = classifyHitch({
    frameMs: rec.frameMs, medianMs: rec.medianMs, insideRenderMs: rec.insideRenderMs ?? 0,
    delta: rec.delta ?? {}, spawned: rec.world?.spawned?.length ?? rec.spawned ?? 0,
    memorySampled: !!rec.memorySampled, attributed: kept,
    // The GPU's time stays part of the verdict when the host re-seals it.
    ...(typeof rec.gpuMs === 'number' ? { gpuMs: rec.gpuMs } : {}),
  });
  return rec.classification[0]?.guess !== before;
}
