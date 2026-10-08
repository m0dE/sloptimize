// Real Chromium: back-to-back long frames are each attributed from their OWN
// samples (none given up to the cooldown, none one frame late), the top
// function names its hot line, and the load is a timed span with its size
// and sections. Run: node test/long-frames-e2e.mjs (~25 s).
import { attach } from '../src/attach.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = '/tmp/sloptimize-e2e-long';
rmSync(DIR, { recursive: true, force: true });
const url = 'file://' + fileURLToPath(new URL('./fixtures/long-frames.html', import.meta.url));
const session = await attach({ launch: url, headless: true, port: 9334, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 16000));
await session.close();

const recs = readFileSync(`${DIR}/perf.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };

const work = recs.filter((r) => r.type === 'hitch' && /^work_/.test(r.phase ?? ''));
for (const h of work) console.log(`  ${h.phase} ${h.frameMs}ms → ${h.unattributed ?? h.topFrames?.[0]?.fn} (${h.profileWindow}${h.frameSampledMs ? `, ${h.frameSampledMs}ms sampled` : ''})`);
check(work.length >= 10, `${work.length} back-to-back long frames recorded`);
check(work.every((h) => h.unattributed !== 'cooldown'), 'no long frame left unattributed (cooldown)');
const own = work.filter((h) => h.profileWindow === 'frame');
check(own.length >= work.length - 1, `${own.length}/${work.length} attributed from their own frame's samples`);
// Off by one names a neighbour's work<N>; V8 sometimes cannot resolve an
// optimized loop at all (`(program)`), which names nothing — never the wrong one.
const mine = (h) => h.phase.slice(5);
const wrong = own.filter((h) => h.topFrames?.some((f) => /^work\d+$/.test(f.fn) && f.fn !== mine(h) && f.share > 0.1));
const right = own.filter((h) => h.topFrames?.[0]?.fn === mine(h));
check(wrong.length === 0, `no frame attributed to a neighbour's function (${wrong.map((h) => `${mine(h)}→${h.topFrames[0].fn}`).join(', ') || 'none'})`);
check(right.length >= own.length / 2, `${right.length}/${own.length} name their own frame's function first (the rest: V8 sampled the optimized loop as (program))`);

const load = recs.find((r) => r.type === 'hitch' && r.phase === 'load' && r.frameMs > 1500);
const top = load?.topFrames?.find((f) => f.fn === 'busy' || f.fn === 'loadCity');
check(!!top, `the 2 s load frame is attributed: ${load ? `${load.frameMs}ms → ${load.topFrames?.map((f) => f.fn).join(', ')}` : 'no hitch'}`);
check(!!top?.lines?.length, `its top function names hot lines: ${JSON.stringify(top?.lines)}`);

const span = recs.find((r) => r.type === 'phase-span' && r.phase === 'load' && !r.open);
check(span && span.ms > 1900 && span.ms < 2600, `the load is a span: ${span?.ms} ms`);
check(span?.scale?.roads === 40, `with its size: ${JSON.stringify(span?.scale)}`);
check(span?.sections?.createSidewalks?.[1] === 40, `and its sections with call counts: ${JSON.stringify(span?.sections)}`);
process.exit(fail ? 1 : 0);
