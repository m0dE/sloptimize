# Using sloptimize day to day

INTEGRATION.md is for wiring a game once. This is the manual for everyone
AFTER that: the operator who plays, and the Claude Code sessions that read.
Everything here was verified live against the reference deployment
(mecharoyale) — the multi-session semantics by running the actual hook
binary from parallel directories.

## The mental model (one sentence)

The game never talks to a Claude session: it posts to **its own server**,
the server writes files into `<server cwd>/.sloptimize/`, and every Claude
session **reads those files** — a broadcast over the filesystem, not a
channel to anyone.

```
game tab ──POST──► game server ──writes──► .sloptimize/{profile.json, perf.jsonl, census.json}
                                               ▲            ▲            ▲
                                        session A      session B      session C
                                        (reads at its next prompt, independently)
```

## A normal day

1. **Start the game server with its dev switch** (reference deployment:
   `ALLOW_DEBUG_SPAWN=1` or `SLOPTIMIZE_INGEST=1`; the standalone launcher
   sets the latter by default). Without it the ingest endpoint does not
   exist and every tab stays inert — by design, that is what production
   looks like.
2. **Open the game and just play.** The in-page runtime arms itself:
   instantly on localhost or `?sloptimize`, otherwise by probing the ingest
   endpoint (204 arms; the probe retries on a backoff, so a server that
   comes up late still lights the recorder without a refresh). Your
   confirmation is the **PERF chip** (bottom-left, dev sessions only):
   - `◉ PERF` — armed, feed flowing.
   - `◌ PERF DARK` — armed but the server refused/vanished; recording
     continues, posts buffer and retry. Hover the chip for the reason.
3. **When something feels wrong, press Ctrl+F12** (or click the chip).
   The trailing 5 seconds freeze **at the press** — typing the note cannot
   shift the window. Then:
   - type one line ("huge stutter when the buildings loaded") + Enter →
     keyframe + note land in the ledger;
   - Esc or just closing → you were only looking; nothing is minted.
   The debugger has three tabs (← → switch them):
   - **Session** — this tab's incident list; every row already reached the
     ledger when it happened.
   - **Timeline** — the deployment's history: frame p95, draw calls and
     hitch spikes on one time axis, build boundaries dashed, and a
     "now vs first build" line. Hover a bucket for its numbers. A gap is
     "nothing measured then", never zero; a caret is a spike past the
     strip's ceiling (hover reads the real value).
   - **Fixes** — what sloptimize + Claude Code changed and what it bought:
     one card per recorded fix — date, commit, was → now, and the measured
     before/after (p95, draw calls, hitches/h, worst frame) sparklined.
4. **Go to a Claude Code session and type anything.** The evidence arrives
   attached to that prompt. That's the whole handoff.

## A new Claude Code session: zero setup

Any session started in a repo with the prompt hook installed (README
"Claude Code integration") is integrated from its first prompt. The hook
runs `sloptimize hook-status` on every prompt-submit and prints at most 5
lines, only when something is NEW:

- `★ NEW perf keyframe (f12: <your note>) …` — a usermark, with the worst
  frame's classification and evidence inline.
- `⚠ budget breach (<regime>): perf.budget.… n/limit` — a budget crossed
  an edge (said once per distinct breach signature, re-said if it clears
  and returns).
- `◌ feed quiet Nmin …` — the ledger went stale (>45min). Heartbeats keep
  it fresh once a minute while a session is armed, so quiet MEANS the feed
  is dark or the play session ended — never merely "idle".

Silence means nothing new — the hook exits 0 with no output.

The watcher (below) adds the live lines. Reading one:

```
sloptimize ↯ jitter unit snap 17.542 (jump [-16.25, 5.552, 3.584], expected 1.363 of travel
  at 33.25/s in a 41ms frame) @ … → snap (17.542m off its trajectory …; motion resumed from
  the new place) phase=play ctx=combat=yes,hull=droyd-g,squad=duo,stance=helm,view=tps
  build=v178… fp=b5b203ba ×2 [.sloptimize]
```

`↯` is a coordinate jump: which track (the unit or the camera), how far off
its own trajectory it landed, what constant velocity predicted for that
frame, and the verdict — `snap` (one displacement, motion resumed),
`oscillation` (frame-to-frame reversals), `follows-track` (the camera rode
along with the unit; that record is the cause), `reach-change` (the camera
boom clamped or zoomed), `long-frame-catch-up` (the stall it rode is the
incident — silent on the watcher, listed in the ledger). `ctx=` is the
game's situation when it happened; `fp=` is the cause's id and `×N` how
often this ledger has seen it — `sloptimize issues --fp <id>` is its history
and the fixes already applied.

## Several sessions at once: who gets told?

**All of them, once each.** Dedup state is **per working directory**
(`.sloptimize/.hook-state.json` in the session's own cwd, keyed by watched
dir), not global. Three sessions in three worktrees each surface the same
new keyframe at their own next prompt, then never again.

Consequences worth knowing:

- **You pick the acting session by typing into it.** The game cannot
  address a session and the F12 box cannot target one. Work the incident
  wherever you type; the other sessions merely mention it once.
- **Delivery is pull, not push.** A session you never prompt never hears
  anything, no matter how many freezes land in the ledger.
- **Same-directory sessions race.** Two sessions sharing one cwd share one
  `.hook-state.json`; whichever prompts first consumes the "new" flag and
  the other never sees that record. One session per directory (worktrees
  make this automatic).
- **Scope follows the `--dir` flags.** The reference hook watches the
  session's own `./.sloptimize` **plus** the main deployment's directory.
  So a worktree's private dev server is seen only by that worktree's
  session; the shared deployment is seen by everyone.

## Do I need a dedicated monitor session?

**No** for the normal loop above — the hook makes every session ambient.

**Yes, one, if you want unprompted reaction** (or none, if the
`SessionStart` hook arms the watcher for you) — an agent that starts
investigating while you keep playing and never type. Two recipes:

- **`sloptimize watch` as a Monitor** (INTEGRATION.md §5): the shipped
  watcher polls `perf.jsonl` with a byte cursor (~20s) and wakes the
  agent with one line per new usermark, ≥100ms hitch, gpu cap-hit, coordinate jitter or
  feed-dark edge. A `SessionStart` hook can arm it in every session
  automatically — then nobody types anything, ever.
- **`/loop` in one session**: e.g.
  `/loop check <game>/.sloptimize for new keyframes or budget breaches; investigate any new incident`
  — that session self-paces polls and works incidents autonomously.

Either coexists with the ambient hook in the other sessions; dedup state
is per directory, so the watcher consuming its own view hides nothing from
anyone else.

## The Issues tab: what keeps happening, and what was done about it

Every incident carries a **footprint** — the identity of its cause (kind,
phase, verdict, site, and the game's own situation: which machine, at the
helm or on foot, squad size, in combat), never the time it happened. The
debugger's **Issues** tab groups the whole ledger by footprint: one row per
cause, `×N` occurrences, `last 3h ago`, the situation as chips. Click a row
for its history: first and last seen, builds, worst, the last verdict, and
every fix a session recorded against it (`sloptimize fix propose
--footprints <id> …`). The same catalogue is `sloptimize issues` in a
shell, and every watcher wake line ends with `fp=<id> ×N` so an agent knows
on arrival whether it is looking at something new or the seventh time.

## Reading on demand (any session, any shell)

```bash
npx sloptimize report --dir <game>/.sloptimize   # profile + incidents
npx sloptimize check  --dir <game>/.sloptimize   # budgets → exit 0/1/4
npx sloptimize census --dir <game>/.sloptimize   # per-entity costs
npx sloptimize history --dir <game>/.sloptimize  # p95/calls/hitches over time, per build + fixes
npx sloptimize doctor --dir <game>/.sloptimize   # what is wired/degraded
```

## The cloud catalogue (optional, paid, invite-only)

With a project on sloptimize cloud, `SLOPTIMIZE_KEY` and `SLOPTIMIZE_ENDPOINT`
(or `--key`/`--endpoint`) point the same CLI at every player's ledger
instead of just this machine's:

```bash
export SLOPTIMIZE_KEY=<key from the settings page>
export SLOPTIMIZE_ENDPOINT=<endpoint from the settings page>
npx sloptimize issues --cloud                     # last 24h across every player/build, by default
npx sloptimize issues --cloud --preset 7d         # or 30d
npx sloptimize issues --cloud --from <ISO> --to <ISO> --source client --kind hitch
```

Unconfigured, it exits 2 and names the missing variable rather than
silently falling back to the local ledger; a request that fails once
configured (bad key, unreachable endpoint) exits 4. `sloptimize doctor`
reports which state you're in (`cloud: configured (<endpoint>)` or
`cloud: not configured (...)`).

`sloptimize fix --push` records the fix locally exactly as `sloptimize fix`
always has — the local ledger stays the source of truth — and then also
POSTs it to the cloud service; a push failure prints `push failed: <reason>`
but the command still exits 0, since the fix was recorded either way.

## Recording a fix (the agent's last step)

Once a fix is verified — the new build is live and the ledger has evidence
from it — the session records it:

```bash
npx sloptimize fix --dir <game>/.sloptimize \
  --title "Launch: pipelines pre-warmed behind the reveal cover" \
  --issue "programs +4 mid-launch, 1.4s freeze on first draw" \
  --solution "compile the launch material set inside the hangar settle gate" \
  --commit $(git rev-parse --short HEAD)
```

The before/after are **measured**: by default the previous build's window
vs the latest build's (a fix ships as a build), or name them —
`--before v1787863993876 --after v1787881270783`, or a range
`--before 2026-08-27T20:00Z..2026-08-27T22:00Z`. The record lands in
`fixes.jsonl`; the Fixes tab and `sloptimize history` read it back. From
Claude Code the same verb is the MCP tool `record_fix`.

Rules that keep the numbers honest (the doctrine skill enforces them):
counters (calls/triangles/programs) compare exactly on any renderer;
timing counts only in `regime: hardware`; an absent field means
unmeasured, never zero; `long-script` escalates to a CPU profiler —
sloptimize answers *which frame, which entity, which workload*, not
*which function* (unless the attach tier's sampler is running).

The armed page also exposes a console surface: `__sloptimize.mark(note)`,
`.census()`, `.summary()`, `.feed()` (transport state), `.gpu()`
(WebGPU-wrapper stats), `.mints()` / `.remint()` (pipeline-mint
attribution).

## When it seems dead

- **Chip says DARK / hook says feed quiet**: the usual cause is the game
  server restarted **without its dev switch** — the ingest 404s exactly
  like production. Restore the switch; the client re-probes every 5
  minutes and flushes what it buffered. No refresh needed.
- **No chip at all**: the tab never armed — not localhost, no
  `?sloptimize`, and the arm probe never got its 204. Same fix.
- **`no census.json`**: nobody has walked the scene yet — run
  `__sloptimize.census()` in the game tab.
- **Ctrl+F12 does nothing**: click the chip instead (keyboard geography
  is why it exists); failures log `[sloptimize]` lines to the console
  rather than dying silently.

## The fix loop (git only)

A fix is a PROPOSAL: a `sloptimize/<slug>` branch and one entry in
`.sloptimize/fixes.jsonl`. No forge, no API, no token — a repo with no remote
works the same; with a remote the branch and `main` are pushed.

```bash
sloptimize fix propose --title "…" --issue "…" --solution "…"   # branch + commit + ledger entry
sloptimize fixes                       # every proposal, status as git sees it
sloptimize fix merge <id>              # merge commit into main (+ push); refuses a stale branch
sloptimize fix reject <id>             # delete the branch, keep the entry
sloptimize policy                      # automation: propose | merge
sloptimize settings --automation merge
```

The debugger's **Fixes** tab lists proposals with Merge / Reject and a badge
counting the ones you have not looked at; **Settings** holds the automation
level (server-side, `.sloptimize/settings.json`). A project that is not a
git repo is told so in both places.
