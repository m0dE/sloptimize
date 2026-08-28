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
   The overlay also shows the session's incident list — every row already
   reached the ledger when it happened.
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
  agent with one line per new usermark, ≥100ms hitch, gpu cap-hit or
  feed-dark edge. A `SessionStart` hook can arm it in every session
  automatically — then nobody types anything, ever.
- **`/loop` in one session**: e.g.
  `/loop check <game>/.sloptimize for new keyframes or budget breaches; investigate any new incident`
  — that session self-paces polls and works incidents autonomously.

Either coexists with the ambient hook in the other sessions; dedup state
is per directory, so the watcher consuming its own view hides nothing from
anyone else.

## Reading on demand (any session, any shell)

```bash
npx sloptimize report --dir <game>/.sloptimize   # profile + incidents
npx sloptimize check  --dir <game>/.sloptimize   # budgets → exit 0/1/4
npx sloptimize census --dir <game>/.sloptimize   # per-entity costs
npx sloptimize doctor --dir <game>/.sloptimize   # what is wired/degraded
```

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
