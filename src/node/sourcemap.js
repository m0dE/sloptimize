// ============================================================
// node/sourcemap.js — generated line:col → source file:line (name)
// ============================================================
// Enough of the source-map v3 format to symbolicate a self-profiling sample
// (`sloptimize ask cpuprofile … --map dist/game.min.js.map`): base64 VLQ
// mappings, binary search per line. No dependency; a map is read once.
import { readFileSync } from 'node:fs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CH = new Map([...B64].map((c, i) => [c, i]));
function* vlq(seg) {
  let v = 0, sh = 0;
  for (const c of seg) {
    const d = CH.get(c);
    if (d === undefined) return;
    v += (d & 31) << sh;
    if (d & 32) { sh += 5; continue; }
    yield v & 1 ? -(v >>> 1) : v >>> 1;
    v = 0; sh = 0;
  }
}

export function loadSourceMap(path) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  const lines = [];
  let si = 0, sl = 0, sc = 0, ni = 0;
  for (const line of map.mappings.split(';')) {
    const segs = [];
    let gc = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const f = [...vlq(seg)];
      gc += f[0];
      if (f.length >= 4) {
        si += f[1]; sl += f[2]; sc += f[3];
        if (f.length >= 5) ni += f[4];
        segs.push([gc, si, sl, f.length >= 5 ? ni : -1]);
      }
    }
    lines.push(segs);
  }
  return {
    /** 1-based generated line, 0-based column → `{ file, line, name }` or null. */
    original(line, col) {
      const segs = lines[line - 1];
      if (!segs) return null;
      let lo = 0, hi = segs.length - 1, best = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= col) { best = segs[mid]; lo = mid + 1; } else hi = mid - 1; }
      if (!best) return null;
      const file = (map.sources[best[1]] ?? '?').replace(/^(\.\.\/)+/, '');
      return { file, line: best[2] + 1, name: best[3] >= 0 ? map.names[best[3]] : null };
    },
  };
}

/** Symbolicate the `where` of every frame in a cpuprofile answer in place:
 *  `game.min.js:82:22569` → `src/entity-manager.ts:2061 (update)`. Only
 *  frames of `generatedFile` (the map's own script, basename, query string
 *  ignored) are mapped; every other frame keeps its generated position. */
export function symbolicate(summary, sm, generatedFile) {
  for (const f of summary.top ?? []) {
    const m = /^(.*?)(?:\?[^:]*)?:(\d+):(\d+)$/.exec(f.where ?? '');
    if (!m) continue;
    // The map describes ONE generated file. A frame from another script
    // (three's own bundle, a vendor file) keeps its position — mapping it
    // through this map would name a random line of the wrong source.
    if (generatedFile && m[1] !== generatedFile) continue;
    const o = sm.original(Number(m[2]), Number(m[3]));
    if (!o) continue;
    f.where = `${o.file}:${o.line}`;
    if (o.name && (f.name === '(anonymous)' || f.name.length <= 2)) f.name = o.name;
  }
  return summary;
}
