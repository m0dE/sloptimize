// ============================================================
// proposals.mjs — the fix loop, in git and nothing else (SPEC §8.5)
// ============================================================
// A fix an agent wants to land is a PROPOSAL: a `sloptimize/<slug>` branch
// holding the change, and one entry in `.sloptimize/fixes.jsonl` naming the
// issue, the solution, the commit and the measured before/after. The
// debugger lists proposals with a status READ FROM GIT — proposed while the
// branch stands ahead of main, merged once its commit is an ancestor of
// main, rejected once the branch is gone — and offers merge / reject, which
// are a merge commit into main and a branch delete. There is no pull
// request, no forge API, no token: a repo with no remote works identically,
// and one with a remote gets the branch and main pushed.
//
// The status entries appended here (`fix-status`) are the audit trail; the
// live truth is git, and `listFixes` prefers it.
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export const NOT_A_REPO = "this project isn't a git repo — run `git init` (and commit) before sloptimize can propose or merge fixes";
export const AUTOMATION_LEVELS = ['propose', 'merge'];

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}
function tryGit(cwd, args) { try { return git(cwd, args); } catch { return null; } }

export function isGitRepo(repoDir) {
  return tryGit(repoDir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}
function requireRepo(repoDir) { if (!isGitRepo(repoDir)) throw new Error(NOT_A_REPO); }

/** The integration branch: `main` if it exists, else `master`, else the
 *  current branch. */
export function mainBranch(repoDir) {
  for (const b of ['main', 'master']) if (tryGit(repoDir, ['rev-parse', '--verify', '-q', `refs/heads/${b}`])) return b;
  return git(repoDir, ['branch', '--show-current']);
}
function hasRemote(repoDir) { return (tryGit(repoDir, ['remote']) ?? '') !== ''; }
const short = (sha) => sha.slice(0, 12);

export function slugOf(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'fix';
}

// ── ledger ──────────────────────────────────────────────────────────────────
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function append(dir, rec) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'fixes.jsonl'), JSON.stringify(rec) + '\n');
}
/** Fold fix entries and their status lines into one record per fix. */
function foldFixes(dir) {
  const byId = new Map();
  for (const r of readJsonl(join(dir, 'fixes.jsonl'))) {
    if (r.type === 'fix' && r.id) byId.set(r.id, { ...r });
    else if (r.type === 'fix-status' && byId.has(r.id)) Object.assign(byId.get(r.id), { status: r.status, statusAt: r.at, ...(r.mergeCommit ? { mergeCommit: r.mergeCommit } : {}) });
  }
  return [...byId.values()];
}

// ── settings ────────────────────────────────────────────────────────────────
export function readSettings(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return { automation: AUTOMATION_LEVELS.includes(s.automation) ? s.automation : 'propose' };
  } catch { return { automation: 'propose' }; }
}
export function writeSettings(dir, settings) {
  if (!AUTOMATION_LEVELS.includes(settings.automation)) throw new Error(`automation must be one of ${AUTOMATION_LEVELS.join(' | ')}`);
  mkdirSync(dir, { recursive: true });
  const next = { automation: settings.automation };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ── propose ─────────────────────────────────────────────────────────────────
/**
 * Turn the working tree's changes (or the current branch's unmerged commits)
 * into a proposal. `measure(records)` is optional: given, it returns the
 * measured before/after windows (history.buildFix); absent or throwing, the
 * proposal carries `before: null, after: null` — a fix may be proposed
 * before its after-data exists, and the numbers arrive when it is played.
 */
export function proposeFix(repoDir, dir, opts) {
  requireRepo(repoDir);
  if (!opts?.title) throw new Error('a proposal needs a title');
  const main = mainBranch(repoDir);
  // Dirty = anything outside the ledger dir itself. Match on the directory
  // boundary: a sibling file whose NAME starts with the dir's (".sloptimize-x")
  // is a change to propose, not the ledger.
  const ledgerRel = relative(repoDir, dir);
  const inLedger = (path) => !!ledgerRel && !ledgerRel.startsWith('..') && (path === ledgerRel || path.startsWith(ledgerRel + '/'));
  const dirty = git(repoDir, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .some((l) => !inLedger(l.slice(3).replace(/^"|"$/g, '')));
  const current = git(repoDir, ['branch', '--show-current']);
  let branch = opts.branch ?? (current.startsWith('sloptimize/') ? current : `sloptimize/${slugOf(opts.title)}`);
  if (!dirty) {
    const ahead = Number(tryGit(repoDir, ['rev-list', '--count', `${main}..HEAD`]) ?? 0);
    if (ahead === 0 || current === main) throw new Error('nothing to propose: the working tree is clean and HEAD is not ahead of ' + main);
    branch = opts.branch ?? current;   // already committed on a branch: propose that branch as it stands
  } else {
    if (current !== branch) {
      if (tryGit(repoDir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])) git(repoDir, ['checkout', '-q', branch]);
      else git(repoDir, ['checkout', '-q', '-b', branch]);
    }
    // Never stage the ledger itself, wherever it lives relative to the repo:
    // stage everything, then unstage the ledger dir (a no-op when, as in the
    // reference deployment, it is gitignored — an exclude pathspec on an
    // ignored path makes git refuse instead).
    git(repoDir, ['add', '-A']);
    const rel = relative(repoDir, dir);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) tryGit(repoDir, ['reset', '-q', '--', rel]);
    git(repoDir, ['commit', '-q', '-m', opts.message ?? opts.title]);
  }
  const commit = short(git(repoDir, ['rev-parse', branch]));
  const base = short(git(repoDir, ['merge-base', main, branch]));
  // The proposal lives on its branch; the checkout goes back to where the
  // agent was working. Its change has MOVED to the branch, so the tree is
  // clean on return — a session mid-ticket is not left parked on a
  // sloptimize/ branch it never asked for.
  if (dirty && current !== branch) git(repoDir, ['checkout', '-q', current]);
  let pushed = false;
  if (hasRemote(repoDir) && opts.push !== false) {
    try { git(repoDir, ['push', '-q', '-u', 'origin', branch]); pushed = true; } catch { pushed = false; }
  }
  let before = null, after = null;
  if (opts.measure) { try { ({ before, after } = opts.measure()); } catch { /* no evidence yet */ } }
  const fix = {
    type: 'fix', id: `${Date.now().toString(36)}-${slugOf(opts.title).slice(0, 24)}`,
    at: new Date().toISOString(), title: opts.title,
    ...(opts.issue ? { issue: opts.issue } : {}), ...(opts.solution ? { solution: opts.solution } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    branch, commit, base, main, from: current, pushed, status: 'proposed', before, after,
  };
  append(dir, fix);
  return fix;
}

// ── list ────────────────────────────────────────────────────────────────────
/** Every proposal with its status as git sees it now. */
export function listFixes(repoDir, dir) {
  if (!isGitRepo(repoDir)) return { repo: false, error: NOT_A_REPO, fixes: [] };
  const main = mainBranch(repoDir);
  const mainHead = git(repoDir, ['rev-parse', main]);
  const fixes = foldFixes(dir).map((f) => {
    if (!f.branch || !f.commit) return { ...f, status: f.status ?? 'recorded' };
    const branchHead = tryGit(repoDir, ['rev-parse', '--verify', '-q', `refs/heads/${f.branch}`]);
    const merged = tryGit(repoDir, ['merge-base', '--is-ancestor', f.commit, main]) !== null;
    let status = f.status;
    if (merged) status = 'merged';
    else if (!branchHead) status = f.status === 'rejected' ? 'rejected' : 'orphaned';
    else status = 'proposed';
    const mergeBase = branchHead ? tryGit(repoDir, ['merge-base', main, branchHead]) : null;
    const ahead = branchHead ? Number(tryGit(repoDir, ['rev-list', '--count', `${main}..${branchHead}`]) ?? 0) : 0;
    return { ...f, status, ahead, upToDate: mergeBase !== null && mergeBase === mainHead, head: branchHead ? short(branchHead) : null };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { repo: true, main, fixes };
}

// ── merge / reject ──────────────────────────────────────────────────────────
function findFix(dir, id) {
  const f = foldFixes(dir).find((x) => x.id === id);
  if (!f) throw new Error(`no proposal with id ${id}`);
  return f;
}

/** Merge a proposal into main with a merge commit; push main if a remote
 *  exists. Refuses anything that is not a plain, current, unmerged proposal:
 *  the direct-push-to-main class of accident is exactly what this must not
 *  be a new door for. */
export function mergeFix(repoDir, dir, id) {
  requireRepo(repoDir);
  const f = findFix(dir, id);
  const main = mainBranch(repoDir);
  if (tryGit(repoDir, ['merge-base', '--is-ancestor', f.commit, main]) !== null) throw new Error(`already merged: ${f.title}`);
  const current = git(repoDir, ['branch', '--show-current']);
  if (current !== main) throw new Error(`checkout is on '${current}', not '${main}' — merge from the ${main} checkout`);
  if (git(repoDir, ['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error(`the ${main} checkout has uncommitted changes — commit or discard them first`);
  const branchHead = tryGit(repoDir, ['rev-parse', '--verify', '-q', `refs/heads/${f.branch}`]);
  if (!branchHead) throw new Error(`branch ${f.branch} no longer exists`);
  if (hasRemote(repoDir)) { tryGit(repoDir, ['fetch', '-q', 'origin', main]); }
  const mainHead = git(repoDir, ['rev-parse', main]);
  const remoteMain = hasRemote(repoDir) ? tryGit(repoDir, ['rev-parse', `origin/${main}`]) : null;
  if (remoteMain && remoteMain !== mainHead) throw new Error(`local ${main} is not at origin/${main} — pull first`);
  if (git(repoDir, ['merge-base', main, branchHead]) !== mainHead) throw new Error(`proposal is not based on current ${main} — rebase ${f.branch} first`);
  git(repoDir, ['merge', '-q', '--no-ff', '-m', `Merge sloptimize fix: ${f.title}`, branchHead]);
  const mergeCommit = short(git(repoDir, ['rev-parse', 'HEAD']));
  let pushed = false;
  if (hasRemote(repoDir)) { try { git(repoDir, ['push', '-q', 'origin', main]); pushed = true; } catch { pushed = false; } }
  const status = { type: 'fix-status', id, at: new Date().toISOString(), status: 'merged', mergeCommit, pushed };
  append(dir, status);
  return status;
}

/** Delete a proposal's branch (locally, and on the remote if pushed). */
export function rejectFix(repoDir, dir, id) {
  requireRepo(repoDir);
  const f = findFix(dir, id);
  const main = mainBranch(repoDir);
  if (tryGit(repoDir, ['merge-base', '--is-ancestor', f.commit, main]) !== null) throw new Error(`already merged: ${f.title}`);
  const current = git(repoDir, ['branch', '--show-current']);
  if (current === f.branch) git(repoDir, ['checkout', '-q', f.from && f.from !== f.branch ? f.from : main]);
  tryGit(repoDir, ['branch', '-D', f.branch]);
  if (hasRemote(repoDir)) tryGit(repoDir, ['push', '-q', 'origin', '--delete', f.branch]);
  const status = { type: 'fix-status', id, at: new Date().toISOString(), status: 'rejected' };
  append(dir, status);
  return status;
}
