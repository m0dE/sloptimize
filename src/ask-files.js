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
