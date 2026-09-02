// ============================================================
// errors.js — the browser's errors as incidents (SPEC cloud §8.1)
// ============================================================
// An uncaught error is a bottleneck of a different kind: the frame it killed
// never rendered. It is recorded with the same identity model as a hitch —
// the footprint names the cause (class, normalized message, top frame),
// never the occurrence — so a thousand players hitting one bug is one row.
// The monitor NEVER preventDefault()s: the console and the host's own
// handlers see exactly what they saw before.
import { footprintOf } from './footprint.js';

export function createErrorMonitor(recorder, opts = {}) {
  const target = opts.target ?? globalThis;
  const dedupeMs = opts.dedupeMs ?? 10000;
  const maxFrames = opts.maxFrames ?? 10;
  const now = opts.now ?? (() => Date.now());
  const lastByFp = new Map();
  const stats = { seen: 0, emitted: 0, deduped: 0 };

  // V8 frames start with "at "; SpiderMonkey/JavaScriptCore frames are
  // "fn@url:line:col" (or "@url:line:col" when anonymous). Keeping only the
  // V8 shape gave every Firefox and Safari player an empty stack — and a
  // second catalogue row for the same bug.
  const FRAME_RE = /^at |^[^\s]*@.+:\d+/;
  function frames(stack) {
    return String(stack ?? '').split('\n').map((l) => l.trim()).filter((l) => FRAME_RE.test(l)).slice(0, maxFrames);
  }

  /** A rejection reason that is not an Error, said as plainly as it can be
   *  said. JSON.stringify throws on a circular object (and on a throwing
   *  toJSON); an uncaught throw here would lose the incident entirely. */
  function reasonMessage(r) {
    if (typeof r === 'string') return r;
    try { const j = JSON.stringify(r ?? null); if (j !== undefined) return j; } catch { /* circular / throwing toJSON */ }
    try { return String(r); } catch { return '[unstringifiable]'; }
  }
  function toRecord(name, message, stack) {
    return { type: 'error', at: new Date().toISOString(), source: 'client', name, message: String(message ?? ''), stack: frames(stack) };
  }
  function handle(rec) {
    stats.seen++;
    const fp = footprintOf(rec);
    const t = now();
    const last = fp ? lastByFp.get(fp.id) : undefined;
    if (last !== undefined && t - last < dedupeMs) { stats.deduped++; return; }
    if (fp) lastByFp.set(fp.id, t);
    if (recorder.emit(rec)) stats.emitted++;
  }
  const onError = (ev) => {
    try {
      const e = ev?.error;
      handle(e instanceof Error ? toRecord(e.name || 'Error', e.message, e.stack) : toRecord('Error', ev?.message ?? String(e ?? ''), ''));
    } catch { /* never throw into the host */ }
  };
  const onRejection = (ev) => {
    try {
      const r = ev?.reason;
      handle(r instanceof Error ? toRecord(r.name || 'Error', r.message, r.stack) : toRecord('UnhandledRejection', reasonMessage(r), ''));
    } catch { /* never throw into the host */ }
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return {
    dispose() { target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection); },
    stats() { return { ...stats }; },
  };
}
