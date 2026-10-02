#!/usr/bin/env node
// ============================================================
// sloptimize CLI — report | check | census | history | compare | touched | fix | doctor  (SPEC §8.1)
// ============================================================
// Files-first: every verb reads `.sloptimize/` in the cwd (or --dir) and
// says what it cannot know instead of guessing. Exit codes are API:
//   check: 0 all budgets pass · 1 breach · 2 bad budgets.json · 3 measured under other conditions than the budgets were set for · 4 no measurement · 5 cannot judge (too few runs, a budget unmeasured — run mode)
//   compare: 0 compared · 3 refused: the sides were measured under different conditions (--allow-mismatch reads anyway) · 4 a side unmeasured
//   compare --fail-on-regression: 0 no significant regression · 1 regressed · 3 incomparable (incl. the machine changed) · 4 unmeasured · 5 too few runs to judge
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
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

// `--phase play[,sample]` scopes every ledger read below to those phases: a
// load phase and a play phase are two workloads, and read together the
// bigger one wins on volume alone. A filter that matches nothing exits 4
// and says what the ledger does carry — never an empty report that reads
// as "no problems".
const phaseAt = args.indexOf('--phase');
const H = phaseAt >= 0 ? await import('../src/history.js') : null;
const phaseArg = args[phaseAt + 1];
const PHASES = H?.parsePhases(phaseArg?.startsWith('--') ? undefined : phaseArg) ?? null;
if (H && !PHASES) { console.error('sloptimize: --phase needs a name (or a comma list): --phase play'); process.exit(2); }
function readLedger(limit = Infinity) {
  if (!PHASES) return readJsonl('perf.jsonl', limit);
  const all = readJsonl('perf.jsonl', Infinity);
  const kept = H.onlyPhases(all, PHASES);
  if (kept.length > 0 || all.length === 0) return kept.slice(-limit);   // an empty ledger is each verb's own message
  const { phases, unphased } = H.phaseCounts(all);
  const asked = [...PHASES].join(',');
  const why = phases.length === 0
    ? `no record on this ledger carries a phase — tier 1 stamps one per frame, rec.frame({ phase }); a tier-0 page sets window.__sloptimizePhase = 'steady' (--phase ? reads the unstamped)`
    : `no records in phase ${asked} — phases on this ledger: ${phases.map(([p, n]) => `${p} ×${n}`).join(', ')}${unphased ? `; ${unphased} records carry no phase (--phase ?)` : ''}`;
  // --json: an empty match is data — the verb prints its usual empty shape
  // and the reason goes to stderr, where a parser of stdout never trips on it.
  if (json) { console.error(`sloptimize: ${why}`); return []; }
  console.log(why);
  process.exit(4);
}

if (cmd === 'report') {
  const profile = readJson('profile.json');
  // 80 lines, not 20: heartbeats (1/min while a session is armed) share the
  // ledger and must not crowd the actual incidents out of the report window.
  const hitches = readLedger(80);
  const marks = hitches.filter((h) => h.type === 'usermark');
  const auto = hitches.filter((h) => h.type === 'hitch');
  const jitters = hitches.filter((h) => h.type === 'jitter');
  const census = readJson('census.json');
  // The session's conditions (conditions.js): what every number below was
  // measured under — the display's refresh rate first among them.
  const C = await import('../src/conditions.js');
  const conds = profile ? C.runConditions([profile, ...readJsonl('perf.jsonl', Infinity).filter((r) => r.type === 'conditions' && (!profile.session || r.session === profile.session))],
    profile.session ? (await import('../src/runs.js')).readRuns(DIR).find((r) => r.session === profile.session) : null) : undefined;
  if (json) { out({ profile, conditions: conds, hitches: auto, usermarks: marks, jitters, census }); process.exit(0); }
  if (!profile) { console.log('no profile.json — is the game running with the sloptimize runtime?'); process.exit(4); }
  console.log(`profile @ ${profile.at}  regime=${profile.regime ?? 'unknown'}`);
  console.log(`  measured under: ${C.describeConditions(conds)}`);
  // profile.json is the rolling summary of whatever ran last; everything
  // read from the ledger below is the filtered phase's alone.
  if (PHASES) console.log(`  phase: ${[...PHASES].join(',')} — heartbeat, host profile, hitches and issues below are this phase's only`);
  const beats = hitches.filter((h) => h.type === 'heartbeat');
  const lastBeat = beats[beats.length - 1];
  // A field a record does not carry is '—', never "undefined": tier 0
  // measures the rAF clock and the graphics API, not the engine, so it has
  // no inside-render time and no program count to report — and a hidden
  // page's beat drew no frames to time.
  const fmt = (v, unit = '') => (v === undefined || v === null ? '—' : `${v}${unit}`);
  if (lastBeat) console.log(`  feed: last heartbeat @ ${lastBeat.at}  build=${lastBeat.build ?? '?'}  phase=${lastBeat.phase ?? '?'}  median ${fmt(lastBeat.medianFrameMs, 'ms')} p95 ${fmt(lastBeat.p95Ms, 'ms')}`);
  if (profile.frame?.medianMs !== undefined) {
    console.log(`  frame median ${fmt(profile.frame.medianMs, 'ms')}  p95 ${fmt(profile.frame.p95Ms, 'ms')}  (~${fmt(profile.frame.fps, 'fps')})  inside-render ${fmt(profile.frame.insideRenderMs, 'ms')}`);
  }
  if (profile.render) {
    // Tier 0 counts at the WebGL/WebGPU API, averaged over its sample window;
    // tier 1 reads the engine's own renderer.info. Said, so the two are not
    // read as the same instrument.
    const per = profile.tier === 0 ? `  (tier 0: per frame, mean of ${fmt(profile.render.frames)} frames, counted at the graphics API)` : '';
    console.log(`  calls ${fmt(profile.render.calls)}  triangles ${fmt(profile.render.triangles)}  programs ${fmt(profile.memory?.programs)}${per}`);
  }
  // Tier 0's frame is the rAF-to-rAF interval of a page with a recorder and
  // a sampler in it: vsync-quantized (a 26 ms body presents every 33.3 ms at
  // 60 Hz) and paying for the instrument. Fine for attached-vs-attached; a
  // field report compared it against the game's own frame timer and against
  // unattached runs, and nothing said not to.
  if (profile.tier === 0) console.log('  timings are rAF intervals with the recorder attached (vsync-quantized, recorder cost included) — compare only with other attached runs, never with the app\'s own frame timer or unattached measurements');
  const vsync = C.vsyncNote(conds, profile.frame?.medianMs);
  if (vsync) console.log(`  ${vsync}`);
  // The game's own throughput (SPEC §3.11), over its own clock when it gave one.
  if (profile.session) {
    const R = await import('../src/runs.js');
    const file = R.readRuns(DIR).find((r) => r.session === profile.session);
    const acc = file ? R.runBucket(file).tally : R.emptyTally();
    for (const r of readJsonl('perf.jsonl', Infinity)) if (r.session === profile.session && r.type === 'profile' && r.tally && !(file && r.tier === 0)) R.foldTally(acc, r);
    const rates = R.ratesOf(acc);
    if (rates) {
      const vals = Object.entries(rates.values).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}/${rates.per}`).join(' · ');
      console.log(rates.denominator === 'wall'
        ? `  rates (per wall second — no game clock: a build that renders faster covers more game time per second and flatters itself; window.__sloptimizeClock('sim', simMs, 1000) fixes it): ${vals}`
        : `  rates (per second of the game's ${rates.denominator.slice(6)} clock): ${vals}`);
    } else if (acc.clock?.mixed) console.log('  rates: the run reported two different game clocks — no honest denominator');
  }
  // The host's own frame (SPEC §3.2b): the newest profile line with sections
  // says where the loop's time goes and what its counters read, without
  // anyone at the keyboard. Twelve sections and the counters that moved
  // most; `--json` has all of them.
  const lastProf = hitches.filter((h) => h.type === 'profile' && (h.sections || h.counts)).pop();
  if (lastProf) {
    const win = lastProf.window ? ` over ${lastProf.window.frames} frames` : '';
    console.log(`  host profile @ ${lastProf.at}${win}  build=${lastProf.build ?? '?'}  phase=${lastProf.phase ?? '?'}${lastProf.frame?.bodyMs !== undefined ? `  body ${lastProf.frame.bodyMs}ms` : ''}`);
    const secs = Object.entries(lastProf.sections ?? {}).slice(0, 12);
    if (secs.length) console.log(`    sections: ${secs.map(([k, v]) => `${k} ${v}`).join('  ')}`);
    const cnts = Object.entries(lastProf.counts ?? {});
    if (cnts.length) console.log(`    counts (${cnts.length}): ${cnts.slice(0, 12).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  }
  // The count is of the report window (the last 80 ledger lines), not the
  // ledger — `sloptimize issues` and `history` fold all of it.
  console.log(`  hitches in the last 80 ${PHASES ? `${[...PHASES].join(',')} ` : ''}ledger lines: ${auto.length} (showing last ${Math.min(auto.length, 5)})  usermarks: ${marks.length}`);
  // A top frame reads as a CAUSE, so it carries its share of the frame, and
  // one under a tenth of the stall is not printed as one (attach's
  // low-share gate; applied here too, to lines written before it existed).
  const { ATTRIBUTE_MIN_SHARE } = await import('../src/incident-pipeline.mjs');
  const pct = (x) => `${x >= 0.1 ? Math.round(x * 100) : +(x * 100).toFixed(1)}%`;
  const attribution = (h) => {
    const top = h.topFrames?.[0];
    if (!top) return h.unattributed ? `  unattributed (${h.unattributed})` : '';
    const name = `${top.fn}${top.url ? `@${top.url}` : ''} ${top.selfMs}ms`;
    // A line that carries a share was judged by the recorder (at whatever
    // --min-share it ran with); only older lines are judged here.
    const judged = top.share !== undefined;
    const share = top.share ?? (h.frameMs > 0 ? top.selfMs / h.frameMs : undefined);
    if (share === undefined) return `  top ${name}`;
    if (h.unattributed === 'low-share' || (!judged && share < ATTRIBUTE_MIN_SHARE && h.classification?.[0]?.guess !== 'shader-compile')) {
      const s = h.sampled;
      const rest = s ? `; the chunk's other time: native ${s.programMs}ms, gc ${s.gcMs}ms` : '';
      return `  unattributed (heaviest JS ${name} = ${pct(share)} of the frame${rest})`;
    }
    // The chunk spans more than the frame, so a share can pass 100%: that
    // reads as "all of it", not as more than all of it.
    return `  top ${name} (${pct(Math.min(share, 1))} of frame)`;
  };
  for (const h of auto.slice(-5)) {
    console.log(`  · ${h.at} ${h.frameMs}ms (median ${h.medianMs}) → ${h.classification?.[0]?.guess}: ${h.classification?.[0]?.evidence}${attribution(h)}`);
  }
  // A page that armed more than once in one attach session booted more than
  // once under the recorder (it navigated or reloaded itself): its load-phase
  // hitches and worst frames cover every boot. Attach's own reload is not
  // one of them — the first boot runs before the recorder, so one `armed`
  // per session is the normal case.
  const armedBy = new Map();
  for (const r of readJsonl('perf.jsonl', Infinity)) if (r.type === 'armed' && r.session) armedBy.set(r.session, (armedBy.get(r.session) ?? 0) + 1);
  const reboots = [...new Set(hitches.map((r) => r.session).filter(Boolean))].filter((s) => armedBy.get(s) > 1);
  for (const s of reboots) console.log(`  note: session ${s} armed ${armedBy.get(s)}× — the page loaded ${armedBy.get(s)} times under the recorder, so load-phase hitch counts and worst frames span every one of those boots`);
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
  // InstancedMesh slots drawn but no longer written (instance-slots.js):
  // the newest word per mesh in the window, a clear included — ghosts are
  // a correctness incident, visible to no counter above.
  const slotRecs = new Map();
  for (const r of hitches) if (r.type === 'instance-slots') slotRecs.set(r.name, r);
  if (slotRecs.size) {
    console.log(`  instance slots (drawn inside .count, per mesh — newest):`);
    for (const r of slotRecs.values()) {
      console.log(r.stale > 0
        ? `  ◫ ${r.name}: ${r.drawn} drawn, ${r.active} written/moved in the last window, ${r.stale} untouched for ${r.staleSec}s — static instances, or ghosts drawn at stale positions (count past the live set?)`
        : `  ◫ ${r.name}: no stale slots any more (${r.drawn} drawn, ${r.active} active) @ ${r.at}`);
    }
  }
  // The catalogue's head: which causes recur most (SPEC §3.7). The whole
  // ledger, not the 80-line window — recurrence is the point.
  const { buildIssues, agoText } = await import('../src/history.js');
  const issues = buildIssues(readLedger(), { fixes: readJsonl('fixes.jsonl', Infinity) });
  if (issues.length) {
    console.log(`  issues (${issues.length} footprints; top 5 by occurrences — \`sloptimize issues\` for all):`);
    for (const i of issues.slice(0, 5)) console.log(`  ${i.glyph} fp=${i.id} ×${i.count}  ${i.label} [${i.phase}]  last ${agoText(i.lastAgoMs)}${i.fixes.length ? `  fixes: ${i.fixes.length}` : ''}`);
  }
  if (census?.hints?.length) {
    console.log(`  census hints (${census.hints.length}):`);
    for (const h of census.hints.slice(0, 8)) console.log(`  · [${h.kind}] ${h.entity ?? ''} ${h.detail}`);
  }
  process.exit(0);
}

if (cmd === 'issues') {
  // The issue catalogue (SPEC §3.7): every incident type grouped by
  // footprint, with occurrences, first/last, builds, worst, and the fixes
  // applied to it. `--from/--to` scope the count; `--all` includes robots.
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const { buildIssues, agoText } = await import('../src/history.js');
  if (args.includes('--cloud')) {
    // The cloud catalogue (SPEC cloud §8.4): every player, every build, not
    // just this machine's ledger. Configuration is explicit — a missing key
    // or endpoint is said, never guessed.
    const { cloudConfig, fetchIssues } = await import('../src/cloud-client.js');
    const cfg = cloudConfig(process.env, args);
    if (!cfg) { console.error('sloptimize issues --cloud: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT (or --key/--endpoint)'); process.exit(2); }
    let rows;
    try { rows = await fetchIssues(cfg, { preset: get('--preset'), from: get('--from'), to: get('--to'), source: get('--source'), kind: get('--kind') }); }
    catch (e) { console.error(`sloptimize issues --cloud: ${e.message}`); process.exit(4); }
    if (PHASES) rows = rows.filter((i) => PHASES.has(i.phase));
    if (json) { out(rows); process.exit(0); }
    if (rows.length === 0) { console.log(`no incidents in this range${PHASES ? ` and phase ${[...PHASES].join(',')}` : ''} on the cloud catalogue`); process.exit(4); }
    console.log(`cloud ${cfg.endpoint} · ${get('--preset') ?? (get('--from') ? 'custom' : '24h')} · ${rows.length} footprints`);
    for (const i of rows) console.log(`${i.glyph} fp=${i.id} ×${String(i.count).padEnd(5)} ${i.label.padEnd(44)} [${i.phase}] ${i.source}  last ${agoText(i.lastAgoMs).padEnd(8)} first ${i.first.slice(0, 16)}  builds ${i.builds.length}${i.fixCount ? `  fixes ${i.fixCount}` : ''}`);
    process.exit(0);
  }
  const issues = buildIssues(readLedger(), {
    fixes: readJsonl('fixes.jsonl', Infinity), from: get('--from'), to: get('--to'), includeAutomated: args.includes('--all'),
  });
  if (json) { out(issues); process.exit(0); }
  if (issues.length === 0) { console.log(PHASES ? `no incidents in phase ${[...PHASES].join(',')}` : 'no incidents on the ledger yet'); process.exit(4); }
  const only = get('--fp');
  for (const i of issues) {
    if (only && i.id !== only) continue;
    console.log(`${i.glyph} fp=${i.id} ×${String(i.count).padEnd(5)} ${i.label.padEnd(44)} [${i.phase}]  last ${agoText(i.lastAgoMs).padEnd(8)} first ${i.first.slice(0, 16)}  builds ${i.builds.length}${i.worst ? `  worst ${+i.worst.value.toFixed(1)}${i.worst.unit}` : ''}`);
    if (only || issues.length <= 8) {
      console.log(`      key ${i.key}`);
      if (i.sample) console.log(`      last verdict: ${i.sample.guess} — ${i.sample.evidence}`);
      for (const f of i.fixes) console.log(`      ✔ ${f.at.slice(0, 10)} ${f.status ?? 'recorded'} ${f.title}${f.commit ? ` (${f.commit})` : ''}${f.pr?.url ? ` ${f.pr.url}` : ''}`);
      if (i.fixes.length === 0) console.log(`      no fix recorded — sloptimize fix propose --footprints ${i.id} --title "…"`);
    }
  }
  process.exit(0);
}

if (cmd === 'check') {
  const profile = readJson('profile.json');
  const budgets = readJson('budgets.json');   // { "perf.budget.draw_calls": 300, "perf.budget.load.worst_ms": 500, ... }
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  const sessionArg = flag('--session'), buildArg = flag('--build');
  if (!profile && !sessionArg && !buildArg) { out({ error: 'no measurement' }, 'no profile.json to check against'); process.exit(4); }
  if (!budgets || Object.keys(budgets).length === 0) {
    out({ warning: 'no budgets declared', breached: [] }, 'no budgets declared (create .sloptimize/budgets.json) — passing with a warning');
    process.exit(0);
  }
  const G = await import('../src/gate.js');
  const C = await import('../src/conditions.js');
  const { readRuns } = await import('../src/runs.js');
  const parsed = G.parseBudgets(budgets);
  if (parsed.errors.length) { out({ error: 'bad budgets.json', errors: parsed.errors }, ['budgets.json:', ...parsed.errors.map((e) => `  ✗ ${e}`)].join('\n')); process.exit(2); }
  const want = budgets['perf.conditions'];
  const refuse = (conds, cmp, why) => {
    out({ refused: true, conditions: conds, ...(want ? { expected: want } : {}), mismatches: cmp.mismatches },
      [`measured under: ${C.describeConditions(conds)}`, `refused: ${why}`, ...C.mismatchLines(cmp).map((l) => `  ${l}`)].join('\n'));
    process.exit(3);
  };
  // Run mode (SPEC §7.1): a session or a build judged over EVERY record it
  // wrote, per phase — what a per-phase budget needs and what a CI gate runs.
  // Without a selector and with only global budgets, `check` reads the
  // profile.json snapshot as it always has.
  const runMode = !!(sessionArg || buildArg) || parsed.rows.some((r) => r.phase !== null);
  if (runMode) {
    const records = readJsonl('perf.jsonl', Infinity);
    const runFiles = readRuns(DIR);
    let sessions;
    if (sessionArg) sessions = [sessionArg];
    else if (buildArg) sessions = [...new Set([...records.filter((r) => r.build === buildArg).map((r) => r.session), ...runFiles.filter((r) => r.build === buildArg).map((r) => r.session)].filter(Boolean))];
    else sessions = profile?.session ? [profile.session] : [];
    sessions = sessions.filter((s) => records.some((r) => r.session === s) || runFiles.some((r) => r.session === s));
    if (!sessions.length) {
      out({ error: 'no measured run' }, sessionArg || buildArg ? `no run recorded for ${sessionArg ? `session ${sessionArg}` : `build ${buildArg}`}` : 'per-phase budgets judge a whole run — and profile.json names no session: pass --session <id> or --build <id>');
      process.exit(4);
    }
    const minRuns = Number(flag('--min-runs') ?? 1);
    const runs = sessions.map((s) => {
      const recs = records.filter((r) => r.session === s);
      const file = runFiles.find((r) => r.session === s) ?? null;
      return { session: s, conditions: C.runConditions(recs, file), metrics: G.runPhaseMetrics(recs, file) };
    });
    const conds = runs.map((r) => r.conditions);
    // A coverage run's timings are its instrumentation's; runs that disagree
    // are not one build; and budgets set for other conditions do not apply.
    const cov = conds.find((c) => (c.mode ?? 'timing') !== 'timing');
    if (cov) refuse(cov, { mismatches: [{ key: 'mode', label: 'run mode', material: true, a: cov.mode, b: 'timing', why: 'a coverage run is slowed by its own instrumentation; its timings are not timings' }], unverified: [] }, 'this is not a timing run');
    // Phase mixes may differ between runs: budgets are read per phase.
    const mixed = C.mixedConditions(conds, { phaseScoped: true });
    if (!mixed.comparable) refuse(conds[0], mixed, `the ${runs.length} runs were measured under different conditions`);
    const expect = want && typeof want === 'object' ? C.expectConditions(conds[0], want) : null;
    if (expect && !expect.comparable) refuse(conds[0], expect, 'budgets.json\'s perf.conditions do not match what this measurement was taken under');
    const j = G.judgeBudgets(parsed.rows, runs.map((r) => r.metrics));
    // Too few runs, or a budget nothing measured: the gate cannot judge, and
    // says so with its own exit code — never a pass by default.
    const insufficient = runs.length < minRuns ? `${runs.length} run(s), --min-runs ${minRuns}` : j.unmeasured && !args.includes('--allow-unmeasured') ? `${j.unmeasured} budget(s) unmeasured (--allow-unmeasured to pass them)` : null;
    const fmtV = (r) => (r.value === null ? '—' : `${r.value}${r.runs ? ` [${r.runs.lo}–${r.runs.hi}]` : ''}`);
    const lim = (r) => (r.max !== undefined ? `≤ ${r.max}` : `≥ ${r.min}`);
    out({ mode: 'run', sessions, ...(buildArg ? { build: buildArg } : {}), conditions: conds[0], checked: j.results.length, breached: j.breached, unmeasured: j.unmeasured,
      ...(insufficient ? { insufficient } : {}), ...(expect?.unverified.length ? { unverified: expect.unverified } : {}), results: j.results },
      [`check ${buildArg ? `build ${buildArg}` : `session ${sessions[0]}`} — ${runs.length} run(s), judged per phase over the whole run`,
        `measured under: ${C.describeConditions(conds[0])}`,
        ...(expect?.unverified.length ? [`  ? perf.conditions unverified — not recorded by this run: ${expect.unverified.map((u) => u.label).join(', ')}`] : []),
        ...j.results.map((r) => `  ${r.budget.padEnd(40)} ${fmtV(r).padStart(18)} ${lim(r).padEnd(10)} ${r.breached ? '✗ ' : ''}${r.verdict}${r.rule ? `  · ${r.rule}` : ''}${r.note ? `  · ${r.note}` : ''}`),
        `budgets: ${j.results.length} checked, ${j.breached} breached${j.unmeasured ? `, ${j.unmeasured} unmeasured` : ''}`,
        ...(insufficient ? [`cannot judge: ${insufficient} — exit 5`] : [])].join('\n'));
    process.exit(j.breached > 0 ? 1 : insufficient ? 5 : 0);
  }
  // What the measurement was taken under, and — when budgets.json says what
  // its numbers were set for (`perf.conditions`: { "refreshHz": 60, ... }) —
  // whether that matches. A budget met at 144 Hz says nothing about 60 Hz:
  // refused, exit 3, before any budget is read.
  const conds = C.runConditions([profile, ...readJsonl('perf.jsonl', Infinity).filter((r) => r.type === 'conditions' && (!profile.session || r.session === profile.session))],
    profile.session ? readRuns(DIR).find((r) => r.session === profile.session) : null);
  const expect = want && typeof want === 'object' ? C.expectConditions(conds, want) : null;
  if (expect && !expect.comparable) refuse(conds, expect, 'budgets.json\'s perf.conditions do not match what this measurement was taken under');
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
    if (!k.startsWith('perf.budget.')) continue;
    const v = read[k];
    if (v === undefined) { results.push({ budget: k, value: null, limit: budget, verdict: countersOnly && k.includes('ms') ? 'skipped (counters-only)' : 'unmeasured' }); continue; }
    const over = v > budget;
    if (over) breached++;
    results.push({ budget: k, value: v, limit: budget, verdict: over ? `over by ${(v / budget).toFixed(1)}x` : 'inside' });
  }
  out({ checked: results.length, breached, results, conditions: conds, ...(expect?.unverified.length ? { unverified: expect.unverified } : {}) },
    `measured under: ${C.describeConditions(conds)}\n`
    + (expect?.unverified.length ? `  ? perf.conditions unverified — not recorded by this run: ${expect.unverified.map((u) => u.label).join(', ')}\n` : '')
    + results.map((r) => `  ${r.budget.padEnd(28)} ${String(r.value).padStart(10)} / ${r.limit}   ${r.verdict}`).join('\n')
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
  const em = readJsonl('perf.jsonl', 400).filter((r) => r.type === 'electron-metrics').at(-1);
  if (em) console.log(`  electron: sink active (last process sample ${em.at}: gpu ${em.cpu?.gpu}% renderer ${em.cpu?.renderer}% cpu) — hitches carry .processes`);
  const cfg = (await import('../src/cloud-client.js')).cloudConfig(process.env, args);
  console.log(cfg ? `  cloud: configured (${cfg.endpoint})` : '  cloud: not configured (SLOPTIMIZE_KEY, SLOPTIMIZE_ENDPOINT)');
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
//   fix propose --title … [--issue … --solution … --files a,b --footprints id,id --branch … --no-push]
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
      const records = readLedger();
      const fix = P.proposeFix(REPO, DIR, {
        title: get('--title'), issue: get('--issue'), solution: get('--solution'), branch: get('--branch'),
        files: get('--files')?.split(','), push: !args.includes('--no-push'),
        footprints: get('--footprints')?.split(',').filter(Boolean), phase: PHASES ? [...PHASES].join(',') : undefined,
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
  const records = readLedger();
  const fixes = readJsonl('fixes.jsonl', Infinity);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const fmt = (v, unit = '') => (v === undefined ? '—' : `${v}${unit}`);
  // The rate is over RECORDED minutes when the feed beat (`recordedMin`), and
  // a build measured in several runs says so with their range — one run's
  // count is one noisy sample.
  const rate = (s) => `${fmt(s.hitchesPerHour)}/h${s.recordedMin !== undefined ? ` over ${s.recordedMin} min` : ''}${s.spread ? `, ${s.spread.n} runs ${s.spread.lo}–${s.spread.hi}/h` : ''}`;
  const line = (s) => `p95 ${fmt(s.p95Ms, 'ms')}  calls ${fmt(s.calls)}  hitches ${s.hitches} (${rate(s)}, worst ${fmt(s.worstMs, 'ms')}${s.worstGuess ? ` ${s.worstGuess}` : ''})`;
  if (cmd === 'fix') {
    let commit = get('--commit');
    if (!commit) {
      try { const { execSync } = await import('node:child_process'); commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo */ }
    }
    if (!get('--title')) { console.error('sloptimize fix: --title is required'); process.exit(2); }
    let fix;
    try {
      fix = buildFix(records, { title: get('--title'), issue: get('--issue'), solution: get('--solution'), commit,
        files: get('--files')?.split(','), before: get('--before'), after: get('--after'),
        footprints: get('--footprints')?.split(',').filter(Boolean), phase: PHASES ? [...PHASES].join(',') : undefined });
    } catch (e) { console.error(`sloptimize fix: ${e.message}`); process.exit(4); }
    const { appendFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, 'fixes.jsonl'), JSON.stringify(fix) + '\n');
    if (args.includes('--push')) {
      // The local ledger is the source of truth — a push failure is
      // reported but never turns a recorded fix into a failed command.
      const { cloudConfig, pushFix } = await import('../src/cloud-client.js');
      const cfg = cloudConfig(process.env, args);
      if (!cfg) console.error('push skipped: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT');
      else { try { await pushFix(cfg, fix); console.log('pushed to cloud'); } catch (e) { console.error(`push failed: ${e.message}`); } }
    }
    const moved = fix.moved
      ? [...fix.moved.sections.slice(0, 12).map((r) => `    ${r.name}: ${fmt(r.before, 'ms')} → ${fmt(r.after, 'ms')}${r.share !== undefined && Number.isFinite(r.share) ? ` (${r.share >= 0 ? '+' : ''}${Math.round(r.share * 100)}%)` : ''}`),
        ...fix.moved.counts.slice(0, 12).map((r) => `    ${r.name}: ${fmt(r.before)} → ${fmt(r.after)}${Number.isFinite(r.share) ? ` (${r.share >= 0 ? '+' : ''}${Math.round(r.share * 100)}%)` : ''}`)]
      : [];
    out(fix, `fix recorded: ${fix.title}${fix.commit ? ` (${fix.commit})` : ''}${fix.phase ? `  phase ${fix.phase}` : ''}\n  before ${fix.before.build ?? fix.before.from}: ${line(fix.before)}\n  after  ${fix.after.build ?? fix.after.from}: ${line(fix.after)}${moved.length ? `\n  moved (host sections, then counters that changed ≥20%):\n${moved.join('\n')}` : ''}`);
    process.exit(0);
  }
  const h = buildHistory(records, { fixes, buckets: Number(get('--buckets')) || 24 });
  if (json) { out(h); process.exit(0); }
  if (!h.span) { console.log('no measured records in perf.jsonl yet'); process.exit(4); }
  console.log(`history ${h.span.from} → ${h.span.to}  (${h.builds.length} builds, ${h.fixes.length} fixes)${PHASES ? `  phase ${[...PHASES].join(',')}` : ''}`);
  for (const b of h.builds) console.log(`  build ${b.build.padEnd(16)} ${b.from.slice(0, 16)}  ${line(b)}`);
  console.log('  buckets:');
  for (const b of h.buckets) console.log(`  ${b.from.slice(5, 16)}  p95 ${String(fmt(b.p95Ms)).padStart(7)}  calls ${String(fmt(b.calls)).padStart(5)}  hitches ${String(b.hitches).padStart(3)}  ${b.worstMs ? `worst ${b.worstMs}ms ${b.worstGuess ?? ''}` : ''}`);
  for (const f of h.fixes) console.log(`  ✔ ${f.at.slice(0, 10)} ${f.title}${f.commit ? ` (${f.commit})` : ''}: p95 ${fmt(f.before.p95Ms, 'ms')} → ${fmt(f.after.p95Ms, 'ms')}, hitches/h ${fmt(f.before.hitchesPerHour)} → ${fmt(f.after.hitchesPerHour)}`);
  process.exit(0);
}

if (cmd === 'compare') {
  // A vs B, each a build, a session, <ISO>..<ISO>, or a comma list of them;
  // each side is its RUNS (sessions), every metric read per run and judged
  // against its own run-to-run floor (src/compare.js). Tier-0 function
  // shares come from runs/<session>.json, which attach writes.
  const { resolveSide, compareSides } = await import('../src/compare.js');
  const { readRuns } = await import('../src/runs.js');
  const { describeConditions, mismatchLines } = await import('../src/conditions.js');
  const specs = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--dir', '--phase', '--min-runs'].includes(all[i - 1]));
  const gate = args.includes('--fail-on-regression');
  const minAt = args.indexOf('--min-runs');
  const minRuns = minAt >= 0 ? Number(args[minAt + 1]) : 3;
  if (!(minRuns >= 1)) { console.error('sloptimize compare: --min-runs takes a count ≥ 1'); process.exit(2); }
  if (specs.length < 2) { console.error('sloptimize compare: two sides are required — sloptimize compare <build|session|ISO..ISO> <build|session|ISO..ISO>'); process.exit(2); }
  const records = readLedger();
  const runs = readRuns(DIR);
  // What each run was measured under, read off the WHOLE ledger: a --phase
  // filter scopes the metrics, never the conditions.
  const condLines = readJsonl('perf.jsonl', Infinity).filter((r) => r.type === 'conditions');
  const side = (spec) => {
    const r = resolveSide(spec, records, runs, PHASES, condLines);
    if (r.error) { console.error(`sloptimize compare: ${r.error}${PHASES ? ` (phase ${[...PHASES].join(',')})` : ''}`); process.exit(4); }
    return r;
  };
  const c = compareSides(side(specs[0]), side(specs[1]), { phaseScoped: !!PHASES });
  // Two sides measured under different conditions are not a delta to judge:
  // refused, exit 3, naming what differs. --allow-mismatch reads them anyway,
  // under a banner — for when the difference IS the question.
  const allow = args.includes('--allow-mismatch');
  const refused = !c.conditions.comparable && !allow;
  // The gate (SPEC §7.1): significant moves the WORSE way fail; too few runs
  // a side is its own exit code and never a pass; and a uniform slowdown
  // with unchanged composition is the machine, not the code — incomparable.
  let g = null;
  if (gate && !refused) {
    const budgets = readJson('budgets.json') ?? {};
    const rateDir = {};
    for (const [k, v] of Object.entries(budgets)) { const m = /^perf\.budget\.[^.]+\.rate\.(.+)$/.exec(k); if (m && v && typeof v === 'object') rateDir[m[1]] = typeof v.max === 'number' ? 'max' : 'min'; }
    const { regressionGate } = await import('../src/gate.js');
    g = regressionGate(c, { minRuns, rateDir });
    if (g.verdict !== 'insufficient' && c.hostSuspect) g = { ...g, verdict: 'machine', why: 'uniform change with unchanged composition — the machine changed, not the code; re-measure on a quiet machine' };
  }
  const gateExit = !g ? 0 : g.verdict === 'regressed' ? 1 : g.verdict === 'machine' ? 3 : g.verdict === 'insufficient' ? 5 : 0;
  if (json) { out(refused ? { refused: true, conditions: c.conditions, a: c.a, b: c.b } : { ...c, ...(g ? { gate: g } : {}) }); process.exit(refused ? 3 : gateExit); }
  const sp = (s) => `${s.median} [${s.lo}–${s.hi}]`;
  console.log(`compare A=${c.a.label} (${c.a.runs.length} run${c.a.runs.length === 1 ? '' : 's'}) → B=${c.b.label} (${c.b.runs.length} run${c.b.runs.length === 1 ? '' : 's'})${PHASES ? `  phase ${[...PHASES].join(',')}` : ''}`);
  console.log(`  A: ${describeConditions(c.conditions.a[0])}`);
  console.log(`  B: ${describeConditions(c.conditions.b[0])}`);
  if (refused) {
    console.log('  refused: the sides were measured under different conditions — a delta here would be the conditions, not the code');
    for (const l of mismatchLines(c.conditions)) console.log(`    ${l}`);
    console.log('  re-measure under one set of conditions, or pass --allow-mismatch to read the deltas anyway');
    process.exit(3);
  }
  if (!c.conditions.comparable) {
    console.log('  ⚠ INCOMPARABLE CONDITIONS (--allow-mismatch) — every delta below includes the difference in conditions:');
    for (const l of mismatchLines(c.conditions)) console.log(`    ${l}`);
  } else {
    for (const l of mismatchLines(c.conditions)) console.log(`  ${l}`);
  }
  const w = Math.min(Math.max(...c.rows.map((r) => r.metric.length), 12), 56);
  console.log(`  ${'metric'.padEnd(w)}  ${'A median [lo–hi]'.padEnd(24)}  ${'B median [lo–hi]'.padEnd(24)}  ${'Δ'.padStart(9)}  ${'noise'.padStart(7)}  verdict`);
  for (const r of c.rows) {
    const d = `${r.delta > 0 ? '+' : ''}${r.delta}`;
    const v = r.verdict === 'significant' ? '✱ significant' : r.verdict === 'unproven' ? `unproven (${r.why})` : 'within noise';
    console.log(`  ${r.metric.slice(0, w).padEnd(w)}  ${sp(r.a).padEnd(24)}  ${sp(r.b).padEnd(24)}  ${d.padStart(9)}  ${String(r.noise ?? '—').padStart(7)}  ${v}`);
  }
  if (c.composition) console.log(`  composition (${c.composition.by}): shares moved ${+(c.composition.moved * 100).toFixed(1)}% A→B${c.composition.within !== undefined ? `, ${+(c.composition.within * 100).toFixed(1)}% between runs of one side` : ''}`);
  for (const wn of c.warnings) console.log(`  ⚠ ${wn}`);
  console.log('  significant = every B run beyond every A run AND |Δ| > 2× noise (the larger side\'s run-to-run range); one run on a side has no floor.');
  if (g) {
    if (g.verdict === 'regressed') console.log(`gate: ✗ REGRESSED — ${g.regressions.map((r) => `${r.metric} ${r.delta > 0 ? '+' : ''}${r.delta}`).join(', ')}`);
    else if (g.verdict === 'pass') console.log('gate: ✔ no significant regression');
    else console.log(`gate: cannot pass — ${g.why}`);
  }
  process.exit(gateExit);
}

if (cmd === 'coverage') {
  // What the run never CALLED (SPEC §3.12), from a coverage run's exact call
  // counts: modules that loaded and sat idle (bench content missing), files
  // that never loaded, and — with --changed/--since — every changed function
  // that was never called. Never from a timing run: samples cannot say what
  // did not run, only bound it.
  const { readdirSync: rd, readFileSync: rf, statSync } = await import('node:fs');
  const Cv = await import('../src/coverage.js');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  const cdir = join(DIR, 'coverage');
  let files = [];
  try { files = rd(cdir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(rf(join(cdir, f), 'utf8')); } catch { return null; } }).filter((x) => x?.type === 'coverage'); } catch { /* none */ }
  if (!files.length) { out({ error: 'no coverage run' }, `no coverage run under ${DIR} — record one with \`sloptimize attach --coverage --launch <url> --duration <s>\` (its own run: coverage slows the page, so it never shares a run with timings)`); process.exit(4); }
  if (get('--build')) files = files.filter((f) => f.build === get('--build'));
  else if (get('--session')) files = files.filter((f) => f.session === get('--session'));
  else files = [files.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)];
  if (!files.length) { out({ error: 'no coverage run matches' }, `no coverage run for ${get('--build') ? `build ${get('--build')}` : `session ${get('--session')}`}`); process.exit(4); }
  const maps = [];
  if (get('--map')) {
    const { loadSourceMap } = await import('../src/node/sourcemap.js');
    const { basename } = await import('node:path');
    for (const m of get('--map').split(',')) {
      try { maps.push({ file: basename(m).replace(/\.map$/, ''), sm: loadSourceMap(m) }); } catch (e) { console.error(`sloptimize coverage: --map ${m}: ${e.message}`); process.exit(2); }
    }
  }
  const mods = Cv.byModule(Cv.foldCoverage(files), { maps });
  const repo = get('--repo') ?? process.cwd();
  const { execFileSync } = await import('node:child_process');
  const git = (...a) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch { return null; } };
  const listed = git('ls-files', '-co', '--exclude-standard');
  const repoFiles = (listed ?? '').split('\n').filter(Boolean).map((f) => { try { return { file: f, size: statSync(join(repo, f)).size }; } catch { return null; } }).filter(Boolean);
  const a = Cv.analyzeCoverage(mods, { repoFiles, includeDeps: args.includes('--all') });
  const head = `coverage: ${files.length === 1 ? `run ${files[0].session}` : `${files.length} runs`}${files[0].build ? ` (build ${files[0].build})` : ''} · ${mods.size} module(s) loaded · function granularity, exact call counts`;
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const top = Number(get('--top') ?? 15);
  // --changed / --since: the exact `touched` — per changed FUNCTION.
  let changed = null;
  if (args.includes('--changed') || args.includes('--since')) {
    let diff;
    if (get('--since')) diff = git('diff', '-U0', get('--since'));
    else {
      const names = get('--changed').split(',').map((x) => x.trim()).filter(Boolean);
      diff = git('diff', '-U0', 'HEAD', '--', ...names);
      if (!diff) diff = git('diff', '-U0', 'HEAD~1', 'HEAD', '--', ...names);
      // A named file with no diff at all: every line of it is "the change".
      for (const n of names) if (!diff?.includes(`+++ b/${n}`)) diff = `${diff ?? ''}\n+++ b/${n}\n@@ -0,0 +1,1000000 @@`;
    }
    if (diff === null) { console.error('sloptimize coverage: not a git repo — run from the repo, or --repo <dir>'); process.exit(2); }
    changed = Cv.changedFunctions(mods, Cv.changedRanges(diff));
  }
  const missed = changed ? changed.filter((f) => f.code && (!f.loaded || f.uncalled > 0)) : [];
  if (json) { out({ runs: files.map((f) => ({ session: f.session, build: f.build })), modules: mods.size, ...a, ...(changed ? { changed } : {}) }); process.exit(missed.length ? 1 : 0); }
  console.log(head);
  if (changed) {
    console.log('  changed code, function by function:');
    for (const f of changed) {
      if (!f.code) { console.log(`  · ${f.file} — not JS`); continue; }
      if (!f.loaded) { console.log(`  ✗ ${f.file} — never loaded by this run`); continue; }
      const parts = f.fns.map((x) => `${x.count > 0 ? '✔' : '✗'} ${x.name}:${x.line} (${x.count} call${x.count === 1 ? '' : 's'})`);
      console.log(`  ${f.uncalled ? '✗' : '✔'} ${f.file}${f.moduleLevel ? ` — module-level code ${f.ran ? 'ran' : 'did not run'}` : ''}${parts.length ? `\n      ${parts.join('\n      ')}` : ''}`);
    }
    if (missed.length) console.log(`${missed.length} changed file(s) with code this run never executed — a before/after from it says nothing about that code.`);
  }
  console.log(`  loaded, but functions never called — largest modules first (${a.idle.length}):`);
  for (const m of a.idle.slice(0, top)) {
    const names = m.uncalled.slice(0, 6).map((f) => `${f.name}:${f.line}`).join(', ');
    console.log(`  ${m.idle ? '◌' : '·'} ${m.file.padEnd(48)} ${kb(m.size).padStart(9)}  ${m.called}/${m.total} called${m.idle ? ' — IDLE: loaded and sat (bench content missing?)' : ''}\n      never called: ${names}${m.uncalled.length > 6 ? `, … (${m.uncalled.length})` : ''}`);
  }
  if (a.silent.length) console.log(`  loaded, nothing in it ever ran (${a.silent.length}): ${a.silent.slice(0, 8).map((m) => m.file).join(', ')}`);
  if (!listed) console.log('  never loaded: (not a git repo — run from the repo or pass --repo <dir> to list the files this run never loaded)');
  else if (!a.matched) console.log(`  never loaded: no loaded module matched a file of the repo — a bundle? pass --map <bundle>.js.map`);
  else {
    console.log(`  never loaded — repo files beside the loaded code, largest first (${a.never.length}):`);
    for (const f of a.never.slice(0, top)) console.log(`  ✗ ${f.file.padEnd(48)} ${kb(f.size).padStart(9)}`);
    if (a.never.length) console.log('    (a dead import, a stripped feature, tooling — or a feature this run never reached)');
  }
  process.exit(missed.length ? 1 : 0);
}

if (cmd === 'touched') {
  // Did the run execute the change under test? For each changed file: did
  // any profiler sample land in it (src/runs.js touchedFiles). A clean A/B
  // on a benchmark that never ran the new code path is a rubber stamp, and
  // only this can say so.
  const { readRuns, runBucket, touchedFiles, CODE_FILE } = await import('../src/runs.js');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  let runs = readRuns(DIR);
  if (runs.length === 0) { console.log(`no runs/*.json under ${DIR} — attach writes one per session (sloptimize attach); tier 1 has no whole-run sampler`); process.exit(4); }
  if (get('--build')) runs = runs.filter((r) => r.build === get('--build'));
  else if (get('--session')) runs = runs.filter((r) => r.session === get('--session'));
  else runs = [runs.sort((a, b) => Date.parse(a.to ?? 0) - Date.parse(b.to ?? 0)).at(-1)];
  if (runs.length === 0) { console.log(`no run matches ${get('--build') ? `build ${get('--build')}` : `session ${get('--session')}`}`); process.exit(4); }
  let changed = get('--changed')?.split(',').map((s) => s.trim()).filter(Boolean);
  let source = '--changed';
  if (!changed) {
    const { execFileSync } = await import('node:child_process');
    const git = (...a) => { try { return execFileSync('git', a, { cwd: get('--repo') ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return null; } };
    const since = get('--since');
    if (since) { changed = git('diff', '--name-only', since); source = `git diff ${since}`; }
    else {
      changed = git('diff', '--name-only', 'HEAD'); source = 'uncommitted changes';
      if (changed && changed.length === 0) { changed = git('diff', '--name-only', 'HEAD~1', 'HEAD'); source = 'the last commit (the tree is clean)'; }
    }
    if (!changed) { console.error('sloptimize touched: not a git repo — pass --changed a.js,b.js'); process.exit(2); }
  }
  if (changed.length === 0) { console.log(`no changed files (${source})`); process.exit(4); }
  const maps = [];
  if (get('--map')) {
    const { loadSourceMap } = await import('../src/node/sourcemap.js');
    const { basename } = await import('node:path');
    for (const m of get('--map').split(',')) {
      try { maps.push({ file: basename(m).replace(/\.map$/, ''), sm: loadSourceMap(m) }); } catch (e) { console.error(`sloptimize touched: --map ${m}: ${e.message}`); process.exit(2); }
    }
  }
  const bucket = runBucket(runs, PHASES);
  if (bucket.samples === 0) {
    // No samples at all says nothing about any file — never "0 samples in N of N".
    const have = [...new Set(runs.flatMap((r) => Object.keys(r.phases ?? {})))];
    console.log(`no samples in ${PHASES ? `phase ${[...PHASES].join(',')}` : 'this run'} — phases in the run file: ${have.join(', ') || 'none'}`);
    process.exit(4);
  }
  const t = touchedFiles(bucket, changed, { maps });
  const code = t.files.filter((f) => f.code), missed = code.filter((f) => !f.hit);
  if (json) { out({ runs: runs.map((r) => ({ session: r.session, build: r.build })), source, ...t }); process.exit(missed.length ? 1 : 0); }
  const iv = runs[0].intervalUs ? `${runs[0].intervalUs / 1000}ms` : '?';
  console.log(`touched: ${runs.length === 1 ? `run ${runs[0].session}` : `${runs.length} runs`}${runs[0].build ? ` (build ${runs[0].build})` : ''} · ${t.jsSamples} JS samples at ${iv}${PHASES ? ` · phase ${[...PHASES].join(',')}` : ''} · ${changed.length} changed file(s) from ${source}`);
  const pct = (x) => `${+(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const w = Math.min(Math.max(...t.files.map((f) => f.file.length)), 60);
  for (const f of t.files) {
    if (!f.code) console.log(`  · ${f.file.padEnd(w)}  not JS — the sampler cannot see it run (a shader, data, style)`);
    else if (f.hit) console.log(`  ✔ ${f.file.padEnd(w)}  ${f.heaviest} samples under ${f.top} (${pct(f.share)} of JS), ${f.self} self in the file`);
    else console.log(`  ✗ ${f.file.padEnd(w)}  0 samples${t.bound !== undefined ? ` — if it ran, it took under ${pct(t.bound)} of JS time (95%)` : ''}`);
  }
  if (missed.length) {
    console.log(`0 samples in ${missed.length} of ${code.length} changed code file(s) — this run did not measurably execute ${missed.length === code.length ? 'the change' : 'part of the change'}; a before/after from it says nothing about ${missed.length === 1 ? 'that file' : 'those files'}.`);
    if (!maps.length) {
      const scripts = new Map();
      for (const r of bucket.fns.values()) { const b = String(r.url).replace(/[?#].*$/, '').split('/').pop(); if (b) scripts.set(b, (scripts.get(b) ?? 0) + r.self); }
      const top = [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b]) => b);
      if (top.length && !top.some((b) => CODE_FILE.test(b) && code.some((f) => f.file.endsWith(b)))) console.log(`  (the samples name these scripts: ${top.join(', ')} — if those are bundles, pass --map <bundle>.js.map so samples are credited to sources)`);
    }
  }
  process.exit(missed.length ? 1 : 0);
}

if (cmd === 'serve') {
  // The dev server for any app (SPEC §8.6): the ingest/ledger/ask routes on
  // a bare http server, plus the app's static files with the js-profiling
  // document policy. `--repo <dir>` enables the fix loop's git verbs.
  const { serve } = await import('../src/node/serve.js');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const s = await serve({ dir: DIR, port: Number(get('--port') ?? 4390), host: get('--host'), static: get('--static'), repoDir: get('--repo') });
  console.log(`sloptimize serve: http://${get('--host') ?? '127.0.0.1'}:${s.port}  ledger ${s.dir}${s.static ? `  static ${s.static}` : ''}\n  POST /api/sloptimize/ingest · GET /api/sloptimize/ledger · the runtime posts here; \`sloptimize ask …\` answers ride the profile post back`);
  await new Promise(() => {});
}

if (cmd === 'ask') {
  // The agent asks the running tab (SPEC §3.9): `sloptimize ask profile`,
  // `ask capture 10`, `ask cpuprofile 5`, `ask eval "<js>"` — one line into
  // ask.jsonl, the host's dev ingest hands it to the tab, the answer lands in
  // perf.jsonl and is printed here. Nobody at the keyboard.
  const { makeAsk } = await import('../src/ask.js');
  const { writeAsk, awaitAnswer } = await import('../src/ask-files.js');
  const kind = args[1];
  const arg = args.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--'))).join(' ');
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  let ask;
  try { ask = makeAsk(kind, arg); } catch (e) { console.error(`sloptimize ask: ${e.message}`); process.exit(2); }
  writeAsk(DIR, ask);
  const timeout = Number(get('--timeout') ?? 30) * 1000;
  const ans = await awaitAnswer(DIR, ask.id, timeout);
  if (!ans) { console.error(`sloptimize ask: no answer from a tab in ${timeout / 1000}s — is a game running against a dev server with the ingest armed?`); process.exit(4); }
  if (json || ans.ok === false) { out(ans, JSON.stringify(ans, null, 2)); process.exit(ans.ok === false ? 1 : 0); }
  let r = ans.result;
  // A cpuprofile names minified positions; a source map beside the build
  // turns them into files and lines (`--map dist/game.min.js.map`).
  const mapPath = get('--map');
  if (kind === 'cpuprofile' && mapPath && r && typeof r === 'object') {
    const { loadSourceMap, symbolicate } = await import('../src/node/sourcemap.js');
    const { basename } = await import('node:path');
    try { r = symbolicate(r, loadSourceMap(mapPath), basename(mapPath).replace(/\.map$/, '')); } catch (e) { console.error(`sloptimize ask: --map ${mapPath}: ${e.message}`); }
  }
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
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
  const waitSeconds = (v, flag = '--wait') => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { console.error(`sloptimize attach: ${flag} takes seconds (got "${v}")`); process.exit(2); }
    return n;
  };
  const share = (v) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) { console.error(`sloptimize attach: --min-share is a fraction of the frame, 0–1 (got "${v}")`); process.exit(2); }
    return n;
  };
  // --runs N: N back-to-back runs, each its own session of one build — the
  // repetitions compare's noise floor and the gate need, from one command.
  // Every run but an open-ended single one needs --duration to end it.
  const runsN = get('--runs') !== undefined ? Number(get('--runs')) : 1;
  if (!(Number.isInteger(runsN) && runsN >= 1)) { console.error(`sloptimize attach: --runs takes a count ≥ 1 (got "${get('--runs')}")`); process.exit(2); }
  const duration = get('--duration') !== undefined ? waitSeconds(get('--duration'), '--duration') : undefined;
  if (runsN > 1 && !duration) { console.error('sloptimize attach: --runs needs --duration <s> to end each run'); process.exit(2); }
  const opts = {
    launch: get('--launch'),
    port: get('--port') ? Number(get('--port')) : undefined,
    dir: get('--dir') ?? '.sloptimize',
    headless: args.includes('--headless'),
    minHitchMs: get('--min-hitch-ms') ? Number(get('--min-hitch-ms')) : undefined,
    build: get('--build'),
    waitMs: get('--wait') !== undefined ? waitSeconds(get('--wait')) * 1000 : undefined,
    minShare: get('--min-share') !== undefined ? share(get('--min-share')) : undefined,
    slots: !args.includes('--no-slots'),
    coverage: args.includes('--coverage'),
  };
  if (opts.coverage) console.log('[attach] coverage run: exact call counts, no sampler — its timings are not timings, and no verb will read them as such');
  let session = null, closing = false;
  // Any signal a wrapper sends stops the sampler in the page before we go;
  // and the target going away ends the session — an attach without a target
  // has nothing to record and must not linger with a CDP session open. Both
  // leave through close(): it is the only place a --launch'd browser is
  // killed, so a page that vanished under a still-running browser must not
  // orphan that browser.
  const stop = async () => { if (session) await Promise.race([session.close(), new Promise((r) => setTimeout(r, 5000))]); };
  const bye = async (why, code = 0) => {
    if (closing) return; closing = true;
    console.log(`[attach] ${why} — stopping`);
    // Bounded: a target that never answers the final Profiler.stop must not keep us alive.
    await stop();
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => bye(sig));
  const done = [];
  for (let i = 0; i < runsN; i++) {
    try { session = await attach(opts); }
    catch (e) {
      // Nothing was recorded: say why on one line and leave non-zero, never a
      // stack trace that reads like an attach that ran and saw nothing.
      console.error(`sloptimize attach: ${e?.message ?? e}${done.length ? ` (after ${done.length} of ${runsN} runs: ${done.join(', ')})` : ''}`);
      process.exit(4);
    }
    const tag = runsN > 1 ? ` (run ${i + 1}/${runsN})` : '';
    console.log(`[attach] recording — session ${session.session}${session.build ? `, build ${session.build}` : ''}${tag} — ${duration ? `${duration}s` : 'Ctrl+C to stop'}`);
    const timer = duration ? new Promise((r) => setTimeout(() => r('time'), duration * 1000)) : new Promise(() => {});
    const why = await Promise.race([session.closed, timer]);
    if (why !== 'time') {
      if (runsN === 1) await bye(`target gone (${why.code ?? 'socket closed'})`);
      // A run cut short is not one of N equal runs: stop, and say which ones stand.
      await bye(`target gone during run ${i + 1}/${runsN} — ${done.length} complete run(s): ${done.join(', ') || 'none'}`, 4);
    }
    await stop();
    done.push(session.session);
    session = null;
  }
  console.log(`[attach] ${done.length} run(s) recorded: ${done.join(', ')}`);
  if (opts.build && done.length > 1) console.log(`  next: sloptimize check --build ${opts.build} --min-runs ${done.length} · sloptimize compare <base> ${opts.build} --fail-on-regression`);
  process.exit(0);
}

console.log('usage: sloptimize <report|issues|check|census|history|compare|touched|fix|doctor|hook-status|watch|attach|ask|serve> [--json] [--dir <path>]... [--phase a,b] [--counters-only] [--interval <s>] [--min-hitch-ms N] [--launch <url>] [--port N] [--wait <s>] [--headless] [--build <id>] [--min-share 0.1] [--no-slots] [--runs N --duration <s>] [--coverage]\n       sloptimize check [--session <id> | --build <id>] [--min-runs N] [--allow-unmeasured] [--counters-only]   (exit 0 pass · 1 breach · 2 bad budgets · 3 incomparable · 4 unmeasured · 5 cannot judge)\n       sloptimize fix --title "…" [--issue "…"] [--solution "…"] [--commit sha] [--files a,b] [--footprints id,id] [--before <build|ISO..ISO>] [--after <build|ISO..ISO>] [--push]\n       sloptimize compare <A> <B> [--phase a,b] [--allow-mismatch] [--fail-on-regression [--min-runs 3]] [--json]      (A/B: a build, a session, <ISO>..<ISO>, or a comma list; exit 3 when measured under different conditions)\n       sloptimize coverage [--session <id> | --build <id>] [--changed a.js,b.ts | --since <rev>] [--map <bundle.map>] [--repo <dir>] [--top N] [--all]   (record with attach --coverage)\n       sloptimize touched [--changed a.js,b.ts | --since <rev>] [--build <id> | --session <id>] [--map <bundle.map>[,…]] [--phase a,b]\n       sloptimize ask <profile|capture <s>|cpuprofile <s> [--map <file.map>]|eval <js>> [--timeout <s>]\n       sloptimize serve [--port 4390] [--static <dir>] [--repo <dir>] [--dir <ledger>]\n       sloptimize issues [--json] [--from ISO] [--to ISO] [--phase a,b] [--fp <id>] [--all] [--cloud [--preset 24h|7d|30d] [--source s] [--kind k] [--key k] [--endpoint url]]');
process.exit(2);
