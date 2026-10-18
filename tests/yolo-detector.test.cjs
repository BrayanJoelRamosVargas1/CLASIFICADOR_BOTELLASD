const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(outputs) {
  let calls = 0, disposed = 0;
  const ctx = { fillRect() {}, drawImage() {}, translate() {}, rotate() {},
    getImageData: () => ({ data: new Uint8ClampedArray(640 * 640 * 4).fill(255) }) };
  const sandbox = { window: { BottleDetection: { config: { threshold: 0.3 } } },
    document: { createElement: () => ({ getContext: () => ctx }) },
    ort: { Tensor: class {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
      dispose() { disposed++; }
    } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/yolo-detector.js'), 'utf8'), sandbox);
  const session = { inputNames: ['images'], outputNames: ['output0'],
    async run({ images }) {
      assert.equal(images.type, 'float32');
      assert.deepEqual(Array.from(images.dims), [1, 3, 640, 640]);
      assert.equal(images.data[0], 1);
      const rows = outputs[calls++];
      if (rows instanceof Error) throw rows;
      return { output0: { dims: [1, rows.length, 6], data: Float32Array.from(rows.flat()), dispose() { disposed++; } } };
    } };
  return { detector: new sandbox.window.YoloBottleDetector(session), calls: () => calls, disposed: () => disposed };
}

test('decodes bottle boxes and releases ONNX input and output tensors', async () => {
  const h = setup([[[10, 20, 110, 220, 0.9, 39], [0, 0, 100, 100, 0.9, 41]]]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.deepEqual(Array.from(predictions[0].bbox), [10, 20, 100, 200]);
  assert.equal(h.calls(), 1);
  assert.equal(h.disposed(), 2);
});
test('failed direct pass retries 90 and 180 rotation and maps boxes to original coordinates', async () => {
  const h = setup([[], [[10, 20, 110, 220, 0.9, 39]], []]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.deepEqual(Array.from(predictions[0].bbox), [20, 370, 200, 100]);
  assert.equal(h.calls(), 3);
  assert.equal(h.disposed(), 6);
});
test('releases input tensor when inference throws', async () => {
  const h = setup([new Error('failed inference')]);
  await assert.rejects(h.detector.detect({ width: 640, height: 480 }), /failed inference/);
  assert.equal(h.disposed(), 1);
});

test('throttles auxiliary pass on live video frames to every 2nd empty frame and locks onto active mode', async () => {
  const h = setup([[], [], [[10, 20, 110, 220, 0.9, 39]]]);
  const videoSource = { videoWidth: 640, videoHeight: 480 };
  const first = await h.detector.detect(videoSource);
  assert.equal(first.length, 0);
  assert.equal(h.calls(), 1);
  const second = await h.detector.detect(videoSource);
  assert.equal(second.length, 1);
  assert.equal(h.calls(), 3);
});

test('suppresses false-positive bottle when another COCO class has higher score on the same bounding box', async () => {
  // Same box [10, 20, 110, 220] has cup (class 41, score 0.72) and bottle (class 39, score 0.28)
  const h = setup([
    [[10, 20, 110, 220, 0.72, 41], [10, 20, 110, 220, 0.28, 39], [300, 100, 420, 480, 0.85, 39]],
    [],
    []
  ]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.equal(Math.round(predictions[0].score * 100), 85);
});

test('keeps bottle held in front of a person on webcam even when inside the person bounding box', async () => {
  // Person (class 0, score 0.92) covers [0, 0, 640, 480]; bottle (class 39, score 0.32) is held at [250, 140, 340, 360]
  const h = setup([
    [[0, 0, 640, 480, 0.92, 0], [250, 140, 340, 360, 0.32, 39]],
    [],
    []
  ]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.equal(Math.round(predictions[0].score * 100), 32);
});



