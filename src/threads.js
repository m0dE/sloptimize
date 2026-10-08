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
// each frame that thread was working, which is how "frame 16.2 ms · main
// 6.1 ms · worker[sim] 15.8 ms" is read.
//
// Two different symptoms share the word "worker-bound":
//   · the frame waits on the worker (main mostly idle, the worker saturated)
//     — the frame time rises;
//   · the worker runs decoupled and falls BEHIND real time — the frames stay
//     smooth and only the game clock says so (`__sloptimizeClock`, §3.11).
// The verdict names which, when the run carries the game clock.
//
// Pure: a runBucket in, rows and a verdict out.

/** A thread this busy is saturated: it is the ceiling, or about to be. */
export const SATURATED = 0.85;
/** The main thread under this while a worker is saturated: the worker binds. */
const MAIN_FREE = 0.6;
/** Game seconds per wall second under this: the sim is falling behind. */
const BEHIND = 0.95;

const r3 = (x) => +x.toFixed(3);

/**
 * One row per thread that has a wall time: `main` first, then workers by busy.
 * @param {object} bucket   a runBucket (runs.js)
 * @param {number} [frameMs] the frame median, for ms per frame
 * @returns {{name:string, busy:number, busyMs:number, wallMs:number, perFrameMs?:number, fns?:Map}[]}
 */
export function threadRows(bucket, frameMs) {
  if (!bucket?.threads?.size) return [];
  const rows = [];
  const row = (name, t) => {
    if (!(t.wallMs > 0)) return;
    const busy = Math.min(1, t.busyMs / t.wallMs);
    rows.push({ name, busy: r3(busy), busyMs: +t.busyMs.toFixed(1), wallMs: +t.wallMs.toFixed(1), ...(frameMs > 0 ? { perFrameMs: +(busy * frameMs).toFixed(1) } : {}), ...(t.fns ? { fns: t.fns } : {}) });
  };
  row('main', bucket);
  const workers = [];
  for (const [name, t] of bucket.threads) workers.push([name, t]);
  for (const [name, t] of workers.sort((a, b) => b[1].busyMs / (b[1].wallMs || 1) - a[1].busyMs / (a[1].wallMs || 1))) row(name, t);
  return rows;
}

/**
 * The verdict over thread rows. `clockRate` is game seconds per wall second
 * (the run's `__sloptimizeClock` over its visible time), when there is one.
 * @returns {{verdict:'worker-bound'|'sim-behind'|'main-bound'|'headroom', thread?:string, text:string} | null}
 */
export function threadVerdict(rows, { clockRate } = {}) {
  const main = rows.find((r) => r.name === 'main');
  const workers = rows.filter((r) => r.name !== 'main');
  if (!main || !workers.length) return null;
  const top = workers[0];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const behind = typeof clockRate === 'number' && clockRate > 0 && clockRate < BEHIND;
  if (top.busy >= SATURATED && behind) {
    return { verdict: 'sim-behind', thread: top.name, text: `sim falling behind: ${top.name} ${pct(top.busy)} busy and the game clock runs at ${clockRate.toFixed(2)}× real time — the frames can look smooth while the simulation slows; the worker is the ceiling` };
  }
  if (top.busy >= SATURATED && main.busy < MAIN_FREE) {
    return { verdict: 'worker-bound', thread: top.name, text: `worker-bound: ${top.name} ${pct(top.busy)} busy while main is ${pct(main.busy)} — the worker is the ceiling; a faster main thread will not raise it` };
  }
  if (main.busy >= SATURATED) return { verdict: 'main-bound', thread: 'main', text: `main-bound: main ${pct(main.busy)} busy, ${top.name} ${pct(top.busy)}` };
  return { verdict: 'headroom', text: `no thread saturated (main ${pct(main.busy)}, ${top.name} ${pct(top.busy)})` };
}

/** Game seconds per wall second from a counter accumulator (runs.js), or undefined. */
export function clockRateOf(tally) {
  const c = tally?.clock;
  if (!c || c.mixed || !(c.seconds > 0) || !(tally.wallSec > 0)) return undefined;
  return +(c.seconds / tally.wallSec).toFixed(3);
}
