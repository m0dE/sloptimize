# dmitriy's 0.10.1 feedback (ticket 960070d5) — what shipped, and how it differs from the ask

Context: 0.10.1 tested from a scratch clone on the traffic sim (~9k cars,
6.7k suburb houses, the sim in a Worker). The profiler anchor held: 3.91 ms
attached against 4.0 ms unattached; workers were found and named; ff4996c's
two fixes were confirmed. These are the nine items that followed, in the
order they were built, each with its real-browser proof.

## 1. The instance-slot watch is the heaviest JS — counted and capped

Agreed on both halves. The cost was mostly ours to stop paying, not only to
report:
- **Translation only, no copies.** Each check sliced a fresh copy of every
  matrix buffer and compared all 16 floats a slot. It now compares and keeps
  3 floats a slot in a buffer it reuses. A slot rotated in place without
  `setMatrixAt` reads as idle. That does not matter here: a ghost stands still.
- **Static meshes back off.** A mesh with nothing active for 3 visits is
  visited one check in 4. A town of instanced houses is the case.
- **A budget per check.** A check stops at 2 ms and the next one resumes
  round-robin.
- **An adaptive interval.** The page doubles the interval (up to 16×) when a
  check costs more than 0.5% of the frames since the last one.
- **Counted.** `recorder.slotsMs` rides every profile record and the run
  file's `recorder.page`. The report's recorder line now includes it, and
  past 1% it warns and names `--no-slots`.

dmitriy suggested sampling rows. Comparing translation only is that
suggestion in a form that still sees every slot.

## 2. ms/frame for a decoupled worker — replaced by ms/task, and "cannot judge"

Agreed. The run file now keeps each worker's **tasks**: busy stretches
between idle samples, as a histogram by length. The report reads a worker as
`57 ms/task (p95 64) × 13/s`; main keeps ms/frame.

The verdict changed in three ways:
- **Behind is behind.** `sim-behind` no longer needs the worker saturated. A
  tick that outgrew its budget falls behind with idle time between ticks.
- **No clock, no headroom.** Without `__sloptimizeClock` the verdict says
  "cannot judge sim-behind: no __sloptimizeClock".
- **A declared tick rate is evidence.** When `__sloptimizeSim({tickHz})` is
  declared and the median task exceeds the tick budget, the verdict is
  `over-tick`.

**Found on the way: a saturated worker's tasks merge.** Its idle gaps are
mostly shorter than one 10 ms sample, so its ticks run together. The
existing fixture (a 15 ms step every 16 ms) read "133 ms/task". It is now
said as `back-to-back tasks`, and compare and sweep skip it.

Real Chromium (test/workers-e2e.mjs, new decoupled case): a 57 ms tick every
75 ms read `53.9 ms/task (p95 64.7) × 13.1/s (77% busy)` and "cannot judge".

## 3. Periodic hitches below the floor — cadence, and pooled samples

Agreed. The pooling costs nothing extra:
- **Gated hitches are kept.** Every hitch the gate skipped (below the floor
  or in the cooldown) is cut out of the chunks the 10 s window roll already
  stops. Only its few samples are kept.
- **A cadence pools them.** When a period holds, the members' samples are
  pooled into one `hitch-pattern` record. A period here means ≥4 hitches,
  each within 2% or 50 ms of a neighbour one period away, spanning ≥3
  periods. Pooled, twelve 75 ms frames carry as many samples as one 900 ms
  stall.
- **The report shows it.** It prints the cadence and the pooled cause, and
  marks member hitches `↻ every 15.0 s`. A ledger written before this change
  still gets the cadence from hitch times alone.

Real Chromium (test/periodic-e2e.mjs): a 70 ms `setInterval` every 3 s left 8
hitches below the floor. They were found at `every 3.00 s` and the pooled
samples gave `top serializeWorld 98%`.

## 4. Reduced-rate sims read as hundreds of hitches — frame pacing

Agreed, in both tiers. dmitriy's field case was tier 1. `framePacing` lives in
cadence.js, so both recorders share it. It looks for:
- two clusters at least 2.5× apart;
- a long cluster that is ≥25 ms and tight;
- long frames on a stride.

A change of pacing is said only when two windows agree, as one `pacing`
record. While pacing holds, a frame inside the long band is paced, not a
hitch. A stall beyond the band is still a hitch.

Profiles and summaries now carry `meanMs` beside the median. The report
prints the pacing line with mean and p95.

## 5. `update` conflates every method of that name — qualified at stop

Agreed. Keying by file:line alone would make compare read noise across
builds, because lines move. So at stop:
- **Shared names are found.** These are names that several functions of one
  script answer to.
- **Each is qualified.** The script's source is read once, and each function
  is named by its enclosing class (`Car.update`), or by line outside any
  class (`update:812`).
- **Unshared names are left alone.** They compare across builds as before.

Real Chromium (test/qualify-e2e.mjs): three classes, each with `update()`,
came back as `Car.update`, `CarManager.update` and `TrainConsist.update`.

Known limit: a comparison against a pre-0.11 run matches only names that
were never shared.

## 6. A timeline verb — built, as `sloptimize timeline`

The October 8 answer was a `git bisect run` recipe. dmitriy asked for the
whole timeline instead of a bisection, and a bisection cannot tell a
staircase from a cliff. So the verb was built.

What it does:
- **Input:** `--commits` or `--range A..B [--every N]`, `--build-cmd`, and
  `--launch` or `--exec`.
- **One run per commit.** Each commit gets one attached run over the same
  settle-then-measure window.
- **The tree is protected.** A dirty working tree is refused, and HEAD is
  restored whatever happens.
- **Shapes:** `CLIFF` (one step carries ≥60% of the change), `STAIRCASE`,
  `DRIFT` or `flat`.
- **A measured noise floor:** a commit's own runs, else the typical step of a
  long enough range, else an assumed 10% that is said as assumed.
- **A per-step profile diff** in ms/frame, self and inclusive.

**The default metric is not the frame median.** A tier-0 frame is
vsync-quantized, so 2 ms and 8 ms of work both read 16.7. The default is the
app's own `__sloptimizeFrame` body when every step has one, else sampled
main-thread ms/frame.

Real Chromium over a real git history (test/timeline-e2e.mjs): frame work
went 2 → 2 → 8 → 8 ms, and the result was `CLIFF at <3rd commit>`, naming
`rebuildLanes` by its inclusive time. Its own time sits in a shared helper.

## 7. sweep/equivalence need a custom launcher — `--exec`

Agreed. `attach --exec "<cmd>"` runs the app's own launch line for every
run, so it covers equivalence's runs too. Placeholders:
- `{port}`;
- `{tmp}`: a fresh data dir, removed after;
- `{value}` in `sweep`: the launcher sets N, and no page knob is needed;
- `{commit}` in `timeline`.

The whole process group is stopped and waited for, so the next level finds
the port free. A launcher that dies before its endpoint appears is reported
with its last output.

Real Chromium (test/exec-e2e.mjs): `sweep --exec` over `?cars={value}` read
`stepCars 2.8 → 6.0 → 14.2 ms/frame` at 20k, 40k and 80k.

## 8. Warn on `renderer.debug.checkShaderErrors` — a condition, and a warning

Agreed, with one correction. It is three's **default** (`true`), not a
dev-only setting: any build that does not turn it off ships it. So the
warning does not say "dev artifact". It says:
- each link waits on a synchronous status read;
- it counts the shader-compile hitches that wait inflates;
- it tells you to measure with the check off before reading those hitches as
  the shipped cost.

The value and three's revision come from the renderer three hands the
devtools hook. Both join the run's conditions as a mention, not a refusal.

## 9. Accept the host's frame-body timer — `__sloptimizeFrame(ms)`

Agreed. Call it once a frame:
- each profile carries the window's body median, p95 and mean;
- the run file and compare read it as `frame body ms`, the same row a tier-1
  host already fills;
- the report prints it as the number to set beside unattached runs, in place
  of "never compare".

## Game-side integration (dev-only, a few lines each)

Every one of these is now read somewhere specific:
- `__sloptimizeClock('sim', simMs, 1000)` turns "cannot judge sim-behind"
  into `sim-behind` or `headroom`. That is the F1 question.
- `__sloptimizeSim({ seed, tickHz })` enables `over-tick` without a clock and
  lets equivalence refuse runs that simulate different things.
- `__sloptimizeCount('delivered', n)` gives throughput per game-second.
- `__sloptimizeKnob('cars', n => PerfHUD.stressSpawn(n))` drives sweeps. With
  `--exec`, `{value}` on the launch line also works.
- `__sloptimizeTick(tick, WorldDigest(...))` from both the main-thread and
  the worker sim makes SIM0 checkable with `sloptimize equivalence`.
- `__sloptimizeFrame(bodyMs)` puts attached numbers beside the app's own.
