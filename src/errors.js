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

  function frames(stack) {
    return String(stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, maxFrames);
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
      handle(r instanceof Error ? toRecord(r.name || 'Error', r.message, r.stack) : toRecord('UnhandledRejection', typeof r === 'string' ? r : JSON.stringify(r ?? null), ''));
    } catch { /* never throw into the host */ }
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return {
    dispose() { target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection); },
    stats() { return { ...stats }; },
  };
}
