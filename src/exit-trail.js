// ============================================================
// exit-trail.js — how the previous page in this tab went away
// ============================================================
// A player "thrown back to the menu" is a page being replaced, and a page can
// be replaced three ways that look identical to them:
//
//   code-reload         the game asked (location.reload / a navigation), by name
//   browser-navigation  the page got its `pagehide`, but no code asked: a
//                       refresh gesture, the back gesture, the address bar
//   killed              no `pagehide` at all: the browser ended the process
//                       (out of memory, a renderer crash) — on a phone it then
//                       reloads the tab, and the game simply starts over
//
// No incident describes that: the page that could have reported it is gone.
// So every page keeps a short TRAIL in sessionStorage (it outlives a reload
// AND a killed process, and stays with the tab) — its last events, on its own
// clock — and the NEXT page reads what it finds, classifies it, and hands it
// on as one `page-exit` record naming the session that ended.
//
// The trail records for itself what any page has: `pagehide`, bfcache
// restores, visibility, viewport changes, uncaught errors and rejections, and
// taps on buttons. The host adds what only it knows through `crumb()` (a
// phase, a kick, a graphics loss), and leaves through `reload(reason)` /
// `navigate(url, reason)`, which write the reason first — the difference
// between "our code sent them away, from here" and "we did not".
//
// It is a SOURCE for the cloud sink (`drainRecords`), and its `session` is the
// one the sink should stamp (`createCloudSink({ session: trail.session })`),
// so the dead page's own records and its exit join on one id. Never throws
// into the host; with no sessionStorage it records nothing and reports nothing.

export const EXIT_VERDICTS = Object.freeze(['code-reload', 'browser-navigation', 'killed']);
export const MAX_CRUMBS = 40;
export const MAX_CRUMB_CHARS = 120;
const DEFAULT_KEY = 'sloptimize.exitTrail';
const UNSAFE = /[^0-9A-Za-z .,:;=+_()[\]/?!-]/g;
const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Classify a finished trail's crumbs. Pure. */
export function classifyExit(crumbs) {
  let reason = null, hid = false;
  for (const c of crumbs ?? []) {
    const m = /^\+[\d.]+s (reload|navigate) ?(.*)$/.exec(c);
    if (m) reason = `${m[1]} ${m[2]}`.trim();
    if (/^\+[\d.]+s pagehide\b/.test(c)) hid = true;
  }
  if (reason !== null) return { verdict: 'code-reload', reason };
  return { verdict: hid ? 'browser-navigation' : 'killed', reason: null };
}

export function createExitTrail(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : safeSessionStorage();
  const key = opts.key ?? DEFAULT_KEY;
  const now = opts.now ?? (() => Date.now());
  const target = opts.target ?? globalThis;
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  const perf = opts.performance ?? (typeof performance !== 'undefined' ? performance : null);
  const loc = opts.location ?? (typeof location !== 'undefined' ? location : null);
  const build = typeof opts.build === 'string' ? opts.build : null;
  /** Touches this far from the top of the viewport are recorded whatever they
   *  land on (0 = off): the one question a "the button does nothing" report
   *  asks is whether the touch reached the page at all, and what it hit. */
  const touchStripPx = Number.isFinite(opts.touchStripPx) ? opts.touchStripPx : 0;
  const session = typeof opts.session === 'string' && opts.session ? opts.session : mintSession();

  const previousTrail = read();
  let pending = previousTrail && previousTrail.session !== session ? toExit(previousTrail) : null;
  let taken = false;
  const trail = { session, build, t0: now(), last: now(), crumbs: [] };
  const off = [];

  function read() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const t = JSON.parse(raw);
      const ok = t && typeof t.session === 'string' && typeof t.t0 === 'number' && typeof t.last === 'number'
        && Array.isArray(t.crumbs) && t.crumbs.every((c) => typeof c === 'string');
      return ok ? t : null;
    } catch { return null; }
  }
  function persist() {
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify(trail)); } catch { /* full or blocked: the trail is best-effort */ }
  }
  function toExit(t) {
    let nav = null;
    try { nav = perf?.getEntriesByType?.('navigation')?.[0]?.type ?? null; } catch { /* ignore */ }
    const { verdict, reason } = classifyExit(t.crumbs);
    return {
      deadSession: t.session, deadBuild: typeof t.build === 'string' ? t.build : null,
      verdict, reason, livedMs: Math.max(0, Math.round(t.last - t.t0)), nav,
      crumbs: t.crumbs.slice(-MAX_CRUMBS),
    };
  }

  function crumb(kind, detail = '') {
    try {
      const t = now();
      const line = `+${((t - trail.t0) / 1000).toFixed(1)}s ${kind}${detail ? ` ${detail}` : ''}`;
      trail.crumbs.push(line.replace(UNSAFE, '').slice(0, MAX_CRUMB_CHARS));
      if (trail.crumbs.length > MAX_CRUMBS) trail.crumbs.splice(0, trail.crumbs.length - MAX_CRUMBS);
      trail.last = t;
      persist();
    } catch { /* never throw into the host */ }
  }

  const describe = (el) => {
    if (!el || typeof el.closest !== 'function') return '?';
    const own = el.closest('[id]');
    return `${String(el.tagName ?? '?').toLowerCase()}${own ? `(${own.id})` : ''}`;
  };
  const on = (t, type, fn, capture = false) => {
    if (!t?.addEventListener) return;
    const h = (e) => { try { fn(e); } catch { /* never throw into the host */ } };
    t.addEventListener(type, h, { capture, passive: true });
    off.push(() => t.removeEventListener?.(type, h, { capture }));
  };

  crumb('boot', `${target.innerWidth ?? '?'}x${target.innerHeight ?? '?'} ${doc?.visibilityState ?? '?'}`);
  on(target, 'pagehide', (e) => crumb('pagehide', `persisted=${e?.persisted ? 1 : 0}`));
  on(target, 'pageshow', (e) => { if (e?.persisted) crumb('pageshow', 'bfcache'); });
  on(doc, 'visibilitychange', () => crumb('visibility', doc.visibilityState));
  on(target, 'error', (e) => crumb('error', e?.message ?? ''));
  on(target, 'unhandledrejection', (e) => crumb('rejection', String(e?.reason?.message ?? e?.reason ?? '')));
  // Capture phase: a button's own handler may stop the click's propagation.
  on(target, 'click', (e) => { const b = e?.target?.closest?.('button, a, [role="button"]'); if (b) crumb('click', describe(b)); }, true);
  on(target, 'touchstart', (e) => {
    const t = e?.changedTouches?.[0];
    if (!t) return;
    const onControl = e.target?.closest?.('button, a, [role="button"]');
    if (!onControl && !(touchStripPx > 0 && t.clientY <= touchStripPx)) return;
    crumb('touch', `${Math.round(t.clientX)},${Math.round(t.clientY)} ${describe(e.target)}`);
  }, true);
  let resizeTimer = null;
  on(target, 'resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => crumb('viewport', `${target.innerWidth}x${target.innerHeight}`), 500);
  });

  return {
    /** This page's session: the id its exit will be reported under. */
    session,
    crumb,
    /** Reload, saying why first. */
    reload(reason) { crumb('reload', reason); loc?.reload?.(); },
    /** Navigate away, saying why first. */
    navigate(url, reason) { crumb('navigate', reason); loc?.assign?.(url); },
    /** The previous page's exit (null for the first page in a tab), for the host. */
    previous() { return pending ? { ...pending, crumbs: pending.crumbs.slice() } : null; },
    /** Cloud-sink source: the previous page's exit as ONE `page-exit` record, once. */
    drainRecords() {
      if (taken || !pending) return [];
      taken = true;
      return [{ type: 'page-exit', at: new Date(now()).toISOString(), session, ...pending }];
    },
    dispose() { for (const f of off.splice(0)) f(); if (resizeTimer) clearTimeout(resizeTimer); pending = null; },
  };
}

function safeSessionStorage() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

function mintSession() {
  const bytes = new Uint8Array(12);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += SESSION_ALPHABET[b % 62];
  return s;
}
