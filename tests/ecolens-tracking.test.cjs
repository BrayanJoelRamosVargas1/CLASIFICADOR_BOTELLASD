const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const BottleDetection = require('../js/bottle-detection.js');
const bottle = { class: 'bottle', score: 0.9, bbox: [10, 20, 50, 100] };

function engine(detect) {
  let now = 10000;
  class Clock extends Date { static now() { return now; } }
  const element = () => ({ style: {}, classList: { remove() {}, toggle() {} }, getContext: () => ({}) });
  const sandbox = { window: { BottleDetection }, navigator: {}, console, Date: Clock,
    document: { getElementById: element, querySelector: element, createElement: element, addEventListener() {} },
    cancelAnimationFrame() {}, clearTimeout() {} };
  const code = fs.readFileSync(require.resolve('../js/ecolens.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    const registrations = [];
    onNewBottlesRegistered = items => registrations.push(...items.map(x => x.id));
    globalThis.harness = {
      processVisualFrame, stopActiveSource, registrations,
      getTrackers: () => trackers,
      setSource: () => { activeSource = { width: 640, height: 480, readyState: 2 }; },
      setDetector: value => { detector = value; }
    };
  })();`);
  vm.runInNewContext(code, sandbox);
  sandbox.harness.setDetector({ detect });
  sandbox.harness.setSource();
  sandbox.harness.advanceTime = ms => { now += ms; };
  return sandbox.harness;
}

test('registers only after consecutive detections and counts a stationary bottle once', async () => {
  let predictions = [bottle];
  const h = engine(async () => predictions);
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 0);
  predictions = [];
  await h.processVisualFrame();
  predictions = [bottle];
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 0);
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
});
test('keeps two distinct bottles in independent tracks', async () => {
  const h = engine(async () => [bottle, { ...bottle, bbox: [150, 20, 50, 100] }]);
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 2);
});
test('does not recount after short detection losses, expires tracks by time', async () => {
  let predictions = [bottle];
  const h = engine(async () => predictions);
  await h.processVisualFrame();
  await h.processVisualFrame();
  predictions = [];
  for (let i = 0; i < 5; i++) { h.advanceTime(50); await h.processVisualFrame(); }
  predictions = [bottle];
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
  predictions = [];
  await h.processVisualFrame();
  h.advanceTime(1100);
  predictions = [bottle];
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 2);
});
test('slow inference still confirms and does not recount a continuously visible bottle', async () => {
  const h = engine(async () => [bottle]);
  await h.processVisualFrame();
  h.advanceTime(5000);
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
  h.advanceTime(5000);
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
});
test('serializes inference and discards results arriving after the source stopped', async () => {
  let resolve, calls = 0;
  const h = engine(() => { calls++; return new Promise(done => { resolve = done; }); });
  const pending = h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(calls, 1);
  h.stopActiveSource();
  resolve([bottle]);
  await pending;
  assert.equal(h.getTrackers().length, 0);
  assert.equal(h.registrations.length, 0);
});
test('ByteTrack stage-2 hysteresis continues an active bottle track when glare drops confidence to 0.16', async () => {
  let predictions = [{ ...bottle, score: 0.16 }];
  const h = engine(async () => predictions);
  // A low-score box alone never starts a new track
  await h.processVisualFrame();
  assert.equal(h.getTrackers().length, 0);
  // Frame 1 with high score starts the track
  predictions = [{ ...bottle, score: 0.45 }];
  await h.processVisualFrame();
  assert.equal(h.getTrackers().length, 1);
  assert.equal(h.registrations.length, 0);
  // Frame 2 dips to 0.16 due to glare on transparent PET bottle, but ByteTrack stage 2 confirms it
  predictions = [{ ...bottle, score: 0.16, bbox: [12, 22, 50, 100] }];
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
});

