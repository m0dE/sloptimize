// ============================================================
// recorder.js — the flight recorder (SPEC §3, plus §3.5 usermark)
// ============================================================
// Framework-agnostic: the host calls `frame(sample)` once per render with
// numbers it already has (three's renderer.info + two clock reads). The
// recorder owns the ring, the hitch math, the rate limits and the summaries;
// it allocates nothing on the steady path (pre-allocated ring, records only
// when a hitch or a usermark actually happens).
//
// The host decides transport: `drainRecords()` hands back and clears whatever
// accumulated; the caller ships them wherever its sink lives. The recorder
// must never be the hitch it reports — no JSON, no strings, no closures per
// frame.

import { classifyHitch } from './classify.js';

const RING = 600;                 // ~10s at 60fps (SPEC §3.1)
const MAX_RECORDS_PER_SESSION = 500;
const MIN_RECORD_GAP_MS = 1000;   // at most 1 hitch record per second

const FIELDS = ['frameMs', 'insideRenderMs', 'calls', 'triangles', 'programs',
  'textures', 'geometries', 'spawned'];

export function createRecorder(opts = {}) {
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const budgetFrameMs = opts.budgetFrameMs ?? 16.7;

  // The ring: one Float64Array lane per field plus paused/timestamps lanes.
  const lanes = Object.fromEntries(FIELDS.map((f) => [f, new Float64Array(RING)]));
  const pausedLane = new Uint8Array(RING);
  const atLane = new Float64Array(RING);
  let head = 0;       // next write index
  let count = 0;      // filled slots (≤ RING)
  let frameNo = 0;

  // Rolling median over the last window of NON-paused frames, recomputed
  // lazily at a coarse cadence — a per-frame exact median would sort 600
  // numbers every frame for a threshold that moves slowly.
  let cachedMedian = budgetFrameMs;
  let medianStale = 60;

  let records = [];
  let sessionRecords = 0;
  let droppedSinceLast = 0;
  let lastRecordAt = -Infinity;

  function sortedNonPaused(field, sinceIdx = 0) {
    const vals = [];
    for (let i = 0; i < count; i++) {
      const idx = (head - 1 - i + RING * 2) % RING;
      if (pausedLane[idx]) continue;
      vals.push(lanes[field][idx]);
    }
    vals.sort((a, b) => a - b);
    return vals;
  }
  function pct(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function rollingMedian() {
    if (--medianStale <= 0 || cachedMedian === null) {
      const s = sortedNonPaused('frameMs');
      cachedMedian = pct(s, 0.5) ?? budgetFrameMs;
      medianStale = 60;
    }
    return cachedMedian;
  }

  function prevIdx(back = 1) { return (head - 1 - back + RING * 2) % RING; }

  return {
    /** One frame's numbers. Zero-allocation on the steady path. */
    frame(s) {
      const idx = head;
      for (const f of FIELDS) lanes[f][idx] = s[f] ?? 0;
      pausedLane[idx] = s.paused ? 1 : 0;
      atLane[idx] = now();
      head = (head + 1) % RING;
      if (count < RING) count++;
      frameNo++;

      if (s.paused) return;
      const median = rollingMedian();
      const threshold = Math.max(2 * median, budgetFrameMs * 1.5);
      if (s.frameMs <= threshold || count < 30) return;

      // A hitch. Rate limits first (SPEC §3.3): silence must mean nothing
      // was dropped, so the drops are counted and reported on the NEXT record.
      const t = now();
      if (t - lastRecordAt < MIN_RECORD_GAP_MS || sessionRecords >= MAX_RECORDS_PER_SESSION) {
        droppedSinceLast++;
        return;
      }
      lastRecordAt = t;
      sessionRecords++;

      const prev = prevIdx(1);
      const delta = {};
      for (const f of ['calls', 'triangles', 'programs', 'textures', 'geometries']) {
        delta[f] = count > 1 ? lanes[f][idx] - lanes[f][prev] : 0;
      }
      const rec = {
        type: 'hitch',
        at: new Date().toISOString(),
        frame: frameNo,
        frameMs: s.frameMs,
        medianMs: +median.toFixed(2),
        insideRenderMs: s.insideRenderMs ?? 0,
        delta,
        classification: classifyHitch({
          frameMs: s.frameMs, medianMs: median, insideRenderMs: s.insideRenderMs ?? 0,
          delta, spawned: s.spawned ?? 0, memorySampled: !!s.memorySampled,
        }),
      };
      if (s.world) rec.world = s.world;
      // Phase is a string the HOST passes per frame (menu/boot/launch/match…)
      // — stamped at mint time so the record names the moment the hitch
      // happened, not the moment it was drained/posted (drains run on a 2s
      // cadence, and a launch is over in less).
      if (s.phase) rec.phase = s.phase;
      if (droppedSinceLast > 0) { rec.droppedSinceLast = droppedSinceLast; droppedSinceLast = 0; }
      records.push(rec);
    },

    /** SPEC §3.2 — the rolling summary. Absent fields stay absent. */
    summary() {
      const sortedMs = sortedNonPaused('frameMs');
      const seconds = count > 1
        ? (atLane[prevIdx(0)] - atLane[prevIdx(count - 1)]) / 1000
        : 0;
      const last = prevIdx(0);
      const median = pct(sortedMs, 0.5);
      const s = {
        at: new Date().toISOString(),
        window: { frames: sortedMs.length, seconds: +Math.max(0, seconds).toFixed(1) },
        frame: {},
        render: {}, memory: {},
        paused: count > 0 ? pausedLane[last] === 1 : false,
      };
      if (median !== null) {
        s.frame.medianMs = +median.toFixed(2);
        s.frame.p95Ms = +pct(sortedMs, 0.95).toFixed(2);
        s.frame.fps = median > 0 ? Math.round(1000 / median) : 0;
        const inside = sortedNonPaused('insideRenderMs');
        s.frame.insideRenderMs = +pct(inside, 0.5).toFixed(2);
      }
      if (count > 0) {
        s.render.calls = lanes.calls[last];
        s.render.triangles = lanes.triangles[last];
        s.memory.geometries = lanes.geometries[last];
        s.memory.textures = lanes.textures[last];
        s.memory.programs = lanes.programs[last];
      }
      return s;
    },

    /**
     * §3.5 — USERMARK. The human's half of hitch detection: they FELT it, so
     * they press the key and the recorder freezes the evidence — the trailing
     * `windowMs` of ring samples, summarized, with the worst frames ranked
     * and each classified exactly like an automatic hitch. Exists because the
     * automatic threshold cannot see "it feels wrong" (steady-but-low fps,
     * micro-stutter under the hitch bar), and because a human timestamp turns
     * ten seconds of ring into a labeled training example.
     */
    usermark(meta = {}) {
      const windowMs = meta.windowMs ?? 5000;
      const tNow = now();
      const idxs = [];
      for (let i = 0; i < count; i++) {
        const idx = prevIdx(i);
        if (tNow - atLane[idx] > windowMs) break;
        idxs.push(idx);
      }
      const ms = idxs.filter((i) => !pausedLane[i]).map((i) => lanes.frameMs[i]).sort((a, b) => a - b);
      const worst = [...idxs]
        .filter((i) => !pausedLane[i])
        .sort((a, b) => lanes.frameMs[b] - lanes.frameMs[a])
        .slice(0, 5)
        .map((i) => {
          const prev = (i - 1 + RING) % RING;
          const delta = {};
          for (const f of ['calls', 'triangles', 'programs', 'textures', 'geometries']) {
            delta[f] = lanes[f][i] - lanes[f][prev];
          }
          const median = pct(ms, 0.5) ?? 0;
          // A worst frame UNDER the hitch bar is a healthy window, and saying
          // so beats forcing the classifier to name a culprit for a 17.8ms
          // frame (field capture: a perfect 300-frame window labeled
          // long-script — a guess with no incident under it).
          const nominal = lanes.frameMs[i] <= Math.max(2 * median, 25);
          return {
            agoMs: Math.round(tNow - atLane[i]),
            frameMs: +lanes.frameMs[i].toFixed(1),
            insideRenderMs: +lanes.insideRenderMs[i].toFixed(1),
            delta,
            classification: nominal
              ? [{ guess: 'nominal', confidence: 'high', evidence: `worst frame ${lanes.frameMs[i].toFixed(1)}ms is inside the hitch bar — a healthy window` }]
              : classifyHitch({
                frameMs: lanes.frameMs[i], medianMs: median,
                insideRenderMs: lanes.insideRenderMs[i], delta,
                spawned: lanes.spawned[i],
              }),
          };
        });
      const mark = {
        type: 'usermark',
        at: new Date().toISOString(),
        frame: frameNo,
        window: {
          ms: windowMs,
          frames: idxs.length,
          medianMs: pct(ms, 0.5) !== null ? +pct(ms, 0.5).toFixed(2) : undefined,
          p95Ms: pct(ms, 0.95) !== null ? +pct(ms, 0.95).toFixed(2) : undefined,
        },
        worstFrames: worst,
      };
      if (meta.note) mark.note = meta.note;
      if (meta.phase) mark.phase = meta.phase;
      if (meta.inputsHeld) mark.inputsHeld = meta.inputsHeld;
      if (meta.world) mark.world = meta.world;
      records.push(mark);
      return mark;
    },

    /** Hand back accumulated records and clear — the host owns transport. */
    drainRecords() { const r = records; records = []; return r; },
  };
}
