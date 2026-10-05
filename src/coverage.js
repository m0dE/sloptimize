// ============================================================
// coverage.js — what the run never CALLED (SPEC §3.12)
// ============================================================
// `touched` answers "did my changed file run" from samples. The worst miss a
// field team had was the other question: a whole subsystem never ran,
// because the benchmark city contained none of it — and module granularity
// would have missed it too. TrafficLight.js LOADED: the class was defined,
// its manager constructed, and the manager's tick() ran every frame over an
// empty map. At module level the file reads as executed.
// `TrafficLight.prototype.update` — 0 calls, inside a module that ran — is
// what would have caught it on day one. So the unit is the function, and
// the answer comes in two kinds that a bench gets wrong differently:
//   · LOADED but IDLE — the module ran, much of it was never called: bench
//     content missing (the one benches get wrong);
//   · NEVER LOADED — a dead import, a stripped feature, server code — or a
//     feature this run never reached.
//
// Counts come from V8 precise coverage in a separate run mode (attach
// --coverage): exact call counts, where a sampler can only say "under 3/n
// of JS time, if it ran". It is not free, so it never shares a run with
// timings — compare and check refuse a coverage run as a timing side.
//
// Pure: the CLI hands coverage files, source maps, the repo's file list and
// git's changed line ranges in.

import { normPath, samePath, CODE_FILE } from './runs.js';

const DEP = /(^|\/)(node_modules|\.vite\/deps|bower_components)\//;

/** Several coverage files (one build's runs) as one: counts summed per
 *  function, by script URL and source position. */
export function foldCoverage(files) {
  const scripts = new Map();
  for (const f of files) {
    for (const sc of f.scripts ?? []) {
      const s = scripts.get(sc.url) ?? scripts.set(sc.url, { url: sc.url, size: sc.size, fns: new Map() }).get(sc.url);
      for (const fn of sc.fns ?? []) {
        // The script's top level starts where its first function does:
        // position alone is not identity.
        const [name, line, col, , count, size] = fn;
        const k = `${name}|${line}:${col}|${size}`;
        const r = s.fns.get(k);
        if (r) r[4] += count; else s.fns.set(k, [...fn]);
      }
    }
  }
  return [...scripts.values()].map((s) => ({ url: s.url, size: s.size, fns: [...s.fns.values()] }));
}

/**
 * Functions credited to their SOURCE module: a script's own path, or — when
 * `maps` holds its source map — the source its start maps to.
 * @returns {Map<string, {file:string, fns:object[], bytes:number}>}
 */
export function byModule(scripts, { maps = [] } = {}) {
  const byMap = new Map(maps.map((m) => [m.file, m.sm]));
  const mods = new Map();
  for (const sc of scripts) {
    const sm = byMap.get(normPath(sc.url).split('/').pop());
    for (const [name, line, col, endLine, count, size, endCol] of sc.fns) {
      let file = normPath(sc.url), l = line, el = endLine;
      if (sm) {
        const o = sm.original(line, col);
        if (!o?.file) continue;   // bundler glue with no source
        file = normPath(o.file); l = o.line;
        // The function's LAST position (coverage files written before end
        // columns were recorded fall back to the end line's first mapping).
        const e = sm.original(endLine, endCol ?? 0) ?? sm.original(endLine, Number.MAX_SAFE_INTEGER);
        el = e?.file && normPath(e.file) === file ? Math.max(e.line, l) : l;
      }
      const m = mods.get(file) ?? mods.set(file, { file, fns: [], lo: Infinity, hi: -Infinity, bytes: 0, mapped: !!sm }).get(file);
      // The script's top-level "function" is the module itself (unbundled).
      const top = !sm && name === '' && line === 1 && col === 0 && size >= (sc.size || size);
      m.fns.push({ name: name || '(anonymous)', line: l, endLine: el, count, size, top });
      if (!top) m.bytes += size;
    }
  }
  for (const m of mods.values()) {
    const tops = m.fns.filter((f) => f.top);
    m.size = tops.length ? Math.max(...tops.map((f) => f.size)) : m.bytes;
    m.loaded = true;
    m.ran = m.fns.some((f) => f.count > 0);
    // Through a map, a module's top level is the bundle's: whether it RAN is
    // not visible, so "nothing in it ran" is never claimed for it.
    m.topKnown = !m.mapped || m.fns.some((f) => f.top);
    const inner = m.fns.filter((f) => !f.top);
    m.called = inner.filter((f) => f.count > 0).length;
    m.uncalled = inner.filter((f) => f.count === 0);
  }
  return mods;
}

/**
 * The two findings, ranked by module size: modules that ran with functions
 * never called (idle share ≥ `idleShare` is flagged), and repo files that
 * never loaded. `repoFiles` is `[{file, size}]` (git ls-files, say);
 * candidates for "never loaded" are code files in the same top directories
 * as something that did load, minus tests, tooling and type declarations.
 */
export function analyzeCoverage(mods, { repoFiles = [], includeDeps = false, idleShare = 0.5 } = {}) {
  const own = [...mods.values()].filter((m) => includeDeps || !DEP.test(m.file));
  const idle = own.filter((m) => (m.ran || !m.topKnown) && m.uncalled.length > 0)
    .map((m) => ({ file: m.file, size: m.size, called: m.called, total: m.called + m.uncalled.length,
      share: +(m.uncalled.length / (m.called + m.uncalled.length)).toFixed(3),
      uncalled: m.uncalled.sort((a, b) => b.size - a.size).map((f) => ({ name: f.name, line: f.line, size: f.size })) }))
    .map((m) => ({ ...m, idle: m.share >= idleShare }))
    .sort((a, b) => b.size - a.size);
  const silent = own.filter((m) => !m.ran && m.topKnown).map((m) => ({ file: m.file, size: m.size })).sort((a, b) => b.size - a.size);
  // Where the run's code lives in the repo: for every loaded module that
  // names a repo file, the repo path down to the module's own first segment
  // (a dev server serves `src/a.ts` for `packages/client/src/a.ts`).
  const roots = new Set();
  for (const m of own) {
    const hit = repoFiles.find((f) => samePath(m.file, normPath(f.file)));
    if (!hit) continue;
    const rp = normPath(hit.file), head = m.file.split('/')[0];
    const at = rp.split('/').lastIndexOf(head, rp.split('/').length - m.file.split('/').length);
    roots.add(at >= 0 ? rp.split('/').slice(0, at + 1).join('/') : rp.split('/')[0]);
  }
  // Say a module by its repo path when it names one (a file:// URL is an
  // absolute path; a dev server's is the served one).
  const shown = (file) => { const hit = repoFiles.find((f) => samePath(file, normPath(f.file))); return hit ? normPath(hit.file) : file; };
  for (const m of idle) m.file = shown(m.file);
  for (const m of silent) m.file = shown(m.file);
  const NOISE = /(^|\/)(tests?|__tests__|spec|e2e|scripts|tools|bin|docs?|examples?|fixtures|mocks?|stories)\/|\.(test|spec|stories)\.|\.d\.ts$|(^|\/)(vite|webpack|rollup|esbuild|eslint|prettier|jest|vitest|babel|postcss|tailwind|playwright)\.config\./;
  const loadedFiles = own.map((m) => m.file);
  const never = repoFiles
    .filter((f) => CODE_FILE.test(f.file) && !/\.html?$/i.test(f.file) && !NOISE.test(f.file) && !DEP.test(f.file))
    .filter((f) => [...roots].some((r) => normPath(f.file).startsWith(`${r}/`)))
    .filter((f) => !loadedFiles.some((l) => samePath(l, normPath(f.file))))
    .sort((a, b) => b.size - a.size);
  return { idle, silent, never, matched: roots.size > 0 };
}

/** `git diff -U0` → Map<file, [lo, hi][]> of NEW-file line ranges. */
export function changedRanges(diff) {
  const out = new Map();
  let file = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; continue; }   // a new file's header: no hunk belongs to the last one
    if (line.startsWith('+++ /dev/null')) { file = null; continue; }
    const f = /^\+\+\+ (.+?)\t?$/.exec(line);
    if (f) {
      let path = f[1];
      // git C-quotes paths with unusual bytes: "b/caf\303\251.js".
      if (path.startsWith('"') && path.endsWith('"')) path = unquoteC(path.slice(1, -1));
      file = path.replace(/^b\//, '');
      if (!out.has(file)) out.set(file, []);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const lo = +h[1], n = h[2] === undefined ? 1 : +h[2];
      out.get(file).push([lo, lo + Math.max(n, 1) - 1]);   // a pure deletion marks the line it left
    }
  }
  return out;
}

/** git's C-style quoting (octal UTF-8 bytes, \t \n \" \\) back to a string. */
function unquoteC(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { bytes.push(...Buffer.from(s[i])); continue; }
    const n = s[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(({ t: 9, n: 10, r: 13, '"': 34, '\\': 92 })[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * For each changed code file: did it load, and was each function the change
 * touched ever called? A function is touched when a changed line falls in
 * it; the innermost such function is the one credited. A changed line in no
 * function is module-level code, credited to the module having run.
 */
export function changedFunctions(mods, ranges) {
  const files = [];
  for (const [file, rs] of ranges) {
    const c = normPath(file);
    if (!CODE_FILE.test(c)) { files.push({ file, code: false }); continue; }
    const m = [...mods.values()].find((x) => samePath(x.file, c));
    if (!m) { files.push({ file, code: true, loaded: false }); continue; }
    const inner = m.fns.filter((f) => !f.top);
    const hit = new Map();
    let moduleLevel = false;
    const last = Math.max(1, ...m.fns.map((f) => f.endLine));
    for (const [lo, hi] of rs) {
      for (let l = lo; l <= Math.min(hi, last); l++) {
        const around = inner.filter((f) => f.line <= l && l <= f.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
        if (around) hit.set(`${around.name}:${around.line}`, around); else moduleLevel = true;
      }
    }
    const fns = [...hit.values()].map((f) => ({ name: f.name, line: f.line, count: f.count }));
    files.push({ file, code: true, loaded: true, ran: m.ran, moduleLevel, fns, uncalled: fns.filter((f) => f.count === 0).length });
  }
  return files;
}
