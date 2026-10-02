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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const PKG_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const DIR = () => join(process.cwd(), '.sloptimize');
let attachSession = null;
let driveState = null;   // { status: 'running'|'done'|'failed', error? } of the session's drive script

const TOOLS = [
  { name: 'get_report', description: 'Current profile, recent incidents (classified, clustered), and census hints from the project’s .sloptimize/ directory.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'max incident records (default 20)' } } } },
  { name: 'check_budgets', description: 'Check the measurement against .sloptimize/budgets.json. Returns per-budget verdicts; "fast enough" as data. Per-phase budgets (perf.budget.<phase>.<metric>, e.g. load.worst_ms, steady.p95_ms, steady.frames_over_100ms_per_min) and session/build judge a WHOLE run; a build\'s value is the median of its runs. `insufficient` means it could not judge (too few runs, a budget unmeasured) — never read that as a pass. `refused` means the run was measured under other conditions than budgets.json\'s perf.conditions, or is a coverage run.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, build: { type: 'string' }, minRuns: { type: 'number' } } } },
  { name: 'get_history', description: 'The deployment’s timeline folded from perf.jsonl: time buckets (frame p95, draw calls, hitch spikes, build), one measured window per build, and the fix ledger (fixes.jsonl) — the before/after evidence behind every recorded fix.',
    inputSchema: { type: 'object', properties: { buckets: { type: 'number', description: 'time slices (default 24)' } } } },
  { name: 'get_issues', description: 'The issue catalogue (SPEC §3.7): every incident type on the ledger grouped by FOOTPRINT — the identity of a cause (type, phase, verdict, site, the game’s situation), never its time — with occurrences, first/last seen, builds, worst, the last verdict, and the fixes applied to it. Read this before proposing a fix: an issue with a fix already recorded is not new.',
    inputSchema: { type: 'object', properties: { fp: { type: 'string', description: 'one footprint id' }, from: { type: 'string', description: 'ISO lower bound' }, to: { type: 'string', description: 'ISO upper bound' }, includeAutomated: { type: 'boolean', description: 'count robots’ sessions too (default false)' }, limit: { type: 'number', description: 'max rows (default 50)' },
      cloud: { type: 'boolean', description: 'read the cloud catalogue (every player, every build) instead of this machine\'s ledger — requires SLOPTIMIZE_KEY/SLOPTIMIZE_ENDPOINT' },
      preset: { type: 'string', description: 'cloud only: 24h | 7d | 30d' }, source: { type: 'string', description: 'cloud only: filter by source (client|server)' }, kind: { type: 'string', description: 'cloud only: filter by incident kind' } } } },
  { name: 'record_fix', description: 'Append a fix report to .sloptimize/fixes.jsonl: title, issue, solution, commit, the FOOTPRINTS it addresses (from get_issues — this is how the Issues tab shows which fixes were applied to an issue), and MEASURED before/after windows of the ledger (default: the previous build vs the latest build with evidence; or name a build / an <ISO>..<ISO> range). Call this after verifying a perf fix — never with numbers of your own.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, issue: { type: 'string' }, solution: { type: 'string' }, commit: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } }, footprints: { type: 'array', items: { type: 'string' }, description: 'footprint ids this fix addresses' },
      before: { type: 'string' }, after: { type: 'string' } }, required: ['title'] } },
  { name: 'compare_runs', description: 'A vs B (each a build, a session id, or <ISO>..<ISO>): every metric — frame median/p95/body, draw calls, hitches/h, each host loop section, each hot function\'s share — read per RUN and judged against its OWN run-to-run noise floor (significant / within noise / unproven at n=1), plus a warning when the slowdown is uniform with unchanged composition (the machine changed, not the code). Run each side at least twice. Sides measured under different conditions (display refresh, instrument, GPU, run mode, drawing size, phase mix…) are REFUSED: `refused: true` with `conditions.mismatches` naming what differs — re-measure rather than pass allowMismatch, unless the difference is the question.',
    inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, phase: { type: 'string', description: 'comma list of page phases' },
      allowMismatch: { type: 'boolean', description: 'read the deltas even when the conditions differ (they then include the difference)' },
      failOnRegression: { type: 'boolean', description: 'the gate: `gate.verdict` is regressed (a significant move the worse way), pass, insufficient (fewer than minRuns a side — not a pass) or machine (uniform change, unchanged composition)' },
      minRuns: { type: 'number', description: 'runs a side the gate needs (default 3)' } }, required: ['a', 'b'] } },
  { name: 'check_touched', description: 'Did the measured run EXECUTE the change under test? For each changed file (default: git diff of the working tree, else the last commit), whether any profiler sample of the attach run landed in it. Call before trusting any before/after: a clean A/B on a benchmark that never ran the new code path proves nothing. Bundled builds need `maps` to credit samples to sources.',
    inputSchema: { type: 'object', properties: { changed: { type: 'array', items: { type: 'string' } }, since: { type: 'string', description: 'git rev to diff against' },
      build: { type: 'string' }, session: { type: 'string' }, maps: { type: 'array', items: { type: 'string' }, description: 'source map paths of bundled scripts' }, phase: { type: 'string' } } } },
  { name: 'attach_start', description: 'Tier-0 attach: launch a Chromium at a URL with the injected recorder + rolling profiler (zero game integration). Records land in .sloptimize/ and incidents are clustered with file:line attribution.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, headless: { type: 'boolean' }, port: { type: 'number' },
      build: { type: 'string', description: 'the bundle identity to stamp on every record — runs of one build then compare as one build with n runs' },
      minShare: { type: 'number', description: 'share of a frame (0–1) a function needs to be named a hitch\'s cause (default 0.1)' },
      slots: { type: 'boolean', description: 'false: skip the InstancedMesh stale-slot watch and leave __THREE_DEVTOOLS__ undefined (default true)' },
      drive: { type: 'string', description: 'path to a drive script (export default async function drive(api)) run on the recording\'s timeline: api.phase, at, eval, until, key, move, click, drag, wait, cdp. Its hash is a condition: runs of two scripts never compare. attach_stop reports how it ended.' },
      heapGc: { type: 'boolean', description: 'soak: force a GC before each minute\'s heap reading (post-GC floor). Pauses the page — a condition of the run.' },
      heapSnapshots: { type: 'boolean', description: 'soak: heap/<session>-start.heapsnapshot (~30 s in) and -end at attach_stop, for DevTools\' Comparison view' },
      coverage: { type: 'boolean', description: 'a COVERAGE run: exact per-function call counts instead of the sampler (read with check_coverage). Its timings are not timings — never a compare/check side.' } }, required: ['url'] } },
  { name: 'check_coverage', description: 'What a coverage run (attach_start coverage:true) never CALLED: modules that loaded but whose functions never ran (an idle subsystem — bench content missing, e.g. TrafficLight.update with 0 calls while its manager ticked an empty map), repo files that never loaded, and with changed/since every changed FUNCTION and whether it was called. Call before trusting a benchmark of a subsystem.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, build: { type: 'string' }, changed: { type: 'array', items: { type: 'string' } }, since: { type: 'string' },
      maps: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean', description: 'include dependencies' } } } },
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

/** A CLI verb's --json answer. A non-zero exit still carries its answer
 *  (touched: a file got no samples; compare/check: a refusal, a breach, a
 *  regression, cannot-judge) — only an unparseable one is an error. */
function cliJson(argv) {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs'), ...argv, '--json', '--dir', DIR()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    try { return { ...JSON.parse(e.stdout), exitCode: e.status }; } catch { return { error: (e.stderr || e.stdout || e.message).toString().trim() }; }
  }
}

async function callTool(name, args = {}) {
  if (name === 'get_report') {
    return { profile: readJson('profile.json'), incidents: readJsonl('perf.jsonl', args.limit ?? 20),
      clusters: readJson('clusters.json'), census: readJson('census.json'),
      note: existsSync(DIR()) ? undefined : 'no .sloptimize/ in this project — run the game with the tier-1 feed, or attach_start' };
  }
  if (name === 'check_budgets') {
    // The CLI's own --json: one implementation of the snapshot, run mode,
    // per-phase budgets, the conditions refusal and the cannot-judge answer.
    const argv = ['check'];
    if (args.session) argv.push('--session', String(args.session)); else if (args.build) argv.push('--build', String(args.build));
    if (args.minRuns) argv.push('--min-runs', String(args.minRuns));
    return cliJson(argv);
  }
  if (name === 'get_history') {
    const { buildHistory } = await import('../src/history.js');
    return buildHistory(readJsonl('perf.jsonl', Infinity), { fixes: readJsonl('fixes.jsonl', Infinity), buckets: args.buckets ?? 24 });
  }
  if (name === 'get_issues') {
    if (args.cloud === true) {
      const { cloudConfig, fetchIssues } = await import('../src/cloud-client.js');
      const cfg = cloudConfig(process.env, []);
      if (!cfg) return { error: 'cloud not configured: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT' };
      try {
        const rows = await fetchIssues(cfg, { preset: args.preset, from: args.from, to: args.to, source: args.source, kind: args.kind });
        return { source: 'cloud', endpoint: cfg.endpoint, footprints: rows.length, occurrences: rows.reduce((n, i) => n + i.count, 0), issues: args.fp ? rows.filter((i) => i.id === args.fp) : rows.slice(0, args.limit ?? 50) };
      } catch (e) { return { error: e.message }; }
    }
    const { buildIssues } = await import('../src/history.js');
    const issues = buildIssues(readJsonl('perf.jsonl', Infinity), { fixes: readJsonl('fixes.jsonl', Infinity), from: args.from, to: args.to, includeAutomated: args.includeAutomated === true });
    const rows = args.fp ? issues.filter((i) => i.id === args.fp) : issues.slice(0, args.limit ?? 50);
    return { footprints: issues.length, occurrences: issues.reduce((n, i) => n + i.count, 0), issues: rows };
  }
  if (name === 'record_fix') {
    const { buildFix } = await import('../src/history.js');
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const fix = buildFix(readJsonl('perf.jsonl', Infinity), args);
    mkdirSync(DIR(), { recursive: true });
    appendFileSync(join(DIR(), 'fixes.jsonl'), JSON.stringify(fix) + '\n');
    return { ok: true, fix };
  }
  if (name === 'compare_runs' || name === 'check_touched') {
    // The CLI's own --json: one implementation of both verbs.
    const argv = name === 'compare_runs' ? ['compare', String(args.a), String(args.b)] : ['touched'];
    if (name === 'check_touched') {
      if (args.changed?.length) argv.push('--changed', args.changed.join(','));
      else if (args.since) argv.push('--since', args.since);
      if (args.build) argv.push('--build', args.build); else if (args.session) argv.push('--session', args.session);
      if (args.maps?.length) argv.push('--map', args.maps.join(','));
    }
    if (args.phase) argv.push('--phase', args.phase);
    if (name === 'compare_runs' && args.allowMismatch === true) argv.push('--allow-mismatch');
    if (name === 'compare_runs' && args.failOnRegression === true) argv.push('--fail-on-regression');
    if (name === 'compare_runs' && args.minRuns) argv.push('--min-runs', String(args.minRuns));
    return cliJson(argv);
  }
  if (name === 'check_coverage') {
    const argv = ['coverage'];
    if (args.session) argv.push('--session', String(args.session)); else if (args.build) argv.push('--build', String(args.build));
    if (args.changed?.length) argv.push('--changed', args.changed.join(',')); else if (args.since) argv.push('--since', String(args.since));
    if (args.maps?.length) argv.push('--map', args.maps.join(','));
    if (args.all) argv.push('--all');
    return cliJson(argv);
  }
  if (name === 'attach_start') {
    if (attachSession) return { error: 'an attach session is already running — attach_stop first' };
    const { attach } = await import('../src/attach.mjs');
    attachSession = await attach({ launch: args.url, headless: args.headless ?? true,
      port: args.port ?? 9222, dir: DIR(), log: () => {}, build: args.build, minShare: args.minShare, slots: args.slots, coverage: args.coverage === true, drive: args.drive,
      heap: { gc: args.heapGc === true, snapshots: args.heapSnapshots === true } });
    driveState = null;
    if (args.drive) {
      driveState = { status: 'running' };
      attachSession.runDrive().then(() => { driveState = { status: 'done' }; }, (e) => { driveState = { status: 'failed', error: String(e?.message ?? e) }; });
    }
    return { ok: true, session: attachSession.session, note: 'recording into .sloptimize/ — read with get_report; new causes cluster in clusters.json' };
  }
  if (name === 'attach_stop') {
    if (!attachSession) return { error: 'no attach session running' };
    const clusters = [...attachSession.clusters.entries()].map(([k, v]) => ({ key: k, count: v.count }));
    await attachSession.close();
    attachSession = null;
    return { ok: true, clusters, ...(driveState ? { drive: driveState } : {}) };
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
          capabilities: { tools: {} }, serverInfo: { name: 'sloptimize', version: PKG_VERSION } });
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
