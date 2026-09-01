// ============================================================
// motion.js — coordinate continuity: the jitter detector (SPEC §3.6)
// ============================================================
// The recorder's hitch math is about TIME: a frame that took too long. This
// module is about SPACE: a tracked point — the player's unit, the camera —
// that did not arrive where its own motion said it would. The operator sees
// a hitch as a stutter and a jump as a snap; the second was invisible to
// every instrument here until it was asked for in as many words ("my player
// unit/camera's coordinate suddenly jumping instead of smoothly transitioning
// at every frame").
//
// The test is a one-step prediction. With the last two samples p0, p1 at
// t0, t1, constant velocity predicts p̂ = p1 + (p1 − p0)/(t1 − t0)·(t2 − t1);
// the residual r = p2 − p̂ is how far the point landed OFF its own trajectory.
// Smooth motion has residuals of ½·a·dt² — millimetres for anything a physics
// step accelerates. A frame that took longer moves the point proportionally
// further and the prediction scales with dt, so a long frame with dt-scaled
// motion is NOT a jump.
//
// A residual alone is a velocity change (a dash starting, a camera boom
// beginning to ease back out) — legitimate. What makes it a JUMP is that the
// next frame REVERSES it: a point displaced by d that then continues at its
// old velocity is predicted d further along and lands d back. So an event is
// confirmed one frame late, on the reversal; a residual the next frame does
// not reverse is a change of motion and is not reported (stated limit: a
// snap that coincides with an equal-and-opposite velocity change reads as
// one). The reversal is compared as a VELOCITY anomaly (residual ÷ frame
// time): a jump that lands in a 400ms stall frame is pulled back in the 17ms
// frame after it by 1/24 of the distance, and in position units that is not
// a reversal at all.
//
// Consecutive events (≤3 frames apart) fold into one BURST: one event is a
// `snap`, two or more an `oscillation` — the signature of a fixed-step sim
// drawn at a higher rate without interpolation, or of two writers fighting
// over one transform. A burst posts as ONE record when it closes (or every
// 2s while it goes on), rate-limited like hitches so a storm can never be the
// hitch it reports.
//
// HELD frames: the host says when a frame is input-driven (a mouse flick
// swings a camera boom metres in one frame — intended, not a jump) or paused,
// and the track re-seeds after it. CUTS: the host says when the view changed
// on purpose (mode flip, spectate target, respawn); the track re-seeds.
// Nothing here guesses what the host meant.
//
// Pure: no DOM, no three.js; positions are numbers in the host's own unit.
// Steady path allocates nothing (per-track state is preallocated; strings and
// objects exist only when a burst closes).

const DT_RING = 64;
const EVENT_RING = 8;

/**
 * @param {object} opts
 * @param {Record<string, {floor:number, reach?:string, follows?:string}>} opts.tracks
 *   One entry per tracked point. `floor` is the smallest residual (host
 *   units) worth calling a jump; `reach` names the optional scalar the host
 *   samples beside the point (the camera's distance to its pivot) so a jump
 *   that is a change of that distance can say so; `follows` names the track
 *   this one is attached to (the camera follows the unit), so a jump shared
 *   with it is explained as the passenger's rather than reported twice.
 * @param {number}  [opts.ratio=0.25]  a residual must also exceed this fraction
 *   of the frame's predicted travel — at speed, a pop under a quarter of one
 *   frame's motion is not a jump anyone sees
 * @param {string}  [opts.unit='u']    unit label for evidence strings
 * @param {() => number} [opts.now]    wall clock (ms since epoch) for `at`
 * @param {number}  [opts.longFrameMs=100] a frame at least this long cannot have
 *   its motion judged: past the host sim's dt clamp the point moves by the
 *   clamp while the prediction scales with the wall clock, so every residual
 *   in such a frame is the clamp's, not a jump's. Hosts pass their own clamp
 *   (mecharoyale: 50ms); the default is the hitch bar
 * @param {number}  [opts.burstGapFrames=3]
 * @param {number}  [opts.burstMaxMs=2000]
 * @param {number}  [opts.maxRecordsPerSession=200]
 * @param {number}  [opts.minRecordGapMs=1000]
 */
export function createMotionMonitor(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const ratio = opts.ratio ?? 0.25;
  const unit = opts.unit ?? 'u';
  const longFrameMs = opts.longFrameMs ?? 100;
  const burstGapFrames = opts.burstGapFrames ?? 3;
  const burstMaxMs = opts.burstMaxMs ?? 2000;
  const maxRecords = opts.maxRecordsPerSession ?? 200;
  const minGapMs = opts.minRecordGapMs ?? 1000;

  const tracks = new Map();
  for (const [name, cfg] of Object.entries(opts.tracks ?? {})) {
    if (!cfg || !(cfg.floor > 0)) throw new Error(`motion track "${name}" needs a positive floor`);
    tracks.set(name, newTrack(name, cfg));
  }

  let records = [];
  let sessionRecords = 0;      // the cap is per session, across tracks
  let droppedSinceLast = 0;
  let totalDropped = 0;

  function newTrack(name, cfg) {
    return {
      name, floor: cfg.floor, reachName: cfg.reach ?? null, follows: cfg.follows ?? null,
      samples: 0, held: 0, cuts: 0, events: 0, bursts: 0,
      // The 1/s gap is PER TRACK: a unit that teleports takes its camera with
      // it in the same frame, and the camera's record is the one that says so
      // (`follows-track`) — a shared gap would drop exactly that record.
      lastRecordAt: -Infinity,
      // The last two samples (p0 older, p1 newer) and their times.
      seeds: 0, p0x: 0, p0y: 0, p0z: 0, p1x: 0, p1y: 0, p1z: 0, t0: 0, t1: 0,
      reach1: NaN,             // reach at p1 (NaN = not sampled)
      phase: undefined,
      // Frame-time ring, for the long-frame verdict (median read at event time).
      dts: new Float64Array(DT_RING), dtN: 0, dtHead: 0,
      // The residual awaiting its reversal verdict.
      pend: { active: false, rx: 0, ry: 0, rz: 0, mag: 0, travel: 0, speed: 0, dt: 0, t: 0, wall: 0,
        frame: 0, fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 0, toZ: 0, reachBefore: NaN, reachAfter: NaN, phase: undefined },
      // The open burst (folds consecutive events).
      burst: { active: false, events: 0, firstWall: 0, lastWall: 0, lastFrame: 0, amplitude: 0, durationMs: 0,
        first: null },
      // Recent event sample-times, for cross-track coincidence.
      eventT: new Float64Array(EVENT_RING), eventN: 0,
    };
  }

  function reseed(tr, x, y, z, t, reach) {
    tr.seeds = 1;
    tr.p1x = x; tr.p1y = y; tr.p1z = z; tr.t1 = t;
    tr.reach1 = reach;
    tr.pend.active = false;
  }

  function pushDt(tr, dt) {
    tr.dts[tr.dtHead] = dt;
    tr.dtHead = (tr.dtHead + 1) % DT_RING;
    if (tr.dtN < DT_RING) tr.dtN++;
  }
  function medianDt(tr) {
    if (tr.dtN === 0) return undefined;
    const s = Array.from(tr.dts.subarray(0, tr.dtN)).sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function noteEvent(tr, p) {
    tr.events++;
    tr.eventT[tr.eventN % EVENT_RING] = p.t;
    tr.eventN++;
    const b = tr.burst;
    if (!b.active) {
      b.active = true; b.events = 0; b.amplitude = 0;
      b.firstWall = p.wall;
      b.first = { ...p };
      tr.bursts++;
    }
    b.events++;
    b.lastWall = p.wall;
    b.lastFrame = p.frame;
    if (p.mag > b.amplitude) b.amplitude = p.mag;
  }

  function hadEventAt(tr, t) {
    const n = Math.min(tr.eventN, EVENT_RING);
    for (let i = 0; i < n; i++) if (tr.eventT[i] === t) return true;
    return false;
  }

  function closeBurst(tr) {
    const b = tr.burst;
    if (!b.active) return;
    b.active = false;
    const f = b.first;
    b.first = null;
    // Rate limits first (the recorder's own contract): silence must mean
    // nothing was dropped, so drops are counted onto the NEXT record.
    if (f.wall - tr.lastRecordAt < minGapMs || sessionRecords >= maxRecords) {
      droppedSinceLast++; totalDropped++;
      return;
    }
    tr.lastRecordAt = f.wall;
    sessionRecords++;

    const kind = b.events >= 2 ? 'oscillation' : 'snap';
    const durationMs = b.lastWall - b.firstWall;
    const med = medianDt(tr);
    const fx = (n) => +n.toFixed(3);
    const px = (n) => +n.toFixed(2);
    const rec = {
      type: 'jitter',
      at: new Date(f.wall).toISOString(),
      track: tr.name,
      kind,
      frame: f.frame,
      jump: [fx(f.rx), fx(f.ry), fx(f.rz)],
      units: fx(f.mag),
      travelUnits: fx(f.travel),
      speed: +f.speed.toFixed(2),
      dtMs: +f.dt.toFixed(1),
      from: [px(f.fromX), px(f.fromY), px(f.fromZ)],
      to: [px(f.toX), px(f.toY), px(f.toZ)],
      classification: [],
    };
    if (med !== undefined) rec.medianDtMs = +med.toFixed(1);
    if (kind === 'oscillation') {
      rec.frames = b.events;
      rec.durationMs = +durationMs.toFixed(0);
      rec.amplitude = fx(b.amplitude);
    }
    if (f.phase) rec.phase = f.phase;

    // Cross-track: another point jumped in the SAME sample frame. Data on
    // every record; an EXPLANATION only where the host declared the hierarchy.
    const coincident = [];
    for (const other of tracks.values()) if (other !== tr && hadEventAt(other, f.t)) coincident.push(other.name);
    if (coincident.length) rec.coincident = coincident;
    const passenger = tr.follows && coincident.includes(tr.follows);
    // Reach: the host's scalar (camera→pivot distance) across the jump.
    const reachKnown = tr.reachName && Number.isFinite(f.reachBefore) && Number.isFinite(f.reachAfter);
    if (reachKnown) rec.reach = { name: tr.reachName, before: px(f.reachBefore), after: px(f.reachAfter) };

    // Explanations rank ahead of the kind: the wake line shows one guess, and
    // "the camera moved because its pivot did" is worth more than "snap".
    const cls = rec.classification;
    if (passenger) {
      cls.push({ guess: 'follows-track', confidence: 'high',
        evidence: `jumped in the same frame as ${tr.follows}, which it follows — see that record; this one is the passenger` });
    }
    if (reachKnown) {
      const d = f.reachAfter - f.reachBefore;
      if (Math.abs(d) >= 0.7 * f.mag) {
        cls.push({ guess: 'reach-change', confidence: 'high',
          evidence: `${tr.reachName} ${px(f.reachBefore)}→${px(f.reachAfter)}${unit} (Δ${d >= 0 ? '+' : ''}${fx(d)} ≈ the ${fx(f.mag)}${unit} jump): the point's distance to its anchor changed — a clamp or a zoom, not a teleport` });
      }
    }
    // A frame past the sim's clamp owns every residual in it — an alternation
    // across such frames is the clamp meeting a wobbling frame time, not two
    // writers — so the long-frame verdict ranks ahead of the kind.
    if (f.dt >= longFrameMs || (med !== undefined && f.dt >= 2 * med && f.dt >= 50)) {
      const rel = med !== undefined ? ` (${(f.dt / med).toFixed(1)}× the ${med.toFixed(1)}ms median)` : '';
      const shape = kind === 'oscillation' ? `${b.events} reversals starting in` : 'landed in';
      cls.push({ guess: 'long-frame-catch-up', confidence: 'medium',
        evidence: `${shape} a ${f.dt.toFixed(0)}ms frame${rel}, past the ${longFrameMs}ms the sim integrates against the clock: a dt clamp across a stall reads as a jump — the stall is the incident` });
    } else if (kind === 'oscillation') {
      cls.push({ guess: 'oscillation', confidence: 'high',
        evidence: `${b.events} reversals over ${durationMs.toFixed(0)}ms, amplitude ${fx(b.amplitude)}${unit} — a fixed-step sim drawn without interpolation, or two writers fighting over one transform` });
    } else {
      cls.push({ guess: 'snap', confidence: 'high',
        evidence: `${fx(f.mag)}${unit} off its trajectory in one ${f.dt.toFixed(1)}ms frame (expected ${fx(f.travel)}${unit} of travel at ${f.speed.toFixed(2)}${unit}/s); motion resumed from the new place` });
    }
    if (droppedSinceLast > 0) { rec.droppedSinceLast = droppedSinceLast; droppedSinceLast = 0; }
    records.push(rec);
  }

  return {
    /**
     * One rendered frame's position for `track`, at host time `t` (ms, the
     * same clock every frame — performance.now()). `meta.held` marks a frame
     * whose motion is not the track's own to judge (look input, pause);
     * `meta.reach` is the optional anchor distance; `meta.phase` stamps the
     * record. Zero-allocation unless a burst closes.
     */
    sample(track, x, y, z, t, meta) {
      const tr = tracks.get(track);
      if (!tr) throw new Error(`unknown motion track "${track}"`);
      tr.samples++;
      const reach = meta && typeof meta.reach === 'number' ? meta.reach : NaN;
      const phase = meta ? meta.phase : undefined;
      if (meta && meta.held) {
        tr.held++;
        closeBurst(tr);
        reseed(tr, x, y, z, t, reach);
        return;
      }
      if (tr.seeds === 0) { reseed(tr, x, y, z, t, reach); return; }
      const dt2 = t - tr.t1;
      if (tr.seeds === 1) {
        if (dt2 <= 0) { reseed(tr, x, y, z, t, reach); return; }
        pushDt(tr, dt2);
        tr.p0x = tr.p1x; tr.p0y = tr.p1y; tr.p0z = tr.p1z; tr.t0 = tr.t1;
        tr.p1x = x; tr.p1y = y; tr.p1z = z; tr.t1 = t; tr.reach1 = reach;
        tr.seeds = 2;
        return;
      }
      const dt1 = tr.t1 - tr.t0;
      if (dt1 <= 0 || dt2 <= 0) { closeBurst(tr); reseed(tr, x, y, z, t, reach); return; }
      pushDt(tr, dt2);

      const vx = (tr.p1x - tr.p0x) / dt1, vy = (tr.p1y - tr.p0y) / dt1, vz = (tr.p1z - tr.p0z) / dt1;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const travel = speed * dt2;
      const rx = x - (tr.p1x + vx * dt2), ry = y - (tr.p1y + vy * dt2), rz = z - (tr.p1z + vz * dt2);
      const mag = Math.sqrt(rx * rx + ry * ry + rz * rz);

      // The verdict on the PREVIOUS residual: reversed by this one? Compared
      // as velocity anomalies (residual ÷ dt), see the header.
      const p = tr.pend;
      if (p.active) {
        const dot = p.rx * rx + p.ry * ry + p.rz * rz;
        const scaled = mag * (p.dt / dt2);
        // Anti-parallel (cos ≤ −0.5) and at least half the size.
        const reversed = dot < 0 && scaled >= 0.5 * p.mag && dot * dot >= 0.25 * p.mag * p.mag * mag * mag;
        if (reversed) noteEvent(tr, p);
        p.active = false;
      }
      // This residual as the next candidate.
      if (mag > Math.max(tr.floor, ratio * travel)) {
        p.active = true;
        p.rx = rx; p.ry = ry; p.rz = rz; p.mag = mag;
        p.travel = travel; p.speed = speed * 1000; p.dt = dt2; p.t = t; p.wall = now();
        p.frame = tr.samples;
        p.fromX = tr.p1x; p.fromY = tr.p1y; p.fromZ = tr.p1z;
        p.toX = x; p.toY = y; p.toZ = z;
        p.reachBefore = tr.reach1; p.reachAfter = reach;
        p.phase = phase;
      }
      // Burst bookkeeping: closed by silence or by age.
      const b = tr.burst;
      if (b.active) {
        if (tr.samples - b.lastFrame > burstGapFrames + 1 || now() - b.firstWall >= burstMaxMs) closeBurst(tr);
      }

      tr.p0x = tr.p1x; tr.p0y = tr.p1y; tr.p0z = tr.p1z; tr.t0 = tr.t1;
      tr.p1x = x; tr.p1y = y; tr.p1z = z; tr.t1 = t; tr.reach1 = reach;
    },

    /** The host changed the view on purpose (mode flip, spectate target,
     *  respawn, session boundary): the track(s) forget their trajectory. An
     *  open burst closes as it stands. */
    cut(track) {
      const list = track ? [tracks.get(track)].filter(Boolean) : [...tracks.values()];
      for (const tr of list) { tr.cuts++; closeBurst(tr); tr.seeds = 0; tr.pend.active = false; }
    },

    /** Hand back accumulated records and clear — the host owns transport. */
    drainRecords() { const r = records; records = []; return r; },

    /** Counters for probes: did the instrument see anything at all? */
    stats() {
      const out = { records: sessionRecords, dropped: totalDropped, tracks: {} };
      for (const tr of tracks.values()) {
        out.tracks[tr.name] = { samples: tr.samples, held: tr.held, cuts: tr.cuts, events: tr.events, bursts: tr.bursts,
          pending: tr.pend.active, burstOpen: tr.burst.active };
      }
      return out;
    },
  };
}
