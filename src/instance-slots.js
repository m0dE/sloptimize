// ============================================================
// instance-slots.js — InstancedMesh slots drawn but no longer written
// ============================================================
// Every slot below an InstancedMesh's .count draws, written this frame or
// not. A field bug: a visibility cull skipped writing the transforms of
// off-screen entities while flush() still published count = the high-water
// mark, and ~95 ghost bodies stood at their last written positions.
// Invisible to draw counts, triangles, frame time and a code read — and to
// the graphics API too: three.js uploads the whole instanceMatrix, stale
// slots included, so no GL wrap can tell a written slot from a stale one.
// Only the mesh can.
//
// So this watches the meshes themselves. A slot is ACTIVE in a check window
// when the game wrote it through setMatrixAt (wrapped on the instance) or
// its matrix changed since the last check (a direct write into
// instanceMatrix.array). A slot inside .count that stayed inactive for
// STALE_CHECKS windows, in a mesh where other slots are active, is STALE:
// a deliberate static instance, or a ghost — the developer knows which; this
// only says the numbers. A mesh where nothing moves is static and says
// nothing.
//
// Tier 0 reaches the scenes through three.js's own devtools hook: every
// Scene three constructs dispatches itself to `__THREE_DEVTOOLS__` when that
// global exists, and the injected recorder defines it before any page
// script runs. No game code involved.
//
// What the watch costs is the recorder's cost, and it is capped. A field
// run on ~9k car slots and 6.7k instanced houses found `check` the heaviest
// JS of the session — 13.2 s self, 21% of sampled JS — while the report's
// recorder line said 0%: every check sliced a fresh copy of every matrix
// buffer and compared all 16 floats of every slot. Now:
//   · a slot's TRANSLATION is what is compared and kept (3 floats, not 16,
//     in a copy reused in place — no allocation per check). A slot rotated
//     or scaled in place without setMatrixAt reads as idle; a ghost stands
//     still, which is the case this exists for;
//   · a mesh where nothing moved for QUIET_CHECKS visits (a town of static
//     houses) is visited one check in QUIET_EVERY until something does;
//   · each check stops at `budgetMs` and the next one resumes where it
//     stopped, round-robin;
//   · the time spent is kept (`stats()`), so the recorder can report it and
//     back off — the page side widens the interval when the watch costs more
//     than a sliver of the frames it watches.
//
// No imports, browser and node: attach.mjs concatenates this file into the
// injected recorder (exports stripped), and census.js imports it.

/** Checks a slot must stay inactive to count as stale. */
export const STALE_CHECKS = 5;

/** Slots [0, n) whose 16 floats differ between `arr` and `copy`, as a
 *  0/1 array (null when there is no copy to compare with). */
export function changedSlots(arr, copy, n) {
  if (!copy) return null;
  const out = new Uint8Array(n);
  const m = Math.min(n, Math.floor(copy.length / 16));
  for (let i = 0; i < m; i++) {
    for (let j = i * 16, e = j + 16; j < e; j++) if (arr[j] !== copy[j]) { out[i] = 1; break; }
  }
  return out;
}

/** Floats compared per slot: the translation (elements 12–14 of the matrix). */
const KEPT = 3;
/** Visits with nothing active before a mesh is checked one time in QUIET_EVERY. */
export const QUIET_CHECKS = 3;
export const QUIET_EVERY = 4;
/** A check's time budget: meshes past it wait for the next check. */
export const SLOT_BUDGET_MS = 2;

/** Slots [0, n) whose translation differs between `arr` (16 floats a slot)
 *  and `kept` (KEPT a slot), into `out` (0/1); `kept` is updated in place.
 *  Slots past `known` had no copy yet: unchanged, and copied. */
export function changedTranslations(arr, kept, n, known, out) {
  for (let i = 0; i < n; i++) {
    const a = i * 16 + 12, k = i * KEPT;
    const x = arr[a], y = arr[a + 1], z = arr[a + 2];
    out[i] = i < known && (kept[k] !== x || kept[k + 1] !== y || kept[k + 2] !== z) ? 1 : 0;
    kept[k] = x; kept[k + 1] = y; kept[k + 2] = z;
  }
}

/**
 * @param {{staleChecks?:number, budgetMs?:number, now?:()=>number}} [opts]
 * @returns {{observe:(scene:object)=>void, check:(nowMs:number)=>object[], meshes:()=>number,
 *   stats:()=>{ms:number, checks:number, deferred:number, maxMs:number}}}
 *   `check` returns one row per watched mesh that has stale slots or just
 *   stopped having them: `{name, drawn, capacity, active, written, changed,
 *   stale, staleSec}` (`staleSec`: how long the stalest slot has been idle).
 *   `stats`: the watch's own time, in total and its longest check.
 */
export function createSlotWatch(opts = {}) {
  const staleChecks = opts.staleChecks ?? STALE_CHECKS;
  const budgetMs = opts.budgetMs ?? SLOT_BUDGET_MS;
  const clock = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const scenes = [];
  const state = new WeakMap();
  let meshes = [];
  let checks = 0, cursor = 0, deferred = 0, spentMs = 0, maxMs = 0;

  function observe(scene) {
    if (scene && scene.isScene && !scenes.some((s) => (s.deref ? s.deref() : s) === scene)) {
      scenes.push(typeof WeakRef === 'function' ? new WeakRef(scene) : scene);
    }
  }

  /** Visible InstancedMeshes: visibility is inherited, a hidden group's
   *  children never draw. The walk is bounded by the check's budget and
   *  resumes on the next check: a scene of 100k nodes is a few checks'
   *  walk, never one long frame. True when a walk completed. */
  let walk = null;
  function scanStep(t0) {
    if (!walk) {
      const stack = [];
      for (let k = scenes.length - 1; k >= 0; k--) {
        const root = scenes[k].deref ? scenes[k].deref() : scenes[k];
        if (!root) { scenes.splice(k, 1); continue; }
        stack.push(root);
      }
      walk = { stack, found: [] };
    }
    const { stack, found } = walk;
    let n = 0;
    while (stack.length) {
      if ((++n & 1023) === 0 && clock() - t0 > budgetMs) return false;
      const node = stack.pop();
      if (!node || node.visible === false) continue;
      if (node.isInstancedMesh) found.push(node);
      const kids = node.children;
      if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    meshes = found;
    walk = null;
    return true;
  }

  function track(mesh) {
    let st = state.get(mesh);
    if (st) return st;
    const cap = Math.floor((mesh.instanceMatrix?.array?.length ?? 0) / 16);
    st = { cap, written: new Uint8Array(cap), idle: new Uint16Array(cap), changed: new Uint8Array(cap), kept: new Float32Array(cap * KEPT),
      known: -1, at: 0, lastStale: 0, quiet: 0, skip: 0 };
    state.set(mesh, st);
    // The instance's own property, so only this mesh pays; the prototype
    // (bundled, unreachable at tier 0) is never touched.
    const orig = mesh.setMatrixAt;
    if (typeof orig === 'function' && !orig.__sloptimize) {
      // The state is looked up per call: a replaced buffer gets a new one.
      const w = function (i, m) { const s = state.get(this); if (s && i >= 0 && i < s.cap) s.written[i] = 1; return orig.call(this, i, m); };
      w.__sloptimize = true;
      mesh.setMatrixAt = w;
    }
    return st;
  }

  /** One mesh's visit: its row, when there is something to say. */
  function visit(mesh, nowMs) {
    const arr = mesh.instanceMatrix?.array;
    if (!arr) return null;
    const st = track(mesh);
    // A buffer replaced by a bigger one (three re-creates it on resize): start over.
    if (Math.floor(arr.length / 16) !== st.cap) { state.delete(mesh); return null; }
    const drawn = Math.max(0, Math.min(mesh.count ?? 0, st.cap));
    const first = st.known < 0;
    changedTranslations(arr, st.kept, drawn, first ? 0 : st.known, st.changed);
    let active = 0, written = 0, moved = 0, stale = 0, stalest = 0;
    if (!first) {
      for (let i = 0; i < drawn; i++) {
        const w = st.written[i] === 1, c = i < st.known && st.changed[i] === 1;
        if (w) written++;
        if (c) moved++;
        if (w || c || i >= st.known) { if (w || c) active++; st.idle[i] = 0; } else if (st.idle[i] < 65535) st.idle[i]++;
        if (st.idle[i] >= staleChecks) { stale++; if (st.idle[i] > stalest) stalest = st.idle[i]; }
      }
    }
    const sinceMs = nowMs - st.at;
    st.idle.fill(0, drawn);   // not drawn: a slot re-used later starts fresh
    st.written.fill(0);
    st.known = drawn;
    st.at = nowMs;
    st.quiet = active > 0 ? 0 : st.quiet + 1;
    if (first) return null;
    // A mesh where nothing is active is static (or paused) — not a
    // finding either way. Said when the stale count moves by ≥10%, and
    // once when it clears: the "after" of a fix.
    const report = active > 0 && stale > 0;
    const cleared = st.lastStale > 0 && stale === 0;
    if ((report && Math.abs(stale - st.lastStale) >= Math.max(1, 0.1 * st.lastStale)) || cleared) {
      st.lastStale = stale;
      return { name: mesh.name || `InstancedMesh ${String(mesh.uuid ?? '').slice(0, 8)}`, drawn, capacity: st.cap,
        active, written, changed: moved, stale, staleSec: +((stalest * sinceMs) / 1000).toFixed(1) };
    }
    return null;
  }

  function check(nowMs) {
    const t0 = clock();
    // The scene walk is the expensive half: redone every fifth check, and
    // meshes added in between are found then.
    if (walk || checks % 5 === 0) { if (scanStep(t0) && cursor >= meshes.length) cursor = 0; }
    checks++;
    const rows = [];
    const n = meshes.length;
    let done = 0;
    for (; done < n; done++) {
      // At least one mesh a check, so a single huge one is still watched.
      if (done > 0 && clock() - t0 > budgetMs) break;
      const mesh = meshes[(cursor + done) % n];
      const st = state.get(mesh);
      if (st && st.quiet >= QUIET_CHECKS && st.skip++ % QUIET_EVERY !== 0) continue;
      const row = visit(mesh, nowMs);
      if (row) rows.push(row);
    }
    cursor = n ? (cursor + done) % n : 0;
    deferred = n - done;
    const ms = clock() - t0;
    spentMs += ms;
    if (ms > maxMs) maxMs = ms;
    return rows;
  }

  return { observe, check, meshes: () => meshes.length,
    stats: () => ({ ms: +spentMs.toFixed(2), checks, deferred, maxMs: +maxMs.toFixed(2) }) };
}
