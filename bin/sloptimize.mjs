#!/usr/bin/env node
// ============================================================
// sloptimize CLI — report | check | census | doctor  (SPEC §8.1)
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
  const hitches = readJsonl('perf.jsonl', 20);
  const marks = hitches.filter((h) => h.type === 'usermark');
  const auto = hitches.filter((h) => h.type === 'hitch');
  const census = readJson('census.json');
  if (json) { out({ profile, hitches: auto, usermarks: marks, census }); process.exit(0); }
  if (!profile) { console.log('no profile.json — is the game running with the sloptimize runtime?'); process.exit(4); }
  console.log(`profile @ ${profile.at}  regime=${profile.regime ?? 'unknown'}`);
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
  }
  try { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dirs[0], { recursive: true }); writeFileSync(stateP, JSON.stringify(state)); } catch { /* stateless is only chattier */ }
  if (lines.length) console.log(lines.slice(0, 5).join('\n'));
  process.exit(0);
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

console.log('usage: sloptimize <report|check|census|doctor|hook-status|attach> [--json] [--dir <path>] [--counters-only] [--launch <url>] [--port N] [--headless]');
process.exit(2);
