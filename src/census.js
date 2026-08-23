// ============================================================
// census.js — the static per-entity cost census (SPEC §4.1)
// ============================================================
// A scene walk, on demand, never per-frame. The host hands it entity roots
// (id + Object3D); everything else is read off the graph. Draw calls are a
// runtime fact and are reported as `null` here — profile.json carries the
// measured number (principle 4).

const INSTANCING_MIN_COUNT = 20;      // N same-geometry+material meshes worth a hint
const MATERIAL_DEDUP_MIN = 8;
const OVERSIZED_TEXTURE_DIM = 4096;

function triCount(geometry) {
  if (!geometry) return 0;
  if (geometry.index) return Math.floor(geometry.index.count / 3);
  const pos = geometry.attributes && geometry.attributes.position;
  return pos ? Math.floor(pos.count / 3) : 0;
}

function materialKey(m) {
  // Identical-parameter detection without serializing textures: type + the
  // scalar/color params that force separate programs or batches.
  try {
    return [m.type, m.color?.getHex?.() ?? '', m.roughness ?? '', m.metalness ?? '',
      m.map?.uuid ?? '', m.transparent ?? false, m.side ?? 0].join('|');
  } catch { return m.uuid; }
}

function walkEntity(root) {
  const out = {
    meshes: 0, visibleMeshes: 0, instancedMeshes: 0, triangles: 0,
    visibleTriangles: 0, castShadow: 0,
    materials: new Map(), geometries: new Map(), pairs: new Map(),
    matParams: new Map(), textures: new Map(),
  };
  // Visibility is INHERITED: an invisible group's children never draw
  // whatever their own flag says, and a pooled mesh parked with
  // visible=false costs no draw call. The census reports both counts —
  // total (memory/census weight) and visible (draw weight) — and the
  // instancing hint keys on the VISIBLE count, because sending an agent to
  // instance a parked pool is a guess dressed as a measurement.
  const stack = [[root, root.visible !== false]];
  while (stack.length) {
    const [node, parentVisible] = stack.pop();
    if (!node) continue;
    const vis = parentVisible && node.visible !== false;
    if (node.isMesh) {
      const inst = !!node.isInstancedMesh;
      out.meshes++;
      if (vis) out.visibleMeshes++;
      if (inst) out.instancedMeshes++;
      const tris = triCount(node.geometry) * (inst ? (node.count ?? 1) : 1);
      out.triangles += tris;
      if (vis) out.visibleTriangles += tris;
      if (node.castShadow) out.castShadow++;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        if (!m) continue;
        out.materials.set(m.uuid, m);
        const pk = materialKey(m);
        out.matParams.set(pk, (out.matParams.get(pk) ?? 0) + 1);
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
          const tex = m[slot];
          if (tex && tex.image) out.textures.set(tex.uuid, tex);
        }
      }
      if (node.geometry) {
        out.geometries.set(node.geometry.uuid, node.geometry);
        const m0 = mats[0];
        const pairKey = `${node.geometry.uuid}|${m0 ? m0.uuid : ''}`;
        const p = out.pairs.get(pairKey) ?? { geometry: node.geometry.uuid, material: m0?.uuid ?? '', count: 0, visibleCount: 0, instanced: false };
        p.count += 1;
        if (vis) p.visibleCount += 1;
        p.instanced = p.instanced || inst;
        out.pairs.set(pairKey, p);
      }
    }
    const kids = node.children;
    if (kids) for (let i = 0; i < kids.length; i++) stack.push([kids[i], vis]);
  }
  return out;
}

function textureBytesEstimate(textures) {
  let bytes = 0;
  for (const t of textures.values()) {
    const img = t.image;
    const w = img?.width ?? 0, h = img?.height ?? 0;
    bytes += w * h * 4 * (t.generateMipmaps === false ? 1 : 1.33);
  }
  return Math.round(bytes);
}

/**
 * @param {object} opts
 * @param {{id:string, root:object, persistent?:boolean}[]} opts.entities
 * @param {{geometries:number,textures:number}} [opts.previousTotals]
 */
export function buildCensus(opts) {
  const entities = [];
  const hints = [];
  const totals = { calls: null, meshes: 0, triangles: 0, uniqueMaterials: 0, uniqueGeometries: 0, textureBytesEstimate: 0, geometries: 0, textures: 0 };
  const allMats = new Set(); const allGeos = new Set(); const allTex = new Set();

  for (const ent of opts.entities ?? []) {
    const w = walkEntity(ent.root);
    const sharedGroups = [...w.pairs.values()].filter((p) => p.count >= 2)
      .sort((a, b) => b.count - a.count).slice(0, 10);
    const row = {
      id: ent.id,
      meshes: w.meshes,
      visibleMeshes: w.visibleMeshes,
      instancedMeshes: w.instancedMeshes,
      triangles: w.triangles,
      visibleTriangles: w.visibleTriangles,
      uniqueMaterials: w.materials.size,
      uniqueGeometries: w.geometries.size,
      sharedGeometryGroups: sharedGroups,
      textureBytesEstimate: textureBytesEstimate(w.textures),
      castShadow: w.castShadow,
      visible: ent.root.visible !== false,
      persistent: ent.persistent ?? true,
    };
    entities.push(row);
    totals.meshes += w.meshes;
    totals.triangles += w.triangles;
    for (const u of w.materials.keys()) allMats.add(u);
    for (const u of w.geometries.keys()) allGeos.add(u);
    for (const u of w.textures.keys()) allTex.add(u);
    totals.textureBytesEstimate += row.textureBytesEstimate;

    // ── hints (closed vocabulary, SPEC §4.1) ──
    for (const grp of sharedGroups) {
      // Keyed on VISIBLE members: a parked pool (visible=false) draws
      // nothing, and hinting it would send the loop after a non-cost. The
      // pool still shows in the counts above; it is just not a draw-call fix.
      if (!grp.instanced && (grp.visibleCount ?? grp.count) >= INSTANCING_MIN_COUNT) {
        hints.push({
          kind: 'instancing-candidate',
          entity: ent.id,
          detail: `${grp.visibleCount} visible meshes share one geometry+material and are not instanced (${grp.count} incl. pooled)`,
          estimate: { callsSavedAtLeast: (grp.visibleCount ?? grp.count) - 1 },
          fix: `merge into one InstancedMesh at the construction site of ${ent.id}`,
        });
        break; // one per entity — the top group carries the point
      }
    }
    for (const [, n] of w.matParams) {
      if (n >= MATERIAL_DEDUP_MIN && w.materials.size > 1) {
        hints.push({
          kind: 'material-dedup-candidate',
          entity: ent.id,
          detail: `${n} materials share identical parameters — one shared material batches them`,
        });
        break;
      }
    }
    for (const t of w.textures.values()) {
      const img = t.image;
      if (img && (img.width > OVERSIZED_TEXTURE_DIM || img.height > OVERSIZED_TEXTURE_DIM)) {
        hints.push({ kind: 'oversized-texture', entity: ent.id,
          detail: `texture ${img.width}x${img.height} exceeds ${OVERSIZED_TEXTURE_DIM}` });
        break;
      }
    }
  }
  totals.uniqueMaterials = allMats.size;
  totals.uniqueGeometries = allGeos.size;
  totals.geometries = allGeos.size;
  totals.textures = allTex.size;

  if (opts.previousTotals) {
    const dg = totals.geometries - (opts.previousTotals.geometries ?? 0);
    const dt = totals.textures - (opts.previousTotals.textures ?? 0);
    if (dg > 50 || dt > 20) {
      hints.push({
        kind: 'undisposed-suspect',
        detail: `geometries ${opts.previousTotals.geometries}→${totals.geometries}, textures ${opts.previousTotals.textures}→${totals.textures} across censuses — monotonic growth suggests missing dispose()`,
      });
    }
  }

  return { at: new Date().toISOString(), totals, entities, hints };
}
