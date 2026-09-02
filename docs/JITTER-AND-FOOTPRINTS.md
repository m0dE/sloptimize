# Coordinate jitter and the issue catalogue — the integrator's cookbook

This is the shortest complete path from "my game has a recorder feed"
(INTEGRATION.md §1) to: **every snap of the player's unit or camera lands as
a classified record, every incident of every kind carries a footprint naming
its cause and the game's situation, and the debugger's Issues tab shows what
keeps happening and what was done about it.** Everything here is framework-
agnostic; the reference implementation is mecharoyale (three.js/WebGPU), and
each step names the file to copy from.

Two things in the package do the work; the game supplies four small answers.

| The package gives you | You tell it |
|---|---|
| `createMotionMonitor` — the jitter detector (SPEC §3.6) | two points per rendered frame, which frames are not its to judge, when the view cut on purpose, your sim's dt clamp |
| `footprintOf` + `canonicalContext` + `buildIssues` — footprints and the catalogue (SPEC §3.7) | a few facets of the player's situation, refreshed once a second |

---

## 1. What a jitter is, and why the naive detector fails

The recorder's hitches are about **time**: a frame that took too long. The
other thing a player feels is about **space**: the unit or the camera landing
somewhere its own motion did not predict. The detector is a one-step
constant-velocity prediction from the last two samples; the residual
`r = p − p̂` is how far the point landed off its trajectory (½·a·dt² for smooth
motion — millimetres). A residual is only a **jump** when the next frame
**reverses** it; an un-reversed residual is a change of motion (a dash, a
boom easing) and is never reported.

Three things will make a naive position track lie to you, and the design
answers each:

1. **Rotation.** A camera on a boom swings metres in one frame when the
   mouse flicks: 16° per frame on a 10 m boom is 2.9 m of travel that is
   entirely intended. Do not feed a camera's raw world position and expect
   silence. Feed the **pivot** the view is arranged around (the unit) — it
   is rotation-invariant by construction — and feed the eye **held** on any
   frame that consumed look or zoom input.
2. **Transient offsets.** A camera shake applied around the render and
   restored after it is a per-frame random offset by design. Sample **after
   the render**, once the transient is gone, so what you feed is what was
   drawn.
3. **The dt clamp.** Every game clamps the delta its sim integrates with
   (mecharoyale: 50 ms). Past the clamp the point moves by the clamp while
   the wall clock moved further, so the prediction is wrong for the frame's
   whole length — the detector must know the clamp (`longFrameMs`) to file
   those as `long-frame-catch-up` (the stall is the incident) instead of
   `snap`. Measured on a software rasteriser drawing a frame every 1.5 s:
   without it every frame was a "snap".

---

## 2. Feed the detector

```js
import { createMotionMonitor } from 'sloptimize';

const motion = createMotionMonitor({
  unit: 'm',                         // your world unit, for evidence strings
  longFrameMs: MAX_SIM_STEP_S * 1000, // YOUR sim's dt clamp — never a guess
  tracks: {
    unit:   { floor: 0.1 },                                   // the view pivot
    camera: { floor: 0.1, reach: 'boom', follows: 'unit' },   // the eye
  },
});
```

- `floor` is the smallest off-trajectory displacement worth a record, in
  your units. Pick the smallest pop a player can see at your camera
  distances and comfortably above ½·a·dt² for your fastest acceleration
  (120 m/s² at 60 fps is 1.7 cm; mecharoyale uses 10 cm).
- `reach` names the scalar you sample beside the camera — its distance to
  the pivot — so a jump that is a boom clamp or a zoom is explained as
  `reach-change`, not a teleport.
- `follows` declares the hierarchy: when the camera jumps in the same frame
  as the unit it follows, its record is filed `follows-track` (the
  passenger) and does not wake anyone twice.

Once per **rendered** frame, after the render, with the same clock every
frame:

```js
const source = viewPivot(camera.position, pivot);   // who published the pivot this frame
const key = `${source}|${thirdPerson ? 'tps' : 'fp'}|${spectateTargetId}`;
if (key !== lastKey) { lastKey = key; motion.cut(); }  // an intentional discontinuity

const off = paused || !continuityExpected(phase);   // covered tab, boot, a cinematic that cuts
motion.sample('unit',   pivot.x, pivot.y, pivot.z, now, { held: off || source === FALLBACK, phase, ctx });
motion.sample('camera', cam.x,   cam.y,   cam.z,   now, { held: off || lookInputSinceLastSample, reach: dist(cam, pivot), phase, ctx });
```

Rules the reference keeps, each learned the hard way:

- **Cuts are derived, not declared.** Compose a view-configuration key from
  everything about the camera that is not motion — who publishes the pivot
  (foot/hull/spectate), first vs third person, the spectated target — and
  `cut()` whenever it changes. Mode flips, boarding, dismount, death, respawn
  and spectate cycling all change it; no call site has to remember.
- **Held ≠ cut.** `held` is a frame the track must not judge (input-driven,
  paused, a phase with no continuous view); the track re-seeds after it.
  Both are counted in `stats()`.
- **The pivot fallback is not the unit.** When no camera published a pivot
  and the camera stood in, hold the unit track — judging it would judge the
  camera twice.
- **Drain beside the recorder**, same pipe, same ledger:
  `post('records', [...rec.drainRecords(), ...motion.drainRecords()])`.
- **Rate limit is per track, 1/s, 200/session**, drops counted onto the next
  record. A unit that teleports takes its camera with it in the same frame;
  a shared gap would drop exactly the camera's explanatory record.

Reference: `packages/client/src/dev/sloptimize-motion-feed.ts` (policy +
plumbing, ~150 lines, unit-tested with a fake camera and pivot), called from
the runtime's counter site.

### The record

```json
{ "type": "jitter", "at": "…", "track": "unit", "kind": "snap",
  "jump": [-16.25, 5.55, 3.58], "units": 17.54, "travelUnits": 1.36, "speed": 33.25,
  "dtMs": 41.0, "medianDtMs": 16.7, "from": [x,y,z], "to": [x,y,z],
  "coincident": ["camera"], "reach": { "name": "boom", "before": 15.7, "after": 15.7 },
  "classification": [{ "guess": "snap", "confidence": "high", "evidence": "…" }],
  "phase": "play", "ctx": "combat=yes,hull=droyd-g,squad=duo,stance=helm,view=tps",
  "footprint": { "v": 1, "id": "b5b203ba", "key": "jitter|unit|snap|play|snap|horizontal|ctx:…" } }
```

Verdicts (closed): `snap` · `oscillation` (≥2 reversals in one burst — a
fixed-step sim drawn without interpolation, or two writers on one transform)
· `long-frame-catch-up` · `follows-track` · `reach-change`. The watcher wakes
on the first two only.

---

## 3. Declare the situation

Time is not part of an issue's identity; the game's **state** is. Declare a
handful of **low-cardinality** facets — categories, never positions or
counters — and hand the canonical string along:

```js
import { canonicalContext } from 'sloptimize';

function situation() {          // read ONCE A SECOND, never per frame
  return {
    stance: dead ? 'dead' : aboard ? (atHelm ? 'helm' : 'crew') : 'foot',
    hull:   aboard ? frameName(aboard) : 'none',
    squad:  squadSize >= 3 ? 'trio' : squadSize === 2 ? 'duo' : 'solo',
    view:   thirdPerson ? 'tps' : 'fp',
    combat: now - lastHitAt <= 10_000 ? 'yes' : 'no',
  };
}
let ctx = '';
setInterval(() => { ctx = canonicalContext(situation()); }, 1000);   // "combat=no,hull=none,squad=solo,stance=foot,view=fp"

rec.frame({ …, phase, ctx });                     // hitches carry it from mint
rec.usermark({ …, phase, ctx });
motion.sample(track, x, y, z, now, { …, phase, ctx });
```

A facet that varies per frame makes every incident its own issue and turns
the catalogue back into a log. Values with `|`, `,`, `=` or whitespace are
scrubbed; keys are sorted; the string is what gets hashed.

Reference: `packages/client/src/dev/sloptimize-situation.ts` (pure rules,
every fact injected, unit-tested) wired as `context` on the runtime.

---

## 4. Stamp every record at post

The writer stamps the identity; every reader then agrees without
re-deriving — the watcher's `×N`, the Issues tab, a service deduping many
clients:

```js
import { footprintOf } from 'sloptimize';

for (const r of records) {
  if (r.build === undefined) r.build = buildStamp();
  if (r.phase === undefined) r.phase = currentPhase();
  if (navigator.webdriver && r.automated === undefined) r.automated = true;   // robots never wake anyone
  if (r.ctx === undefined && ctx) r.ctx = ctx;        // host-built records take the current situation
  const fp = footprintOf(r); if (fp) r.footprint = fp;
}
```

What goes into a footprint key, per type, and what never does, is SPEC §3.7.
Records written before footprints existed are derived at read time, so the
catalogue reaches back over the whole ledger. Changing what enters a key is a
new `FOOTPRINT_VERSION`, never a silent reshuffle.

---

## 5. Read it back

- **`sloptimize issues [--fp <id>] [--from … --to …] [--all]`** — every
  incident type grouped by footprint: `×N`, first/last, `last 3h ago`,
  builds, worst, the last verdict, the fixes applied. `report` shows the
  top five.
- **`sloptimize watch`** — every wake line ends `fp=<id> ×N`, the count
  being this ledger's own (seeded from the file at arm). ×1 is new; ×40 is
  the same issue again.
- **The debugger's Issues tab** — `createPanel` renders it from the same
  `history()` callback the Timeline uses (`{ records, fixes }` from your
  dev-gated ledger read-back); no extra host work. Rows by frequency with
  `×N` and last-seen and the situation as chips; a row opens its history and
  its fixes. Session rows show their `fp` when the host's incident rows
  carry one (`{ …, fp, label, glyph }`).
- **Linking fixes** — `sloptimize fix propose --footprints <id>,<id> …` (and
  `sloptimize fix`). The catalogue answers "which fixes were applied to this
  issue" by that join; the fix's measured before/after says whether it
  landed.

Host-side ranges: the in-page tab folds only the ledger tail the server
hands back (the reference serves 2 MB, a few thousand records); the CLI folds
the whole file.

---

## 6. Checklist

- [ ] `createMotionMonitor` with `longFrameMs` = your sim's dt clamp and a
      `floor` you can defend
- [ ] `unit` = the view pivot (rotation-invariant), `camera` = the eye held
      on look/zoom input, `reach` = distance to the pivot, `follows: 'unit'`
- [ ] sample after the render, same clock every frame; hold paused frames
      and phases without a continuous view; cut on a derived view key
- [ ] drain beside the recorder, same post
- [ ] `context()` with ≤ 6 categorical facets; `canonicalContext` once a
      second; `ctx` on `frame`, `usermark`, `sample`
- [ ] at post: `build`, `phase`, `automated`, `ctx`, `footprint`
- [ ] incident rows for the panel carry `fp` (and `label`/`glyph` for
      non-millisecond rows)
- [ ] watcher armed; `sloptimize issues` in the agent's playbook; fixes
      recorded with `--footprints`
