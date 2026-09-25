# Integrating sloptimize into a game (and its Claude Code session)

What the mecharoyale deployment wired, generalized. Five pieces; each is
small, and the first three are enough to be useful. This doc is the ONE-TIME
wiring; for how to use the result day to day (the operator's verbs, how new
and concurrent Claude Code sessions pick up the feed), see USAGE.md. The
jitter detector and the footprint/issue catalogue have their own step-by-step
cookbook with the traps spelled out: JITTER-AND-FOOTPRINTS.md — read it
after §1 here.

## 1. The in-page runtime (the game feeds the recorder)

```js
import { createRecorder, buildCensus } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });
```

Once per frame, from wherever your loop already reads `renderer.info`,
hand the recorder numbers you already have (≤0.2ms, zero allocations):

```js
rec.frame({
  frameMs,                    // rAF-to-rAF delta (must bound insideRenderMs)
  insideRenderMs,             // wall time inside renderer.render
  calls, triangles,           // renderer.info.render.*  (WebGPU: drawCalls)
  programs,                   // program/pipeline count (WebGPU: pipeline cache size)
  geometries, textures,       // renderer.info.memory.*
  spawned,                    // entities added this frame (0 if unknown)
  paused: false,
});
```

Hitches are detected, classified with evidence, and rate-limited
automatically.

Coordinate jitter (SPEC §3.6) is the second detector — the unit or the
camera landing off its own trajectory. Feed it once per RENDERED frame,
after the render (so a transient camera shake the host restores is not
sampled), with the same clock every frame:

```js
import { createMotionMonitor } from 'sloptimize';
const motion = createMotionMonitor({
  unit: 'm',
  longFrameMs: 50,     // YOUR sim's dt clamp: a frame past it cannot have its motion judged
  tracks: {
    unit:   { floor: 0.1 },                                   // the view pivot: rotation-invariant
    camera: { floor: 0.1, reach: 'boom', follows: 'unit' },   // the eye; reach = distance to the pivot
  },
});
// per frame:
motion.sample('unit',   pivot.x,  pivot.y,  pivot.z,  performance.now(), { held: paused || !continuityExpected, phase });
motion.sample('camera', camera.x, camera.y, camera.z, performance.now(), { held: lookInputThisFrame || paused, reach, phase });
// on a camera-mode flip, a spectate-target change, a respawn, a session boundary:
motion.cut();
// drain beside the recorder's records — same pipe, same ledger:
post('records', [...rec.drainRecords(), ...motion.drainRecords()]);
```

Every record's FOOTPRINT (SPEC §3.7) — the identity of its cause — is
stamped by the writer at post time, and the game's SITUATION rides in it.
Declare the facets that make two incidents two issues in your game
(categories only, never positions), refresh the canonical string once a
second, and hand it along:

```js
import { canonicalContext, footprintOf } from 'sloptimize';
let ctx = '';
setInterval(() => { ctx = canonicalContext({ stance: 'helm', hull: 'elong-x', squad: 'duo', combat: 'no' }); }, 1000);
rec.frame({ …, ctx });                       // stamped on hitches at mint
rec.usermark({ …, ctx });
motion.sample('unit', x, y, z, t, { held, phase, ctx });
// at post, for every record (host-built ones take the current ctx):
for (const r of records) { if (r.ctx === undefined && ctx) r.ctx = ctx; const fp = footprintOf(r); if (fp) r.footprint = fp; }
```

`held` frames are not judged and re-seed the track (a mouse flick swings a
boom metres in one frame — intended; the reference runtime marks a frame
held when a mousemove/wheel/touchmove landed since the previous sample).
`cut()` is for the discontinuities the host MEANT; the reference runtime
derives them from a view-configuration key (pivot publisher · third-person
flag · spectated subject) and cuts whenever it changes, so no call site has
to remember. Bind a chord for the manual channel — capture FIRST, then
optionally ask the human for one line (see mecharoyale's
`dev/sloptimize-runtime.ts` for a complete reference including the note
overlay, held-input tracking, WebGPU regime detection, and the
GPU-process wrappers):

```js
if (ctrlF11) { const mark = rec.usermark({ windowMs: 5000, note, world }); }
```

The debugger itself ships in the package — `createPanel` (Session ·
Timeline · Fixes + the note box), dependency-free, inline-styled. Capture
first, then open it; it swallows every key at capture phase while open and
calls `onNote` exactly once on close:

```js
import { createPanel } from 'sloptimize';
const panel = createPanel({
  incidents: () => sessionIncidents,               // rows the recorder drained this tab
  feed: () => ({ state: 'ok' }),                   // or { state: 'dark', reason, buffered }
  history: () => fetch('/api/sloptimize/ledger').then((r) => r.json())
    .then(({ perf, fixes }) => ({ records: parseJsonl(perf), fixes: parseJsonl(fixes) })),
  onNote: (note) => { if (note) { mark.note = `f12: ${note}`; post('records', [mark]); } },
});
panel.open();
```

The ticker (SPEC §3.10) is the debugger's live edge: one line bottom-left
per incident record as it is minted, gone a few seconds later. Push the
same array you post:

```js
import { createTicker } from 'sloptimize';
const ticker = createTicker({ offsetPx: 28 });   // above your own corner chip
ticker.push(records);                            // beside post('records', records)
```

## 2. The sink (files on disk)

- **Vite host**: the plugin (planned surface) lands payloads in `.sloptimize/`.
- **Any other host** (esbuild, custom server): add one dev-only endpoint —
  `POST /api/sloptimize/ingest` `{kind: 'profile'|'records'|'census', payload}`
  → writes `.sloptimize/profile.json`, appends `perf.jsonl`, writes
  `census.json`. Gate it to your dev flag and 404 identically to unknown
  routes otherwise (mecharoyale: `server/admin/sloptimize-ingest.ts`, ~100
  lines + tests).
- **Activation**: don't gate the client on `location.hostname` — a dev
  preview proxy looks like production. Probe the ingest endpoint at boot;
  a 204 arms everything, anything else stays dark — and RETRY the probe on
  a backoff (5s/30s/2min, then every 5min): an ingest that comes back
  mid-session must re-light the instrument without a hard refresh.
- **Transport state, never silent**: once armed, a refused or failed post
  flips the feed DARK — buffer outgoing posts (bounded, count drops), retry
  on the same backoff, and SHOW the state (the reference runtime renders it
  on its PERF chip and in the debugger header, with the reason). The first
  deployment's "first 404 disables posting for the session" contract lost an
  hour of real freezes to a server restart that dropped the ingest.
- **Self-sufficient records**: stamp `build` (the tab's bundle identity) and
  `phase` (menu/boot/launch/match…) on every ledger line. The recorder
  accepts `phase` per `frame()` sample and stamps hitches at mint time;
  backfill the rest at post time. A record read in isolation weeks later
  should not depend on the arm-probe that happened to precede it.
- **Heartbeat**: post a tiny `{type:'heartbeat', medianFrameMs, p95Ms,
  calls, triangles, programs}` ledger line once a minute while armed
  (directly — never through the recorder, so it costs none of the incident
  budget). It makes a quiet file MEAN dark-or-closed instead of idle;
  `sloptimize hook-status` warns once when the ledger goes stale (>45min).
  The counters ride the beat because `profile.json` is overwritten every
  2s — without them the ledger has no draw-call HISTORY, and the debugger's
  Timeline cannot draw "calls over time".
- **Ledger read-back** (for the debugger's Timeline/Fixes tabs): one
  dev-gated `GET /api/sloptimize/ledger` → `{ perf, fixes }` — the last
  ~2MB of `perf.jsonl` (first partial line dropped) and all of
  `fixes.jsonl`, as raw JSONL strings. Same gate as the ingest, 404
  otherwise. The page folds it with sloptimize's own `history.js`; the
  server stays a file reader (mecharoyale: `readSloptimizeLedger`, ~20
  lines + tests).
- **GPU-settle verdicts**: if your boot holds its reveal on
  `queue.onSubmittedWorkDone()` (it should — pipeline compiles bill the
  first submit that uses them, invisibly to every CPU-side recorder), post
  `{type:'gpu-settle', tag, ms, settled}` when the wait was real (>50ms or
  capped). That record is the on-hardware proof the freeze moved behind the
  cover.
- **createStacks** (optional, on hitch records): capture `new Error().stack`
  in your createRenderPipeline/createComputePipeline/createShaderModule
  wrappers into a small ring (creates are rare — never do this per draw or
  per write), and attach the top ~3 deduped tails to any hitch whose frame
  window overlaps them, byte-capped (~2KB). Ship an UNREFERENCED external
  sourcemap from the same build so the minified positions decode to source
  file:line on the dev side without ever serving the map to players.

Flush cadence: post `profile` every ~2s, drain records with it.
Gitignore `.sloptimize/*` except `budgets.json`.

### Cloud sink (optional — [sloptimizejs.com](https://sloptimizejs.com))

The dev-endpoint sink above stays the default: it is what makes the files
useful with nobody watching. sloptimize cloud is an additive tee — never a
replacement — that ships the same records to the service so the catalogue
spans every player and build, not just this machine. Sign in with GitHub,
create a project, and its settings page hands you the publishable key. Run
the sink BESIDE the local `post()`, never instead of it:

```js
import { createCloudSink } from 'sloptimize/cloud';
const cloud = createCloudSink({ key: 'pk_live_…', endpoint: 'https://sloptimizejs.com/v1/ingest', build });   // publishable: safe in the client bundle
// wherever the local sink drains and posts:
const batch = [...rec.drainRecords(), ...motion.drainRecords()];
post('records', batch);   // unchanged: the local ledger, still the source of truth
cloud.enqueue(batch);     // same records, teed to the cloud sink's own queue and flush timer
```

Every record the sink sends is stamped with a `session` id (12 chars, minted
once per sink — a tab's lifetime), which is what the service's Sessions view
groups by; pass `session: '<id>'` to pin one, and a record that already
carries a `session` keeps it. `enqueue(records)` just appends to the sink's internal queue (capped at
`maxQueue`, oldest dropped and counted honestly) — it does not fetch or
flush itself; the sink's own timer (and `pagehide`/`visibilitychange`) drain
and post it on the usual backoff. Pair it with `createErrorMonitor(rec)` —
the SAME recorder from §1, not a bare call — so uncaught client errors land
in `rec` via `recorder.emit()` and ride `rec.drainRecords()` into `batch`
above like any hitch, with no separate wiring to the cloud sink needed.

**The cap.** A project's daily cap and an account's monthly quota bind
incidents only; the heartbeat series and page exits (below) are never quota.
When the service says the cap is spent (a `202` carrying `capped`, or a `429`
whose drops are all `cap`), the sink sheds incidents until the answer's
`Retry-After` and keeps posting beats and exits, so a capped day does not
blind the Sessions view. `sink.stats().capped` counts what it shed.

**The device and the frame (0.7.0).** A sink with a session files one
`device` record when it is created (cloud ruling 36). It carries the browser's
own facts (`ua`, `platform`, `mobile`, `touch`, `dpr`, `screenW/H`, `vw/vh`,
`cores`, `memGB`; `browserDevice()` reads them) merged with what only the host
knows, passed as `device`: its GPU as its renderer resolved it, its backend,
its quality level, its drawing buffer. Call `sink.device(facts)` when those
change; it files again only if something differs. `device: false` files none.
Keep it to performance facts: the cloud refuses more than 48 fields or
strings over 160 chars.

```js
const cloud = createCloudSink({ key, endpoint, build, device: { gpu, backend: 'webgl2', level: 'low', bw: 603, bh: 276 } });
cloud.device({ gpu, backend: 'webgl2', level: 'medium', bw: 1206, bh: 552 });   // the player picked Medium
```

A host that samples its frame (the SPEC §3.2b `profile` record) can tee it to
the cloud like any record. The sink forwards the first and then one per
`profileEveryMs` (60 s), and counts the rest in `stats().profilesThinned`.
The cloud keeps each map's largest entries and shows ms/frame per section,
per phase, on the session's page (ruling 37). Neither record is ever quota.

### How the last page ended (optional — `createExitTrail`)

A player "thrown back to the menu" is a page being replaced, and no incident
can say so: the page that could have reported it is gone. The exit trail keeps
each page's last events in `sessionStorage` (it survives a reload AND a killed
process). The NEXT page in the tab reports how the previous one ended, as one
`page-exit` record:

- `killed`: no `pagehide`. The browser ended the process (out of memory, a
  crash). On a phone the tab then reloads.
- `code-reload`: your code left through `trail.reload(reason)` /
  `trail.navigate(url, reason)`, named.
- `browser-navigation`: a `pagehide` your code did not ask for (a refresh
  gesture, back, the address bar).

```js
import { createExitTrail } from 'sloptimize';
// as early in the page as you can — a page replaced before this line leaves nothing
const trail = createExitTrail({ build, touchStripPx: 60 });   // touchStripPx: record taps near the top edge (0 = off)
const cloud = createCloudSink({ key, endpoint, build, session: trail.session, sources: [trail] });
trail.crumb('phase', 'match');          // what only your game knows: phases, kicks, GPU loss…
trail.reload('return-to-menu');         // instead of location.reload(): the next page can say who
```

Give the sink the trail's `session`, so the dead page's records and its exit
join on one id. The trail records `pagehide`, bfcache restores, visibility,
viewport changes, uncaught errors, and taps and clicks on controls by itself.
`trail.previous()` hands the host the same exit to read. The cloud's Sessions
page opens with "How sessions ended" (verdicts per build) and shows a session's
last events; `/v1/exits` answers the same.

### Game server (optional — the same project's secret key)

The server side of the same catalogue: ticks that overran their budget,
event-loop stalls the runtime itself measured, and uncaught errors — each
attributed by a sampling profiler and shipped through the same cloud sink
the browser uses.

```js
import { createServerRuntime } from 'sloptimize/node';
const server = createServerRuntime({ key: process.env.SLOPTIMIZE_KEY, endpoint: 'https://sloptimizejs.com/v1/ingest', build, tickBudgetMs: 16 });

function gameLoop() {
  server.tick(() => {          // wraps one tick; records a server-hitch if it overran tickBudgetMs
    // … the game's own tick work …
  });
}
```

The key here is a SECRET key (`server-*` record types and the read routes
are secret-only) — it never goes in a client bundle. Mint it on the same
keys & setup page (kind: secret) and copy it when it is shown, once.

`createServerRuntime` registers `uncaughtExceptionMonitor` only (never
`uncaughtException`/`unhandledRejection`) — it observes a crash, it never
becomes part of the crash path. That also means that under
`--unhandled-rejections=warn` or `none`, unhandled rejections are NOT
captured: `uncaughtExceptionMonitor` sees them only in Node's default
`throw` mode. Call `await server.close()` on shutdown to
flush the queue; a `beforeExit` hook already races a best-effort flush so a
clean exit does not lose the last batch.

The sampler is a rolling window, bounded in time: V8 keeps every sample of a
running profile in memory until it is stopped, so the runtime rolls the
profiler over every 10 s when no hitch has read it. A server that runs quiet
for hours (an empty lobby) holds at most one window of samples — never the
whole day's — and each hitch is attributed by the frames of the seconds
leading up to it, not by everything the process did since the last one.
`profile: false` turns the sampler off altogether (attribution `off`).

### A host that profiles itself (optional)

A `long-script` hitch is the one verdict sloptimize cannot take further in a
player's tab — there is no profiler there. If the game keeps its own per-frame
sections, put the top ones on the record before it is drained:

```js
rec.sections = [{ label: 'sim.world.greenery', excessMs: 41.2, baselineMs: 1.1 },
                { label: 'terrain',            excessMs: 9.6,  baselineMs: 0.4 }];
```

The first section becomes the hitch's SITE in its footprint (`hitch|play|
long-script|section:sim.world.greenery`), so the catalogue shows one row per
cause instead of one row per phase; mints, when a hitch has them, still win.
Extra fields (`sectionCoverage`, `offLoop`, …) ride along as evidence.

### …and posts that profile to the ledger on a cadence

Sections on a hitch say what one bad frame was made of. To say what the
ORDINARY frame is made of — and whether a fix moved it — post the same
instrument's means as a `profile` line every ~10 s in play (SPEC §3.2b):

```js
post('records', [{
  type: 'profile', at: new Date().toISOString(), build, phase, ctx, regime,
  window: { frames: p.frames, seconds },
  frame: { medianMs, p95Ms, bodyMs: p.bodyMsPerFrame },
  sections: p.sectionsMsPerFrame,      // mean ms per frame, biggest first
  counts: p.countsPerFrame,            // mean per frame
  gauges: Object.fromEntries(Object.entries(p.gauges).map(([k, g]) => [k, g.value])),
}]);
```

Sample rather than accumulate if the instrument costs anything with nobody
reading it: open the profiler for two seconds every ten, read it, close it
(unless a panel holds it). After that, `sloptimize report` shows the frame
by section without a keyboard, and `sloptimize fix` says which sections and
counters a build moved — the before/after that used to need a paste.

### …and lets that profile decide the verdict

Sections are a site; they do not change the guess. When the host has
MEASURED what spent the frame — a loop section over its baseline, a tagged
activity that ran between frames (a shader warm, a server tick stepped on
the render thread, a scenery build), an attributed long task — hand those
spans to `reclassify` before the drain and the classifier takes a second
look with them:

```js
import { reclassify } from 'sloptimize';
reclassify(rec, [
  { label: 'mesh:step',   ms: 12.3 },   // what ran during the gap, by tag
  { label: 'net:DELTA',   ms: 2.1 },
  { label: 'crowd.bodies', ms: 3.9 },   // a section's excess over baseline
]);
// rec.classification[0] → { guess: 'host-attributed', confidence: 'high',
//   evidence: 'mesh:step 12.3ms of 14.1ms excess, host-instrumented' }
// rec.attributed → the spans, largest first (at most three)
// footprint → hitch|play|host-attributed|span:mesh:step
```

A span has to explain at least half of the frame's excess over its median
to become the verdict (SPEC §3.3); smaller ones still ride on the record as
evidence. Do this at drain time, not at mint: the browser's long-task and
long-animation-frame entries for a frame arrive a drain or two after it, and
a loop's section table closes at the end of the body. Without this step a
hitch whose cost was entirely off-loop and unnamed by any counter reads
`gc-or-upload-by-elimination` — which is what a game whose match server ran
on the render thread saw 4,338 times before the step was tagged.

### …and answers the agent's asks (dev only)

The dev ingest, on a `profile` post, reads `.sloptimize/ask.jsonl`, keeps
the requests `pendingAsks(askText, ledgerTail)` returns, and answers the post
with `200 {"asks":[…]}` instead of `204`. The tab runs each one and posts
`{type:'answer', id, kind, ok, result|error, ms}` through its records post.
Kinds: `profile` (open the frame profiler for a window and answer with the
SPEC §3.2b record), `capture <s>` (the host's own capture), `cpuprofile <s>`
(`new Profiler()` where the document policy allows it; answer with the
top self-time frames), `eval <js>` (`new Function` in the page, awaited,
JSON result — refuse it wherever the dev switch is off). See SPEC §3.9.

## 3. The CLI (the agent's shell surface)

`sloptimize report|check|census|doctor --dir <game>/.sloptimize` — no
setup beyond the files existing. Declare budgets in
`.sloptimize/budgets.json`:

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

`check` exits 0/1/4 — the termination condition for an agent loop.

## 4. The Claude Code session (pull: ambient on every prompt)

`.claude/settings.json` in the game repo:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ {
  "type": "command",
  "command": "node <path-to>/sloptimize/bin/sloptimize.mjs hook-status --dir .sloptimize 2>/dev/null || true",
  "timeout": 10 } ] } ] } }
```

Silent unless a NEW keyframe or a budget-breach edge exists; at most 5
lines. Copy the doctrine skill into `.claude/skills/sloptimize/` so any
future session inherits the playbook (report → classify → census → ONE
change → verify with counters; never claim a fix without a before/after).

## 5. The push channel (auto mode: the agent is woken, nobody types)

`sloptimize watch` is the watcher (SPEC §8.1.1): a byte cursor over each
`--dir`'s `perf.jsonl`, polled every 20s, printing ONE line per record an
agent should act on — every usermark, every auto hitch ≥100ms
(`--min-hitch-ms`), a gpu-settle that hit its cap, any gpu-stall, every
coordinate jitter that is its own incident (`↯` — not a long-frame
catch-up, not a passenger of another track), and the feed going quiet /
coming back. Every line ends with the record's footprint and how many
times this ledger has seen that cause (`fp=a3f92c1d ×7`, SPEC §3.7):
`sloptimize issues --fp a3f92c1d` is its history and the fixes applied. Heartbeats, arm-probes and small hitches
stay silent. It starts at EOF (history is `report`'s job) and never exits.

Arm it as a Claude Code Monitor — stdout lines become wake events:

```
Monitor({ command: 'node <path-to>/sloptimize/bin/sloptimize.mjs watch --dir .sloptimize',
          description: 'sloptimize perf incidents', persistent: true })
```

To make every session arm it WITHOUT anyone asking, add a `SessionStart`
hook that prints the instruction into the agent's context (mecharoyale's
`.claude/settings.json` is the reference; it skips ticket-runner jobs so a
session working an unrelated task is not pulled off it, unless
`SLOPTIMIZE_WATCH=1` says otherwise). The operator then just plays:
auto-detected hitches and Ctrl+F12 notes wake the agent with the
classification attached, and it starts the §8.2 playbook unprompted.

## Porting cost, measured once

mecharoyale (149k-line client, esbuild, WebGPU, no vite): runtime file
~250 lines, server endpoint ~100 + tests, build-resolution plugin ~15,
one `rec.frame(...)` call at the existing stats site, settings + skill
copies. One session end to end, including the mistakes this doc exists
to save you from (hostname gating, arming inside an on-demand function,
frameMs not bounding insideRenderMs).
