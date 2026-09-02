// ============================================================
// cloud-client.js — read side of sloptimize cloud (SPEC cloud §8.4)
// ============================================================
// Read side of sloptimize cloud for the CLI and MCP: the catalogue over every
// player, not just this machine's ledger. Configuration is explicit — a key
// and an endpoint — and a missing one is said, never guessed.
export function cloudConfig(env = process.env, args = []) {
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const key = flag('--key') ?? env.SLOPTIMIZE_KEY;
  const endpoint = (flag('--endpoint') ?? env.SLOPTIMIZE_ENDPOINT ?? '').replace(/\/+$/, '');
  return key && endpoint ? { key, endpoint } : null;
}

export async function fetchIssues(cfg, q = {}, fetchImpl = globalThis.fetch, now = Date.now) {
  const u = new URL(`${cfg.endpoint}/v1/issues`);
  for (const k of ['preset', 'from', 'to', 'source', 'kind']) if (q[k]) u.searchParams.set(k, q[k]);
  const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${cfg.key}` } });
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.json().catch(() => ({}))).error ?? 'request failed'}`);
  const rows = await res.json();
  const t = now();
  return rows.map((r) => ({ id: r.id, key: r.key, type: r.kind, glyph: r.glyph, label: r.label, phase: r.phase, ctx: r.ctx, source: r.source,
    count: r.count, first: r.firstSeen, last: r.lastSeen, lastAgoMs: Math.max(0, t - Date.parse(r.lastSeen)), builds: r.builds ?? [], fixCount: r.fixes ?? 0, fixes: [], daily: r.daily ?? [], exact: r.exact }));
}

export async function pushFix(cfg, fix, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${cfg.endpoint}/v1/fixes`, { method: 'POST', headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' }, body: JSON.stringify(fix) });
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.json().catch(() => ({}))).error ?? 'request failed'}`);
  return res.json();
}
