// `sloptimize issues --cloud` end to end (SPEC cloud §8.4, §11): the real
// binary, a real HTTP server, real exit codes. The rendering is the product
// here — an agent reads these lines — so it is asserted on stdout, not on the
// mapper's return value.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url));

const ROWS = [
  { id: 'aaa11111', key: 'hitch|match|shader-compile', glyph: '⚡', label: 'hitch · shader-compile', kind: 'hitch', phase: 'match', source: 'client', ctx: '', count: 42, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-02T00:00:00.000Z', builds: ['b1', 'b2'], fixes: 1, daily: [], exact: true },
  { id: 'bbb22222', key: 'server-hitch|match|/srv/world.js#step', glyph: '▣', label: 'server tick over budget · /srv/world.js#step', kind: 'server-hitch', phase: 'match', source: 'server', ctx: '', count: 7, firstSeen: '2026-09-01T12:00:00.000Z', lastSeen: '2026-09-02T00:30:00.000Z', builds: ['srv1'], fixes: 0, daily: [], exact: false },
];

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (!req.url.startsWith('/v1/issues')) { res.writeHead(404).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ROWS));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

/** Run the real CLI and hand back { code, stdout, stderr } — a non-zero exit
 *  is data here (exit codes are the CLI's API), never a thrown failure. */
function run(argv, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '', ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('issues --cloud with no cloud env exits 2 and names what is missing', async () => {
  const { code, stderr } = await run(['issues', '--cloud']);
  assert.equal(code, 2);
  assert.match(stderr, /set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT/);
});

test('issues --cloud renders the catalogue rows and exits 0', async () => {
  const { code, stdout } = await run(['issues', '--cloud', '--preset', '7d'], { SLOPTIMIZE_KEY: 'sk_test', SLOPTIMIZE_ENDPOINT: ENDPOINT });
  assert.equal(code, 0);
  assert.match(stdout, /cloud http:\/\/127\.0\.0\.1:\d+ · 7d · 2 footprints/);
  assert.match(stdout, /fp=aaa11111/);
  assert.match(stdout, /×42/);
  assert.match(stdout, /fp=bbb22222/);
  assert.match(stdout, /×7/);
  assert.match(stdout, /server tick over budget/);
  const last = seen.at(-1);
  assert.equal(last.auth, 'Bearer sk_test');
  assert.match(last.url, /^\/v1\/issues\?preset=7d$/);
});

test('issues --cloud --json prints a parseable array', async () => {
  const { code, stdout } = await run(['issues', '--cloud', '--json'], { SLOPTIMIZE_KEY: 'sk_test', SLOPTIMIZE_ENDPOINT: ENDPOINT });
  assert.equal(code, 0);
  const rows = JSON.parse(stdout);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'aaa11111');
  assert.equal(rows[0].count, 42);
  assert.equal(rows[0].exact, true);
  assert.equal(rows[1].exact, false);   // §4: the row says whether its count is exact
});
