// ============================================================
// history.js — the timeline and the fix ledger (SPEC §8.5)
// ============================================================
// perf.jsonl is append-only and every line is self-sufficient (build +
// phase + timestamp), so the whole history of a deployment IS the ledger —
// this module just folds it: equal time buckets (for a graph), one window
// per build (for "what did this bundle measure"), and fix records whose
// before/after are MEASURED windows of that same ledger. Nobody types a
// number into a report; the report is a pair of windows and their summaries.
//
// Pure and environment-free on purpose: the CLI folds it in node, the
// in-page panel folds the same bytes in the browser, and a test folds a
// fixture — one implementation, three readers.

import { footprintOf, describeFootprint } from './footprint.js';

/** A date as ms — a number passes through, a string parses; NaN for junk. */
function asMs(v) { return typeof v === 'number' ? v : Date.parse(v); }

/** Median of a numeric array (undefined for empty). */
function median(vals) {
  if (vals.length === 0) return undefined;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : +((s[mid - 1] + s[mid]) / 2).toFixed(2);
}

/** Records with a parseable timestamp, each paired with its ms. */
function stamped(records) {
  const out = [];
  for (const r of records) {
    const t = Date.parse(r?.at);
    if (Number.isFinite(t)) out.push({ t, r });
  }
  return out;
}

/** The counters a heartbeat may carry (INTEGRATION.md §2: calls/triangles/
 *  programs ride the beat since 0.3 — older beats simply have none). Absent
 *  means unmeasured, never zero. */
const BEAT_COUNTERS = ['calls', 'triangles', 'programs'];

/**
 * Summarize one window [from, to] of the ledger: medians of the heartbeats
 * (frame p95/median and whichever counters they carry), the hitch count,
 * rate, worst frame and most frequent guess, and the regime that measured
 * them. Every field is absent when the window has no evidence for it.
 */
export function summarizeWindow(records, from, to) {
  const beats = [], counters = Object.fromEntries(BEAT_COUNTERS.map((k) => [k, []]));
  const p95s = [], meds = [], guesses = new Map();
  let hitches = 0, jitters = 0, worstMs, worstGuess, regime;
  for (const { t, r } of stamped(records)) {
    if (t < from || t > to) continue;
    if (r.type === 'heartbeat') {
      beats.push(r);
      if (typeof r.p95Ms === 'number') p95s.push(r.p95Ms);
      if (typeof r.medianFrameMs === 'number') meds.push(r.medianFrameMs);
      for (const k of BEAT_COUNTERS) if (typeof r[k] === 'number') counters[k].push(r[k]);
      if (r.regime && r.regime !== 'unknown') regime = r.regime;
    } else if (r.type === 'hitch' && typeof r.frameMs === 'number') {
      hitches++;
      const g = r.classification?.[0]?.guess;
      if (g) guesses.set(g, (guesses.get(g) ?? 0) + 1);
      if (worstMs === undefined || r.frameMs > worstMs) { worstMs = r.frameMs; worstGuess = g; }
    } else if (r.type === 'jitter') {
      // A coordinate jump (SPEC §3.6) — counted, so a fix's before/after can
      // say the view stopped snapping, not only that frames got shorter.
      jitters++;
    }
  }
  const hours = Math.max((to - from) / 3_600_000, 1 / 60);
  const s = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), beats: beats.length, hitches,
    hitchesPerHour: +(hitches / hours).toFixed(1) };
  if (p95s.length) s.p95Ms = median(p95s);
  if (meds.length) s.medianMs = median(meds);
  for (const k of BEAT_COUNTERS) if (counters[k].length) s[k] = median(counters[k]);
  if (jitters > 0) { s.jitters = jitters; s.jittersPerHour = +(jitters / hours).toFixed(1); }
  if (worstMs !== undefined) { s.worstMs = +worstMs.toFixed(1); s.worstGuess = worstGuess; }
  if (guesses.size) s.topGuess = [...guesses].sort((a, b) => b[1] - a[1])[0][0];
  if (regime) s.regime = regime;
  return s;
}

/** Evidence = a record that measured something: a beat, a hitch, a jitter.
 *  Arm probes and settles name a build without saying how it ran. */
const EVIDENCE = new Set(['heartbeat', 'hitch', 'jitter']);

/** Builds in order of first evidence, each with its measured window. */
function buildWindows(records) {
  const seen = new Map();
  for (const { t, r } of stamped(records)) {
    if (!EVIDENCE.has(r.type) || !r.build) continue;
    const w = seen.get(r.build);
    if (!w) seen.set(r.build, { build: r.build, fromMs: t, toMs: t });
    else { if (t < w.fromMs) w.fromMs = t; if (t > w.toMs) w.toMs = t; }
  }
  return [...seen.values()].sort((a, b) => a.fromMs - b.fromMs);
}

/** The newest build with evidence and the one before it, oldest first —
 *  the default before/after pair of a fix, because a fix ships as a build. */
export function latestBuilds(records) {
  return buildWindows(records).slice(-2).map((w) => w.build);
}

/**
 * Fold the ledger into a timeline. `buckets` equal time slices from the
 * first to the last measured record; each carries the window summary's
 * fields (see summarizeWindow) plus the build that ran in it, so a graph
 * can draw p95 / draw calls / hitch spikes and mark build boundaries.
 */
export function buildHistory(records, opts = {}) {
  const n = opts.buckets ?? 48;
  // A date range (ms or ISO; either end open) scopes EVERYTHING below —
  // buckets, per-build windows and the fix list — so "how much did we gain
  // between these dates" is the same fold over fewer records.
  const lo = opts.from !== undefined && opts.from !== null && opts.from !== '' ? asMs(opts.from) : -Infinity;
  const hi = opts.to !== undefined && opts.to !== null && opts.to !== '' ? asMs(opts.to) : Infinity;
  if (lo !== -Infinity || hi !== Infinity) {
    records = records.filter((r) => { const t = Date.parse(r.at); return !Number.isFinite(t) || (t >= lo && t <= hi); });
  }
  // Sorted: the sink appends per post, and a post can carry a settle that
  // was measured before the beat ahead of it in the file.
  const measured = stamped(records).filter(({ r }) => EVIDENCE.has(r.type)).sort((a, b) => a.t - b.t);
  const fixes = [...(opts.fixes ?? [])]
    .filter((f) => { const t = Date.parse(f.at); return !Number.isFinite(t) || (t >= lo && t <= hi); })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (measured.length === 0) return { span: null, buckets: [], builds: [], fixes };
  const fromMs = measured[0].t, toMs = measured[measured.length - 1].t;
  const width = Math.max(toMs - fromMs, 1) / n;
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const b0 = fromMs + i * width, b1 = i === n - 1 ? toMs : fromMs + (i + 1) * width - 1;
    const s = summarizeWindow(records, b0, b1);
    delete s.hitchesPerHour;                       // a bucket is a slice, not a rate
    delete s.jittersPerHour;
    const inBucket = measured.filter(({ t }) => t >= b0 && t <= b1);
    const build = inBucket.map(({ r }) => r.build).filter(Boolean).pop();
    if (build) s.build = build;
    buckets.push(s);
  }
  const builds = buildWindows(records).map((w) => ({ build: w.build, ...summarizeWindow(records, w.fromMs, w.toMs) }));
  return { span: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }, buckets, builds, fixes };
}

/** Resolve a window spec — a build name or "ISO..ISO" — against the ledger. */
function resolveWindow(records, spec, label) {
  if (typeof spec === 'string' && spec.includes('..')) {
    const [a, b] = spec.split('..').map((s) => Date.parse(s));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error(`bad ${label} window "${spec}" — want <ISO>..<ISO>`);
    return { fromMs: a, toMs: b };
  }
  const w = buildWindows(records).find((x) => x.build === spec);
  if (!w) throw new Error(`no evidence for ${label} window "${spec}" — builds with evidence: ${buildWindows(records).map((x) => x.build).join(', ') || 'none'}`);
  return w;
}

/** The window's summary plus the per-bucket p95 series a card sparklines. */
function windowReport(records, w) {
  const s = summarizeWindow(records, w.fromMs, w.toMs);
  if (w.build) s.build = w.build;
  const slices = 24, width = Math.max(w.toMs - w.fromMs, 1) / slices;
  s.series = [];
  for (let i = 0; i < slices; i++) {
    const p = summarizeWindow(records, w.fromMs + i * width, w.fromMs + (i + 1) * width).p95Ms;
    if (p !== undefined) s.series.push(p);
  }
  return s;
}

/**
 * A fix record: what was wrong, what changed (commit), and the measured
 * before/after — two ledger windows, by build name (default: the previous
 * and the latest build with evidence) or by explicit time range.
 */
export function buildFix(records, opts = {}) {
  let { before, after } = opts;
  if (!before || !after) {
    const pair = latestBuilds(records);
    if (pair.length < 2) throw new Error('a fix needs two builds with evidence in the ledger (before → after); pass --before/--after explicitly (a build name, or <ISO>..<ISO>)');
    before ??= pair[0]; after ??= pair[1];
  }
  const fix = {
    type: 'fix',
    at: opts.now ?? new Date().toISOString(),
    title: opts.title ?? '',
  };
  for (const k of ['issue', 'solution', 'commit', 'files', 'footprints']) if (opts[k]) fix[k] = opts[k];
  fix.before = windowReport(records, resolveWindow(records, before, 'before'));
  fix.after = windowReport(records, resolveWindow(records, after, 'after'));
  return fix;
}

/**
 * THE ISSUE CATALOGUE (SPEC §3.7): every incident record in `records`,
 * grouped by footprint — the same cause across builds, sessions and days is
 * ONE row — with how often it happened, when first and last, on which builds,
 * how bad at worst, and which fixes were applied to it (a fix names the
 * footprints it addresses in `footprints`). Records stamped by the writer keep
 * their footprint; older lines are derived here, so the catalogue reaches back
 * to before footprints existed.
 *
 * `from`/`to` scope the occurrences counted (ms or ISO; either end open);
 * `now` is for `lastAgoMs`. Sorted most-frequent first; ties by most recent.
 */
export function buildIssues(records, opts = {}) {
  const lo = opts.from !== undefined && opts.from !== null && opts.from !== '' ? asMs(opts.from) : -Infinity;
  const hi = opts.to !== undefined && opts.to !== null && opts.to !== '' ? asMs(opts.to) : Infinity;
  const now = opts.now ?? Date.now();
  const groups = new Map();
  for (const { t, r } of stamped(records)) {
    if (t < lo || t > hi) continue;
    if (r.automated === true && opts.includeAutomated !== true) continue;   // a robot's session is not a player's issue
    const fp = footprintOf(r);
    if (!fp) continue;
    let g = groups.get(fp.id);
    if (!g) {
      const d = describeFootprint(fp.key);
      g = { id: fp.id, key: fp.key, type: r.type, glyph: d.glyph, label: d.label, phase: d.phase, ctx: d.ctx,
        count: 0, firstMs: t, lastMs: t, builds: new Set(), worst: undefined, sample: undefined };
      groups.set(fp.id, g);
    }
    g.count++;
    if (t < g.firstMs) g.firstMs = t;
    if (t > g.lastMs) { g.lastMs = t; g.sample = r.classification?.[0] ?? g.sample; }
    if (r.build) g.builds.add(r.build);
    const w = worstOf(r);
    if (w !== undefined && (g.worst === undefined || w.value > g.worst.value)) g.worst = w;
  }
  const fixes = (opts.fixes ?? []).filter((f) => Array.isArray(f.footprints) && f.footprints.length);
  const out = [];
  for (const g of groups.values()) {
    const linked = fixes.filter((f) => f.footprints.includes(g.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    out.push({
      id: g.id, key: g.key, type: g.type, glyph: g.glyph, label: g.label, phase: g.phase, ctx: g.ctx,
      count: g.count,
      first: new Date(g.firstMs).toISOString(), last: new Date(g.lastMs).toISOString(),
      lastAgoMs: Math.max(0, now - g.lastMs),
      builds: [...g.builds],
      ...(g.worst ? { worst: g.worst } : {}),
      ...(g.sample ? { sample: g.sample } : {}),
      fixes: linked.map((f) => ({ id: f.id, title: f.title, at: f.at, ...(f.commit ? { commit: f.commit } : {}),
        ...(f.status ? { status: f.status } : {}), ...(f.pr ? { pr: f.pr } : {}), ...(f.mergeCommit ? { mergeCommit: f.mergeCommit } : {}) })),
    });
  }
  return out.sort((a, b) => b.count - a.count || Date.parse(b.last) - Date.parse(a.last));
}

/** The one number that says how bad an occurrence was, with its unit. */
function worstOf(r) {
  switch (r.type) {
    case 'hitch': return typeof r.frameMs === 'number' ? { value: r.frameMs, unit: 'ms' } : undefined;
    case 'usermark': return typeof r.worstFrames?.[0]?.frameMs === 'number' ? { value: r.worstFrames[0].frameMs, unit: 'ms' } : undefined;
    case 'jitter': { const v = r.kind === 'oscillation' ? r.amplitude : r.units; return typeof v === 'number' ? { value: v, unit: 'u' } : undefined; }
    case 'warm': return typeof r.worstBatchMs === 'number' ? { value: r.worstBatchMs, unit: 'ms' } : undefined;
    case 'gpu-stall': return typeof r.queueDoneMs === 'number' ? { value: r.queueDoneMs, unit: 'ms' } : undefined;
    case 'gpu-settle': return typeof r.ms === 'number' ? { value: r.ms, unit: 'ms' } : undefined;
    case 'error': return undefined;
    case 'server-hitch': return typeof r.tickMs === 'number' ? { value: r.tickMs, unit: 'ms' } : undefined;
    case 'server-stall': return typeof r.p99Ms === 'number' ? { value: r.p99Ms, unit: 'ms' } : undefined;
    default: return undefined;
  }
}

/** "X ago", the way a human reads a last occurrence. */
export function agoText(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
