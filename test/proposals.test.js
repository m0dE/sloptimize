// The fix loop, git only (SPEC §8.5 → proposals): an agent proposes a fix as
// a branch + a ledger entry; the debugger lists proposals with a status read
// from git; merge is a merge commit into main; reject deletes the branch.
// Exercised against throwaway repos — a local one, one with a bare remote,
// and a directory that is not a repo at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isGitRepo, proposeFix, listFixes, mergeFix, rejectFix, readSettings, writeSettings, NOT_A_REPO,
} from '../src/proposals.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo({ remote = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sloptimize-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  // As the real deployment has it: the ledger dir is inside the repo and ignored.
  writeFileSync(join(dir, '.gitignore'), '.sloptimize/\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  const ledger = join(dir, '.sloptimize'); mkdirSync(ledger);
  if (remote) {
    const bare = mkdtempSync(join(tmpdir(), 'sloptimize-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  return { dir, ledger };
}

test('a directory without git says so, in one recognisable message', () => {
  const d = mkdtempSync(join(tmpdir(), 'sloptimize-norepo-'));
  assert.equal(isGitRepo(d), false);
  assert.throws(() => proposeFix(d, join(d, '.sloptimize'), { title: 'x' }), (e) => e.message === NOT_A_REPO);
  assert.deepEqual(listFixes(d, join(d, '.sloptimize')), { repo: false, error: NOT_A_REPO, fixes: [] });
});

test('propose: current changes become a sloptimize/<slug> branch, a commit, and a ledger entry', () => {
  const { dir, ledger } = repo();
  writeFileSync(join(dir, 'a.txt'), 'fixed\n');
  const fix = proposeFix(dir, ledger, { title: 'Key batcher priced per build', issue: '656ms warm:post', solution: 'price by builds' });
  assert.equal(fix.status, 'proposed');
  assert.equal(fix.branch, 'sloptimize/key-batcher-priced-per-build');
  assert.match(fix.commit, /^[0-9a-f]{7,}$/);
  // The change moved to the proposal branch; the checkout is back where it
  // was, clean.
  assert.equal(git(dir, 'branch', '--show-current'), 'main');
  assert.equal(fix.from, 'main');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(git(dir, 'show', `${fix.branch}:a.txt`), 'fixed');
  assert.equal(fix.before, null, 'no ledger evidence yet → no before window, and that is not an error');
  const lines = readFileSync(join(ledger, 'fixes.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, fix.id);
  // Listed as proposed, based on current main, one commit ahead.
  const l = listFixes(dir, ledger);
  assert.equal(l.repo, true);
  assert.equal(l.fixes.length, 1);
  assert.equal(l.fixes[0].status, 'proposed');
  assert.equal(l.fixes[0].ahead, 1);
  assert.equal(l.fixes[0].upToDate, true);
});

test('a sibling file whose name merely starts with the ledger dir\'s is a change, not the ledger', () => {
  // Caught live: `.sloptimize-demo.txt` matched `.sloptimize` by prefix, the
  // tree read clean, and the proposal recorded the wrong branch.
  const { dir, ledger } = repo();
  writeFileSync(join(dir, '.sloptimize-demo.txt'), 'demo\n');
  const fix = proposeFix(dir, ledger, { title: 'Sibling' });
  assert.equal(fix.branch, 'sloptimize/sibling');
  assert.equal(git(dir, 'show', '--stat', '--format=', fix.branch).includes('.sloptimize-demo.txt'), true);
});

test('proposing from a ticket branch returns to that branch, and reject does too', () => {
  const { dir, ledger } = repo();
  git(dir, 'checkout', '-q', '-b', 'ticket-1');
  writeFileSync(join(dir, 'a.txt'), 'fixed\n');
  const fix = proposeFix(dir, ledger, { title: 'From a ticket' });
  assert.equal(fix.from, 'ticket-1');
  assert.equal(git(dir, 'branch', '--show-current'), 'ticket-1');
  git(dir, 'checkout', '-q', fix.branch);
  rejectFix(dir, ledger, fix.id);
  assert.equal(git(dir, 'branch', '--show-current'), 'ticket-1');
});

test('propose refuses with nothing to propose', () => {
  const { dir, ledger } = repo();
  assert.throws(() => proposeFix(dir, ledger, { title: 'nothing' }), /nothing to propose/);
});

test('merge: a merge commit into main, the branch kept, status merged; a second merge is refused', () => {
  const { dir, ledger } = repo();
  writeFileSync(join(dir, 'a.txt'), 'fixed\n');
  const fix = proposeFix(dir, ledger, { title: 'Fix one' });
  git(dir, 'checkout', '-q', 'main');
  const r = mergeFix(dir, ledger, fix.id);
  assert.equal(r.status, 'merged');
  assert.match(r.mergeCommit, /^[0-9a-f]{7,}$/);
  assert.equal(git(dir, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'fixed\n');
  assert.equal(git(dir, 'log', '-1', '--format=%P').split(' ').length, 2, 'a real merge commit, two parents');
  assert.equal(listFixes(dir, ledger).fixes[0].status, 'merged');
  assert.throws(() => mergeFix(dir, ledger, fix.id), /already merged/);
});

test('merge refuses a proposal that is not based on current main, and a checkout that is not on main', () => {
  const { dir, ledger } = repo();
  writeFileSync(join(dir, 'a.txt'), 'fixed\n');
  const fix = proposeFix(dir, ledger, { title: 'Stale' });
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'b.txt'), 'main moved\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main moved');
  assert.equal(listFixes(dir, ledger).fixes[0].upToDate, false);
  assert.throws(() => mergeFix(dir, ledger, fix.id), /not based on current main/);
  git(dir, 'checkout', '-q', fix.branch);
  assert.throws(() => mergeFix(dir, ledger, fix.id), /checkout is on/);
});

test('reject deletes the branch and stamps rejected; the ledger keeps the entry', () => {
  const { dir, ledger } = repo();
  writeFileSync(join(dir, 'a.txt'), 'bad idea\n');
  const fix = proposeFix(dir, ledger, { title: 'Bad idea' });
  git(dir, 'checkout', '-q', 'main');
  const r = rejectFix(dir, ledger, fix.id);
  assert.equal(r.status, 'rejected');
  assert.throws(() => git(dir, 'rev-parse', '--verify', fix.branch));
  const l = listFixes(dir, ledger);
  assert.equal(l.fixes[0].status, 'rejected');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a\n');
});

test('with a remote, propose pushes the branch and merge pushes main', () => {
  const { dir, ledger } = repo({ remote: true });
  writeFileSync(join(dir, 'a.txt'), 'fixed\n');
  const fix = proposeFix(dir, ledger, { title: 'Pushed fix' });
  assert.equal(fix.pushed, true);
  assert.equal(git(dir, 'rev-parse', `origin/${fix.branch}`), git(dir, 'rev-parse', fix.branch));
  git(dir, 'checkout', '-q', 'main');
  const r = mergeFix(dir, ledger, fix.id);
  assert.equal(r.pushed, true);
  assert.equal(git(dir, 'rev-parse', 'origin/main'), git(dir, 'rev-parse', 'main'));
});

test('a record-only fix (no branch, no id) still lists — as recorded, with a derived id', () => {
  const { dir, ledger } = repo();
  writeFileSync(join(ledger, 'fixes.jsonl'), JSON.stringify({ type: 'fix', at: '2026-08-28T10:00:00.000Z', title: 'Backfilled fix', commit: 'abc1234' }) + '\n');
  const l = listFixes(dir, ledger);
  assert.equal(l.fixes.length, 1);
  assert.equal(l.fixes[0].status, 'recorded');
  assert.match(l.fixes[0].id, /^rec-20260828100000000-backfilled-fix$/);
});

test('settings: default automation is propose; a saved level reads back', () => {
  const { ledger } = repo();
  assert.deepEqual(readSettings(ledger), { automation: 'propose' });
  writeSettings(ledger, { automation: 'merge' });
  assert.deepEqual(readSettings(ledger), { automation: 'merge' });
  assert.throws(() => writeSettings(ledger, { automation: 'yolo' }), /automation/);
  assert.ok(existsSync(join(ledger, 'settings.json')));
});

test('PR discovery from git alone: github origin parsed, pull heads matched by branch head or recorded commit', async () => {
  const { githubOrigin, parsePullRefs, matchPR } = await import('../src/proposals.mjs');
  assert.deepEqual(githubOrigin('git@github.com:m0dE/mecharoyale.git'), { owner: 'm0dE', repo: 'mecharoyale', url: 'https://github.com/m0dE/mecharoyale' });
  assert.deepEqual(githubOrigin('https://github.com/m0dE/mecharoyale'), { owner: 'm0dE', repo: 'mecharoyale', url: 'https://github.com/m0dE/mecharoyale' });
  assert.equal(githubOrigin('https://gitlab.com/x/y.git'), null);
  assert.equal(githubOrigin(null), null);
  const refs = parsePullRefs('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/pull/12/head\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/pull/650/head\nccc\trefs/heads/main\n');
  assert.deepEqual(refs, [{ number: 12, sha: 'a'.repeat(40) }, { number: 650, sha: 'b'.repeat(40) }]);
  const origin = githubOrigin('git@github.com:m0dE/mecharoyale.git');
  assert.deepEqual(matchPR({ commit: 'bbbbbbbbbbbb' }, refs, origin), { number: 650, url: 'https://github.com/m0dE/mecharoyale/pull/650' });
  assert.deepEqual(matchPR({ head: 'aaaaaaaaaaaa', commit: 'zzz' }, refs, origin), { number: 12, url: 'https://github.com/m0dE/mecharoyale/pull/12' });
  assert.equal(matchPR({ commit: 'ffffffffffff' }, refs, origin), null);
  assert.equal(matchPR({ commit: 'bbbbbbbbbbbb' }, refs, null), null);
});
