import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDevice, cleanDevice, DEVICE_FIELDS_MAX } from '../src/device.js';

const env = (nav, over = {}) => ({ navigator: nav, devicePixelRatio: 3, screen: { width: 430, height: 932 }, innerWidth: 932, innerHeight: 430, ...over });

test('an iPhone (Safari: no Client Hints) reads as mobile iOS from its UA', () => {
  const d = browserDevice(env({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5, hardwareConcurrency: 6, platform: 'iPhone' }));
  assert.deepEqual(d, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', platform: 'iOS', touch: 5, mobile: true,
    dpr: 3, screenW: 430, screenH: 932, vw: 932, vh: 430, cores: 6 });
});

test('an iPad asking for the desktop site (a Mac UA with touch points) is mobile iOS', () => {
  const d = browserDevice(env({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5, platform: 'MacIntel' }));
  assert.equal(d.platform, 'iOS');
  assert.equal(d.mobile, true);
});

test('Client Hints win where the browser gives them; a desktop Mac is desktop macOS', () => {
  const chromeAndroid = browserDevice(env({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', userAgentData: { platform: 'Android', mobile: true }, deviceMemory: 8 }));
  assert.equal(chromeAndroid.platform, 'Android');
  assert.equal(chromeAndroid.memGB, 8);
  const mac = browserDevice(env({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, { devicePixelRatio: 2 }));
  assert.equal(mac.platform, 'macOS');
  assert.equal(mac.mobile, false);
});

test('a browser that gives nothing yields nothing guessed, and a throwing getter keeps what was read', () => {
  assert.deepEqual(browserDevice({}), {});
  const nav = { userAgent: 'X', get maxTouchPoints() { throw new Error('no'); } };
  assert.deepEqual(browserDevice({ navigator: nav }), { ua: 'X' });
});

test('cleanDevice keeps flat, bounded fields only', () => {
  const many = Object.fromEntries(Array.from({ length: DEVICE_FIELDS_MAX + 5 }, (_, i) => [`f${i}`, i]));
  assert.equal(Object.keys(cleanDevice(many)).length, DEVICE_FIELDS_MAX);
  assert.deepEqual(cleanDevice({ a: 1, b: 'x', c: true, d: null, e: {}, f: [1], g: Number.NaN, 'h h!': 1, i: undefined }), { a: 1, b: 'x', c: true, d: null });
});
