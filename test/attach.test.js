// The pure halves of tier 0: profile top-frame extraction, cluster identity,
// and the inject-script assembly (parses, carries classify, no exports).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjectScript, clusterKey, topFramesFromProfile } from '../src/attach.mjs';

test('inject script assembles into parseable JS with classify inlined and no export tokens', () => {
  const s = buildInjectScript();
  new Function(s);                       // throws on syntax error
  assert.ok(s.includes('classifyHitch'));
  assert.ok(!/^export /m.test(s));
});

test('topFrames ranks by self time and drops idle/program/gc', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' } },
      { id: 2, callFrame: { functionName: '(idle)' } },
      { id: 3, callFrame: { functionName: 'buildWorld', url: 'https://x/game.min.js', lineNumber: 41 } },
      { id: 4, callFrame: { functionName: 'tinyHelper', url: 'https://x/game.min.js', lineNumber: 9 } },
    ],
    samples: [2, 3, 3, 3, 4],
    timeDeltas: [1000, 5000, 5000, 5000, 1000],
  };
  const top = topFramesFromProfile(profile);
  assert.equal(top[0].fn, 'buildWorld');
  assert.equal(top[0].url, 'game.min.js:42');
  assert.equal(top[0].selfMs, 15);
  assert.ok(!top.some((f) => f.fn === '(idle)'));
});

test('cluster identity: same cause = same key, different cause = different key', () => {
  const hitchA = { classification: [{ guess: 'long-script' }] };
  const hitchB = { classification: [{ guess: 'long-script' }] };
  const hitchC = { classification: [{ guess: 'shader-compile' }] };
  assert.equal(clusterKey(hitchA, 'buildWorld@game.min.js:42'), clusterKey(hitchB, 'buildWorld@game.min.js:42'));
  assert.notEqual(clusterKey(hitchA, 'buildWorld@game.min.js:42'), clusterKey(hitchA, 'other@x.js:1'));
  assert.notEqual(clusterKey(hitchA, 'x'), clusterKey(hitchC, 'x'));
});
