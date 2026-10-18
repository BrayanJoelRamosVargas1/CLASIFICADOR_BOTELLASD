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
test('failed direct pass retries rotation and maps boxes to original coordinates', async () => {
  const h = setup([[], [[10, 20, 110, 220, 0.9, 39]]]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.deepEqual(Array.from(predictions[0].bbox), [20, 370, 200, 100]);
  assert.equal(h.calls(), 2);
  assert.equal(h.disposed(), 4);
});
test('releases input tensor when inference throws', async () => {
  const h = setup([new Error('failed inference')]);
  await assert.rejects(h.detector.detect({ width: 640, height: 480 }), /failed inference/);
  assert.equal(h.disposed(), 1);
});
