// Coordinate continuity (SPEC §3.6): a tracked point that lands off its own
// trajectory and is pulled back the next frame is a jump; a residual the next
// frame does not reverse is a change of motion and stays silent. Pinned here:
// smooth motion of every honest kind is silent, a teleport is one `snap` with
// the right vector, a fixed-step sim drawn without interpolation is one
// `oscillation`, held/cut frames re-seed, the long-frame verdict, the
// cross-track and reach explanations, and the rate limits with a loud drop
// count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionMonitor } from '../src/motion.js';

const DT = 1000 / 60;
function monitor(extra = {}) {
  let wall = Date.parse('2026-01-01T00:00:00.000Z');
  const m = createMotionMonitor({
    unit: 'm',
    tracks: { unit: { floor: 0.1 }, camera: { floor: 0.1, reach: 'boom', follows: 'unit' } },
    now: () => wall,
    ...extra,
  });
  // The wall clock advances with the host clock the samples carry.
  const feed = (track, pts, opts = {}) => {
    for (const p of pts) {
      wall = Date.parse('2026-01-01T00:00:00.000Z') + p.t;
      m.sample(track, p.x, p.y, p.z, p.t, { phase: 'play', ...(opts.meta?.(p) ?? {}) });
    }
  };
  return { m, feed, setWall: (t) => { wall = Date.parse('2026-01-01T00:00:00.000Z') + t; } };
}

/** n frames of motion from `from` at velocity v (units/s), fixed or varying dt. */
function line(n, from, v, { t0 = 0, dt = DT, dtOf } = {}) {
  const out = [];
  let t = t0, x = from[0], y = from[1], z = from[2];
  for (let i = 0; i < n; i++) {
    out.push({ x, y, z, t });
    const d = dtOf ? dtOf(i) : dt;
    t += d; x += v[0] * d / 1000; y += v[1] * d / 1000; z += v[2] * d / 1000;
  }
  return out;
}

test('constant velocity, hard acceleration and a fast orbit are all silent', () => {
  const { m, feed } = monitor();
  feed('unit', line(300, [0, 0, 0], [12, 0, 3]));
  m.cut('unit');   // each fixture is its own trajectory
  // 0 → 60 m/s in half a second: 120 m/s² — a booster dash.
  const accel = [];
  for (let i = 0; i < 120; i++) { const t = i * DT, s = t / 1000; accel.push({ x: 60 * s * s, y: 0, z: 0, t: 5000 + t }); }
  feed('unit', accel);
  // A point orbiting at 4 rad/s on a 10m radius: 160 m/s² of centripetal
  // acceleration, residuals of ½·a·dt² ≈ 2cm — under any floor worth having.
  const orbit = [];
  for (let i = 0; i < 300; i++) { const t = i * DT, a = 4 * t / 1000; orbit.push({ x: 10 * Math.cos(a), y: 0, z: 10 * Math.sin(a), t: 10000 + t }); }
  feed('camera', orbit);
  assert.deepEqual(m.drainRecords(), []);
  assert.equal(m.stats().tracks.unit.events, 0);
});

test('a teleport mid-motion is exactly one snap, with the displacement vector and evidence', () => {
  const { m, feed } = monitor();
  const a = line(120, [0, 0, 0], [8, 0, 0]);
  // Frame 120 onward: the same motion, shifted +0.6m in x and +0.3m in y.
  const last = a[a.length - 1];
  const b = line(60, [last.x + 8 * DT / 1000 + 0.6, 0.3, 0], [8, 0, 0], { t0: last.t + DT });
  feed('unit', [...a, ...b]);
  const recs = m.drainRecords();
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.type, 'jitter');
  assert.equal(r.track, 'unit');
  assert.equal(r.kind, 'snap');
  assert.equal(r.phase, 'play');
  assert.deepEqual(r.jump, [0.6, 0.3, 0]);
  assert.ok(Math.abs(r.units - Math.hypot(0.6, 0.3)) < 1e-3);
  assert.ok(Math.abs(r.travelUnits - 8 * DT / 1000) < 1e-3, `travel ${r.travelUnits}`);
  assert.equal(r.speed, 8);
  assert.equal(r.dtMs, +DT.toFixed(1));
  assert.equal(r.classification[0].guess, 'snap');
  assert.match(r.classification[0].evidence, /0\.671m off its trajectory/);
  assert.equal(r.at, '2026-01-01T00:00:02.000Z');   // stamped at the jump frame, not at the burst close
  assert.equal(r.frame, 121);
});

test('a velocity step (motion starting) is not a jump; a teleport followed by standstill is', () => {
  const { m, feed } = monitor();
  // Stand still, then move at 30 m/s from one frame to the next: 0.5m of
  // residual on the onset frame, never reversed.
  feed('unit', [...line(60, [0, 0, 0], [0, 0, 0]), ...line(60, [0, 0, 0], [30, 0, 0], { t0: 60 * DT })]);
  assert.deepEqual(m.drainRecords(), []);
  m.cut('unit');
  // Stand still, teleport 2m, stand still.
  feed('unit', [...line(60, [0, 0, 0], [0, 0, 0], { t0: 5000 }), ...line(60, [2, 0, 0], [0, 0, 0], { t0: 5000 + 60 * DT })]);
  const recs = m.drainRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'snap');
  assert.deepEqual(recs[0].jump, [2, 0, 0]);
  assert.equal(recs[0].speed, 0);
});

test('a 30Hz sim drawn at 60Hz without interpolation is one oscillation record, closed by age, then another', () => {
  const { m, feed } = monitor();
  const pts = [];
  for (let i = 0; i < 300; i++) pts.push({ x: Math.floor(i / 2) * 0.3, y: 0, z: 0, t: i * DT });  // 9 m/s, stepping every other frame
  feed('unit', pts);
  // 300 frames = 5s; bursts cap at 2s, and the rate limit allows one record a second.
  const recs = m.drainRecords();
  assert.ok(recs.length >= 2, `records ${recs.length}`);
  assert.equal(recs[0].kind, 'oscillation');
  assert.equal(recs[0].classification[0].guess, 'oscillation');
  assert.ok(recs[0].frames >= 100, `frames ${recs[0].frames}`);
  assert.ok(Math.abs(recs[0].amplitude - 0.3) < 1e-3);
  assert.ok(recs[0].durationMs >= 1900 && recs[0].durationMs <= 2000, `duration ${recs[0].durationMs}`);
});

test('a long frame with dt-scaled motion is silent; with clamped motion it is a long-frame-catch-up, not a snap', () => {
  const { m, feed } = monitor();
  // 120 steady frames, one 400ms frame in which the point moved the full 400ms worth.
  feed('unit', line(122, [0, 0, 0], [10, 0, 0], { dtOf: (i) => (i === 119 ? 400 : DT) }));
  assert.deepEqual(m.drainRecords(), []);
  m.cut('unit');
  // The same, but the sim clamped its dt to 100ms across the stall.
  const pts = line(120, [0, 0, 0], [10, 0, 0], { t0: 10000 });
  const last = pts[pts.length - 1];
  const after = line(30, [last.x + 10 * 0.1, 0, 0], [10, 0, 0], { t0: last.t + 400 });
  feed('unit', [...pts, ...after]);
  const recs = m.drainRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'snap');
  assert.equal(recs[0].classification[0].guess, 'long-frame-catch-up');
  assert.match(recs[0].classification[0].evidence, /400ms frame/);
  assert.equal(recs[0].dtMs, 400);
  assert.equal(recs[0].medianDtMs, +DT.toFixed(1));
});

test('a frame at or past longFrameMs is the clamp\'s, whatever the median: every frame of a 1.5s-per-frame session is a catch-up', () => {
  const { m, feed } = monitor({ longFrameMs: 50 });
  // A software rasteriser at 1.5s a frame, the sim clamped to 50ms of motion
  // per frame at 6 m/s (0.3m a frame) — with frame times that wobble, so the
  // wall-clock prediction misses by the wobble every frame.
  const pts = [];
  let t = 0, x = 0;
  for (let i = 0; i < 40; i++) { pts.push({ x, y: 0, z: 0, t }); t += i % 2 ? 1900 : 1100; x += 0.3; }
  feed('unit', pts);
  const recs = m.drainRecords();
  assert.ok(recs.length >= 1, 'the wobble produces candidates');
  for (const r of recs) assert.equal(r.classification[0].guess, 'long-frame-catch-up', JSON.stringify(r.classification));
  assert.match(recs[0].classification[0].evidence, /past the 50ms the sim integrates/);
});

test('held frames are not judged and re-seed the track; a cut forgets the trajectory', () => {
  const { m, feed } = monitor();
  const a = line(60, [0, 0, 0], [5, 0, 0]);
  // A 3m swing while the look input is held — a mouse flick on a boom.
  const swung = line(60, [3, 0, 3], [5, 0, 0], { t0: 60 * DT });
  feed('camera', a);
  feed('camera', swung.slice(0, 1), { meta: () => ({ held: true }) });
  feed('camera', swung.slice(1));
  assert.deepEqual(m.drainRecords(), []);
  assert.equal(m.stats().tracks.camera.held, 1);
  // Cut: the same 3m displacement with no held frame, declared instead.
  m.cut('camera');
  feed('camera', line(60, [0, 0, 0], [5, 0, 0], { t0: 5000 }));
  m.cut('camera');
  feed('camera', line(60, [3, 0, 3], [5, 0, 0], { t0: 5000 + 60 * DT }));
  assert.deepEqual(m.drainRecords(), []);
  assert.equal(m.stats().tracks.camera.cuts, 2);
  // …and undeclared, it is a snap.
  m.cut('camera');
  feed('camera', line(60, [0, 0, 0], [5, 0, 0], { t0: 9000 }));
  feed('camera', line(60, [3, 0, 3], [5, 0, 0], { t0: 9000 + 60 * DT }));
  assert.equal(m.drainRecords().length, 1);
});

test('the reversal is judged in velocity: a jump landing in a long frame is confirmed by the short frame after it', () => {
  const { m, feed } = monitor();
  // Walking at 4 m/s; one 200ms frame carries a 1.5m teleport on top of the
  // dt-scaled travel; the 16.7ms frame after it pulls back 1/12 of that.
  const a = line(90, [0, 0, 0], [4, 0, 0]);
  const last = a[a.length - 1];
  const b = line(30, [last.x + 4 * 0.2 + 1.5, 0, 0], [4, 0, 0], { t0: last.t + 200 });
  feed('unit', [...a, ...b]);
  const recs = m.drainRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'snap');
  assert.deepEqual(recs[0].jump, [1.5, 0, 0]);
  assert.equal(recs[0].dtMs, 200);
  assert.equal(recs[0].classification[0].guess, 'long-frame-catch-up');   // 200ms is 12× the median: the stall owns it
});

test('a camera that jumps with its pivot is explained by follows-track; a boom clamp by reach-change', () => {
  const { m, setWall } = monitor();
  // Unit and camera (10m behind) walk together, then both teleport +1m.
  const u1 = line(90, [0, 0, 0], [6, 0, 0]);
  const c1 = u1.map((p) => ({ ...p, z: p.z + 10 }));
  const lastU = u1[u1.length - 1];
  const u2 = line(30, [lastU.x + 6 * DT / 1000 + 1, 0, 0], [6, 0, 0], { t0: lastU.t + DT });
  const c2 = u2.map((p) => ({ ...p, z: p.z + 10 }));
  for (let i = 0; i < u1.length; i++) {
    setWall(u1[i].t);
    m.sample('unit', u1[i].x, u1[i].y, u1[i].z, u1[i].t, {});
    m.sample('camera', c1[i].x, c1[i].y, c1[i].z, c1[i].t, { reach: 10 });
  }
  for (let i = 0; i < u2.length; i++) {
    setWall(u2[i].t);
    m.sample('unit', u2[i].x, u2[i].y, u2[i].z, u2[i].t, {});
    m.sample('camera', c2[i].x, c2[i].y, c2[i].z, c2[i].t, { reach: 10 });
  }
  let recs = m.drainRecords();
  assert.equal(recs.length, 2);
  const unit = recs.find((r) => r.track === 'unit'), cam = recs.find((r) => r.track === 'camera');
  assert.equal(unit.classification[0].guess, 'snap');          // the cause: never called a passenger
  assert.deepEqual(unit.coincident, ['camera']);
  assert.equal(cam.classification[0].guess, 'follows-track');  // the declared follower is
  assert.deepEqual(cam.coincident, ['unit']);
  assert.match(cam.classification[0].evidence, /same frame as unit/);
  assert.equal(cam.classification.at(-1).guess, 'snap');   // the kind still rides the record
  assert.deepEqual(cam.reach, { name: 'boom', before: 10, after: 10 });

  // The boom alone pulls in 0.9m (an occlusion clamp) while the unit walks on.
  m.cut();
  const u3 = line(90, [0, 0, 0], [6, 0, 0], { t0: 20000 });
  for (let i = 0; i < u3.length; i++) {
    setWall(u3[i].t);
    const reach = i >= 60 ? 9.1 : 10;
    m.sample('unit', u3[i].x, u3[i].y, u3[i].z, u3[i].t, {});
    m.sample('camera', u3[i].x, u3[i].y, u3[i].z + reach, u3[i].t, { reach });
  }
  recs = m.drainRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].track, 'camera');
  assert.equal(recs[0].classification[0].guess, 'reach-change');
  assert.deepEqual(recs[0].reach, { name: 'boom', before: 10, after: 9.1 });
  assert.match(recs[0].classification[0].evidence, /boom 10→9\.1m/);
  assert.equal(recs[0].coincident, undefined);
});

test('at speed, a pop under a quarter of one frame of travel is not a jump', () => {
  const { m, feed } = monitor();
  // 60 m/s = 1m per frame; a 0.2m sideways pop (over the 0.1 floor, under ratio·travel).
  const a = line(60, [0, 0, 0], [60, 0, 0]);
  const last = a[a.length - 1];
  const b = line(30, [last.x + 1, 0, 0.2], [60, 0, 0], { t0: last.t + DT });
  feed('unit', [...a, ...b]);
  assert.deepEqual(m.drainRecords(), []);
  m.cut('unit');
  // The same pop at walking pace is one.
  const c = line(60, [0, 0, 0], [3, 0, 0], { t0: 5000 });
  const lastC = c[c.length - 1];
  feed('unit', [...c, ...line(30, [lastC.x + 3 * DT / 1000, 0, 0.2], [3, 0, 0], { t0: lastC.t + DT })]);
  assert.equal(m.drainRecords().length, 1);
});

test('rate limits: one record a second, a session cap, and the drops counted onto the next record', () => {
  const { m, feed } = monitor({ maxRecordsPerSession: 3 });
  // A teleport every 200ms for 3 seconds: 15 snaps, ≤1 record/s.
  let pts = [];
  let x = 0, t = 0;
  for (let k = 0; k < 15; k++) {
    for (let i = 0; i < 12; i++) { pts.push({ x, y: 0, z: 0, t }); x += 5 * DT / 1000; t += DT; }
    x += 1;
  }
  pts.push(...line(10, [x, 0, 0], [5, 0, 0], { t0: t }));
  feed('unit', pts);
  const recs = m.drainRecords();
  assert.equal(recs.length, 3);                       // the cap
  assert.equal(recs[0].droppedSinceLast, undefined);
  assert.ok(recs[1].droppedSinceLast >= 3, `dropped ${recs[1].droppedSinceLast}`);   // the 1/s limit swallowed the ones between
  assert.ok(m.stats().dropped >= 10);
  assert.equal(m.stats().records, 3);
});

test('an unknown track or a non-positive floor is a configuration error, not silence', () => {
  assert.throws(() => createMotionMonitor({ tracks: { unit: { floor: 0 } } }), /positive floor/);
  const m = createMotionMonitor({ tracks: { unit: { floor: 0.1 } } });
  assert.throws(() => m.sample('camera', 0, 0, 0, 0, {}), /unknown motion track/);
});
