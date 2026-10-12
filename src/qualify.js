// ============================================================
// qualify.js — which `update` is this? (SPEC §3.10, function identity)
// ============================================================
// V8 names a class method by its own name alone: Car.update,
// CarManager.update and TrainConsist.update all sample as `update`. The run
// file keeps them apart by position, but `compare` and `sweep` key functions
// by name and file — positions move between two builds — and in a bundle
// all three are `update@index.js`: one row, three costs, and a comparison
// that reads their mix as noise.
//
// So at the end of a run, for every name that more than one function of the
// same script answers to, the script's source is read once and each is
// qualified by its enclosing class (`Car.update`), or — outside any class —
// by its line (`update:812`). Names nobody shares stay as V8 gave them:
// they compare across builds as before.
//
// The scan is one linear pass with a brace stack, aware of strings,
// template literals, comments and (by the usual heuristic) regex literals.
// Pure: the pipeline fetches sources and renames.

const ID = /[A-Za-z0-9_$]/;
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** 0-based line/column → offset, for every position at once. */
function offsetsOf(src, positions) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return positions.map(([line, col]) => (line < starts.length ? starts[line] + col : Infinity));
}

/**
 * The innermost class enclosing each position.
 * @param {string} src
 * @param {[number, number][]} positions  0-based [line, column] (CDP callFrame)
 * @returns {(string|null)[]}  class name, or null (no class, or an anonymous one)
 */
export function enclosingClasses(src, positions) {
  const offs = offsetsOf(src, positions);
  const order = offs.map((o, i) => [o, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(positions.length).fill(null);
  let next = 0;
  // Brace stack: { cls: name | null, tpl: true when it closes a `${` }.
  const stack = [];
  // A `class` header seen, waiting for its body's `{`: [name, parenDepth].
  let pending = null, parens = 0;
  let prevTok = '';   // the last significant token, for the regex heuristic
  const n = src.length;
  let i = 0;
  const innermost = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].cls !== undefined && stack[k].cls !== false) return stack[k].cls; return null; };
  const settle = (upTo) => { while (next < order.length && order[next][0] <= upTo) { out[order[next][1]] = innermost(); next++; } };
  // Template literal body from i (just past the backtick or a closing `}`):
  // returns the index past its end, or pushes a `${` frame and returns there.
  const template = (j) => {
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') { stack.push({ cls: false, tpl: true }); return j + 2; }
      j++;
    }
    return n;
  };
  while (i < n && next < order.length) {
    settle(i);
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1; prevTok = 'str'; continue;
    }
    if (c === '`') { i = template(i + 1); prevTok = 'str'; continue; }
    if (c === '/' && (REGEX_AFTER.has(prevTok) || REGEX_KEYWORDS.has(prevTok))) {
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      while (i < n && ID.test(src[i])) i++;
      prevTok = 're'; continue;
    }
    if (ID.test(c)) {
      let j = i;
      while (j < n && ID.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'class' && src[i - 1] !== '.') {
        // `class Name extends Base {` — the name, if any, is the next identifier.
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        let name = null;
        if (ID.test(src[k] ?? '')) {
          let e = k;
          while (e < n && ID.test(src[e])) e++;
          const w = src.slice(k, e);
          if (w !== 'extends') name = w;
        }
        pending = [name, parens];
      }
      i = j; prevTok = word; continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') {
      if (pending && pending[1] === parens) { stack.push({ cls: pending[0] }); pending = null; }
      else stack.push({ cls: undefined });
    } else if (c === '}') {
      const top = stack.pop();
      if (top?.tpl) { i = template(i + 1); prevTok = 'str'; continue; }
    }
    if (!/\s/.test(c)) prevTok = c;
    i++;
  }
  settle(Infinity);
  return out;
}

/**
 * Names shared by more than one function of one script, from run-file
 * function rows ([fn, url, line, col, …]).
 * @returns {Map<string, Set<string>>}  url → names to qualify
 */
export function sharedNames(rowsList) {
  const seen = new Map();   // `${url}\t${fn}` → Set of positions
  for (const rows of rowsList) {
    for (const [fn, url, line, col] of rows) {
      if (!url || !fn || fn === '(anonymous)' || fn.includes('.')) continue;
      const k = `${url}\t${fn}`;
      (seen.get(k) ?? seen.set(k, new Set()).get(k)).add(`${line}:${col}`);
    }
  }
  const out = new Map();
  for (const [k, pos] of seen) {
    if (pos.size < 2) continue;
    const [url, fn] = k.split('\t');
    (out.get(url) ?? out.set(url, new Set()).get(url)).add(fn);
  }
  return out;
}

/** The qualified name: `Class.fn`, or `fn:line` (1-based) outside any class. */
export function qualifiedName(fn, cls, line0) {
  return cls ? `${cls}.${fn}` : `${fn}:${line0 + 1}`;
}
