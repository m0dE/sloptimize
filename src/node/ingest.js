// ============================================================
// node/ingest.js — the dev server half, for ANY app (SPEC §8.6)
// ============================================================
// Until 0.6 every host wrote its own landing strip for the runtime's posts
// (INTEGRATION §2 said "Vite host: planned"). This is that strip, in the
// package: a framework-agnostic handler over (method, path, body) → response,
// so it drops into express, vite's connect, a bare http.createServer or the
// bundled `sloptimize serve`. Files-first, same schemas, same directory the
// CLI reads:
//
//   POST /api/sloptimize/ingest   {kind: profile|records|census, payload}
//                                 → profile.json (overwrite) · perf.jsonl
//                                 (append) · census.json (overwrite); a
//                                 `profile` post answers 200 {asks} when the
//                                 agent has asked the tab something (§3.9)
//   GET  /api/sloptimize/ledger   the tail of perf.jsonl + all of fixes.jsonl
//                                 (what the in-page debugger folds)
//   GET  /api/sloptimize/fixes    proposals with git status (needs a repo)
//   POST /api/sloptimize/fix      {id, action: merge|reject}
//   GET/POST /api/sloptimize/settings
//
// DEV ONLY: this writes to a directory on the box it runs on. It exists
// only where the host mounts it; a production server does not, and the
// runtime treats a 404 as "no ingest" and stays quiet.
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pendingAsks } from '../ask.js';

export const MAX_BODY_BYTES = 512 * 1024;
export const LEDGER_TAIL_BYTES = 2 * 1024 * 1024;
const KINDS = { profile: ['profile.json', 'overwrite'], records: ['perf.jsonl', 'append'], census: ['census.json', 'overwrite'] };

/** The last `bytes` of a file as utf8, '' when absent. */
export function readTail(path, bytes) {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, span = Math.min(size, bytes);
    const buf = Buffer.alloc(span);
    readSync(fd, buf, 0, span, size - span);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

/** Parse the runtime's envelope into a file effect — pure. */
export function parseIngest(raw) {
  if (raw.length > MAX_BODY_BYTES) return { ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: 'not JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'body must be an object' };
  const { kind, payload } = parsed;
  if (typeof kind !== 'string' || !(kind in KINDS)) return { ok: false, error: `kind must be one of ${Object.keys(KINDS).join('|')}` };
  const [file, mode] = KINDS[kind];
  if (mode === 'append') {
    if (!Array.isArray(payload) || payload.length === 0 || payload.some((r) => !r || typeof r !== 'object')) return { ok: false, error: 'records payload must be a non-empty array of objects' };
    return { ok: true, effect: { file, mode, data: payload.map((r) => JSON.stringify(r)).join('\n') + '\n' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: `${kind} payload must be an object` };
  return { ok: true, effect: { file, mode, data: JSON.stringify(payload, null, 2) } };
}

/**
 * The handler. `opts.dir` is the ledger directory (default `.sloptimize`);
 * `opts.repoDir` enables the fix loop (git). Returns `handle(method, path,
 * body)` → `{status, headers, body}` or null when the path is not ours —
 * so a host mounts it in front of its own routing without a framework.
 */
export function createIngest(opts = {}) {
  const dir = opts.dir ?? '.sloptimize';
  const now = opts.now ?? (() => Date.now());
  const delivered = new Map();          // ask id → when handed to a tab (§3.9: once)
  const DELIVERED_FORGET_MS = 120_000;
  const json = (status, obj) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  function asksFor() {
    const askText = readTail(join(dir, 'ask.jsonl'), 64 * 1024);
    if (!askText.includes('"id"')) return [];
    const t = now();
    const pending = pendingAsks(askText, readTail(join(dir, 'perf.jsonl'), 512 * 1024), t);
    for (const [id, at] of delivered) if (t - at > DELIVERED_FORGET_MS) delivered.delete(id);
    const fresh = pending.filter((a) => !delivered.has(a.id));
    for (const a of fresh) delivered.set(a.id, t);
    return fresh;
  }

  async function fixes(method, body) {
    if (!opts.repoDir) return json(200, { repo: false, error: 'no repoDir configured — the fix loop needs a git checkout' });
    const p = await import('../proposals.mjs');
    if (method === 'GET') return json(200, p.listFixes(opts.repoDir, dir));
    let req; try { req = JSON.parse(body || '{}'); } catch { return json(400, { error: 'not JSON' }); }
    if (req.action === 'merge') return json(200, p.mergeFix(opts.repoDir, dir, String(req.id ?? '')));
    if (req.action === 'reject') return json(200, p.rejectFix(opts.repoDir, dir, String(req.id ?? '')));
    return json(400, { error: 'action must be merge|reject' });
  }

  async function settings(method, body) {
    const p = await import('../proposals.mjs');
    if (method === 'GET') return json(200, p.readSettings(dir));
    let req; try { req = JSON.parse(body || '{}'); } catch { return json(400, { error: 'not JSON' }); }
    return json(200, p.writeSettings(dir, req));
  }

  return {
    dir,
    async handle(method, path, body = '') {
      const p = path.split('?')[0];
      if (!p.startsWith('/api/sloptimize/')) return null;
      if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
      if (p === '/api/sloptimize/ingest' && method === 'POST') {
        const parsed = parseIngest(body);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const { effect } = parsed;
        mkdirSync(dir, { recursive: true });
        const file = join(dir, effect.file);
        if (effect.mode === 'append') appendFileSync(file, effect.data); else writeFileSync(file, effect.data);
        if (effect.file === 'profile.json') {
          const asks = asksFor();
          if (asks.length) return json(200, { asks });
        }
        return { status: 204, headers: {}, body: '' };
      }
      if (p === '/api/sloptimize/ledger' && method === 'GET') {
        return json(200, { perf: readTail(join(dir, 'perf.jsonl'), LEDGER_TAIL_BYTES), fixes: readTail(join(dir, 'fixes.jsonl'), LEDGER_TAIL_BYTES) });
      }
      if (p === '/api/sloptimize/fixes' && method === 'GET') return fixes('GET');
      if (p === '/api/sloptimize/fix' && method === 'POST') return fixes('POST', body);
      if (p === '/api/sloptimize/settings') return settings(method, body);
      return json(404, { error: 'unknown sloptimize route' });
    },
    /** connect/express-style middleware over the same handler. */
    middleware() {
      return (req, res, next) => {
        if (!req.url?.startsWith('/api/sloptimize/')) return next?.();
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          this.handle(req.method, req.url, raw).then((r) => {
            if (!r) return next?.();
            res.writeHead(r.status, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', ...r.headers });
            res.end(r.body);
          }).catch((e) => { res.writeHead(500); res.end(String(e?.message ?? e)); });
        });
      };
    },
  };
}
