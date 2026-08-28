// ============================================================
// panel.js — the in-game perf debugger (SPEC §8.5): Session · Timeline · Fixes
// ============================================================
// The human's face of the ledger. The host (the game's dev runtime) owns the
// evidence and the transport; this module owns only the view:
//
//   SESSION   what the recorder caught since the tab opened (every row already
//             reached the agent when it happened) + the one-line note box.
//   TIMELINE  the deployment's history folded from perf.jsonl — frame p95,
//             draw calls and hitch spikes on ONE time axis, build boundaries
//             marked — so "is it better than yesterday" is a glance.
//   FIXES     the fix ledger: issue → solution, commit, date, and the MEASURED
//             before/after window of each, sparklined.
//
// No dependencies, no framework, no stylesheet: one root element with inline
// styles (the host page's CSS must not leak in, and ours must not leak out).
// Charts are inline SVG, one series per strip (never a dual axis), a shared
// crosshair, and the honest ceiling: a spike past the strip's ceiling is
// drawn AT the ceiling with a caret, and the readout says the real number.
import { buildHistory } from './history.js';

const C = {
  bg: 'rgba(8,12,20,0.94)', line: 'rgba(60,224,255,0.5)', ink: '#cfe6f5', dim: '#8fb4c4', mute: '#6f9db0',
  accent: '#3ce0ff', warn: '#ffb454', mark: '#ffd479', good: '#5fd68b', rule: 'rgba(207,230,245,0.14)',
  fill: 'rgba(60,224,255,0.10)', field: 'rgba(20,30,45,0.9)',
};
const FONT = '12px system-ui, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
// The panel is a FIXED-size window (PANEL_W × PANEL_H, clamped to the
// viewport) and its body scrolls: a panel sized to its content moved every
// time the content did — the timeline readout wrapping to a second line
// under the cursor shifted the strips the cursor was over (field, 2026-08-28).
// The strips' viewBox is drawn wide so the SVG fills the window at the same
// font proportions rather than scaling a small drawing up.
const PANEL_W = 1100, PANEL_H = 720;
const W = 1000, STRIP_H = 96, PAD_L = 52, PAD_R = 10;
const TABS = [['session', 'Session'], ['timeline', 'Timeline'], ['fixes', 'Fixes'], ['settings', 'Settings']];
/** The Fixes badge remembers what you have seen per browser. */
const SEEN_KEY = 'sloptimize.fixes.seen';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, unit = '') => (v === undefined || v === null ? '—' : `${typeof v === 'number' ? +v.toFixed(v >= 100 ? 0 : 1) : v}${unit}`);
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const el = (tag, style, html) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (html !== undefined) e.innerHTML = html; return e; };
const H = (s) => `<div style="letter-spacing:1px;color:${C.accent};font-size:11px;margin:10px 0 6px;text-transform:uppercase">${s}</div>`;

/** A strip: one series over the shared x axis. `kind` line|bars. Values may be
 *  undefined (unmeasured → a gap, never a zero). Ceiling = 1.5 × the 90th
 *  percentile, so one 500s freeze cannot flatten a week of 17ms. */
function strip(label, unit, values, kind, ticks) {
  const n = values.length, xw = (W - PAD_L - PAD_R) / Math.max(n, 1);
  const known = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (known.length === 0) return `<g><text x="${PAD_L}" y="${STRIP_H / 2}" fill="${C.mute}" font-size="10">${label}: unmeasured in this window</text></g>`;
  const p90 = known[Math.min(known.length - 1, Math.floor(known.length * 0.9))];
  const ceil = Math.max(p90 * 1.5, known[known.length - 1] * 0.0001, 1);
  const top = 8, bottom = STRIP_H - 6;
  const y = (v) => bottom - Math.min(v, ceil) / ceil * (bottom - top);
  const x = (i) => PAD_L + i * xw;
  let marks = '';
  if (kind === 'line') {
    let d = '', pen = false;
    values.forEach((v, i) => {
      if (typeof v !== 'number') { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${(x(i) + xw / 2).toFixed(1)} ${y(v).toFixed(1)} `; pen = true;
    });
    // Dots as well as the stroke: a session is minutes inside a window of
    // days, so many buckets are lone measurements a stroke cannot show.
    const dots = values.map((v, i) => (typeof v === 'number' ? `<circle cx="${(x(i) + xw / 2).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.6" fill="${C.accent}"/>` : '')).join('');
    marks = `<path d="${d}" fill="none" stroke="${C.accent}" stroke-width="1.5" stroke-linejoin="round"/>${dots}`;
  } else {
    values.forEach((v, i) => {
      if (typeof v !== 'number' || v <= 0) return;
      marks += `<rect x="${(x(i) + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(xw - 2, 1).toFixed(1)}" height="${(bottom - y(v)).toFixed(1)}" fill="${C.warn}" rx="1"/>`;
    });
  }
  // Past the ceiling: drawn at the ceiling, flagged with a caret.
  const carets = values.map((v, i) => (typeof v === 'number' && v > ceil
    ? `<path d="M${(x(i) + xw / 2 - 3).toFixed(1)} ${top + 4} l3 -4 l3 4z" fill="${kind === 'line' ? C.accent : C.warn}"/>` : '')).join('');
  const tickLines = ticks.map((i) => `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${top - 4}" y2="${bottom}" stroke="${C.rule}" stroke-dasharray="2 3"/>`).join('');
  return `<g>
    <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${bottom}" y2="${bottom}" stroke="${C.rule}"/>
    ${tickLines}${marks}${carets}
    <text x="${PAD_L - 6}" y="${top + 4}" text-anchor="end" fill="${C.mute}" font-size="9" font-family="${MONO}">${num(ceil, unit)}</text>
    <text x="${PAD_L - 6}" y="${bottom}" text-anchor="end" fill="${C.mute}" font-size="9" font-family="${MONO}">0</text>
    <text x="${PAD_L + 4}" y="${top + 3}" fill="${C.dim}" font-size="10">${label}</text>
  </g>`;
}

/** A card's sparkline: the window's per-slice p95, one pen stroke. */
function spark(series, color) {
  if (!series || series.length < 2) return `<svg width="120" height="28"><text x="0" y="18" fill="${C.mute}" font-size="10">no series</text></svg>`;
  const max = Math.max(...series, 1), xw = 120 / (series.length - 1);
  const d = series.map((v, i) => `${i ? 'L' : 'M'}${(i * xw).toFixed(1)} ${(26 - v / max * 22).toFixed(1)}`).join(' ');
  return `<svg width="120" height="28" viewBox="0 0 120 28"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

/** before → after for one metric: the after value, and the change, colored by
 *  whether it moved the right way (every metric here is lower-is-better). */
function delta(b, a, unit) {
  if (typeof b !== 'number' || typeof a !== 'number') return `<span style="color:${C.mute}">${num(a, unit)}</span>`;
  if (b === 0 && a === 0) return num(a, unit);
  const pct = b === 0 ? null : Math.round((a - b) / b * 100);
  const better = a < b, same = a === b;
  const col = same ? C.dim : better ? C.good : C.warn;
  const arrow = same ? '' : better ? '▼' : '▲';
  return `${num(a, unit)} <span style="color:${col};font-size:10px">${arrow}${pct === null ? '' : `${Math.abs(pct)}%`}</span>`;
}

function renderTimeline(h) {
  if (!h || !h.span) return `<div style="color:${C.dim};padding:12px 0">No history yet — the timeline fills as the recorder posts heartbeats and hitches. Play for a minute.</div>`;
  const b = h.buckets;
  // Build boundaries as dashed hairlines — but a dev day ships thirty
  // bundles, and thirty hairlines is texture, not information: past 12 the
  // count is said in words instead.
  let ticks = []; let prev;
  b.forEach((k, i) => { if (k.build && k.build !== prev) { if (prev !== undefined) ticks.push(i); prev = k.build; } });
  if (ticks.length > 12) ticks = [];
  const svg = `<svg id="sl-strips" viewBox="0 0 ${W} ${STRIP_H * 3 + 14}" width="100%" style="display:block;font-family:${FONT}">
    ${strip('frame p95', 'ms', b.map((k) => k.p95Ms), 'line', ticks)}
    <g transform="translate(0 ${STRIP_H})">${strip('draw calls', '', b.map((k) => k.calls), 'line', ticks)}</g>
    <g transform="translate(0 ${STRIP_H * 2})">${strip('hitches', '', b.map((k) => k.hitches), 'bars', ticks)}</g>
    <line id="sl-x" x1="0" x2="0" y1="4" y2="${STRIP_H * 3 - 6}" stroke="${C.ink}" stroke-opacity="0.5" visibility="hidden"/>
    <text x="${PAD_L}" y="${STRIP_H * 3 + 10}" fill="${C.mute}" font-size="9" font-family="${MONO}">${esc(when(h.span.from))}</text>
    <text x="${W - PAD_R}" y="${STRIP_H * 3 + 10}" text-anchor="end" fill="${C.mute}" font-size="9" font-family="${MONO}">${esc(when(h.span.to))}</text>
  </svg>`;
  const last = h.builds[h.builds.length - 1], first = h.builds[0];
  const summary = last ? `<div style="display:flex;gap:18px;font-family:${MONO};font-size:11px;color:${C.dim};margin-top:4px">
      <span>now <b style="color:${C.ink}">${esc(last.build)}</b></span>
      <span>p95 ${delta(first?.p95Ms, last.p95Ms, 'ms')}</span>
      <span>calls ${delta(first?.calls, last.calls)}</span>
      <span>hitches/h ${delta(first?.hitchesPerHour, last.hitchesPerHour)}</span>
      <span style="color:${C.mute}">vs first build in window · ${h.builds.length} builds${ticks.length ? ' · dashed = new build' : ''}</span></div>` : '';
  // ONE line, fixed height, clipped: the readout under the cursor must never
  // change the layout above it, or the crosshair chases a moving target.
  return `${svg}<div id="sl-read" style="height:18px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:${MONO};font-size:11px;color:${C.dim};padding:0 0 0 ${PAD_L * 100 / W}%">hover the strips</div>${summary}`;
}

function renderFixes(h, list) {
  // `list` is the git-backed proposal list (host.fixes): status per fix as
  // git sees it, merge/reject verbs. `h.fixes` is the measured ledger the
  // timeline folds; the two meet on `id` / commit.
  if (list && list.repo === false) {
    return `<div style="color:${C.warn};padding:12px 0;line-height:1.5">${esc(list.error || "this project isn't a git repo")}</div>`;
  }
  const fixes = list?.fixes?.length ? list.fixes : (h?.fixes ?? []);
  if (fixes.length === 0) return `<div style="color:${C.dim};padding:12px 0;line-height:1.5">No fixes proposed yet. When a Claude Code session has a fix, it proposes it as a branch and records it here with the measured before/after:<br><code style="font-family:${MONO};color:${C.ink}">sloptimize fix propose --title "…" --issue "…" --solution "…"</code></div>`;
  const row = (label, b, a, unit) => `<tr><td style="color:${C.mute};padding:1px 8px 1px 0">${label}</td><td style="text-align:right;padding:1px 8px">${num(b, unit)}</td><td style="text-align:right">${delta(b, a, unit)}</td></tr>`;
  const badge = (st) => {
    const col = st === 'merged' ? C.good : st === 'proposed' ? C.accent : st === 'rejected' ? C.mute : C.warn;
    return `<span style="font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${col};border:1px solid ${col};border-radius:3px;padding:1px 6px">${esc(st)}</span>`;
  };
  const btn = (id, action, label, color) => `<button data-fix="${esc(id)}" data-action="${action}" type="button" style="background:none;border:1px solid ${color};color:${color};border-radius:4px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer">${label}</button>`;
  return fixes.map((f) => `<div style="border-top:1px solid ${C.rule};padding:10px 0" data-fix-row="${esc(f.id ?? '')}">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
      <div style="color:${C.ink};font-size:13px;display:flex;gap:10px;align-items:baseline">${badge(f.status ?? 'recorded')} ${esc(f.title)}</div>
      <div style="font-family:${MONO};font-size:10px;color:${C.mute};white-space:nowrap">${esc(when(f.at))}${f.branch ? ` · ${esc(f.branch)}` : ''}${f.commit ? ` @ <span style="color:${C.ink}">${esc(f.commit)}</span>` : ''}${f.mergeCommit ? ` → ${esc(f.mergeCommit)}` : ''}</div>
    </div>
    ${f.issue ? `<div style="color:${C.dim};margin-top:4px"><span style="color:${C.warn}">was</span> ${esc(f.issue)}</div>` : ''}
    ${f.solution ? `<div style="color:${C.dim};margin-top:2px"><span style="color:${C.good}">now</span> ${esc(f.solution)}</div>` : ''}
    <div style="display:flex;gap:18px;margin-top:8px;align-items:flex-start">
      <div style="font-family:${MONO};font-size:10px;color:${C.mute}">before<br>${spark(f.before?.series, C.warn)}<br>${esc(f.before?.build ?? (f.before ? when(f.before.from) : 'not measured yet'))}</div>
      <div style="font-family:${MONO};font-size:10px;color:${C.mute}">after<br>${spark(f.after?.series, C.good)}<br>${esc(f.after?.build ?? (f.after ? when(f.after.from) : 'not measured yet'))}</div>
      <table style="font-family:${MONO};font-size:11px;color:${C.ink};border-collapse:collapse;margin-left:auto">
        <tr style="color:${C.mute};font-size:10px"><td></td><td style="text-align:right;padding:0 8px">before</td><td style="text-align:right">after</td></tr>
        ${row('frame p95', f.before?.p95Ms, f.after?.p95Ms, 'ms')}
        ${row('draw calls', f.before?.calls, f.after?.calls)}
        ${row('hitches/h', f.before?.hitchesPerHour, f.after?.hitchesPerHour)}
        ${row('worst frame', f.before?.worstMs, f.after?.worstMs, 'ms')}
      </table>
    </div>
    ${f.status === 'proposed' ? `<div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      ${f.upToDate === false ? `<span style="font-size:10px;color:${C.warn}">behind ${esc(list?.main ?? 'main')} — rebase before merging</span>` : btn(f.id, 'merge', 'Merge', C.good)}
      ${btn(f.id, 'reject', 'Reject', C.mute)}
      <span data-fix-msg="${esc(f.id)}" style="font-size:10px;color:${C.warn}"></span></div>` : ''}
  </div>`).join('');
}

function renderSettings(settings, list) {
  const s = settings ?? { automation: 'propose' };
  const opt = (v, label, help) => `<label style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;cursor:pointer">
      <input type="radio" name="sl-automation" value="${v}" ${s.automation === v ? 'checked' : ''} style="margin-top:3px">
      <span><b style="color:${C.ink}">${label}</b><br><span style="color:${C.dim}">${help}</span></span></label>`;
  return `${H('Automation')}
    <div style="color:${C.dim};margin-bottom:6px">How far a Claude Code session goes on its own when it has a verified fix. Saved server-side in <code style="font-family:${MONO}">.sloptimize/settings.json</code>; sessions read it before acting.</div>
    ${opt('propose', 'Propose', 'Branch + commit + ledger entry. You merge or reject from the Fixes tab.')}
    ${opt('merge', 'Merge', 'Propose, then merge into main itself once its tests are green. A merge is always a merge commit of a branch based on current main — never a rewritten tree.')}
    <div id="sl-settings-msg" style="font-size:11px;color:${C.mute};min-height:16px;margin-top:6px">${list && list.repo === false ? esc(list.error) : ''}</div>`;
}

function renderSession(host) {
  const inc = host.incidents?.() ?? [];
  const now = host.now?.() ?? performance.now();
  const rows = inc.slice(-12).map((i) => {
    const ago = Math.round((now - i.at) / 1000);
    const agoTxt = ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    const ph = i.phase ? `<span style="color:${C.mute}">[${esc(i.phase)}]</span> ` : '';
    return `<div style="padding:2px 0;color:${i.manual ? C.mark : C.ink}">${i.manual ? '★' : '·'} ${agoTxt} — ${ph}${Math.round(i.frameMs)}ms → <b>${esc(i.guess)}</b> <span style="color:${C.dim}">${esc(String(i.evidence).slice(0, 64))}</span></div>`;
  }).join('');
  const feed = host.feed?.() ?? { state: 'ok' };
  const feedLine = feed.state === 'ok'
    ? `<div style="font-size:10px;color:${C.good}">feed: live — incidents reach Claude Code as they happen</div>`
    : `<div style="font-size:10px;color:${C.warn}">feed: DARK ${feed.darkForS !== undefined ? `${feed.darkForS}s` : ''} — ${esc(feed.reason)}; recording continues, ${feed.buffered ?? 0} post(s) buffered for retry</div>`;
  return `${feedLine}${H(`incidents this session (${inc.length} logged${feed.state === 'ok' ? ', all already sent to Claude Code' : ' — feed dark, buffered'})`)}
    <div id="sl-list" style="font-size:11.5px;font-variant-numeric:tabular-nums">${rows || `<div style="color:${C.dim}">none yet — the recorder is watching</div>`}</div>`;
}

/**
 * @param host {{
 *   incidents?: () => Array<{at:number, frameMs:number, guess:string, evidence:string, manual:boolean, phase?:string}>,
 *   feed?: () => {state:'ok'|'dark', reason?:string, buffered?:number, darkForS?:number},
 *   history?: () => Promise<{records:object[], fixes?:object[]} | ReturnType<typeof buildHistory> | null>,
 *   onNote: (note: string|null) => void,   // called exactly once per open, on close
 *   now?: () => number,
 * }}
 */
export function createPanel(host) {
  let root = null, input = null, body = null, tab = 'session', histCache = null;

  function close(note) {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', swallow, true);
    root.remove(); root = null; input = null; body = null;
    host.onNote(note);
  }
  const submit = () => close(input?.value.trim() || null);
  const swallow = (e) => { e.stopPropagation(); };
  function onKey(e) {
    e.stopPropagation();                                   // WASD must not walk the mech
    if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
    if (e.key === 'Enter' && e.target === input) { e.preventDefault(); submit(); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target?.dataset?.tab) {
      const i = TABS.findIndex(([k]) => k === tab);
      show(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0], true);
    }
  }

  function show(next, focusTab = false) {
    tab = next;
    for (const b of root.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.style.color = on ? C.accent : C.mute;
      b.style.borderBottomColor = on ? C.accent : 'transparent';
      if (on && focusTab) b.focus();
    }
    if (tab === 'session') { body.innerHTML = renderSession(host); const l = body.querySelector('#sl-list'); if (l) l.scrollTop = l.scrollHeight; return; }
    body.innerHTML = `<div style="color:${C.dim};padding:12px 0">loading the ledger…</div>`;
    if (tab === 'settings') {
      Promise.all([loadSettings(), loadFixes()]).then(([st, list]) => {
        if (!root || tab !== next) return;
        body.innerHTML = renderSettings(st, list);
        wireSettings();
      });
      return;
    }
    Promise.all([loadHistory(), tab === 'fixes' ? loadFixes() : null]).then(([h, list]) => {
      if (!root || (tab !== next)) return;
      body.innerHTML = tab === 'timeline' ? renderTimeline(h) : renderFixes(h, list);
      if (tab === 'timeline') wireCrosshair(h);
      if (tab === 'fixes') { wireFixButtons(); markSeen(list); }
    });
  }

  let fixesCache = null, settingsCache = null;
  function loadFixes() {
    if (fixesCache) return Promise.resolve(fixesCache);
    if (!host.fixes) return Promise.resolve(null);
    return Promise.resolve().then(() => host.fixes()).then((l) => { fixesCache = l; updateBadge(l); return l; }).catch(() => null);
  }
  function loadSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    if (!host.settings) return Promise.resolve(null);
    return Promise.resolve().then(() => host.settings()).then((s) => { settingsCache = s; return s; }).catch(() => null);
  }
  // ── the Fixes badge: proposals you have not looked at yet ──
  function seenIds() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
  function markSeen(list) {
    if (!list?.fixes) return;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(list.fixes.map((f) => f.id).filter(Boolean).slice(0, 500))); } catch { /* storage may be unavailable */ }
    updateBadge(list);
  }
  function updateBadge(list) {
    const b = root?.querySelector('[data-tab="fixes"] [data-badge]');
    if (!b) return;
    const seen = seenIds();
    const fresh = (list?.fixes ?? []).filter((f) => f.status === 'proposed' && !seen.has(f.id)).length;
    b.textContent = fresh ? String(fresh) : '';
    b.style.display = fresh ? 'inline-block' : 'none';
  }
  function wireFixButtons() {
    for (const b of body.querySelectorAll('button[data-fix]')) {
      b.onclick = () => {
        const id = b.dataset.fix, action = b.dataset.action;
        if (action === 'merge' && !window.confirm('Merge this fix into main?')) return;
        const msg = body.querySelector(`[data-fix-msg="${CSS.escape(id)}"]`);
        for (const x of body.querySelectorAll(`button[data-fix="${CSS.escape(id)}"]`)) x.disabled = true;
        if (msg) { msg.style.color = C.dim; msg.textContent = `${action === 'merge' ? 'merging' : 'rejecting'}…`; }
        Promise.resolve().then(() => host.fixAction(id, action)).then((r) => {
          fixesCache = null; histCache = null;
          if (r && r.error) { if (msg) { msg.style.color = C.warn; msg.textContent = r.error; } for (const x of body.querySelectorAll(`button[data-fix="${CSS.escape(id)}"]`)) x.disabled = false; return; }
          show('fixes');
        }).catch((e) => { if (msg) { msg.style.color = C.warn; msg.textContent = String(e?.message ?? e); } });
      };
    }
  }
  function wireSettings() {
    for (const r of body.querySelectorAll('input[name="sl-automation"]')) {
      r.onchange = () => {
        const msg = body.querySelector('#sl-settings-msg');
        if (msg) { msg.style.color = C.dim; msg.textContent = 'saving…'; }
        Promise.resolve().then(() => host.saveSettings({ automation: r.value })).then((s) => {
          settingsCache = s && !s.error ? s : null;
          if (msg) { msg.style.color = s?.error ? C.warn : C.good; msg.textContent = s?.error ? s.error : `saved — automation: ${s.automation}`; }
        }).catch((e) => { if (msg) { msg.style.color = C.warn; msg.textContent = String(e?.message ?? e); } });
      };
    }
  }

  function loadHistory() {
    if (histCache) return Promise.resolve(histCache);
    if (!host.history) return Promise.resolve(null);
    return Promise.resolve().then(() => host.history()).then((raw) => {
      if (!raw) return null;
      histCache = raw.buckets ? raw : buildHistory(raw.records ?? [], { fixes: raw.fixes ?? [], buckets: 72 });
      return histCache;
    }).catch(() => null);
  }

  function wireCrosshair(h) {
    const svg = body.querySelector('#sl-strips'), x = body.querySelector('#sl-x'), read = body.querySelector('#sl-read');
    if (!svg || !h?.buckets?.length) return;
    const n = h.buckets.length, xw = (W - PAD_L - PAD_R) / n;
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = (e.clientX - r.left) / r.width * W;
      const i = Math.floor((vx - PAD_L) / xw);
      if (i < 0 || i >= n) { x.setAttribute('visibility', 'hidden'); return; }
      const k = h.buckets[i], cx = (PAD_L + i * xw + xw / 2).toFixed(1);
      x.setAttribute('x1', cx); x.setAttribute('x2', cx); x.setAttribute('visibility', 'visible');
      read.textContent = `${when(k.from)}  p95 ${num(k.p95Ms, 'ms')}  calls ${num(k.calls)}  hitches ${k.hitches}${k.worstMs ? ` (worst ${num(k.worstMs, 'ms')} ${k.worstGuess ?? ''})` : ''}${k.build ? `  build ${k.build}` : ''}`;
    });
    svg.addEventListener('mouseleave', () => { x.setAttribute('visibility', 'hidden'); read.textContent = 'hover the strips'; });
  }

  return {
    open() {
      if (root) return;
      root = el('div', `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;`
        + `width:${PANEL_W}px;max-width:calc(100vw - 24px);height:${PANEL_H}px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;`
        + `background:${C.bg};border:1px solid ${C.line};border-radius:8px;padding:12px 18px;font:${FONT};color:${C.ink};box-shadow:0 4px 24px rgba(0,0,0,0.6);box-sizing:border-box`);
      root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'sloptimize perf debugger');
      const tabs = el('div', `display:flex;gap:2px;border-bottom:1px solid ${C.rule};margin:0 0 6px`);
      tabs.setAttribute('role', 'tablist');
      for (const [k, label] of TABS) {
        const b = el('button', `background:none;border:0;border-bottom:2px solid transparent;color:${C.mute};font:inherit;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px 6px;cursor:pointer;margin-bottom:-1px`,
          k === 'fixes' ? `${label} <span data-badge style="display:none;background:${C.accent};color:#06101a;border-radius:9px;padding:0 6px;font-size:10px;letter-spacing:0;vertical-align:1px"></span>` : label);
        b.dataset.tab = k; b.setAttribute('role', 'tab'); b.type = 'button';
        b.onclick = () => show(k);
        b.onfocus = () => { b.style.outline = `1px solid ${C.accent}`; b.style.outlineOffset = '-1px'; };
        b.onblur = () => { b.style.outline = 'none'; };
        tabs.appendChild(b);
      }
      // The title leads, top-left, ahead of the tabs (admin, 2026-08-28).
      const brand = el('span', `align-self:center;margin-right:14px;font-size:11px;letter-spacing:2px;color:${C.accent}`, 'SLOPTIMIZE');
      tabs.prepend(brand);
      // The body is the ONLY thing that scrolls; the tabs above and the
      // keyframe prompt below hold their place whatever the tab contains.
      body = el('div', 'overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;padding-right:6px');
      const ask = el('div', '', H('Describe what you just saw to save a keyframe <span style="color:' + C.dim + ';text-transform:none;letter-spacing:0">(Enter sends · Esc just closes)</span>'));
      input = el('input', `width:100%;box-sizing:border-box;background:${C.field};border:1px solid rgba(120,150,190,0.4);border-radius:4px;color:#e8f0ff;padding:6px 8px;font:13px system-ui,sans-serif;outline:none`);
      input.type = 'text'; input.maxLength = 200; input.placeholder = 'e.g. huge stutter when the buildings loaded';
      input.onfocus = () => { input.style.borderColor = C.accent; }; input.onblur = () => { input.style.borderColor = 'rgba(120,150,190,0.4)'; };
      root.append(tabs, body, ask, input);
      document.body.appendChild(root);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('keyup', swallow, true);
      show(tab);
      loadFixes();   // the badge counts unseen proposals whichever tab is open
      input.focus();
    },
    close: () => close(null),
    submit,
    isOpen: () => root !== null,
    /** Forget the folded ledger so the next open re-fetches it. */
    refresh() { histCache = null; fixesCache = null; settingsCache = null; },
  };
}
