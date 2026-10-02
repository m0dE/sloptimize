// ============================================================
// conditions.js — what a run was measured UNDER, and whether two compare
// ============================================================
// Every false performance conclusion this tool has been party to was a
// comparability failure: two numbers that looked alike and were not. An
// in-app frame body set beside an attached run's rAF interval read as "+27%
// attach overhead" — it was the second vsync. A build measured on the dev
// machine while another process held the GPU read as a +46% regression. A
// throughput count normalised by wall time flattered the build that rendered
// faster. None of these is noise; each is a CONDITION that differed.
//
// So a run carries a conditions block (attach writes it into
// runs/<session>.json and as a `conditions` ledger line; a tier-1 host may
// write the ledger line itself — SPEC §3.8), and every verb that sets two
// measurements side by side diffs the blocks through ONE table, below. A
// material difference is a refusal (exit 3, the code SPEC §6.3 already gave
// "incomparable"), not a footnote; a minor one is said; a condition one side
// never recorded is "unverified" — older runs predate the block, and calling
// them incomparable would orphan every ledger written before it.
//
// Pure: the CLI hands records and run files in.

/** Pixel area (device pixels) two runs may differ by and still compare. */
const PIXELS_TOLERANCE = 0.1;

const str = (v) => (typeof v === 'string' && v ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The fields, in the order a refusal names them. `get` reads a value from a
 * conditions block (undefined: not recorded); `eq` defaults to ===;
 * `material` decides refuse vs mention; `why` is the sentence a refusal says.
 */
export const CONDITION_FIELDS = [
  { key: 'instrument', label: 'instrument', material: true, get: (c) => str(c.instrument),
    why: 'an attached run pays for its recorder and reads rAF intervals; an in-app run times its own frame — the two frame numbers are different quantities' },
  { key: 'mode', label: 'run mode', material: true, get: (c) => str(c.mode) ?? (c.instrument ? 'timing' : undefined),
    why: 'a coverage run is slowed by its own instrumentation; its timings are not timings' },
  { key: 'regime', label: 'regime', material: true, get: (c) => (c.regime === 'hardware' || c.regime === 'software' ? c.regime : undefined),
    why: 'a software rasterizer\'s frame times say nothing about a GPU\'s' },
  { key: 'refreshHz', label: 'display refresh', material: true, unit: ' Hz', get: (c) => (c.display?.cadence === 'variable' ? 'variable' : num(c.display?.refreshHz)),
    why: 'a frame lasts whole vsyncs, so the same work presents at different intervals on different displays' },
  { key: 'gpu', label: 'GPU', material: true, get: (c) => str(c.gpu), eq: (a, b) => normGpu(a) === normGpu(b),
    why: 'a different GPU is a different machine' },
  { key: 'platform', label: 'platform', material: true, get: (c) => str(c.device?.platform),
    why: 'a different OS is a different machine' },
  { key: 'cores', label: 'CPU cores', material: true, get: (c) => num(c.device?.cores),
    why: 'a different core count is a different machine' },
  { key: 'pixels', label: 'drawing size', material: true, get: pixelsOf, eq: (a, b) => Math.abs(a.px - b.px) <= PIXELS_TOLERANCE * Math.max(a.px, b.px), show: (v) => v.text,
    why: 'fill cost scales with the pixels drawn — a resized window or another devicePixelRatio moves every GPU-bound frame' },
  { key: 'headless', label: 'headless', material: true, get: (c) => (typeof c.headless === 'boolean' ? c.headless : undefined),
    why: 'a headless browser presents nothing and paces frames itself' },
  { key: 'samplerUs', label: 'sampler interval', material: true, unit: ' µs', get: (c) => num(c.sampler?.intervalUs),
    why: 'the sampling profiler\'s own cost scales with its rate' },
  { key: 'drive', label: 'drive script', material: true, get: (c) => (c.instrument || c.drive ? str(c.drive?.hash) ?? str(c.drive) ?? 'none' : undefined),
    why: 'a drive script decides what the run does; two scripts are two workloads' },
  { key: 'soak', label: 'soak instruments', material: true, get: (c) => (c.instrument ? [c.soak?.forcedGc ? 'forced GC each minute' : '', c.soak?.heapSnapshots ? 'heap snapshots' : ''].filter(Boolean).join(' + ') || 'none' : undefined),
    why: 'a forced collection every minute and a heap snapshot each pause the page' },
  { key: 'counterClock', label: 'counter denominator', material: true, get: (c) => str(c.counters?.denominator),
    why: 'a rate over wall time and a rate over the game\'s clock are different quantities — a faster build covers more game time per wall second' },
  { key: 'phases', label: 'phases', material: true, phased: true, get: (c) => (Array.isArray(c.phases) && c.phases.length ? [...c.phases].sort().join(',') : undefined),
    why: 'two phase mixes are two workloads — name one with --phase' },
  { key: 'browser', label: 'browser', material: false, get: (c) => str(c.browser) },
  { key: 'minHitchMs', label: 'hitch floor', material: false, unit: ' ms', get: (c) => num(c.recorder?.minHitchMs),
    why: 'it changes which frames count as hitches' },
  { key: 'slots', label: 'instance-slot watch', material: false, get: (c) => (typeof c.recorder?.slots === 'boolean' ? c.recorder.slots : undefined) },
];

/** An ANGLE string carries driver build numbers that change on update. */
function normGpu(s) {
  return String(s).replace(/\(0x[0-9a-f]+\)/gi, '').replace(/[\d.]{6,}/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pixelsOf(c) {
  const vw = num(c.device?.vw), vh = num(c.device?.vh);
  if (!vw || !vh) return undefined;
  const dpr = num(c.device?.dpr) ?? 1;
  return { px: Math.round(vw * dpr) * Math.round(vh * dpr), text: `${vw}×${vh}@${dpr}` };
}

/** A field's value as a person reads it. */
export function showValue(f, v) {
  if (v === undefined) return 'unrecorded';
  if (f.show) return f.show(v);
  return `${v}${typeof v === 'number' && f.unit ? f.unit : ''}`;
}

const same = (f, a, b) => (f.eq ? f.eq(a, b) : a === b);

/**
 * One run's conditions: what its ledger lines imply (tier → instrument, a
 * tier-1 profile's regime, the phases its records carry), overlaid by the run
 * file's block, overlaid by the session's last `conditions` line. `records`
 * are that run's lines; `run` its runs/<session>.json, if any.
 */
export function runConditions(records = [], run = null) {
  const c = {};
  if (run || records.some((r) => r?.tier === 0)) c.instrument = 'attach';
  else if (records.some((r) => r?.type === 'heartbeat' || r?.type === 'profile')) c.instrument = 'in-app';
  const regime = [...records].reverse().find((r) => r?.regime === 'hardware' || r?.regime === 'software')?.regime;
  if (regime) c.regime = regime;
  const phases = new Set();
  for (const r of records) if (typeof r?.phase === 'string' && r.phase && r.type !== 'conditions') phases.add(r.phase);
  for (const k of Object.keys(run?.phases ?? {})) if (k !== '?') phases.add(k);
  // A tier-1 host's counters say their denominator by carrying a clock or not.
  const counted = records.filter((r) => r?.type === 'profile' && r.tally);
  if (counted.length) c.counters = { denominator: counted.some((r) => r.clock?.name) ? `clock:${counted.find((r) => r.clock?.name).clock.name}` : 'wall' };
  Object.assign(c, run?.conditions ?? {});
  const line = [...records].reverse().find((r) => r?.type === 'conditions' && r.conditions && typeof r.conditions === 'object');
  if (line) Object.assign(c, line.conditions);
  // The phases a run CARRIED, whatever the block said when it was written.
  for (const p of c.phases ?? []) if (p !== '?') phases.add(p);
  if (phases.size) c.phases = [...phases].sort(); else delete c.phases;
  return c;
}

/**
 * Two sides, each a list of runs' conditions. A side whose runs disagree is
 * a mismatch of its own (`side`), as is a field the two sides disagree on.
 * A field one side never recorded is `unverified`. `phased` fields are
 * skipped when the caller already scoped both sides to the same phases.
 * @returns {{comparable:boolean, mismatches:object[], unverified:object[]}}
 */
export function compareConditions(aList, bList, { phaseScoped = false, labels = ['A', 'B'] } = {}) {
  const mismatches = [], unverified = [];
  for (const f of CONDITION_FIELDS) {
    if (f.phased && phaseScoped) continue;
    const sides = [aList, bList].map((list) => {
      const vals = list.map((c) => f.get(c ?? {}));
      const known = vals.filter((v) => v !== undefined);
      const distinct = [];
      for (const v of known) if (!distinct.some((d) => same(f, d, v))) distinct.push(v);
      return { distinct, missing: vals.length - known.length, n: vals.length };
    });
    sides.forEach((s, i) => {
      if (s.distinct.length > 1) mismatches.push({ key: f.key, label: f.label, material: f.material, side: labels[i], values: s.distinct.map((v) => showValue(f, v)), ...(f.why ? { why: f.why } : {}) });
    });
    const [a, b] = sides;
    if (a.distinct.length === 1 && b.distinct.length === 1 && !same(f, a.distinct[0], b.distinct[0])) {
      mismatches.push({ key: f.key, label: f.label, material: f.material, a: showValue(f, a.distinct[0]), b: showValue(f, b.distinct[0]), ...(f.why ? { why: f.why } : {}) });
    }
    if ((a.distinct.length || b.distinct.length) && (a.missing || b.missing) && f.material) {
      unverified.push({ key: f.key, label: f.label, missing: sides.map((s, i) => (s.missing ? labels[i] : null)).filter(Boolean) });
    }
  }
  return { comparable: !mismatches.some((m) => m.material), mismatches, unverified };
}

/**
 * One set of runs that should be one measurement (a build's runs): the
 * material fields its runs disagree on.
 * @returns {{comparable:boolean, mismatches:object[], unverified:object[]}}
 */
export function mixedConditions(list, { label = 'runs', phaseScoped = false } = {}) {
  const r = compareConditions(list, [], { phaseScoped, labels: [label, '-'] });
  const mismatches = r.mismatches.filter((m) => m.side === label && m.material);
  return { comparable: mismatches.length === 0, mismatches, unverified: [] };
}

/**
 * A run's conditions against what a budgets file says it was set for
 * (`perf.conditions` in budgets.json: `{ "refreshHz": 60, "regime":
 * "hardware" }`, keyed by CONDITION_FIELDS key). An expected field the run
 * never recorded is unverified, not a pass.
 */
export function expectConditions(c, expected = {}) {
  const mismatches = [], unverified = [];
  for (const [key, want] of Object.entries(expected ?? {})) {
    const f = CONDITION_FIELDS.find((x) => x.key === key);
    if (!f) { mismatches.push({ key, label: key, material: true, a: 'unknown condition', b: String(want), why: `not a condition this tool records — known: ${CONDITION_FIELDS.map((x) => x.key).join(', ')}` }); continue; }
    const got = f.get(c ?? {});
    if (got === undefined) { unverified.push({ key, label: f.label, missing: ['run'] }); continue; }
    const wantV = key === 'pixels' && typeof want === 'string' ? pixelsOf({ device: parseViewport(want) }) : want;
    if (wantV === undefined || !same(f, got, wantV)) mismatches.push({ key, label: f.label, material: true, a: showValue(f, got), b: String(want), ...(f.why ? { why: f.why } : {}) });
  }
  return { comparable: mismatches.length === 0, mismatches, unverified };
}

function parseViewport(s) {
  const m = /^(\d+)\s*[x×]\s*(\d+)(?:@([\d.]+))?$/.exec(String(s).trim());
  return m ? { vw: +m[1], vh: +m[2], dpr: m[3] ? +m[3] : 1 } : {};
}

/** One line: "attach · timing · 60 Hz · hardware · ANGLE (…) · 1280×720@1". */
export function describeConditions(c = {}) {
  const parts = [];
  const pick = (key) => { const f = CONDITION_FIELDS.find((x) => x.key === key); const v = f.get(c); return v === undefined ? undefined : showValue(f, v); };
  for (const k of ['instrument', 'mode', 'refreshHz', 'regime', 'gpu', 'pixels', 'browser']) {
    const v = pick(k);
    if (v === undefined) continue;
    parts.push(k === 'refreshHz' && v === 'variable' ? 'variable refresh' : v);
  }
  if (c.headless === true) parts.push('headless');
  const d = pick('drive');
  if (d && d !== 'none') parts.push(`drive ${d}`);
  const soak = pick('soak');
  if (soak && soak !== 'none') parts.push(soak);
  return parts.join(' · ') || 'conditions unrecorded';
}

/** The lines a refusal (or an --allow-mismatch banner) prints. */
export function mismatchLines(cmp) {
  const out = [];
  for (const m of cmp.mismatches) {
    const what = m.side ? `${m.side} mixes ${m.values.join(' / ')}` : `${m.a} vs ${m.b}`;
    out.push(`${m.material ? '✗' : '·'} ${m.label}: ${what}${m.material && m.why ? ` — ${m.why}` : ''}`);
  }
  if (cmp.unverified.length) out.push(`? unverified (not recorded on ${[...new Set(cmp.unverified.flatMap((u) => u.missing))].join(', ')}): ${cmp.unverified.map((u) => u.label).join(', ')}`);
  return out;
}

/**
 * The vsync note: when the median interval spans more than one refresh
 * period, say what that means for any timing set beside it. A median is
 * usually a MIX of steps (34.7 ms on 60 Hz is 33.3s and 50s), so the note
 * names the steps rather than claiming one.
 */
export function vsyncNote(c, medianIntervalMs) {
  const hz = num(c?.display?.refreshHz);
  if (!hz || !(medianIntervalMs > 0)) return undefined;
  const p = 1000 / hz;
  if (medianIntervalMs < 1.5 * p) return undefined;
  const k = Math.max(2, Math.floor(medianIntervalMs / p + 0.08));
  const steps = [k - 1, k, k + 1].map((i) => +(i * p).toFixed(1)).join(', ');
  return `display ${hz} Hz: frames present on whole vsyncs (${steps} ms …), so a frame whose work took ${+((k - 1) * p + 1).toFixed(1)} ms still reads ${+(k * p).toFixed(1)} — the ${+medianIntervalMs.toFixed(1)} ms median interval is made of those steps. An in-app frame timer measures the work, not the interval: compare like with like.`;
}
