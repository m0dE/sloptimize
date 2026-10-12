// ============================================================
// threads.js — the page and its workers, side by side (SPEC §3.18)
// ============================================================
// A many-agent game's endgame is the simulation in a Worker. From then on a
// page-only profile reports a healthy 6 ms main thread and nothing of the
// 16 ms of sim beside it, and a main thread at 6 ms looks FIXED until the
// worker is seen to be the new ceiling. So every thread's sampler folds into
// the run file, and this reads them as one table and one verdict.
//
// Busy is sampled time not idle over the chunks' wall time, from the samples
// alone, no game code. Per frame is busy × the frame median: the share of
// each frame that thread was working — for the MAIN thread. A worker that
// runs its own loop has no frame: a field report read "worker 6.2 ms/frame
// (78% busy) → no thread saturated" for a sim spending 57 ms a tick and
// falling behind its clock. So a worker is read by its TASKS — the busy
// stretches between idle samples (runs.js): ms a task, tasks a second.
// At the 10 ms sampling interval a task under ~2 samples is only "short",
// and a SATURATED worker's idle gaps are mostly shorter than one sample, so
// its tasks merge into longer busy stretches — said as stretches, not tasks.
//
// Two different symptoms share the word "worker-bound":
//   · the frame waits on the worker (main mostly idle, the worker saturated)
//     — the frame time rises;
//   · the worker runs decoupled and falls BEHIND real time — the frames stay
//     smooth and only the game clock says so (`__sloptimizeClock`, §3.11).
// The verdict names which, when the run carries the game clock — and says
// it CANNOT judge the second without one, instead of reading idle time as
// headroom: a worker 78% busy can still be behind a clock it never reports.
//
// Pure: a runBucket in, rows and a verdict out.

/** A thread this busy is saturated: it is the ceiling, or about to be. */
export const SATURATED = 0.85;
/** The main thread under this while a worker is saturated: the worker binds. */
const MAIN_FREE = 0.6;
/** Game seconds per wall second under this: the sim is falling behind. */
const BEHIND = 0.95;

const r3 = (x) => +x.toFixed(3);

/** A task this many samples long or shorter is below what the sampler resolves. */
const COARSE_SAMPLES = 2;

/** A thread's tasks (runs.js `tasks`) read: count, ms a task (mean, p50,
 *  p95), tasks a second, or `never-idle` when every busy stretch ran into a
 *  chunk edge. */
export function taskStats(tasks, wallMs, busy = 0) {
  if (!tasks) return undefined;
  const hist = tasks.hist instanceof Map ? [...tasks.hist] : Object.entries(tasks.hist ?? {}).map(([k, v]) => [+k, v]);
  if (!tasks.n) return tasks.open > 0 ? { n: 0, neverIdle: true } : undefined;
  const msPerSample = tasks.samples > 0 ? (tasks.us ?? (tasks.ms ?? 0) * 1000) / 1000 / tasks.samples : 0;
  hist.sort((a, b) => a[0] - b[0]);
  const at = (p) => { let seen = 0; for (const [k, c] of hist) { seen += c; if (seen >= p * tasks.n) return k; } return hist.at(-1)?.[0] ?? 0; };
  const p50 = at(0.5);
  return {
    n: tasks.n,
    meanMs: +((tasks.us ?? (tasks.ms ?? 0) * 1000) / 1000 / tasks.n).toFixed(1),
    p50Ms: +(p50 * msPerSample).toFixed(1),
    p95Ms: +(at(0.95) * msPerSample).toFixed(1),
    ...(wallMs > 0 ? { perSec: +(tasks.n / (wallMs / 1000)).toFixed(1) } : {}),
    ...(p50 <= COARSE_SAMPLES ? { coarse: true, underMs: +(COARSE_SAMPLES * msPerSample).toFixed(0) } : {}),
    // Merged: the idle gap a task this long leaves at this busy share is
    // under half a sample (or the thread is ≥90% busy) — the sampler cannot
    // see where one task ends, so these are stretches of several.
    ...(busy >= 0.9 || (busy > 0 && (p50 * msPerSample * (1 - busy)) / busy < 0.5 * msPerSample) ? { merged: true, gapMs: +msPerSample.toFixed(0) } : {}),
  };
}

/** Task figures a verb may read as one task's time: whole, resolved, unmerged. */
export const taskReadable = (t) => !!t && !t.neverIdle && !t.coarse && !t.merged;

/** A task stat in words: "57 ms/task (p95 61) × 14/s", "tasks ≤20 ms", "never idle". */
export function taskText(t) {
  if (!t) return '';
  if (t.neverIdle) return 'never idle';
  if (t.merged) return `back-to-back tasks (idle gaps under ${t.gapMs} ms, unseen by the sampler)`;
  if (t.coarse) return `tasks ≤${t.underMs} ms${t.perSec !== undefined ? ` × ${t.perSec}/s` : ''}`;
  return `${t.p50Ms} ms/task${t.p95Ms > t.p50Ms ? ` (p95 ${t.p95Ms})` : ''}${t.perSec !== undefined ? ` × ${t.perSec}/s` : ''}`;
}

/**
 * One row per thread that has a wall time: `main` first, then workers by busy.
 * Main carries ms per frame; a worker carries its tasks instead.
 * @param {object} bucket   a runBucket (runs.js)
 * @param {number} [frameMs] the frame median, for main's ms per frame
 * @returns {{name:string, busy:number, busyMs:number, wallMs:number, perFrameMs?:number, task?:object, fns?:Map}[]}
 */
export function threadRows(bucket, frameMs) {
  if (!bucket?.threads?.size) return [];
  const rows = [];
  const row = (name, t) => {
    if (!(t.wallMs > 0)) return;
    const busy = Math.min(1, t.busyMs / t.wallMs);
    const task = name === 'main' ? undefined : taskStats(t.tasks, t.wallMs, busy);
    rows.push({ name, busy: r3(busy), busyMs: +t.busyMs.toFixed(1), wallMs: +t.wallMs.toFixed(1), ...(name === 'main' && frameMs > 0 ? { perFrameMs: +(busy * frameMs).toFixed(1) } : {}),
      ...(task ? { task } : {}), ...(t.fns ? { fns: t.fns } : {}) });
  };
  row('main', bucket);
  const workers = [];
  for (const [name, t] of bucket.threads) workers.push([name, t]);
  for (const [name, t] of workers.sort((a, b) => b[1].busyMs / (b[1].wallMs || 1) - a[1].busyMs / (a[1].wallMs || 1))) row(name, t);
  return rows;
}

/**
 * The verdict over thread rows. `clockRate` is game seconds per wall second
 * (the run's `__sloptimizeClock` over its visible time), when there is one;
 * `tickHz` the sim's declared tick rate (`__sloptimizeSim`), when there is one.
 * @returns {{verdict:'worker-bound'|'sim-behind'|'over-tick'|'main-bound'|'headroom'|'unjudged', thread?:string, text:string} | null}
 */
export function threadVerdict(rows, { clockRate, tickHz } = {}) {
  const main = rows.find((r) => r.name === 'main');
  const workers = rows.filter((r) => r.name !== 'main');
  if (!main || !workers.length) return null;
  const top = workers[0];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const tasks = (r) => (r.task && !r.task.merged ? `, ${taskText(r.task)}` : '');
  const clocked = typeof clockRate === 'number' && clockRate > 0;
  // Behind is behind, saturated or not: a sim whose tick outgrew its budget
  // falls behind with idle time between ticks.
  if (clocked && clockRate < BEHIND && main.busy >= SATURATED && top.busy < SATURATED) {
    return { verdict: 'main-bound', thread: 'main', text: `main-bound: main ${pct(main.busy)} busy, ${top.name} ${pct(top.busy)}${tasks(top)} — and the game clock runs at ${clockRate.toFixed(2)}× real time: the main thread is what holds the sim back` };
  }
  if (clocked && clockRate < BEHIND) {
    return { verdict: 'sim-behind', thread: top.name, text: `sim falling behind: the game clock runs at ${clockRate.toFixed(2)}× real time — ${top.name} ${pct(top.busy)} busy${tasks(top)}; the frames can look smooth while the simulation slows` };
  }
  if (top.busy >= SATURATED && main.busy < MAIN_FREE) {
    return { verdict: 'worker-bound', thread: top.name, text: `worker-bound: ${top.name} ${pct(top.busy)} busy${tasks(top)} while main is ${pct(main.busy)} — the worker is the ceiling; a faster main thread will not raise it` };
  }
  if (main.busy >= SATURATED) return { verdict: 'main-bound', thread: 'main', text: `main-bound: main ${pct(main.busy)} busy, ${top.name} ${pct(top.busy)}${tasks(top)}` };
  if (clocked) return { verdict: 'headroom', text: `no thread saturated and the game clock keeps real time (${clockRate.toFixed(2)}×) — main ${pct(main.busy)}, ${top.name} ${pct(top.busy)}${tasks(top)}` };
  // No clock: whether a decoupled sim keeps up is not in the samples. A
  // declared tick rate is the next best evidence.
  const budget = tickHz > 0 ? 1000 / tickHz : undefined;
  const over = budget !== undefined ? workers.find((r) => taskReadable(r.task) && r.task.p50Ms > budget) : undefined;
  if (over) {
    return { verdict: 'over-tick', thread: over.name, text: `${over.name} takes ${over.task.p50Ms} ms a task against a ${+budget.toFixed(1)} ms tick (${tickHz} Hz) — it cannot keep real time unless a task carries several ticks; __sloptimizeClock('sim', …) settles it` };
  }
  return { verdict: 'unjudged', text: `no thread saturated (main ${pct(main.busy)}, ${top.name} ${pct(top.busy)}${tasks(top)}) — cannot judge sim-behind: no __sloptimizeClock; a worker on its own loop can fall behind its clock with idle time to spare` };
}

/** Game seconds per wall second from a counter accumulator (runs.js), or undefined. */
export function clockRateOf(tally) {
  const c = tally?.clock;
  if (!c || c.mixed || !(c.seconds > 0) || !(tally.wallSec > 0)) return undefined;
  return +(c.seconds / tally.wallSec).toFixed(3);
}
