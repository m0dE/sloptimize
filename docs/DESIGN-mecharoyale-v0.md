# v0 field deployment: mecharoyale (decision record)

The first real integration target diverges from the spec's assumed platform
in three ways, and v0 is shaped by meeting the game where it is:

1. **No vite.** The game builds with esbuild and serves itself. The vite
   plugin (§1) is therefore not the v0 transport: the in-page runtime posts
   payloads to a dev-gated endpoint on the game's own server
   (`POST /api/sloptimize/ingest`, active only under `ALLOW_DEBUG_SPAWN=1`),
   which lands them in `.sloptimize/` exactly as the plugin would. Same
   files, same schemas, different pipe. The vite plugin remains the plan for
   vite hosts.
2. **WebGPURenderer.** `renderer.info` exists with the same counters
   (`render.drawCalls` not `render.calls`, `render.triangles`,
   `memory.geometries/textures`; programs via the pipeline cache). The
   integration maps names at the sampling site; the recorder is
   renderer-agnostic numbers-in.
3. **`@slopjs/inspector` is present but constrained** (`?debug&inspect`, own
   bundle, pause refused for live multiplayer — the game's own integration
   notes). v0 therefore ships M0+M1 (+§3.5 usermarks): recorder, census,
   hints, CLI report/check/census/doctor. The bench/gate tier (M3) and
   paused-world bisection (M4) wait until the pause story for a
   client-authoritative multiplayer game is resolved; `doctor` says so.

Budgets: v0 reads `.sloptimize/budgets.json` (the game has no vite tunables
panel wired for `tune()`); moving to `tune('perf.budget.*')` when the
inspector's tunables surface is adopted by the host remains the spec path.

The host feeds frames from its ONE render loop (both of the game's frame
loops call a single `sloptimizeFrame()` after their render call), the census
walks the live match scene with the game's own entity groupings, and
Ctrl+F11 is wired per §3.5.
