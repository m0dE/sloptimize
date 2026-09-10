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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The closed set of things a tab can be asked (SPEC §3.9). `eval` is the
 *  code-delivery lane and exists only behind the host's dev switch. */
export const ASK_KINDS = ['profile', 'capture', 'cpuprofile', 'eval'];

export function makeAsk(kind, arg) {
  if (!ASK_KINDS.includes(kind)) throw new Error(`ask kind must be one of ${ASK_KINDS.join('|')}`);
  const ask = { id: randomBytes(4).toString('hex'), kind, at: new Date().toISOString() };
  if (arg !== undefined && arg !== '') ask.arg = arg;
  return ask;
}

export function writeAsk(dir, ask) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ask.jsonl'), JSON.stringify(ask) + '\n');
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

/** Wait for the answer to `id` to land in perf.jsonl. Resolves the record, or
 *  null after `timeoutMs`. Polls the file's growth — the ledger is append-only. */
export async function awaitAnswer(dir, id, timeoutMs = 30_000, pollMs = 500) {
  const p = join(dir, 'perf.jsonl');
  const start = Date.now();
  let offset = existsSync(p) ? statSync(p).size : 0;
  // A tab may answer between the ask being written and the first poll: the
  // scan starts a little behind the current end.
  offset = Math.max(0, offset - 64 * 1024);
  while (Date.now() - start < timeoutMs) {
    if (existsSync(p)) {
      const size = statSync(p).size;
      if (size > offset) {
        const text = readFileSync(p, 'utf8').slice(offset);
        offset = size;
        for (const line of text.split('\n')) {
          if (!line.includes(id)) continue;
          try { const r = JSON.parse(line); if (r.type === 'answer' && r.id === id) return r; } catch { /* partial */ }
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
