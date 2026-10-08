# dmitriy's load-phase feedback (ticket 53db0f54) — verdicts and what shipped

Source: a regression hunt on R21 (load 9 s → 32 s, traced to 4.4 billion
point-segment tests in one function). The question for each item: is it
true of the code, does it hold for games other than his, and should it ship?

## 1. Line-level attribution inside the top function — VALID, shipped

True: V8 profile nodes carry `positionTicks` (1-based line → ticks) in the
payload attach already parses, and nothing read them. Checked in headless
Chromium: a function with a sqrt loop on one line and a sin/cos loop on
the next put ~96% of its ticks on the second. One wrinkle: V8 can list a
line several times in one node (one entry per code version), so the ticks
must be summed. General to any engine with a big update/tick/step function.

Limits we state rather than hide. A minified one-line bundle puts every
tick on line 1, and then we print no lines. A function V8 inlined samples
as its caller, and the line we print is the call site. Both cases were
seen in the e2e.

Shipped: `topFrames[].lines` (top 3 lines, each ≥5% of the function's own
ticks). Rows are now one per FUNCTION; before, each call path was its own
row, which split one cost into several. The run file keeps per-line ticks
for each phase's 25 heaviest functions. `report` prints them under the
hitch's top frame and under the run's heaviest self time.

## 2. Do not give up on the longest frames — VALID problem, different mechanism

The problem is real. On master, the fixture (12 back-to-back 300 ms frames,
each running its own function) gave 8 of 11 `unattributed (cooldown)`, and
the 3 frames it did attribute named a NEIGHBOUR's function.

The proposed mechanism does not work. A profile can't be started for "the
remainder" of a running frame, because a CDP `Profiler.stop`/`start` waits
for the page's current task. We measured it: a stop sent 300 ms into a 2 s
task is answered at 2 s. Attach also has no signal that a frame is still
running; the page's main thread is the busy one.

It isn't needed either. The always-on sampler already holds those samples;
the cooldown only refused to read them. Shipped:
- **The exemption.** A frame of ≥150 ms ignores the cooldown.
- **A hitch's own samples.** The page clock is mapped onto the sampler's
  once per document: a `performance.now()` read is batched on either side
  of a stop, and the mapping was within ±8 ms. Each hitch's `frameSpan` is
  then cut out of the last 4 chunks by sample time (`profileWindow:
  'frame'`). This fixes an off-by-one the feedback didn't mention. With long
  frames back to back, the stop a hitch asks for lands at the end of the
  next frame, so reading whole chunks made every attribution one frame late.
- **An older bug found on the way.** A rotation awaited the stop before
  sending the start, so the start waited out the next task. Every frame
  after a rotation went unsampled (300 ms gaps between chunks), and those
  samples were missing from the run file as well. Stop and start now go
  out together.
- **Hitch phase.** A hitch is filed under the phase that covered most of
  its frame. Before, a 2 s load whose last statement set 'settle' was
  filed as a settle hitch.

After the change: 12/12 frames are attributed from their own samples, each
naming its own function (test/long-frames-e2e.mjs). Shader warmup, GC
storms, level transitions and asset streaming all have this shape.

## 3. Section counts and the "per call vs call count" verdict — VALID, shipped

True, and the existing tier-1 `sections` don't cover it: those are mean ms
per FRAME over a window, which suits a steady loop and says nothing about
a one-off phase. Splitting "called more" from "slower per call" is the
first fork of almost every regression, in any engine.

Shipped: `__sloptimizeSection(name, ms, calls)` accumulates on the open
phase span. `compare` gives each section three rows (total ms, calls,
ms/call) and a verdict: `same call count, 31x ms/call → the work PER CALL
changed (look inside it)` versus `same ms/call, 32x calls → it is CALLED
more (look at its callers)`. A factor within 10% of 1x reads as unchanged.

## 4. Cost per unit of work — VALID, shipped (and it needed phase durations first)

True, and there was a missing prerequisite: tier 0 never measured how long
a phase took. A load made of a few multi-second frames never fills a
120-frame profile window. So `__sloptimizePhase` became an accessor, and
every assignment is timed (`phase-span` records). `__sloptimizeScale(unit,
n)` declares the phase's size. `report` prints `load 9000 ms · 1469 roads →
6.127 ms/road`. `compare` reads ms/unit, and when the sides worked on
different sizes it marks the absolute rows `unlike`, so they are never a
regression, and reads the section verdict per unit. `check` takes
`perf.budget.<phase>.ms_per.<unit>` and `phase_ms`.

Stated limit: per unit assumes cost is linear in the unit. One run can't
show that; runs of one build at two sizes can. We say "comparable per
unit", not "linear".

## 5. Bisect driver — VALID idea, NOT a verb: `git bisect run` plus the gate's exit codes already do it

`check` already speaks the bisect protocol once exit codes are mapped: 0
pass, 1 breach, and 3/4/5 incomparable/unmeasured/cannot-judge, which is
git's 125 "skip". A verb would have to re-implement checkout and build
orchestration that git and each project's own build already own. The
recipe:

```sh
# budgets.json lives in a --dir outside the repo, so every checkout reads the same budgets
mkdir -p /tmp/bisect-slop && cp .sloptimize/budgets.json /tmp/bisect-slop/
git bisect start <bad> <good>
git bisect run sh -c '
  npm run build || exit 125
  B=$(git rev-parse --short HEAD)
  npx sloptimize attach --launch http://localhost:5173 --build "$B" --runs 3 --duration 40 --dir /tmp/bisect-slop || exit 125
  npx sloptimize check --build "$B" --min-runs 3 --dir /tmp/bisect-slop
  case $? in 0) exit 0;; 1) exit 1;; 2) exit 128;; *) exit 125;; esac'
```

(Exit 2 means a bad budgets.json, and 128 aborts the bisect rather than
skipping every commit.) With `perf.budget.load.ms_per.road` as the budget,
the bisect is portable across saves too. Revisit a verb only if agents
keep writing this script by hand.
