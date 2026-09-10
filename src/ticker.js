// ticker.js — the incident ticker (SPEC §3.10): every record the recorder
// mints is a line bottom-left the moment it is minted, so a hitch, a jump, an
// error or a GPU stall is SEEN at the moment it is felt, not found in a
// ledger later. The line is the record's own verdict — the classifier's guess
// and evidence for a hitch, the track and distance for a jump — never a
// second judgement. Pure description (`describeRecord`) is separate from the
// DOM so a host can put the same line anywhere (a console, an overlay of its
// own) and so it is testable without a document.
//
// The ticker is a sink, not a detector: it has no thresholds of its own. What
// counts as a hitch, a jump or a stall was decided by the recorder, the
// motion monitor and the host with the ring in front of them; the ticker
// would only be guessing with less.

const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const C = {
  bg: 'rgba(8,12,20,0.88)', ink: '#cfe6f5', mute: '#6f9db0', warn: '#ffb454', bad: '#ff6b6b', accent: '#3ce0ff', good: '#5fd68b',
};
/** Records that are bookkeeping, not incidents — never a line. */
const QUIET = new Set(['profile', 'heartbeat', 'arm-probe', 'armed', 'warm', 'answer', 'fix', 'census']);

const ms = (n) => (typeof n === 'number' ? `${n.toFixed(n >= 100 ? 0 : 1)}ms` : '');
const first = (rec) => (Array.isArray(rec.classification) ? rec.classification[0] : undefined);

/**
 * One record → one line, or null for a record that is not an incident.
 * `{ glyph, head, detail, tone }`: the head is what happened in the record's
 * own units; the detail is the verdict that came with it.
 */
export function describeRecord(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string' || QUIET.has(rec.type)) return null;
  const c = first(rec);
  switch (rec.type) {
    case 'hitch':
      return { glyph: '▲', tone: rec.frameMs >= 100 ? 'bad' : 'warn', head: `hitch ${ms(rec.frameMs)}`,
        detail: c ? `${c.guess}${c.evidence ? ` — ${c.evidence}` : ''}` : '' };
    case 'jitter': {
      const head = rec.kind === 'oscillation'
        ? `${rec.track} oscillates ×${rec.frames} ±${rec.amplitude}`
        : `${rec.track} jumps ${rec.units}`;
      return { glyph: '↯', tone: 'warn', head, detail: c ? `${c.guess}${c.evidence ? ` — ${c.evidence}` : ''}` : '' };
    }
    case 'usermark':
      return { glyph: '✎', tone: 'accent', head: 'keyframe', detail: rec.note ? String(rec.note) : `worst ${ms(rec.worstFrames?.[0]?.frameMs)}` };
    case 'error':
      return { glyph: '✕', tone: 'bad', head: `${rec.name ?? 'error'}`, detail: String(rec.message ?? '') };
    case 'gpu-stall':
      return { glyph: '◆', tone: 'bad', head: `gpu stall ${ms(rec.queueDoneMs)}`, detail: rec.reason ? String(rec.reason) : '' };
    case 'gpu-queue-lag':
      return { glyph: '◆', tone: 'warn', head: `gpu queue ${ms(rec.ms)} behind`, detail: '' };
    case 'gpu-create':
      return { glyph: '◆', tone: 'warn', head: `${rec.fn} ${ms(rec.ms)}`, detail: rec.label ? String(rec.label) : '' };
    case 'gpu-settle':
      return rec.settled ? null : { glyph: '◆', tone: 'warn', head: `gpu ${rec.tag} not settled after ${ms(rec.ms)}`, detail: '' };
    default:
      // A host-defined record: its type, and any duration it carries.
      return { glyph: '•', tone: 'mute', head: `${rec.type}${typeof rec.ms === 'number' ? ` ${ms(rec.ms)}` : ''}`, detail: rec.note ? String(rec.note) : '' };
  }
}

/** The line as one string — for a console, a log, a test. */
export function lineOf(rec) {
  const d = describeRecord(rec);
  return d ? `${d.glyph} ${d.head}${d.detail ? ` · ${d.detail}` : ''}` : null;
}

/**
 * The DOM ticker. `push(records)` shows one line per incident record for
 * `ttlMs`, newest at the bottom, at most `max` at once (older lines leave
 * early). `opts.corner` is `bottom-left` (default) or `bottom-right`;
 * `opts.offsetPx` lifts it above whatever the host already keeps in that
 * corner. `opts.describe` replaces the default description; returning null
 * drops the record. Without a document every call is a no-op.
 */
export function createTicker(opts = {}) {
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  const ttlMs = opts.ttlMs ?? 7000;
  const max = opts.max ?? 4;
  const describe = opts.describe ?? describeRecord;
  const setTimer = opts.setTimeout ?? ((fn, t) => setTimeout(fn, t));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h));
  let root = null;
  const live = [];   // { el, timer }

  function mount() {
    if (root || !doc) return;
    const side = opts.corner === 'bottom-right' ? 'right' : 'left';
    root = doc.createElement('div');
    root.setAttribute('data-sloptimize', 'ticker');
    root.style.cssText = `position:fixed;${side}:10px;bottom:${(opts.offsetPx ?? 0) + 10}px;z-index:99997;display:flex;flex-direction:column;gap:4px;`
      + `pointer-events:none;max-width:min(60vw,640px);font:11px ${FONT};`;
    doc.body.appendChild(root);
  }
  function drop(entry) {
    const i = live.indexOf(entry);
    if (i < 0) return;
    live.splice(i, 1);
    clearTimer(entry.timer);
    entry.el.remove();
  }
  function show(d) {
    mount();
    if (!root) return;
    const el = doc.createElement('div');
    const color = C[d.tone] ?? C.ink;
    el.style.cssText = `background:${C.bg};color:${C.ink};border-left:2px solid ${color};padding:4px 8px;border-radius:3px;`
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const glyph = doc.createElement('span');
    glyph.style.cssText = `color:${color};margin-right:6px`;
    glyph.textContent = d.glyph;
    const head = doc.createElement('span');
    head.textContent = d.head;
    el.append(glyph, head);
    if (d.detail) {
      const detail = doc.createElement('span');
      detail.style.cssText = `color:${C.mute};margin-left:8px`;
      detail.textContent = d.detail;
      el.append(detail);
    }
    root.appendChild(el);
    const entry = { el, timer: null };
    entry.timer = setTimer(() => drop(entry), ttlMs);
    live.push(entry);
    while (live.length > max) drop(live[0]);
  }
  return {
    push(records) {
      if (!doc || !Array.isArray(records)) return 0;
      let shown = 0;
      for (const rec of records) {
        const d = describe(rec);
        if (d) { show(d); shown++; }
      }
      return shown;
    },
    /** Lines on screen now. */
    size: () => live.length,
    dispose() {
      while (live.length) drop(live[0]);
      root?.remove(); root = null;
    },
  };
}
