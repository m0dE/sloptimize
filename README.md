# sloptimize

The agent-native profiler for three.js games. slopjs makes the slop
addressable; **sloptimize makes it fast** — by giving a coding agent the three
verbs the evidence says it cannot do alone: **measure, attribute, verify.**

Your agent cannot watch a game run. It will never feel a hitch, cannot afford
to screenshot 60 times a second, and — measured across the 2025–26 benchmark
literature — delivers a fraction of expert speedups precisely because it
cannot localize a bottleneck or verify a fix. sloptimize closes that loop:

- **A flight recorder** samples every frame at the render call, always on,
  panel or no panel. When a frame blows its budget, a structured record —
  counter deltas, entities spawned, camera pose, inputs held, a first-guess
  classification — lands in `.sloptimize/perf.jsonl` *before anyone asks*.
- **Attribution** turns "940 draw calls" into "`gltf_town` contributes 611,
  and 500 of its meshes would collapse to ~1 with `InstancedMesh`" — a static
  per-entity cost census plus measured bisection against the paused world.
- **A bench** restores the same snapshot, pins the clock, runs N frames, and
  diffs two runs with noise guards and honest truth grades — so "my fix
  improved p95 by 12ms" is a measurement, not a claim.
- **Budgets** (`perf.budget.draw_calls`, `perf.budget.frame_ms_p95`) make
  "fast enough" a command with an exit code — which is what lets an agent
  self-iterate in a loop that actually terminates.

## Status

Pre-implementation. The founding specification is [`docs/SPEC.md`](./docs/SPEC.md);
the strategy and evidence that produced it live in the slopjs repo
(`docs/performance-strategy.md`). Nothing here runs yet.

## Relationship to slopjs

A sibling product on the same platform, deliberately separate: slopjs is a
pointing device for a human-in-the-loop authoring session; sloptimize is a
measurement loop that must work with nobody watching. It peer-depends on
`@slopjs/inspector` for the primitives every feature stands on — stable
entity IDs, the coherent pause, `snapshot`, `clock`, and the render-call
interception. Severed from those it would be just another `renderer.info`
HUD, and the world has enough of them.

## Scope

**Is** — an always-on frame recorder with hitch forensics, a per-entity cost
census, measured attribution against a paused world, a deterministic
before/after bench with an optional launched browser, perf budgets wired to
exit codes, and the doctrine files that teach a coding agent the loop.

**Is not** — an inspector (that is slopjs), a JS CPU profiler or heap
analyzer (that is Chrome DevTools; we pair with its MCP, we do not compete
with it), a per-draw GPU timer (WebGL cannot honestly provide one), a
production telemetry service, or a general browser-automation layer.

## License

MIT
