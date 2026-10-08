# dmitriy's many-agent feedback (third batch) — what shipped and what changed from the ask

Context: ~9000 simulated agents, one phase at 20.7 ms of a 45 ms frame. They
knew where the time was; what blocked them was the shape of the cost curve,
proof that an optimised sim still behaves the same, and losing the profiler
once the sim moves into a Worker. Order agreed: B, then C, A alongside.

## B. Behavioural equivalence — shipped (SPEC §3.16), with two changes to the ask

- **A tolerant mode next to exact.** The stagger dmitriy plans (half the
  per-agent update on alternate ticks) changes state on purpose, so an exact
  digest would report "diverged at tick 1" for a correct stagger. `--tolerant`
  instead compares the windowed means of summary values within a relative
  tolerance.
- **Named digest parts.** "Tick 1841, `agents` differs, `rng` identical" says
  where to look; a bare hash does not.
- **The game pushes, the tool doesn't poll.** The game calls
  `__sloptimizeTick(tick, digest, values)`; the tool can't call a sim
  mid-step. The ticks go to a file anyone can write (`ticks/<session>.jsonl`;
  `createTickLog` from `sloptimize/ticks`), so a headless Node sim compares
  with a browser run and runs faster than real time.
- **Refusals and warnings.** A different seed, tick rate or save is refused
  (exit 3). Undeclared seed or tick rate, or a drive script (wall-clock
  input), is said out loud. Too few common ticks is exit 5, never "identical".

Real Chromium (test/agents-e2e.mjs): two runs of a seeded sim matched through
400 ticks, and a build nudged at tick 300 reported `first divergence at tick
300 (identical through 299) — differs: agents (identical: rng)`.

## C. Workers — shipped (SPEC §3.18), the zero-code version

The Target.setAutoAttach plan was right. Each worker arrives paused, gets a
sampler, and is always released; an out-of-process iframe is released
untouched. The verdict is split in two:
- **worker-bound:** the main thread waits on the worker.
- **sim-behind:** the worker runs decoupled and the game clock falls behind
  real time while the frames stay smooth.

Busy % comes from samples alone, no game code. Real Chromium
(test/workers-e2e.mjs): `main 3.6 ms/frame (22% busy) · worker[sim] 16.4
ms/frame (98% busy) → worker-bound`, plus the worker's heaviest function.

**Correction to "workers aren't supported in the browser":** Web Workers run
in every browser and in Electron. What was missing was *sloptimize* profiling
them, in both. It now does, over `attach` (browser, or Electron with
`--remote-debugging-port`) and over `attachInApp` (Electron in-process).

Not built: the worker's share of one particular hitch frame. Worker
attribution is per run.

## A. Scaling sweep — shipped (SPEC §3.17), exponent budget deferred

`__sloptimizeKnob(name, setter)` plus `sloptimize sweep --knob --values`.
Each level runs in its own attached session, so the page reloads and no warm
caches carry over. Every section, hot function and worker thread gets:
- **a fit:** the log-log exponent with its 95% interval;
- **steps:** the slope of each adjacent step;
- **a shape:** labelled only as strongly as the interval allows.

The frame row says where the frame budget is crossed (an extrapolation past
the largest level is labelled as one). Real Chromium: a linear section read
`~n^0.98 [0.92–1.05] linear` and an n^1.5 one `~n^1.32 [1.18–1.46]
SUPER-LINEAR`, from the game's sections and also from the sampler alone.

The exponent budget is deferred until real sweeps show how wide the interval
runs; a gate on a noisy exponent would be a coin flip.

## Found on the way

- **Profiler chunks are now credited to phases by sample time.** This uses the
  phase spans' page-clock edges and the clock mapping. A phase shorter than
  the 10 s window used to have no samples of its own; the sweep's 3 s
  measured phase showed it.
- **Rotating at each phase edge was tried and backed out.** Each rotation
  waits out the page's task, which put the record chain one frame behind per
  edge.
- **A hitch the held chunks don't cover is now `not-sampled`.** Before, it
  was attributed from a chunk of another time; with the chain behind, that
  named a later frame's function.
