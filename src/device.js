// ============================================================
// device.js — what machine a session runs on (cloud ruling 36)
// ============================================================
// A frame time means little without the machine it was measured on: "10–15
// fps at the lowest setting" was a phone, and the cloud had no way to say so.
// This reads what the BROWSER will say about itself, as a flat map of named
// facts. The host adds what only it knows (its GPU as its renderer resolved
// it, its backend, its quality level, its drawing buffer) — see the cloud
// sink's `device` option.
//
// Identity-free by construction: no language, no timezone, no fonts, nothing
// that is not a performance fact. Every read is guarded — a field the browser
// will not give is absent, never guessed.

/** Longest string a device field may carry (the cloud refuses longer). */
export const DEVICE_STRING_MAX = 160;
/** Most fields a device record may carry (the cloud refuses more). */
export const DEVICE_FIELDS_MAX = 48;
const KEY = /^[A-Za-z][0-9A-Za-z_.:/?@ -]{0,39}$/;

const MOBILE_UA = /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone|Mobi/;

/**
 * The browser's own facts: `ua`, `platform`, `mobile`, `touch` (max touch
 * points), `dpr`, `screenW/H`, `vw/vh` (the viewport now), `cores` and
 * `memGB` (Chromium only). `mobile` prefers the UA Client Hints answer; an
 * iPad asking for the desktop site (a Mac UA with touch points) is mobile.
 */
export function browserDevice(env = globalThis) {
  const out = {};
  const nav = env.navigator;
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v; };
  try {
    const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
    put('ua', ua.slice(0, DEVICE_STRING_MAX));
    const hints = nav?.userAgentData;
    const touch = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : undefined;
    // An iPad asks for the desktop site by default: a Mac UA, but touch points no Mac has.
    const iPadAsMac = /Macintosh/.test(ua) && (touch ?? 0) > 1;
    put('platform', typeof hints?.platform === 'string' && hints.platform ? hints.platform : platformOf(ua, nav?.platform, iPadAsMac));
    put('touch', touch);
    // Absent, not false, when there is nothing to read it from.
    if (typeof hints?.mobile === 'boolean') put('mobile', hints.mobile);
    else if (ua) put('mobile', MOBILE_UA.test(ua) || /iPad|Android/.test(ua) || iPadAsMac);
    put('dpr', typeof env.devicePixelRatio === 'number' ? Math.round(env.devicePixelRatio * 100) / 100 : undefined);
    put('screenW', env.screen?.width);
    put('screenH', env.screen?.height);
    put('vw', env.innerWidth);
    put('vh', env.innerHeight);
    put('cores', nav?.hardwareConcurrency);
    put('memGB', nav?.deviceMemory);
  } catch { /* whatever was read before the throw stands */ }
  return out;
}

/** A platform name from the UA when Client Hints are absent (Safari, Firefox). */
function platformOf(ua, navPlatform, iPadAsMac) {
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsMac) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return typeof navPlatform === 'string' ? navPlatform.slice(0, 40) : undefined;
}

/**
 * A device map made safe for the wire: flat string/number/boolean/null values
 * under well-formed keys, strings cut to DEVICE_STRING_MAX, at most
 * DEVICE_FIELDS_MAX fields (the browser's first, then the host's). Anything
 * else is dropped, never thrown — a host passing an object is a wiring slip,
 * not a reason to lose the record.
 */
export function cleanDevice(map) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(map ?? {})) {
    if (n >= DEVICE_FIELDS_MAX || !KEY.test(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, DEVICE_STRING_MAX);
    else continue;
    n++;
  }
  return out;
}
