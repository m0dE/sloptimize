// ============================================================
// memory.js — does a long session grow? (SPEC §3.14)
// ============================================================
// Players run long sessions, and a slow leak surfaces in reviews, not bug
// reports. The leak a three.js game actually hits is usually not the JS
// heap: a rebuild of merged geometry on every edit whose dispose misses
// grows the GPU's live buffers and geometries monotonically, invisible to
// every frame metric. So the heartbeat carries the live GPU object counts
// (tier 0 counts them at the graphics API; three.js's renderer.info when the
// devtools hook hands the renderer over) and the JS heap, and this reads a
// session's series as a trend.
//
// A live heap reading is a sawtooth — allocation, then a collection — so
// unless the run forced a collection before each reading, the trend is fit
// to the FLOOR (the minimum of each three readings), and the line says which
// source it read. A trend needs MIN_MINUTES of beats (MIN_POINTS at least); "growing" needs the
// fit to explain the series (R² ≥ 0.6), most steps not to fall, and the rise
// to matter (a tenth of the start, and an absolute minimum per kind).
//
// Pure: records in, trends out.

const MIN_POINTS = 5;
const MIN_MINUTES = 5;
/** The smallest rise worth calling growth, per kind. */
const MIN_RISE = { heapMB: 2, count: 5 };

function fit(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2 };
}

/**
 * One series → its trend. `pts` are `{t (ms), v}`; `kind` 'heapMB' | 'count'.
 * @returns {{first:number, last:number, perHour:number, r2:number, rising:number, minutes:number, n:number, verdict:'growing'|'flat'|'shrinking'|'too short'}}
 */
export function trendOf(pts, kind = 'count', { floor = false } = {}) {
  const s = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  const minutes = s.length > 1 ? (s.at(-1).t - s[0].t) / 60_000 : 0;
  const base = { n: s.length, minutes: +minutes.toFixed(1), first: s[0]?.v, last: s.at(-1)?.v };
  if (s.length < MIN_POINTS || minutes < MIN_MINUTES) return { ...base, verdict: 'too short' };
  // A sawtooth's floor: the minimum of each reading and its two neighbours.
  const series = floor ? s.map((p, i) => ({ t: p.t, v: Math.min(...s.slice(Math.max(0, i - 1), i + 2).map((q) => q.v)) })) : s;
  const { slope, r2 } = fit(series.map((p) => ({ x: (p.t - s[0].t) / 3_600_000, y: p.v })));
  let up = 0;
  for (let i = 1; i < series.length; i++) if (series[i].v >= series[i - 1].v) up++;
  const rising = up / (series.length - 1);
  const rise = series.at(-1).v - series[0].v;
  const big = Math.abs(rise) >= Math.max(MIN_RISE[kind] ?? MIN_RISE.count, 0.1 * Math.abs(series[0].v));
  const verdict = big && r2 >= 0.6 && slope > 0 && rising >= 0.7 ? 'growing' : big && r2 >= 0.6 && slope < 0 ? 'shrinking' : 'flat';
  return { ...base, first: series[0].v, last: series.at(-1).v, perHour: +slope.toFixed(kind === 'heapMB' ? 2 : 1), r2: +r2.toFixed(2), rising: +rising.toFixed(2), verdict };
}

/**
 * A session's heartbeats → a trend per series: `heap` (MB, with its
 * source), `gpu.<kind>` (live objects at the graphics API), `three.<kind>`
 * (renderer.info.memory). Only series the beats carried.
 */
export function memoryTrends(records) {
  const beats = records.filter((r) => r?.type === 'heartbeat' && Number.isFinite(Date.parse(r.at)));
  const series = new Map();
  const push = (k, t, v) => { if (typeof v === 'number') (series.get(k) ?? series.set(k, []).get(k)).push({ t, v }); };
  let heapSource;
  for (const b of beats) {
    const t = Date.parse(b.at);
    if (b.heap) { push('heap', t, b.heap.usedMB); heapSource = b.heap.source ?? heapSource; }
    for (const [k, v] of Object.entries(b.gpuLive ?? {})) push(`gpu.${k}`, t, v);
    for (const [k, v] of Object.entries(b.three ?? {})) push(`three.${k}`, t, v);
  }
  const out = {};
  for (const [k, pts] of series) {
    out[k] = k === 'heap' ? { ...trendOf(pts, 'heapMB', { floor: heapSource !== 'post-gc' }), source: heapSource ?? 'unknown' } : trendOf(pts, 'count');
  }
  return out;
}

/** The lines `report` prints: growing series first, then the flat ones in one line. */
export function memoryLines(trends) {
  const entries = Object.entries(trends);
  if (!entries.length) return [];
  const minutes = Math.max(...entries.map(([, t]) => t.minutes));
  const unit = (k) => (k === 'heap' ? ' MB' : '');
  const label = (k) => (k === 'heap' ? `JS heap (${trends.heap.source === 'post-gc' ? 'post-GC' : 'live — fit to its floor; --heap-gc for post-GC readings'})` : k.startsWith('gpu.') ? `GPU ${k.slice(4)} (live)` : `three ${k.slice(6)}`);
  if (entries.every(([, t]) => t.verdict === 'too short')) return [`  memory: ${minutes} min of heartbeats — a trend needs ${MIN_MINUTES} min and ${MIN_POINTS} beats`];
  const lines = [`  memory over ${minutes} min:`];
  for (const [k, t] of entries.filter(([, x]) => x.verdict === 'growing' || x.verdict === 'shrinking')) {
    lines.push(`    ${t.verdict === 'growing' ? '▲' : '▼'} ${label(k)}: ${t.first}${unit(k)} → ${t.last}${unit(k)} (${t.perHour > 0 ? '+' : ''}${t.perHour}${unit(k)}/h, R² ${t.r2}, rising in ${Math.round(t.rising * 100)}% of steps) — ${t.verdict.toUpperCase()}${t.verdict === 'growing' && k !== 'heap' ? ': a dispose missed on a rebuild?' : ''}`);
  }
  const flat = entries.filter(([, x]) => x.verdict === 'flat').map(([k, t]) => `${label(k).replace(/ \(.*\)$/, '')} ${t.last}${unit(k)}`);
  if (flat.length) lines.push(`    flat: ${flat.join(' · ')}`);
  return lines;
}
