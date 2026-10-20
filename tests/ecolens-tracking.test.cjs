const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const BottleDetection = require('../js/bottle-detection.js');
const bottle = { class: 'bottle', score: 0.9, bbox: [10, 20, 50, 100] };

function engine(detect) {
  let now = 10000;
  class Clock extends Date { static now() { return now; } }
  const mockCtx = {
    clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {},
    fill() {}, stroke() {}, rect() {}, roundRect() {}, fillText() {},
    measureText: () => ({ width: 10 }), drawImage() {}, setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} })
  };
  const element = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getContext: () => mockCtx,
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    play: async () => {},
    textContent: ''
  });
  const sandbox = { window: { BottleDetection }, navigator: {}, console, Date: Clock,
    performance: globalThis.performance || { now: () => Date.now() },
    document: { getElementById: element, querySelector: element, createElement: element, addEventListener() {} },
    requestAnimationFrame: (cb) => 1,
    cancelAnimationFrame() {}, clearTimeout() {}, setTimeout: (cb) => { cb(); return 1; } };
  const code = fs.readFileSync(require.resolve('../js/ecolens.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    const registrations = [];
    onNewBottlesRegistered = items => registrations.push(...items.map(x => x.id));
    globalThis.harness = {
      processVisualFrame, stopActiveSource, startCamera, toggleTorch, forceManualScan, registrations,
      getTrackers: () => trackers,
      getDom: () => dom,
      getIsCameraStarting: () => isCameraStarting,
      getStream: () => stream,
      setSource: () => { activeSource = { width: 640, height: 480, readyState: 2 }; },
      clearSource: () => { activeSource = null; },
      setDetector: value => { detector = value; }
    };
  })();`);
  vm.runInNewContext(code, sandbox);
  sandbox.harness.sandbox = sandbox;
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
test('ByteTrack stage-2 hysteresis continues an active bottle track when glare drops confidence to 0.13', async () => {
  let predictions = [{ ...bottle, score: 0.13 }];
  const h = engine(async () => predictions);
  // A low-score box alone never starts a new track
  await h.processVisualFrame();
  assert.equal(h.getTrackers().length, 0);
  // Frame 1 with high score starts the track
  predictions = [{ ...bottle, score: 0.45 }];
  await h.processVisualFrame();
  assert.equal(h.getTrackers().length, 1);
  assert.equal(h.registrations.length, 0);
  // Frame 2 dips to 0.13 due to glare on transparent PET bottle, but ByteTrack stage 2 confirms it
  predictions = [{ ...bottle, score: 0.13, bbox: [12, 22, 50, 100] }];
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
});

test('tracks two neighboring bottles simultaneously without merging when introduced sequentially', async () => {
  let predictions = [{ ...bottle, bbox: [50, 100, 60, 150] }];
  const h = engine(async () => predictions);
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 1);
  assert.equal(h.getTrackers().length, 1);

  // Frame 3: second bottle placed 90px away
  predictions = [
    { ...bottle, bbox: [50, 100, 60, 150] },
    { ...bottle, bbox: [160, 100, 60, 150] }
  ];
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 2);
  assert.equal(h.getTrackers().length, 2);
});

test('detects bottles and wine glasses processed through WebGL fallback pipeline and registers them as bottles', async () => {
  // Simulates COCO-SSD output mapped by ecolens WebGL fallback adapter
  const fallbackPredictions = [
    { class: 'bottle', rawClass: 'bottle', score: 0.85, bbox: [20, 20, 50, 120] },
    { class: 'bottle', rawClass: 'wine glass', score: 0.78, bbox: [180, 20, 45, 130] }
  ];
  const h = engine(async () => fallbackPredictions);
  await h.processVisualFrame();
  await h.processVisualFrame();
  assert.equal(h.registrations.length, 2);
  const trackers = h.getTrackers();
  assert.equal(trackers.length, 2);
  assert.equal(trackers[0].rawClass, 'bottle');
  assert.equal(trackers[1].rawClass, 'wine glass');
});

test('camera startup mutex, track ended event, and non-blocking manual scan guard', async () => {
  const h = engine(async () => []);
  const dom = h.getDom();

  // 1. Non-blocking guard on manual scan when no camera or photo is active
  h.clearSource();
  await h.forceManualScan();
  assert.match(dom.statusText.textContent, /Primero inicia la cámara o sube una fotografía/);

  // 2. Non-blocking guard on toggleTorch when stream is null
  await h.toggleTorch();
  assert.match(dom.statusText.textContent, /Inicia la cámara primero para encender la linterna LED/);

  // 3. Mutex: concurrent startCamera calls do not duplicate getUserMedia
  let gUMCalls = 0;
  let resolveGUM;
  const mockTrack = {
    stop() {},
    addEventListener(evt, fn) {
      if (evt === 'ended') this.onEnded = fn;
    }
  };
  const mockStream = {
    getVideoTracks: () => [mockTrack],
    getTracks: () => [mockTrack]
  };

  h.sandbox.navigator.mediaDevices = {
    getUserMedia: () => {
      gUMCalls++;
      return new Promise(res => { resolveGUM = () => res(mockStream); });
    }
  };

  const p1 = h.startCamera();
  assert.equal(h.getIsCameraStarting(), true);

  // Rapid second click during camera initialization
  const p2 = h.startCamera();
  assert.equal(gUMCalls, 1, 'getUserMedia must not be called twice concurrently');

  // Finish first stream connection
  resolveGUM();
  await p1;
  await p2;
  assert.equal(h.getIsCameraStarting(), false);
  assert.ok(h.getStream());

  // 4. Track ended event (e.g. phone incoming call or camera disconnected)
  mockTrack.onEnded();
  assert.equal(h.getStream(), null);
  assert.match(dom.statusText.textContent, /Cámara desconectada o suspendida/);

  // Clean shutdown
  h.stopActiveSource();
});


