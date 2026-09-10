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
//
// The 1/s rate limit is a WINDOW, and the record for a window is its WORST
// hitch. A hitch opens a one-second window; every hitch inside it competes
// for the one record, the bigger frame wins, and the losers are counted
// onto that record's `droppedSinceLast`. The record leaves on the first
// frame after the window closes (or on a `final` drain). The alternative —
// keep the first hitch of the second and drop the rest — blinds the
// instrument exactly when it matters: a session dropping one 17 ms frame
// every second at a 120 Hz grade (mecharoyale 2026-09-07, 32 of 199 hitches
// dropped) would swallow a 300 ms freeze that landed 200 ms after one of
// them, and the catalogue would say the session's worst frame was 92 ms.

import { classifyHitch } from './classify.js';

const RING = 600;                 // ~10s at 60fps (SPEC §3.1)
const MAX_RECORDS_PER_SESSION = 500;
const MIN_RECORD_GAP_MS = 1000;   // at most 1 hitch record per second

const FIELDS = ['frameMs', 'insideRenderMs', 'calls', 'triangles', 'programs',
  'textures', 'geometries', 'spawned'];

// What the GPU took, which is optional and must stay distinguishable from
// zero: a host with no timer query extension has NOT measured an idle GPU,
// and storing its silence as 0 would tell the classifier the drawing was
// ruled out. Its own lane, NaN for "nobody said", never percentiled.
const GPU_FIELD = 'gpuMs';

export function createRecorder(opts = {}) {
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const budgetFrameMs = opts.budgetFrameMs ?? 16.7;

  // The ring: one Float64Array lane per field plus paused/timestamps lanes.
  const lanes = Object.fromEntries(FIELDS.map((f) => [f, new Float64Array(RING)]));
  const gpuLane = new Float64Array(RING).fill(NaN);
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
  let droppedSinceLast = 0;   // the session cap's drops — reported on the next record through
  // The open hitch window: the record it will emit, when it opened, and the
  // hitches that lost to it.
  let pending = null;
  // Records leave in MINT order whatever order they land in `records`: a
  // window's record is minted at its hitch but pushed when the window closes,
  // after anything emitted meanwhile. The order lives beside the record, not
  // on it (nothing extra is serialized).
  const mintSeq = new WeakMap();
  let seq = 0;
  const minted = (rec) => { mintSeq.set(rec, ++seq); return rec; };
  function place(rec) {
    const s = mintSeq.get(rec) ?? ++seq;
    let i = records.length;
    while (i > 0 && (mintSeq.get(records[i - 1]) ?? 0) > s) i--;
    records.splice(i, 0, rec);
  }
  let lastPhase;   // most recent s.phase seen by frame(), for emit()'s stamping
  let lastCtx;     // most recent s.ctx seen by frame(), for emit()'s stamping

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

  /** The window closed: its worst hitch becomes the record, its losers ride
   *  on it, and it takes its place in mint order among what was pushed since. */
  function flushPending() {
    const { rec, dropped } = pending;
    pending = null;
    if (dropped + droppedSinceLast > 0) { rec.droppedSinceLast = dropped + droppedSinceLast; droppedSinceLast = 0; }
    place(rec);
  }

  return {
    /** One frame's numbers. Zero-allocation on the steady path. */
    frame(s) {
      if (s.phase) lastPhase = s.phase;
      if (s.ctx) lastCtx = s.ctx;
      const idx = head;
      for (const f of FIELDS) lanes[f][idx] = s[f] ?? 0;
      gpuLane[idx] = typeof s[GPU_FIELD] === 'number' && s[GPU_FIELD] >= 0 ? s[GPU_FIELD] : NaN;
      pausedLane[idx] = s.paused ? 1 : 0;
      const t = atLane[idx] = now();
      head = (head + 1) % RING;
      if (count < RING) count++;
      frameNo++;
      if (pending !== null && t - pending.openedAt >= MIN_RECORD_GAP_MS) flushPending();

      if (s.paused) return;
      const median = rollingMedian();
      const threshold = Math.max(2 * median, budgetFrameMs * 1.5);
      if (s.frameMs <= threshold || count < 30) return;

      // A hitch. Rate limits first (SPEC §3.3): silence must mean nothing
      // was dropped, so the drops are counted and reported — the window's
      // losers on the window's own record, the session cap's on the next one.
      if (pending !== null) {
        pending.dropped++;
        if (s.frameMs <= pending.rec.frameMs) return;
      } else if (sessionRecords >= MAX_RECORDS_PER_SESSION) {
        droppedSinceLast++;
        return;
      }

      const prev = prevIdx(1);
      const delta = {};
      for (const f of ['calls', 'triangles', 'programs', 'textures', 'geometries']) {
        delta[f] = count > 1 ? lanes[f][idx] - lanes[f][prev] : 0;
      }
      const rec = minted({
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
          gpuMs: gpuLane[idx],
        }),
      });
      // Absent unless somebody counted, so a reader can tell "the GPU was
      // idle" from "nobody asked" - the whole point of the lane.
      if (Number.isFinite(gpuLane[idx])) rec.gpuMs = +gpuLane[idx].toFixed(2);
      if (s.world) rec.world = s.world;
      // Phase is a string the HOST passes per frame (menu/boot/launch/match…)
      // — stamped at mint time so the record names the moment the hitch
      // happened, not the moment it was drained/posted (drains run on a 2s
      // cadence, and a launch is over in less).
      if (s.phase) rec.phase = s.phase;
      // The host's situation facets (SPEC §3.7), a canonical string the host
      // refreshes on its own cadence — stamped at mint like the phase.
      if (s.ctx) rec.ctx = s.ctx;
      if (pending !== null) { pending.rec = rec; return; }   // the worse hitch takes the window
      sessionRecords++;
      pending = { rec, openedAt: t, dropped: 0 };
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
                spawned: lanes.spawned[i], gpuMs: gpuLane[i],
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
      if (meta.ctx) mark.ctx = meta.ctx;
      if (meta.inputsHeld) mark.inputsHeld = meta.inputsHeld;
      if (meta.world) mark.world = meta.world;
      records.push(minted(mark));
      return mark;
    },

    /** Append an externally built incident (errors, host-detected events). Same session cap as hitches. */
    emit(rec) {
      if (!rec || typeof rec !== 'object') return false;
      if (sessionRecords >= MAX_RECORDS_PER_SESSION) { droppedSinceLast++; return false; }
      sessionRecords++;
      if (!rec.at) rec.at = new Date().toISOString();
      if (rec.phase === undefined && lastPhase) rec.phase = lastPhase;
      if (rec.ctx === undefined && lastCtx) rec.ctx = lastCtx;
      if (droppedSinceLast > 0) { rec.droppedSinceLast = droppedSinceLast; droppedSinceLast = 0; }
      records.push(minted(rec));
      return true;
    },

    /** Hand back accumulated records and clear — the host owns transport.
     *  A hitch window still open rides to the next drain (its record is not
     *  decided yet); `{ final: true }` — the host is going away — closes it now. */
    drainRecords(opts) {
      if (pending !== null && (opts?.final || now() - pending.openedAt >= MIN_RECORD_GAP_MS)) flushPending();
      const r = records; records = []; return r;
    },
  };
}
