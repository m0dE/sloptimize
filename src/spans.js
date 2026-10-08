// ============================================================
// spans.js — a phase as a measured span: how long, how big, where (SPEC §3.15)
// ============================================================
// A phase used to be a label on records. A one-off phase — a load, a level
// transition, a shader warmup — has a figure of its own that no frame metric
// carries: how long it took. And that figure alone is meaningless across
// inputs: a 1469-road city loading in 9 s and a 286-road one in 1.1 s are
// both healthy, and "load: 9 s" says neither. So the page records a phase as
// a SPAN (inject-body.js times `window.__sloptimizePhase` assignments), and
// the host may hang two things on the span it is in:
//   · a scale — `__sloptimizeScale('roads', 1469)`: the size of what the
//     phase worked on, so a report reads `load 6.1 ms/road` and two
//     different saves compare per unit instead of not at all;
//   · sections with call counts — `__sloptimizeSection('createSidewalks',
//     ms, calls)`: the game's own named work, so a compare can say WHICH of
//     the two moved — the call count (something started calling it more) or
//     the time per call (something inside it got slower). Identical ms can
//     hide either, and they have different fixes.
// A span closes when the phase changes (`phase-span`, `ms` exact). The one
// still running is snapshotted (`open: true`, `ms` so far — a lower bound,
// never read as the phase's duration) so its sections survive a detach.
//
// Pure: records in, tables out.

const r2 = (x) => +x.toFixed(2);

/** Per-call and call-count factors within this of 1× read as unchanged. */
export const SAME_WITHIN = 0.1;

/**
 * The run's spans, one per (session, span id) — the newest record of each
 * wins (a closed span supersedes its open snapshots).
 * @returns {{session?:string, span:string, phase?:string, ms:number, open:boolean, scale?:Record<string,number>, sections?:Record<string,[number,number]>, at:string}[]}
 */
export function phaseSpans(records) {
  const by = new Map();
  for (const r of records ?? []) {
    if (r?.type !== 'phase-span' || typeof r.span !== 'string' || typeof r.ms !== 'number') continue;
    const k = `${r.session ?? ''}\t${r.span}`;
    const prev = by.get(k);
    // A closed span is final; an open snapshot never replaces it.
    if (prev && !prev.open && r.open) continue;
    by.set(k, { session: r.session, span: r.span, phase: r.phase, ms: r.ms, ...(typeof r.frames === 'number' ? { frames: r.frames } : {}), open: r.open === true, scale: r.scale, sections: r.sections, at: r.at });
  }
  return [...by.values()];
}

/**
 * Spans folded per phase. Durations come from CLOSED spans only; a phase
 * that ran twice in one run (a reload, a second level) reads as the mean
 * span, with `spans` saying how many. Per unit is total ms over total units
 * across the closed spans that declared that unit. Sections sum over every
 * span (open included) and read per span the same way.
 * @returns {Map<string, {spans:number, open:number, ms?:number, scale:Record<string,number>, perUnit:Record<string,number>, sections:Map<string,{ms:number, calls:number, perCall?:number}>}>}
 */
export function spanTable(spans) {
  const acc = new Map();
  for (const s of spans) {
    const k = typeof s.phase === 'string' && s.phase ? s.phase : '?';
    const a = acc.get(k) ?? acc.set(k, { closed: [], open: 0, units: new Map(), secs: new Map(), withSecs: 0 }).get(k);
    if (s.open) a.open++; else a.closed.push(s);
    if (s.sections && typeof s.sections === 'object') {
      let any = false;
      for (const [name, v] of Object.entries(s.sections)) {
        if (!Array.isArray(v) || typeof v[0] !== 'number') continue;
        const e = a.secs.get(name) ?? a.secs.set(name, { ms: 0, calls: 0 }).get(name);
        e.ms += v[0]; e.calls += typeof v[1] === 'number' ? v[1] : 0;
        any = true;
      }
      if (any) a.withSecs++;
    }
  }
  const out = new Map();
  for (const [k, a] of acc) {
    const row = { spans: a.closed.length, open: a.open, scale: {}, perUnit: {}, sections: new Map() };
    if (a.closed.length) row.ms = r2(a.closed.reduce((n, s) => n + s.ms, 0) / a.closed.length);
    // The phase's mean frame: its time over the frames drawn in it.
    const framed = a.closed.filter((s) => s.frames > 0);
    if (framed.length) { row.frames = framed.reduce((n, s) => n + s.frames, 0); row.frameMs = r2(framed.reduce((n, s) => n + s.ms, 0) / row.frames); }
    const units = new Map();
    for (const s of a.closed) for (const [u, n] of Object.entries(s.scale ?? {})) {
      if (!(typeof n === 'number' && n > 0)) continue;
      const e = units.get(u) ?? units.set(u, { n: 0, ms: 0, spans: 0 }).get(u);
      e.n += n; e.ms += s.ms; e.spans++;
    }
    // A scale declared on a span that never closed still says the phase's size.
    for (const s of spans) if (s.open && (s.phase ?? '?') === k) for (const [u, n] of Object.entries(s.scale ?? {})) if (typeof n === 'number' && n > 0 && !units.has(u)) row.scale[u] = n;
    for (const [u, e] of units) { row.scale[u] = r2(e.n / e.spans); row.perUnit[u] = +(e.ms / e.n).toPrecision(4); }
    const per = Math.max(a.withSecs, 1);
    for (const [name, e] of a.secs) {
      row.sections.set(name, { ms: r2(e.ms / per), calls: r2(e.calls / per), ...(e.calls > 0 ? { perCall: +(e.ms / e.calls).toPrecision(4) } : {}) });
    }
    out.set(k, row);
  }
  return out;
}

/** "road" for "roads": the unit as one of it (a plain English plural only). */
export function oneOf(unit) {
  const u = String(unit);
  if (/ies$/.test(u) && u.length > 4) return u.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(u)) return u;
  return /s$/.test(u) && u.length > 2 ? u.slice(0, -1) : u;
}

const fmtX = (f) => (f >= 10 ? `${Math.round(f)}x` : `${+f.toFixed(1)}x`);

/**
 * Which of the two factors moved: the call count or the time per call. The
 * diagnosis half of a section compare — "it got called more" and "it got
 * slower" have different fixes, and the total alone cannot tell them apart.
 * `a`/`b` are `{ms, calls}` (medians of each side's runs).
 * @returns {{moved:'none'|'per-call'|'calls'|'both', text:string}}
 */
export function sectionVerdict(a, b, within = SAME_WITHIN) {
  if (!(a?.calls > 0) || !(b?.calls > 0)) return { moved: 'unknown', text: 'no call count on a side — __sloptimizeSection(name, ms, calls) splits the time into calls × ms/call' };
  if (!(a.ms > 0) || !(b.ms > 0)) return { moved: 'unknown', text: `${a.ms > 0 ? 'B' : 'A'} measured no time in it — no ms/call to compare` };
  const calls = b.calls / a.calls;
  const perCall = (b.ms / b.calls) / (a.ms / a.calls);
  const same = (f) => Number.isFinite(f) && Math.abs(f - 1) <= within;
  const dir = (f) => (f >= 1 ? fmtX(f) : `${fmtX(1 / f)} less`);
  if (same(calls) && same(perCall)) return { moved: 'none', text: 'same call count, same ms/call' };
  if (same(calls)) return { moved: 'per-call', text: `same call count, ${dir(perCall)} ms/call → the work PER CALL changed (look inside it)` };
  if (same(perCall)) return { moved: 'calls', text: `same ms/call, ${dir(calls)} calls → it is CALLED ${calls >= 1 ? 'more' : 'less'} (look at its callers)` };
  return { moved: 'both', text: `${dir(calls)} calls and ${dir(perCall)} ms/call — both changed` };
}
