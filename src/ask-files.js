// ============================================================
// ask-files.js — the file half of `sloptimize ask` (node only)
// ============================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function writeAsk(dir, ask) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'ask.jsonl'), JSON.stringify(ask) + '\n');
}

/** Wait for the answer to `id` to land in perf.jsonl. Resolves the record, or
 *  null after `timeoutMs`. Polls the file's growth — the ledger is append-only. */
export async function awaitAnswer(dir, id, timeoutMs = 30_000, pollMs = 500) {
  const p = join(dir, 'perf.jsonl');
  const start = Date.now();
  let offset = existsSync(p) ? statSync(p).size : 0;
  // A tab may answer between the ask being written and the first poll: the
  // scan starts a little behind the current end, at a line boundary.
  if (offset > 0) {
    const back = Math.max(0, offset - 64 * 1024);
    const tail = readFileSync(p).subarray(back);
    const nl = tail.indexOf(10);
    offset = nl < 0 ? offset : back + nl + 1;
  }
  while (Date.now() - start < timeoutMs) {
    if (existsSync(p)) {
      const size = statSync(p).size;
      if (size > offset) {
        // Bytes, not characters: `offset` is a byte position, and a record
        // with a multi-byte glyph (the panel's ★, ⚡) is longer in bytes
        // than in characters — slicing a string by a byte offset lands
        // mid-line and every record after it parses as garbage.
        const buf = readFileSync(p).subarray(offset);
        // Only whole lines are read; a line still being written stays in the
        // file for the next poll, or the answer landing across two polls is
        // parsed as two fragments and lost (measured: an answer 2.4 s after
        // the ask, missed by a 60 s wait).
        const lastNl = buf.lastIndexOf(10);
        if (lastNl < 0) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
        const text = buf.subarray(0, lastNl + 1).toString('utf8');
        offset += lastNl + 1;
        for (const line of text.split('\n')) {
          if (!line.includes(id)) continue;
          try { const r = JSON.parse(line); if (r.type === 'answer' && r.id === id) return r; } catch { /* not a record */ }
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
