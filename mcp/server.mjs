#!/usr/bin/env node
// ============================================================
// mcp/server.mjs — the plugin's live tier (SPEC §8.1 tier 4, M-A2)
// ============================================================
// A dependency-free stdio MCP server (JSON-RPC 2.0, newline-delimited),
// exposing the agent-facing verbs against the CURRENT PROJECT's
// .sloptimize/ plus tier-0 attach. Files stay the primary interface —
// these tools are the same reads, typed; attach_start is the one verb a
// plain file read cannot do.
//
// Push: incident→wakeup stays with the session Monitor / prompt hook for
// now — MCP notifications exist in the protocol, but a server-initiated
// wake is not a contract this host documents; when it becomes one, the
// watcher moves here (SPEC-attach §2, delivery edge).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DIR = () => join(process.cwd(), '.sloptimize');
let attachSession = null;

const TOOLS = [
  { name: 'get_report', description: 'Current profile, recent incidents (classified, clustered), and census hints from the project’s .sloptimize/ directory.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'max incident records (default 20)' } } } },
  { name: 'check_budgets', description: 'Check the measured profile against .sloptimize/budgets.json. Returns per-budget verdicts; "fast enough" as data.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_history', description: 'The deployment’s timeline folded from perf.jsonl: time buckets (frame p95, draw calls, hitch spikes, build), one measured window per build, and the fix ledger (fixes.jsonl) — the before/after evidence behind every recorded fix.',
    inputSchema: { type: 'object', properties: { buckets: { type: 'number', description: 'time slices (default 24)' } } } },
  { name: 'record_fix', description: 'Append a fix report to .sloptimize/fixes.jsonl: title, issue, solution, commit, and MEASURED before/after windows of the ledger (default: the previous build vs the latest build with evidence; or name a build / an <ISO>..<ISO> range). Call this after verifying a perf fix — never with numbers of your own.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, issue: { type: 'string' }, solution: { type: 'string' }, commit: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } }, before: { type: 'string' }, after: { type: 'string' } }, required: ['title'] } },
  { name: 'attach_start', description: 'Tier-0 attach: launch a Chromium at a URL with the injected recorder + rolling profiler (zero game integration). Records land in .sloptimize/ and incidents are clustered with file:line attribution.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, headless: { type: 'boolean' }, port: { type: 'number' } }, required: ['url'] } },
  { name: 'attach_stop', description: 'Stop the running attach session and report its cluster summary.',
    inputSchema: { type: 'object', properties: {} } },
];

function readJson(name) { try { return JSON.parse(readFileSync(join(DIR(), name), 'utf8')); } catch { return null; } }
function readJsonl(name, limit) {
  try {
    return readFileSync(join(DIR(), name), 'utf8').trim().split('\n').filter(Boolean)
      .slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function callTool(name, args = {}) {
  if (name === 'get_report') {
    return { profile: readJson('profile.json'), incidents: readJsonl('perf.jsonl', args.limit ?? 20),
      clusters: readJson('clusters.json'), census: readJson('census.json'),
      note: existsSync(DIR()) ? undefined : 'no .sloptimize/ in this project — run the game with the tier-1 feed, or attach_start' };
  }
  if (name === 'check_budgets') {
    const profile = readJson('profile.json');
    const budgets = readJson('budgets.json');
    if (!profile) return { error: 'no measurement to check' };
    if (!budgets) return { warning: 'no budgets declared (.sloptimize/budgets.json)', breached: [] };
    const countersOnly = profile.regime !== 'hardware';
    const read = { 'perf.budget.draw_calls': profile.render?.calls, 'perf.budget.triangles': profile.render?.triangles,
      'perf.budget.frame_ms_p95': countersOnly ? undefined : profile.frame?.p95Ms, 'perf.budget.programs': profile.memory?.programs };
    const results = Object.entries(budgets).map(([k, b]) => ({ budget: k, value: read[k] ?? null, limit: b,
      verdict: read[k] === undefined ? 'unmeasured' : read[k] > b ? `over by ${(read[k] / b).toFixed(1)}x` : 'inside' }));
    return { regime: profile.regime, results, breached: results.filter((r) => String(r.verdict).startsWith('over')).length };
  }
  if (name === 'get_history') {
    const { buildHistory } = await import('../src/history.js');
    return buildHistory(readJsonl('perf.jsonl', Infinity), { fixes: readJsonl('fixes.jsonl', Infinity), buckets: args.buckets ?? 24 });
  }
  if (name === 'record_fix') {
    const { buildFix } = await import('../src/history.js');
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const fix = buildFix(readJsonl('perf.jsonl', Infinity), args);
    mkdirSync(DIR(), { recursive: true });
    appendFileSync(join(DIR(), 'fixes.jsonl'), JSON.stringify(fix) + '\n');
    return { ok: true, fix };
  }
  if (name === 'attach_start') {
    if (attachSession) return { error: 'an attach session is already running — attach_stop first' };
    const { attach } = await import('../src/attach.mjs');
    attachSession = await attach({ launch: args.url, headless: args.headless ?? true,
      port: args.port ?? 9222, dir: DIR(), log: () => {} });
    return { ok: true, note: 'recording into .sloptimize/ — read with get_report; new causes cluster in clusters.json' };
  }
  if (name === 'attach_stop') {
    if (!attachSession) return { error: 'no attach session running' };
    const clusters = [...attachSession.clusters.entries()].map(([k, v]) => ({ key: k, count: v.count }));
    await attachSession.close();
    attachSession = null;
    return { ok: true, clusters };
  }
  throw new Error(`unknown tool ${name}`);
}

// ── JSON-RPC over stdio (newline-delimited; the SDK-free minimum) ──
const rl = createInterface({ input: process.stdin });
const reply = (id, result, error) => {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
};
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void (async () => {
    try {
      if (msg.method === 'initialize') {
        reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} }, serverInfo: { name: 'sloptimize', version: '0.3.0' } });
      } else if (msg.method === 'tools/list') {
        reply(msg.id, { tools: TOOLS });
      } else if (msg.method === 'tools/call') {
        const out = await callTool(msg.params.name, msg.params.arguments);
        reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } else if (msg.id !== undefined) {
        reply(msg.id, null, { code: -32601, message: `unknown method ${msg.method}` });
      }
    } catch (e) {
      if (msg.id !== undefined) reply(msg.id, null, { code: -32000, message: String(e?.message ?? e) });
    }
  })();
});
