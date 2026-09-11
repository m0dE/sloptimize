// ============================================================
// ask.js — the agent asks the running tab (SPEC §3.9)
// ============================================================
//
// Files-first, like everything else here. A request is one line appended to
// `.sloptimize/ask.jsonl`; the host's dev ingest hands pending requests back
// to the tab on its next rolling-state post (every ~2 s), the tab does the
// work and posts an `answer` record into perf.jsonl; the CLI waits for the
// answer by id. No new socket, no new endpoint on the tab, and a request
// can be written by anything that can write a file.
// PURE — this module rides the host's browser bundle (`pendingAsks` is what
// the host's ingest calls); the file and clock halves live in ask-files.js.

/** The closed set of things a tab can be asked (SPEC §3.9). `eval` is the
 *  code-delivery lane and exists only behind the host's dev switch. */
export const ASK_KINDS = ['profile', 'capture', 'cpuprofile', 'eval'];

export function makeAsk(kind, arg, id = randomId()) {
  if (!ASK_KINDS.includes(kind)) throw new Error(`ask kind must be one of ${ASK_KINDS.join('|')}`);
  const ask = { id, kind, at: new Date().toISOString() };
  if (arg !== undefined && arg !== '') ask.arg = arg;
  return ask;
}

/** Eight hex digits, from whatever randomness the platform has. */
export function randomId() {
  const g = globalThis.crypto;
  if (g?.getRandomValues) { const b = new Uint8Array(4); g.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

/** Requests in `ask.jsonl` not yet answered in `perf.jsonl` and younger than
 *  `maxAgeMs` — what the ingest hands the tab. Pure over the two texts. */
export function pendingAsks(askText, ledgerTail, now = Date.now(), maxAgeMs = 120_000) {
  const answered = new Set();
  for (const line of ledgerTail.split('\n')) {
    if (!line.includes('"answer"')) continue;
    try { const r = JSON.parse(line); if (r.type === 'answer' && r.id) answered.add(r.id); } catch { /* partial line */ }
  }
  const out = [];
  for (const line of askText.split('\n')) {
    if (!line) continue;
    let a; try { a = JSON.parse(line); } catch { continue; }
    if (!a?.id || answered.has(a.id)) continue;
    const t = Date.parse(a.at);
    if (Number.isFinite(t) && now - t > maxAgeMs) continue;
    out.push(a);
  }
  return out;
}

