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

/**
 * @param {{staleChecks?:number}} [opts]
 * @returns {{observe:(scene:object)=>void, check:(nowMs:number)=>object[], meshes:()=>number}}
 *   `check` returns one row per watched mesh that has stale slots or just
 *   stopped having them: `{name, drawn, capacity, active, written, changed,
 *   stale, staleSec}` (`staleSec`: how long the stalest slot has been idle).
 */
export function createSlotWatch(opts = {}) {
  const staleChecks = opts.staleChecks ?? STALE_CHECKS;
  const scenes = [];
  const state = new WeakMap();
  let meshes = [];
  let checks = 0;

  function observe(scene) {
    if (scene && scene.isScene && !scenes.some((s) => (s.deref ? s.deref() : s) === scene)) {
      scenes.push(typeof WeakRef === 'function' ? new WeakRef(scene) : scene);
    }
  }

  /** Visible InstancedMeshes: visibility is inherited, a hidden group's
   *  children never draw. */
  function scan() {
    const found = [];
    for (let k = scenes.length - 1; k >= 0; k--) {
      const root = scenes[k].deref ? scenes[k].deref() : scenes[k];
      if (!root) { scenes.splice(k, 1); continue; }
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node || node.visible === false) continue;
        if (node.isInstancedMesh) found.push(node);
        const kids = node.children;
        if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
      }
    }
    return found;
  }

  function track(mesh) {
    let st = state.get(mesh);
    if (st) return st;
    const cap = Math.floor((mesh.instanceMatrix?.array?.length ?? 0) / 16);
    st = { cap, written: new Uint8Array(cap), idle: new Uint16Array(cap), copy: null, at: 0, lastStale: 0 };
    state.set(mesh, st);
    // The instance's own property, so only this mesh pays; the prototype
    // (bundled, unreachable at tier 0) is never touched.
    const orig = mesh.setMatrixAt;
    if (typeof orig === 'function' && !orig.__sloptimize) {
      const w = function (i, m) { if (i >= 0 && i < st.cap) st.written[i] = 1; return orig.call(this, i, m); };
      w.__sloptimize = true;
      mesh.setMatrixAt = w;
    }
    return st;
  }

  function check(nowMs) {
    // The scene walk is the expensive half: redone every fifth check, and
    // meshes added in between are found then.
    if (checks++ % 5 === 0) meshes = scan();
    const rows = [];
    for (const mesh of meshes) {
      const arr = mesh.instanceMatrix?.array;
      if (!arr) continue;
      const st = track(mesh);
      const drawn = Math.max(0, Math.min(mesh.count ?? 0, st.cap));
      const changed = changedSlots(arr, st.copy, drawn);
      let active = 0, written = 0, moved = 0, stale = 0, stalest = 0;
      if (changed) {
        for (let i = 0; i < drawn; i++) {
          const w = st.written[i] === 1, c = changed[i] === 1;
          if (w) written++;
          if (c) moved++;
          if (w || c) { active++; st.idle[i] = 0; } else if (st.idle[i] < 65535) st.idle[i]++;
          if (st.idle[i] >= staleChecks) { stale++; if (st.idle[i] > stalest) stalest = st.idle[i]; }
        }
      }
      const sinceMs = nowMs - st.at;
      st.idle.fill(0, drawn);   // not drawn: a slot re-used later starts fresh
      st.written.fill(0);
      st.copy = arr.slice(0, drawn * 16);
      st.at = nowMs;
      if (!changed) continue;
      // A mesh where nothing is active is static (or paused) — not a
      // finding either way. Said when the stale count moves by ≥10%, and
      // once when it clears: the "after" of a fix.
      const report = active > 0 && stale > 0;
      const cleared = st.lastStale > 0 && stale === 0;
      if ((report && Math.abs(stale - st.lastStale) >= Math.max(1, 0.1 * st.lastStale)) || cleared) {
        rows.push({ name: mesh.name || `InstancedMesh ${String(mesh.uuid ?? '').slice(0, 8)}`, drawn, capacity: st.cap,
          active, written, changed: moved, stale, staleSec: +((stalest * sinceMs) / 1000).toFixed(1) });
        st.lastStale = stale;
      }
    }
    return rows;
  }

  return { observe, check, meshes: () => meshes.length };
}
