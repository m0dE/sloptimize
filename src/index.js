// sloptimize — public in-page runtime surface (SPEC §1).
export { createRecorder } from './recorder.js';
export { buildCensus } from './census.js';
export { classifyHitch } from './classify.js';
export { createMotionMonitor } from './motion.js';
export { footprintOf, footprintKey, describeFootprint, canonicalContext, contextOfKey, FOOTPRINT_VERSION } from './footprint.js';
export { buildHistory, summarizeWindow, buildFix, latestBuilds, buildIssues, agoText } from './history.js';
export { createPanel } from './panel.js';
