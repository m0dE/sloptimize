// ============================================================
// watch.mjs — the push channel (SPEC §8.1.1): perf.jsonl → agent wake events
// ============================================================
// The recorder is already the auto-detector; this is the other half of
// "auto identifies bottleneck, sends signal to claude code, I just play".
// A byte cursor over each watched ledger, polled on an interval, printing
// ONE line per record an agent should act on — and nothing else, because
// every line is a conversation message to whoever armed the watch
// (Claude Code's Monitor primitive, INTEGRATION.md §5).
//
// Wakes: any usermark · an auto hitch ≥ minHitchMs (default 100) · a
// gpu-settle that hit its cap without settling · a warm run whose worst
// batch ≥ minHitchMs (with its per-batch builds) · any gpu-stall
// record · the feed going quiet (> staleMin without a record) and coming
// back. Silent: heartbeats, arm-probes, sub-threshold hitches.
//
// Starts at EOF: the ledger's history is the report's business, not a wake
// storm at arm time. Cursor is in memory, per watcher — two sessions
// watching the same directory each see every record (USAGE.md "who gets
// told? all of them"); nothing on disk to race over.
import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = { minHitchMs: 100, staleMin: 45, now: () => Date.now() };

/** The line an agent is woken with for one record, or null when the record
 *  is not worth a wake. Pure; the classification vocabulary is the
 *  recorder's own, forwarded verbatim (SPEC §8.1.1: the schema is a PUSH
 *  CONTRACT, fields surface directly). */
export function wakeLine(rec, dir, opts = {}) {
  // A robot's session is not an incident: headless verifies and preview
  // health checks arm the recorder and post real-looking records, and a
  // 16-minute cadence of them woke the agent all day (2026-08-28). The
  // report still lists them; the wake channel is for a human's session.
  if (rec.automated === true) return null;
  const minHitchMs = opts.minHitchMs ?? DEFAULTS.minHitchMs;
  const where = `[${dir}]`;
  const ctx = [rec.phase && `phase=${rec.phase}`, rec.build && `build=${rec.build}`].filter(Boolean).join(' ');
  const cls = (c) => c?.[0] ? `${c[0].guess} (${c[0].evidence})` : 'unclassified';
  switch (rec.type) {
    case 'usermark': {
      const w = rec.worstFrames?.[0];
      return `sloptimize ★ usermark "${rec.note ?? 'Ctrl+F12'}" @ ${rec.at}: window ${rec.window?.frames}f median ${rec.window?.medianMs}ms; worst ${w?.frameMs}ms → ${cls(w?.classification)} ${ctx} ${where}`;
    }
    case 'hitch':
      if (!(rec.frameMs >= minHitchMs)) return null;
      return `sloptimize ⚡ hitch ${round(rec.frameMs)}ms (median ${rec.medianMs}ms, ${round(rec.insideRenderMs)}ms in render) @ ${rec.at} → ${cls(rec.classification)}${mints(rec)} ${ctx} ${where}`;
    case 'gpu-settle':
      // A settled wait is the verification channel (the freeze stayed behind
      // the cover) — the report's business. Only a cap hit is an incident.
      if (rec.settled) return null;
      return `sloptimize ⏳ gpu-settle ${rec.tag} ${rec.ms}ms NOT settled (cap hit) @ ${rec.at} ${ctx} ${where}`;
    case 'warm': {
      // A warm run whose worst batch crossed the hitch bar: the sweep IS the
      // freeze, and the per-batch builds say whether one build cost that or
      // the batcher packed many into one task.
      if (!(rec.worstBatchMs >= minHitchMs)) return null;
      // A warm in a hidden/unfocused tab is not an incident: no frame was
      // drawn around it, and its wall clock is the browser's throttling.
      if (rec.hidden === true) return null;
      const built = Array.isArray(rec.batchBuilt) && rec.batchBuilt.length ? ` builds/batch=[${rec.batchBuilt.join(',')}]` : '';
      return `sloptimize 🔥 warm ${rec.tag} (${rec.kind}, budget ${rec.budgetMs ?? 'atomic'}ms): ${rec.keys} key(s) in ${rec.batches} batch(es), worst ${round(rec.worstBatchMs)}ms${built}${rec.costliest ? ` — ${rec.costliest}` : ''} @ ${rec.at} ${ctx} ${where}`;
    }
    case 'gpu-stall':
      return `sloptimize ⏳ gpu-stall ${rec.queueDoneMs}ms @ ${rec.at} → ${cls(rec.classification)} ${ctx} ${where}`;
    default:
      return null;
  }
}

/** The mints a hitch carries, each with WHY it minted when the record says
 *  (`changed`: the cache-key parts that moved since that material's previous
 *  mint; `[]` = same key compiled again; absent = first mint). */
function mints(rec) {
  if (!Array.isArray(rec.mints) || rec.mints.length === 0) return '';
  const one = (m) => {
    const why = Array.isArray(m.changed) ? (m.changed.length ? ` changed:${m.changed.join(',')}` : ' re-minted:same-key') : '';
    return `${m.material}@${m.object}${why}`;
  };
  return ` mints=[${rec.mints.map(one).join('; ')}]`;
}

function round(n) { return typeof n === 'number' ? +n.toFixed(1) : n; }

/** One ledger's byte cursor. Reads only what was appended since last time,
 *  holds an unterminated tail until its newline lands (the sink appends a
 *  whole batch per post, but a poll can still land mid-write), and resets
 *  when the file shrinks (rotated or recreated). */
function ledgerCursor(path) {
  // Positioned at CREATION, not at the first poll: anything appended between
  // arming and the first tick is new and must wake. A ledger that does not
  // exist yet starts at 0 so its first record wakes too.
  let { size: offset, mtimeMs } = fileStat(path);
  let tail = '';
  return function readNew() {
    if (!existsSync(path)) { offset = 0; mtimeMs = 0; tail = ''; return []; }
    const fd = openSync(path, 'r');
    try {
      const st = fstatSync(fd);
      const size = st.size;
      // Shrunk: rotated or recreated. Same size but touched: rewritten — an
      // append always grows the file, so this can only be a rewrite (a
      // rotation that happened to land on the same byte count). Stated
      // limit: a same-size rewrite inside the same mtime tick as the last
      // read is invisible to stat — not a shape an append-only ledger has.
      if (size < offset || (size === offset && offset > 0 && st.mtimeMs !== mtimeMs)) { offset = 0; tail = ''; }
      mtimeMs = st.mtimeMs;
      if (size === offset) return [];
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      const chunk = tail + buf.toString('utf8', 0, n);
      const parts = chunk.split('\n');
      tail = parts.pop();
      return parts.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally { closeSync(fd); }
  };
}

/** A watcher over one or more `.sloptimize` directories. `poll()` returns
 *  the wake lines since the previous poll — the CLI prints them, a test
 *  asserts on them. */
export function createWatcher(dirs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ledgers = dirs.map((dir) => ({
    dir,
    read: ledgerCursor(join(dir, 'perf.jsonl')),
    lastAt: 0,          // ms of the newest record seen (any type)
    dark: false,
  }));
  // Seed liveness from what is already on disk so a ledger that died before
  // the watch was armed still reports quiet — once.
  for (const l of ledgers) l.lastAt = lastRecordTime(join(l.dir, 'perf.jsonl'));

  function poll() {
    const lines = [];
    for (const l of ledgers) {
      let recs;
      try { recs = l.read(); } catch { recs = []; }   // a transient read error is not a wake
      for (const r of recs) {
        const t = Date.parse(r.at);
        if (t > l.lastAt) l.lastAt = t;
        const w = wakeLine(r, l.dir, o);
        if (w) lines.push(w);
      }
      if (l.lastAt > 0) {
        const ageMin = (o.now() - l.lastAt) / 60_000;
        if (ageMin > o.staleMin && !l.dark) {
          l.dark = true;
          lines.push(`sloptimize ◌ feed quiet ${Math.round(ageMin)}min [${l.dir}] — session over, or the feed went dark (ingest disarmed?)`);
        } else if (ageMin <= o.staleMin && l.dark) {
          l.dark = false;
          lines.push(`sloptimize ◉ feed live again [${l.dir}]`);
        }
      }
    }
    return lines;
  }
  return { poll };
}

function fileStat(path) {
  if (!existsSync(path)) return { size: 0, mtimeMs: 0 };
  const fd = openSync(path, 'r');
  try { const st = fstatSync(fd); return { size: st.size, mtimeMs: st.mtimeMs }; } finally { closeSync(fd); }
}

/** Timestamp (ms) of the last parseable record in a ledger, 0 if none.
 *  Reads only the final few KB — the ledger can be megabytes. */
function lastRecordTime(path) {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const span = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(span);
    readSync(fd, buf, 0, span, size - span);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const t = Date.parse(JSON.parse(lines[i]).at); if (t > 0) return t; } catch { /* partial or foreign line */ }
    }
    return 0;
  } finally { closeSync(fd); }
}

/** The CLI loop: poll every `intervalMs`, print each wake line, never exit
 *  (Monitor semantics: exit ends the watch). Flushes per line — stdout is
 *  the event stream. */
export async function runWatch(dirs, opts = {}) {
  const intervalMs = opts.intervalMs ?? 20_000;
  const w = createWatcher(dirs, opts);
  process.stdout.write(`sloptimize watch armed: ${dirs.join(', ')} (every ${Math.round(intervalMs / 1000)}s; hitches ≥${opts.minHitchMs ?? DEFAULTS.minHitchMs}ms, every usermark)\n`);
  for (;;) {
    for (const line of w.poll()) process.stdout.write(line + '\n');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
