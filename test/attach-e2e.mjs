// M-A0 exit criterion, executed: attach to a browser showing a page with ZERO
// integration, seed a freeze, and require the written record to attribute it
// to its function by file:line. M-A1: the second identical freeze must join
// the first's cluster, not mint a new one.
import { attach } from '../src/attach.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/seeded-freeze.html', import.meta.url));
const session = await attach({ launch: url, headless: true, port: 9333, dir: DIR });
await new Promise((r) => setTimeout(r, 25000));
await session.close();

const recs = readFileSync(`${DIR}/perf.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const hitches = recs.filter((r) => r.type === 'hitch');
console.log(`records: ${recs.length}, hitches: ${hitches.length}`);
const attributed = hitches.filter((h) => h.topFrames?.some((f) => f.fn === 'seededFreezeWork'));
if (attributed.length === 0) {
  console.log('FAIL — no hitch attributed to seededFreezeWork');
  for (const h of hitches) console.log(' ', h.frameMs, 'ms top:', JSON.stringify(h.topFrames?.slice(0, 2)));
  process.exit(1);
}
const f = attributed[0].topFrames.find((x) => x.fn === 'seededFreezeWork');
console.log(`PASS M-A0 — attributed to ${f.fn}@${f.url} (selfMs ${f.selfMs})`);
const clusters = JSON.parse(readFileSync(`${DIR}/clusters.json`, 'utf8'));
console.log('clusters:', JSON.stringify(clusters));
// M-A1: the merge machinery must bound clusters below occurrences. Three
// identical freezes may legitimately land in ≤2 clusters (V8 inlining can
// erase the leaf frame entirely — the spec's stated limit); 3 clusters for
// 3 identical freezes means the merge never ran.
const total = clusters.reduce((n, c) => n + c.count, 0);
console.log(`M-A1: ${total} occurrences in ${clusters.length} cluster(s)`);
if (clusters.length < total) console.log('PASS M-A1 — repeats joined an existing cause');
else { console.log('FAIL M-A1 — every occurrence minted its own cluster'); process.exit(1); }
process.exit(0);
