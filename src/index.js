// sloptimize — public in-page runtime surface (SPEC §1).
export { createRecorder } from './recorder.js';
export { buildCensus } from './census.js';
export { classifyHitch, reclassify, attributedGuess } from './classify.js';
export { createMotionMonitor } from './motion.js';
export { createErrorMonitor } from './errors.js';
export { createCloudSink } from './cloud-sink.js';
export { footprintOf, footprintKey, describeFootprint, canonicalContext, contextOfKey, FOOTPRINT_VERSION } from './footprint.js';
export { buildHistory, summarizeWindow, buildFix, latestBuilds, buildIssues, agoText, diffProfiles } from './history.js';
export { pendingAsks, ASK_KINDS } from './ask.js';
export { createPanel } from './panel.js';
