#!/usr/bin/env node
// ============================================================
// sloptimize CLI — report | check | census | history | fix | doctor  (SPEC §8.1)
// ============================================================
// Files-first: every verb reads `.sloptimize/` in the cwd (or --dir) and
// says what it cannot know instead of guessing. Exit codes are API:
//   check: 0 all budgets pass · 1 breach · 4 no measurement / no budgets file
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes('--json');
const dirFlag = args.indexOf('--dir');
const DIR = dirFlag >= 0 ? args[dirFlag + 1] : '.sloptimize';

function readJson(name) {
  const p = join(DIR, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function readJsonl(name, limit = 50) {
  const p = join(DIR, name);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function out(obj, human) { console.log(json ? JSON.stringify(obj, null, 2) : human); }

if (cmd === 'report') {
  const profile = readJson('profile.json');
  // 80 lines, not 20: heartbeats (1/min while a session is armed) share the
  // ledger and must not crowd the actual incidents out of the report window.
  const hitches = readJsonl('perf.jsonl', 80);
  const marks = hitches.filter((h) => h.type === 'usermark');
  const auto = hitches.filter((h) => h.type === 'hitch');
  const jitters = hitches.filter((h) => h.type === 'jitter');
  const census = readJson('census.json');
  if (json) { out({ profile, hitches: auto, usermarks: marks, jitters, census }); process.exit(0); }
  if (!profile) { console.log('no profile.json — is the game running with the sloptimize runtime?'); process.exit(4); }
  console.log(`profile @ ${profile.at}  regime=${profile.regime ?? 'unknown'}`);
  const beats = hitches.filter((h) => h.type === 'heartbeat');
  const lastBeat = beats[beats.length - 1];
  if (lastBeat) console.log(`  feed: last heartbeat @ ${lastBeat.at}  build=${lastBeat.build ?? '?'}  phase=${lastBeat.phase ?? '?'}  median ${lastBeat.medianFrameMs}ms p95 ${lastBeat.p95Ms}ms`);
  if (profile.frame?.medianMs !== undefined) {
    console.log(`  frame median ${profile.frame.medianMs}ms  p95 ${profile.frame.p95Ms}ms  (~${profile.frame.fps}fps)  inside-render ${profile.frame.insideRenderMs}ms`);
  }
  if (profile.render) console.log(`  calls ${profile.render.calls}  triangles ${profile.render.triangles}  programs ${profile.memory?.programs}`);
  console.log(`  hitches recorded: ${auto.length} (showing last ${Math.min(auto.length, 20)})  usermarks: ${marks.length}`);
  for (const h of auto.slice(-5)) {
    console.log(`  · ${h.at} ${h.frameMs}ms (median ${h.medianMs}) → ${h.classification?.[0]?.guess}: ${h.classification?.[0]?.evidence}`);
  }
  for (const m of marks.slice(-3)) {
    const w = m.worstFrames?.[0];
    console.log(`  ★ usermark ${m.at} ${m.note ?? ''} — window ${m.window?.frames}f median ${m.window?.medianMs}ms; worst ${w?.frameMs}ms → ${w?.classification?.[0]?.guess}`);
  }
  if (jitters.length) {
    // Coordinate jumps (SPEC §3.6): the unit or the camera landed off its own
    // trajectory. Listed apart from hitches — a snap at 60fps is not a slow frame.
    console.log(`  jitters recorded: ${jitters.length} (showing last ${Math.min(jitters.length, 5)})`);
    for (const j of jitters.slice(-5)) {
      const shape = j.kind === 'oscillation' ? `oscillation ×${j.frames} amp ${j.amplitude}` : `snap ${j.units} [${(j.jump ?? []).join(', ')}]`;
      console.log(`  ↯ ${j.at} ${j.track} ${shape} in a ${j.dtMs}ms frame → ${j.classification?.[0]?.guess}: ${j.classification?.[0]?.evidence}`);
    }
  }
  if (census?.hints?.length) {
    console.log(`  census hints (${census.hints.length}):`);
    for (const h of census.hints.slice(0, 8)) console.log(`  · [${h.kind}] ${h.entity ?? ''} ${h.detail}`);
  }
  process.exit(0);
}

if (cmd === 'check') {
  const profile = readJson('profile.json');
  const budgets = readJson('budgets.json');   // { "perf.budget.draw_calls": 300, ... }
  if (!profile) { out({ error: 'no measurement' }, 'no profile.json to check against'); process.exit(4); }
  if (!budgets || Object.keys(budgets).length === 0) {
    out({ warning: 'no budgets declared', breached: [] }, 'no budgets declared (create .sloptimize/budgets.json) — passing with a warning');
    process.exit(0);
  }
  const countersOnly = args.includes('--counters-only') || profile.regime === 'software';
  const results = [];
  const read = {
    'perf.budget.draw_calls': profile.render?.calls,
    'perf.budget.triangles': profile.render?.triangles,
    'perf.budget.frame_ms_p95': countersOnly ? undefined : profile.frame?.p95Ms,
    'perf.budget.programs': profile.memory?.programs,
  };
  let breached = 0;
  for (const [k, budget] of Object.entries(budgets)) {
    const v = read[k];
    if (v === undefined) { results.push({ budget: k, value: null, limit: budget, verdict: countersOnly && k.includes('ms') ? 'skipped (counters-only)' : 'unmeasured' }); continue; }
    const over = v > budget;
    if (over) breached++;
    results.push({ budget: k, value: v, limit: budget, verdict: over ? `over by ${(v / budget).toFixed(1)}x` : 'inside' });
  }
  out({ checked: results.length, breached, results },
    results.map((r) => `  ${r.budget.padEnd(28)} ${String(r.value).padStart(10)} / ${r.limit}   ${r.verdict}`).join('\n')
    + `\nbudgets: ${results.length} checked, ${breached} breached`);
  process.exit(breached > 0 ? 1 : 0);
}

if (cmd === 'census') {
  const census = readJson('census.json');
  if (!census) { console.log('no census.json — trigger a walk from the running game (__sloptimize.census())'); process.exit(4); }
  if (json) { console.log(JSON.stringify(census, null, 2)); process.exit(0); }
  console.log(`census @ ${census.at}: ${census.totals.meshes} meshes, ${census.totals.triangles} tris, ${census.totals.uniqueMaterials} materials, ${census.totals.uniqueGeometries} geometries`);
  const rows = [...census.entities].sort((a, b) => b.triangles - a.triangles).slice(0, 15);
  for (const e of rows) {
    console.log(`  ${String(e.id).padEnd(28)} meshes ${String(e.meshes).padStart(5)}  tris ${String(e.triangles).padStart(9)}  mats ${String(e.uniqueMaterials).padStart(3)}  shadow-casters ${e.castShadow}`);
  }
  for (const h of census.hints ?? []) console.log(`  hint [${h.kind}] ${h.entity ?? ''}: ${h.detail}`);
  process.exit(0);
}

if (cmd === 'doctor') {
  const profile = readJson('profile.json');
  console.log('sloptimize doctor');
  console.log(`  data dir: ${DIR} ${existsSync(DIR) ? '(present)' : '(MISSING — runtime not wired or game not run)'}`);
  console.log(`  profile.json: ${profile ? `fresh as of ${profile.at}` : 'absent'}`);
  console.log(`  regime: ${profile?.regime ?? 'unknown'} — timing numbers from a software regime are flagged and never compared`);
  console.log('  stated limits: no per-draw GPU timing; bisection ranks, never sums; workload repro not trajectory repro;');
  console.log('  gpu:* instruments fire only under a real WebGPU backend — a WebGL2-fallback session reads them as zeros, honestly;');
  console.log('  bench/gate (M3) not built yet in this install — verify fixes with counters (exact grade) + real-hardware sessions.');
  process.exit(0);
}

if (cmd === 'hook-status') {
  // ≤5 lines for a UserPromptSubmit hook, and SILENT (exit 0, no output)
  // when nothing is new — ambient perf the way selection is ambient, and
  // only when it matters (SPEC §8.1). Multi-dir: a game served from the main
  // checkout and a worktree under active surgery both count.
  const dirs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--dir' && args[i + 1]) dirs.push(args[i + 1]);
  if (dirs.length === 0) dirs.push('.sloptimize');
  const stateP = join(dirs[0], '.hook-state.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateP, 'utf8')); } catch { /* first run */ }
  const lines = [];
  for (const dir of dirs) {
    const read = (n) => { try { return JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { return null; } };
    const readL = (n) => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
    const profile = read('profile.json');
    const recs = readL('perf.jsonl');
    const marks = recs.filter((r) => r.type === 'usermark');
    const lastMark = marks[marks.length - 1];
    const seenKey = `mark:${dir}`;
    if (lastMark && state[seenKey] !== lastMark.at) {
      state[seenKey] = lastMark.at;
      const w = lastMark.worstFrames && lastMark.worstFrames[0];
      lines.push(`sloptimize ★ NEW perf keyframe (${lastMark.note ?? 'Ctrl+F11'}) @ ${lastMark.at}: window ${lastMark.window?.frames}f median ${lastMark.window?.medianMs}ms; worst ${w?.frameMs}ms → ${w?.classification?.[0]?.guess} (${w?.classification?.[0]?.evidence}) [${dir}/perf.jsonl]`);
    }
    const budgets = read('budgets.json');
    if (profile && budgets) {
      const countersOnly = profile.regime !== 'hardware';
      const readV = { 'perf.budget.draw_calls': profile.render?.calls, 'perf.budget.triangles': profile.render?.triangles, 'perf.budget.frame_ms_p95': countersOnly ? undefined : profile.frame?.p95Ms, 'perf.budget.programs': profile.memory?.programs };
      const over = Object.entries(budgets).filter(([k, b]) => readV[k] !== undefined && readV[k] > b);
      const overKey = `over:${dir}`;
      const sig = over.map(([k]) => k).join(',');
      if (over.length && state[overKey] !== sig) {
        state[overKey] = sig;
        lines.push(`sloptimize ⚠ budget breach (${profile.regime}): ` + over.map(([k, b]) => `${k} ${readV[k]}/${b}`).join('  '));
      } else if (!over.length) state[overKey] = '';
    }
    // Liveness: heartbeats keep perf.jsonl fresh while a session is armed, so
    // a stale ledger MEANS the feed is dark or the session is over — not
    // merely idle. Said once per distinct last-record (state-deduped): the
    // instrument going silently dark cost an hour of debugging blind
    // (2026-08-24 — a runner restart dropped the ingest and nobody was told).
    const lastRec = recs[recs.length - 1];
    if (lastRec && lastRec.at) {
      const ageMin = (Date.now() - Date.parse(lastRec.at)) / 60000;
      const staleKey = `stale:${dir}`;
      if (ageMin > 45) {
        if (state[staleKey] !== lastRec.at) {
          state[staleKey] = lastRec.at;
          lines.push(`sloptimize ◌ feed quiet ${Math.round(ageMin)}min (last: ${lastRec.type} @ ${lastRec.at}) [${dir}] — session over, or the feed went dark (ingest disarmed?)`);
        }
      } else state[staleKey] = '';
    }
  }
  try { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dirs[0], { recursive: true }); writeFileSync(stateP, JSON.stringify(state)); } catch { /* stateless is only chattier */ }
  if (lines.length) console.log(lines.slice(0, 5).join('\n'));
  process.exit(0);
}

// ── The fix loop, git only (src/proposals.mjs) ──────────────────────────────
//   fix propose --title … [--issue … --solution … --files a,b --branch … --no-push]
//   fix merge <id> · fix reject <id> · fixes [--json] · policy · settings --automation propose|merge
const sub = args[1];
if ((cmd === 'fix' && ['propose', 'merge', 'reject', 'list'].includes(sub)) || cmd === 'fixes' || cmd === 'policy' || cmd === 'settings') {
  const P = await import('../src/proposals.mjs');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const REPO = get('--repo') ?? process.cwd();
  const fail = (e) => { console.error(`sloptimize ${cmd}${sub ? ` ${sub}` : ''}: ${e.message}`); process.exit(e.message === P.NOT_A_REPO ? 3 : 1); };
  try {
    if (cmd === 'policy') {
      const s = P.readSettings(DIR);
      out({ ...s, repo: P.isGitRepo(REPO) }, `automation: ${s.automation}${P.isGitRepo(REPO) ? '' : `\n${P.NOT_A_REPO}`}`);
      process.exit(0);
    }
    if (cmd === 'settings') {
      const level = get('--automation');
      const s = level ? P.writeSettings(DIR, { automation: level }) : P.readSettings(DIR);
      out(s, `automation: ${s.automation}`);
      process.exit(0);
    }
    if (cmd === 'fixes' || sub === 'list') {
      const l = P.listFixes(REPO, DIR);
      if (json) { out(l); process.exit(0); }
      if (!l.repo) { console.log(l.error); process.exit(3); }
      if (l.fixes.length === 0) { console.log('no proposals yet — `sloptimize fix propose --title "…"` records one'); process.exit(0); }
      for (const f of l.fixes) console.log(`  ${f.status.padEnd(9)} ${f.at.slice(0, 16)}  ${f.title}${f.branch ? `  [${f.branch} @ ${f.commit}${f.upToDate === false ? ', behind main' : ''}]` : ''}  id=${f.id}`);
      process.exit(0);
    }
    if (sub === 'propose') {
      if (!get('--title')) { console.error('sloptimize fix propose: --title is required'); process.exit(2); }
      const { buildFix } = await import('../src/history.js');
      const records = readJsonl('perf.jsonl', Infinity);
      const fix = P.proposeFix(REPO, DIR, {
        title: get('--title'), issue: get('--issue'), solution: get('--solution'), branch: get('--branch'),
        files: get('--files')?.split(','), push: !args.includes('--no-push'),
        measure: () => { const f = buildFix(records, { title: get('--title'), before: get('--before'), after: get('--after') }); return { before: f.before, after: f.after }; },
      });
      out(fix, `proposed: ${fix.title}\n  branch ${fix.branch} @ ${fix.commit}${fix.pushed ? ' (pushed)' : ''}\n  id ${fix.id}${fix.before ? '' : '\n  (no measured before/after yet — the numbers land when it is played)'}`);
      process.exit(0);
    }
    const id = args[2];
    if (!id) { console.error(`sloptimize fix ${sub}: <id> is required (see \`sloptimize fixes\`)`); process.exit(2); }
    const r = sub === 'merge' ? P.mergeFix(REPO, DIR, id) : P.rejectFix(REPO, DIR, id);
    out(r, `${r.status}: ${id}${r.mergeCommit ? ` → ${r.mergeCommit}` : ''}${r.pushed ? ' (pushed)' : ''}`);
    process.exit(0);
  } catch (e) { fail(e); }
}

if (cmd === 'history' || cmd === 'fix') {
  // The timeline and the fix ledger (SPEC §8.5). `history` folds perf.jsonl
  // into buckets + per-build windows; `fix` appends one report to
  // fixes.jsonl whose before/after are MEASURED windows of that ledger —
  // the agent names the issue, the solution and the commit; the numbers
  // come from the recorder, never from the agent.
  const { buildHistory, buildFix } = await import('../src/history.js');
  const records = readJsonl('perf.jsonl', Infinity);
  const fixes = readJsonl('fixes.jsonl', Infinity);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const fmt = (v, unit = '') => (v === undefined ? '—' : `${v}${unit}`);
  const line = (s) => `p95 ${fmt(s.p95Ms, 'ms')}  calls ${fmt(s.calls)}  hitches ${s.hitches} (${fmt(s.hitchesPerHour)}/h, worst ${fmt(s.worstMs, 'ms')}${s.worstGuess ? ` ${s.worstGuess}` : ''})`;
  if (cmd === 'fix') {
    let commit = get('--commit');
    if (!commit) {
      try { const { execSync } = await import('node:child_process'); commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo */ }
    }
    if (!get('--title')) { console.error('sloptimize fix: --title is required'); process.exit(2); }
    let fix;
    try {
      fix = buildFix(records, { title: get('--title'), issue: get('--issue'), solution: get('--solution'), commit,
        files: get('--files')?.split(','), before: get('--before'), after: get('--after') });
    } catch (e) { console.error(`sloptimize fix: ${e.message}`); process.exit(4); }
    const { appendFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, 'fixes.jsonl'), JSON.stringify(fix) + '\n');
    out(fix, `fix recorded: ${fix.title}${fix.commit ? ` (${fix.commit})` : ''}\n  before ${fix.before.build ?? fix.before.from}: ${line(fix.before)}\n  after  ${fix.after.build ?? fix.after.from}: ${line(fix.after)}`);
    process.exit(0);
  }
  const h = buildHistory(records, { fixes, buckets: Number(get('--buckets')) || 24 });
  if (json) { out(h); process.exit(0); }
  if (!h.span) { console.log('no measured records in perf.jsonl yet'); process.exit(4); }
  console.log(`history ${h.span.from} → ${h.span.to}  (${h.builds.length} builds, ${h.fixes.length} fixes)`);
  for (const b of h.builds) console.log(`  build ${b.build.padEnd(16)} ${b.from.slice(0, 16)}  ${line(b)}`);
  console.log('  buckets:');
  for (const b of h.buckets) console.log(`  ${b.from.slice(5, 16)}  p95 ${String(fmt(b.p95Ms)).padStart(7)}  calls ${String(fmt(b.calls)).padStart(5)}  hitches ${String(b.hitches).padStart(3)}  ${b.worstMs ? `worst ${b.worstMs}ms ${b.worstGuess ?? ''}` : ''}`);
  for (const f of h.fixes) console.log(`  ✔ ${f.at.slice(0, 10)} ${f.title}${f.commit ? ` (${f.commit})` : ''}: p95 ${fmt(f.before.p95Ms, 'ms')} → ${fmt(f.after.p95Ms, 'ms')}, hitches/h ${fmt(f.before.hitchesPerHour)} → ${fmt(f.after.hitchesPerHour)}`);
  process.exit(0);
}

if (cmd === 'watch') {
  // The push channel (SPEC §8.1.1): tail every --dir's perf.jsonl and print
  // one line per record an agent should wake for. Never exits — arm it as a
  // Claude Code Monitor (INTEGRATION.md §5) and just play.
  const { runWatch } = await import('../src/watch.mjs');
  const dirs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--dir' && args[i + 1]) dirs.push(args[i + 1]);
  if (dirs.length === 0) dirs.push('.sloptimize');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : undefined; };
  await runWatch(dirs, { intervalMs: get('--interval') ? get('--interval') * 1000 : undefined, minHitchMs: get('--min-hitch-ms') });
}

if (cmd === 'attach') {
  // Tier 0 (SPEC-attach): zero-integration attach. --launch <url> spawns a
  // browser; bare attach uses an existing --remote-debugging-port session.
  const { attach } = await import('../src/attach.mjs');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const session = await attach({
    launch: get('--launch'),
    port: get('--port') ? Number(get('--port')) : undefined,
    dir: get('--dir') ?? '.sloptimize',
    headless: args.includes('--headless'),
  });
  console.log('[attach] recording — Ctrl+C to stop');
  process.on('SIGINT', async () => { await session.close(); process.exit(0); });
  await new Promise(() => {});
}

console.log('usage: sloptimize <report|check|census|history|fix|doctor|hook-status|watch|attach> [--json] [--dir <path>]... [--counters-only] [--interval <s>] [--min-hitch-ms N] [--launch <url>] [--port N] [--headless]\n       sloptimize fix --title "…" [--issue "…"] [--solution "…"] [--commit sha] [--files a,b] [--before <build|ISO..ISO>] [--after <build|ISO..ISO>]');
process.exit(2);
