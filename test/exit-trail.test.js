import test from 'node:test';
import assert from 'node:assert/strict';
import { createExitTrail, classifyExit, MAX_CRUMBS } from '../src/exit-trail.js';

/** A tab: sessionStorage that survives page loads, and a fresh window per page. */
function tab() {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => store.delete(k) };
  let t = 1_790_000_000_000;
  const page = (nav = 'reload') => {
    const listeners = {};
    const target = {
      innerWidth: 932, innerHeight: 430,
      addEventListener: (k, f) => (listeners[k] ??= []).push(f), removeEventListener: () => {},
      fire: (k, ev = {}) => (listeners[k] ?? []).forEach((f) => f(ev)),
    };
    const doc = { visibilityState: 'visible', addEventListener: (k, f) => (listeners[`doc:${k}`] ??= []).push(f), removeEventListener: () => {} };
    const location = { reloads: 0, assigned: null, reload() { this.reloads++; }, assign(u) { this.assigned = u; } };
    const trail = createExitTrail({ storage, now: () => t, target, document: doc, location, build: 'b1',
      performance: { getEntriesByType: () => [{ type: nav }] }, touchStripPx: 60 });
    return { trail, target, location };
  };
  return { page, tick: (ms) => { t += ms; } };
}

test('classifyExit', () => {
  assert.deepEqual(classifyExit(['+1.0s boot', '+9.0s reload deploy-again', '+9.0s pagehide persisted=0']), { verdict: 'code-reload', reason: 'reload deploy-again' });
  assert.deepEqual(classifyExit(['+1.0s boot', '+31.0s pagehide persisted=0']), { verdict: 'browser-navigation', reason: null });
  assert.deepEqual(classifyExit(['+1.0s boot', '+20.0s launch done']), { verdict: 'killed', reason: null });
  assert.deepEqual(classifyExit([]), { verdict: 'killed', reason: null });
});

test('the first page in a tab has no exit to report', () => {
  const { page } = tab();
  const { trail } = page('navigate');
  assert.equal(trail.previous(), null);
  assert.deepEqual(trail.drainRecords(), []);
});

test('a page killed mid-match is reported by the next page as ONE page-exit record naming it', () => {
  const { page, tick } = tab();
  const a = page('navigate');
  tick(20_000); a.trail.crumb('launch', 'done');
  tick(15_000); a.trail.crumb('phase', 'play');
  // no pagehide: the process died
  tick(6_000);
  const b = page('reload');
  const recs = b.trail.drainRecords();
  assert.equal(recs.length, 1);
  assert.deepEqual({ ...recs[0], at: undefined, crumbs: undefined }, {
    type: 'page-exit', at: undefined, session: b.trail.session, deadSession: a.trail.session, deadBuild: 'b1',
    verdict: 'killed', reason: null, livedMs: 35_000, nav: 'reload', crumbs: undefined,
  });
  assert.deepEqual(recs[0].crumbs, ['+0.0s boot 932x430 visible', '+20.0s launch done', '+35.0s phase play']);
  assert.deepEqual(b.trail.drainRecords(), [], 'once');
  assert.equal(b.trail.previous().verdict, 'killed', 'the host can still read it');
});

test('a reload the code asked for is named; a bare pagehide is the browser', () => {
  const { page, tick } = tab();
  const a = page();
  tick(9_000); a.trail.reload('return-to-hangar'); a.target.fire('pagehide', { persisted: false });
  assert.equal(a.location.reloads, 1);
  const b = page();
  assert.deepEqual([b.trail.previous().verdict, b.trail.previous().reason], ['code-reload', 'reload return-to-hangar']);
  tick(4_000); b.target.fire('pagehide', { persisted: false });
  const c = page();
  assert.equal(c.trail.previous().verdict, 'browser-navigation');
});

test('taps on controls and in the top strip are recorded; clicks in the capture phase', () => {
  const { page } = tab();
  const a = page();
  const owner = { id: 'menu-btn' };
  const btn = { tagName: 'BUTTON', closest: (sel) => (sel.includes('button') ? btn : owner) };
  const button = { tagName: 'svg', closest: (sel) => (sel.includes('button') ? btn : owner) };
  const canvas = { tagName: 'CANVAS', closest: () => null };
  a.target.fire('touchstart', { target: button, changedTouches: [{ clientX: 18, clientY: 23 }] });
  a.target.fire('touchstart', { target: canvas, changedTouches: [{ clientX: 400, clientY: 30 }] });
  a.target.fire('touchstart', { target: canvas, changedTouches: [{ clientX: 400, clientY: 300 }] });
  a.target.fire('click', { target: button });
  const b = page();
  const crumbs = b.trail.previous().crumbs.join('\n');
  assert.match(crumbs, /touch 18,23 svg\(menu-btn\)/);
  assert.match(crumbs, /touch 400,30 canvas/);
  assert.doesNotMatch(crumbs, /400,300/);
  assert.match(crumbs, /click button\(menu-btn\)/);
});

test('the ring keeps the last MAX_CRUMBS; unsafe characters are stripped', () => {
  const { page } = tab();
  const a = page();
  for (let i = 0; i < MAX_CRUMBS + 10; i++) a.trail.crumb('tick', String(i));
  a.trail.crumb('error', 'boom <script>');
  const b = page();
  const crumbs = b.trail.previous().crumbs;
  assert.equal(crumbs.length, MAX_CRUMBS);
  assert.match(crumbs[crumbs.length - 1], /error boom script$/);
});

test('no storage: records nothing, reports nothing, never throws', () => {
  const t = createExitTrail({ storage: null, target: {}, document: null });
  t.crumb('x');
  assert.equal(t.previous(), null);
  assert.deepEqual(t.drainRecords(), []);
});
