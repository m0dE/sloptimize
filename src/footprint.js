// ============================================================
// footprint.js — the identity of a bottleneck, apart from its occurrence (SPEC §3.7)
// ============================================================
// A ledger line says WHEN something happened and how bad it was. Two lines a
// day apart, on two builds, on two players' machines, are very often the SAME
// thing happening again — and a catalogue that cannot say so is a log, not a
// catalogue. The footprint is the part of a record that names the CAUSE:
// the kind of incident, the phase it lives in, the closed-vocabulary verdict,
// and whatever the record carries that identifies the site (the materials a
// hitch minted, the track and axis a jitter moved on, the tag a warm ran).
// Never the parts that name the OCCURRENCE: the timestamp, the frame number,
// the exact milliseconds or metres, the build, the machine.
//
// Same cause on a new build → same footprint: that is what lets "how often has
// this happened" and "which fixes were applied to it" be answered by a fold
// over the ledger, and what a service aggregating many clients dedupes on.
//
// THE GAME'S OWN STATE IS PART OF THE CAUSE. A hitch while flying a heavy hull
// with a copilot aboard in a firefight is not the same issue as the same hitch
// on foot in an empty lobby, and no profiler can know which facets matter for
// a given game. So the host declares them: `context()` returns a few
// LOW-CARDINALITY facets (`{ stance: 'helm', hull: 'walker', crew: 'copilot',
// combat: 'yes' }` — categories, never positions or counters), the runtime
// canonicalises them (`canonicalContext`) and stamps the string on every
// record as `ctx`, and the key hashes it. Any game feeding sloptimize gets the
// same catalogue shape from its own facets.
//
// Time is deliberately NOT a facet: when an issue happened is the occurrence
// (`at`, and the catalogue's first/last); the footprint is what was going on.
// The key is kept readable beside the id so a human — or a service re-deriving
// ids after a vocabulary change — can see what was hashed. `v` versions the
// derivation: a change to what goes into a key is a new version, never a
// silent re-shuffle of old ids.
//
// Pure, dependency-free, browser and node: the same bytes hash to the same id
// wherever the record is read.

export const FOOTPRINT_VERSION = 1;

/** FNV-1a, 32-bit, as 8 hex characters. Not cryptographic and not meant to be
 *  — a dedupe key over a few thousand distinct causes, stable across runtimes
 *  without a crypto dependency. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The host's situation facets as ONE canonical string: keys sorted, `k=v`
 * pairs joined by ',', separators scrubbed from values. Cheap enough to
 * refresh once a second and hand to the recorder per frame as a string —
 * nothing allocates on the frame path.
 */
export function canonicalContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const scrub = (v) => String(v).replace(/[|,=\s]+/g, '_').slice(0, 40);
  return Object.keys(ctx).filter((k) => ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '').sort()
    .map((k) => `${scrub(k)}=${scrub(ctx[k])}`).join(',');
}

/** The trailing context segment of a key, as facets — `{}` when none. */
export function contextOfKey(key) {
  const seg = String(key ?? '').split('|').find((p) => p.startsWith('ctx:'));
  if (!seg) return {};
  const out = {};
  for (const pair of seg.slice(4).split(',')) { const i = pair.indexOf('='); if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1); }
  return out;
}

/** Scrub an error message down to its shape: quoted strings, hex ids and
 *  numbers collapse to placeholders, whitespace and `|` (the key separator)
 *  are normalized, and the result is capped so a huge message never bloats a
 *  key. Two errors that differ only by which mesh id or how many ms are the
 *  SAME cause once normalized. */
export function normalizeErrorMessage(msg) {
  return String(msg ?? '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '"…"')
    .replace(/0x[0-9a-f]{6,}/gi, '#')
    .replace(/\b[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '¦')
    .trim()
    .slice(0, 120);
}

/** `<path>#<function>` of the top stack frame, without origin, query, hash,
 *  line or column — the site an error is thrown from, apart from which build
 *  served it or which line the minifier put it on. */
export function topFrameSite(stack) {
  const lines = Array.isArray(stack) ? stack : String(stack ?? '').split('\n');
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line.startsWith('at ')) continue;
    // "at fn (loc)" | "at loc"
    const m = /^at (?:(.+?) \()?(.+?)\)?$/.exec(line);
    if (!m) continue;
    const fn = m[1] && !/^(async |new )/.test(m[1]) ? m[1] : (m[1] ? m[1].replace(/^(async |new )+/, '') : 'anonymous');
    let loc = m[2];
    loc = loc.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
    try { const u = new URL(loc); loc = u.pathname; } catch { /* not a URL: a path */ }
    loc = loc.replace(/[?#].*$/, '');
    return `${loc}#${fn || 'anonymous'}`;
  }
  return 'unknown';
}

/** The site a server incident's top self-time frame names — `unattributed`
 *  when attribution was turned off or the server sent no frames at all. */
function serverSite(rec) {
  const f = Array.isArray(rec.frames) ? rec.frames[0] : undefined;
  if (rec.attribution === 'off' || !f) return 'unattributed';
  return `${f.file ?? '?'}#${f.fn ?? 'anonymous'}`;
}

/** The verdict a record leads with, or 'unclassified'. */
function topGuess(rec) {
  return rec.classification?.[0]?.guess ?? 'unclassified';
}

/** The materials a hitch minted, as a sorted, deduped site list — `a@b` pairs
 *  (material@object), the same identity the wake line prints. */
function mintSite(rec) {
  if (!Array.isArray(rec.mints) || rec.mints.length === 0) return '';
  const ids = [...new Set(rec.mints.map((m) => `${m.material ?? '?'}@${m.object ?? '?'}`))].sort();
  return ids.join(',');
}

/** Which way a jitter moved: vertical (a step, a ground clamp, a fall) or
 *  horizontal (a correction, a teleport across the ground). x vs z would only
 *  say which way the pilot happened to be facing. */
function jumpAxis(rec) {
  const j = Array.isArray(rec.jump) ? rec.jump : null;
  if (!j || j.length < 3) return 'unknown';
  const [x, y, z] = j.map((n) => Math.abs(Number(n) || 0));
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag === 0) return 'unknown';
  return y >= 0.7 * mag ? 'vertical' : 'horizontal';
}

/**
 * The readable key of a record's footprint, or null for records that are not
 * incidents (heartbeats, arm probes, a settle that settled).
 */
export function footprintKey(rec) {
  const base = baseKey(rec);
  if (base === null) return null;
  // The host's situation, when the record carries one (see the header).
  const ctx = typeof rec.ctx === 'string' && rec.ctx ? rec.ctx : (rec.ctx && typeof rec.ctx === 'object' ? canonicalContext(rec.ctx) : '');
  return ctx ? `${base}|ctx:${ctx}` : base;
}

function baseKey(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const phase = rec.phase ?? '?';
  switch (rec.type) {
    case 'hitch': {
      const site = mintSite(rec);
      return `hitch|${phase}|${topGuess(rec)}${site ? `|${site}` : ''}`;
    }
    case 'usermark': {
      // The human's press is a timestamp; the cause is what the worst frame
      // under it was doing. A "nominal" window (nothing under the bar) is its
      // own bucket: the operator felt something the counters did not see.
      const w = rec.worstFrames?.[0];
      return `usermark|${phase}|${w?.classification?.[0]?.guess ?? 'unclassified'}`;
    }
    case 'jitter':
      return `jitter|${rec.track ?? '?'}|${rec.kind ?? '?'}|${phase}|${topGuess(rec)}|${jumpAxis(rec)}`;
    case 'warm':
      return `warm|${rec.tag ?? '?'}|${rec.kind ?? '?'}|${phase}`;
    case 'gpu-stall':
      return `gpu-stall|${phase}`;
    case 'gpu-settle':
      // Only a cap hit is an incident; a settled wait is verification evidence.
      return rec.settled === false ? `gpu-settle|${rec.tag ?? '?'}` : null;
    case 'error':
      return `error|${rec.source ?? 'client'}|${rec.name ?? 'Error'}|${normalizeErrorMessage(rec.message)}|${topFrameSite(rec.stack)}`;
    case 'server-hitch':
      return `server-hitch|${phase}|${serverSite(rec)}`;
    case 'server-stall':
      return `server-stall|${phase}|${serverSite(rec)}`;
    default:
      return null;
  }
}

/** `{ v, id, key }` for an incident record, or null when it has none. A record
 *  that already carries a footprint of the current version keeps it — the
 *  writer's word stands, and the fold never re-hashes what was stamped. */
export function footprintOf(rec) {
  if (rec && rec.footprint && rec.footprint.v === FOOTPRINT_VERSION && typeof rec.footprint.id === 'string') return rec.footprint;
  const key = footprintKey(rec);
  if (key === null) return null;
  return { v: FOOTPRINT_VERSION, id: fnv1a32(`v${FOOTPRINT_VERSION}:${key}`), key };
}

/** The glyph and a short human label for a footprint key — what a row leads
 *  with in every reader (watch, report, the debugger's Issues tab). */
export function describeFootprint(key) {
  const parts = String(key ?? '').split('|').filter((p) => !p.startsWith('ctx:'));
  const ctx = contextOfKey(key);
  const d = describeBase(parts);
  return { ...d, ctx };
}

function describeBase(parts) {
  const [type] = parts;
  switch (type) {
    case 'hitch': return { glyph: '⚡', label: `hitch · ${parts[2] ?? '?'}${parts[3] ? ` · ${parts[3].split(',').length} mint site(s)` : ''}`, phase: parts[1] ?? '?' };
    case 'usermark': return { glyph: '★', label: `keyframe · ${parts[2] ?? '?'}`, phase: parts[1] ?? '?' };
    case 'jitter': return { glyph: '↯', label: `jitter · ${parts[1] ?? '?'} ${parts[2] ?? '?'} · ${parts[4] ?? '?'} · ${parts[5] ?? '?'}`, phase: parts[3] ?? '?' };
    case 'warm': return { glyph: '🔥', label: `warm · ${parts[1] ?? '?'} (${parts[2] ?? '?'})`, phase: parts[3] ?? '?' };
    case 'gpu-stall': return { glyph: '⏳', label: 'gpu-process stall', phase: parts[1] ?? '?' };
    case 'gpu-settle': return { glyph: '⏳', label: `gpu-settle cap hit · ${parts[1] ?? '?'}`, phase: '' };
    case 'error': return { glyph: '✖', label: `error · ${parts[2] ?? '?'} · ${(parts[3] ?? '').slice(0, 60)}`, phase: '' };
    case 'server-hitch': return { glyph: '▣', label: `server tick over budget · ${parts[2] ?? '?'}`, phase: parts[1] ?? '?' };
    case 'server-stall': return { glyph: '▦', label: `event-loop stall · ${parts[2] ?? '?'}`, phase: parts[1] ?? '?' };
    default: return { glyph: '·', label: String(key ?? ''), phase: '' };
  }
}
