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

test('keeps bottle placed on a desk or in front of monitor/chair/laptop even when background has higher score', async () => {
  // Dining table (60, score 0.88), TV/monitor (62, score 0.91), chair (56, score 0.79) contain bottle (39, score 0.42)
  const h = setup([
    [
      [0, 100, 640, 480, 0.88, 60],
      [100, 20, 520, 380, 0.91, 62],
      [80, 50, 500, 460, 0.79, 56],
      [260, 150, 330, 350, 0.42, 39]
    ],
    [],
    []
  ]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.equal(Math.round(predictions[0].score * 100), 42);
});

test('fuses multi-pass overlapping bottle detections with ZFTurbo Weighted Boxes Fusion and boosts consensus confidence', async () => {
  const h = setup([
    [[100, 100, 200, 300, 0.50, 39]],
    [],
    [[440, 180, 540, 380, 0.50, 39]] // 180-deg rotated coordinates of [100, 100, 100, 200] in 640x480
  ]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.ok(predictions[0].score > 0.50);
  assert.deepEqual(Array.from(predictions[0].bbox, v => Math.round(v)), [100, 100, 100, 200]);
});

test('recovers close-up bottle filling the frame via perifoveal zoomout pass and maps coordinates back', async () => {
  // direct=[], rot90=[], rot180=[], crop=[], zoomout=[detected at scaled box]
  // For 640x480 with scale=0.58: padX=135, padY=101; original [100, 10, 200, 460] -> in zoomout canvas: [193, 106.8, 309, 373.6]
  const h = setup([
    [],
    [],
    [],
    [],
    [[193, 106.8, 309, 373.6, 0.78, 39]]
  ]);
  const predictions = await h.detector.detect({ width: 640, height: 480 });
  assert.equal(predictions.length, 1);
  assert.equal(Math.round(predictions[0].score * 100), 78);
  assert.deepEqual(Array.from(predictions[0].bbox, v => Math.round(v)), [100, 10, 200, 460]);
});

test('applies bio-inspired retinal gamma LUT adaptation on dark backlit and overexposed frames', () => {
  const h = setup([]);
  const Yolo = h.detector.constructor;
  const darkRgba = new Uint8ClampedArray(640 * 640 * 4);
  const half = (640 * 240) * 4;
  for (let i = 0; i < darkRgba.length; i += 4) {
    const v = i < half ? 20 : 65;
    darkRgba[i] = v; darkRgba[i + 1] = v; darkRgba[i + 2] = v; darkRgba[i + 3] = 255;
  }
  const { lut: darkLut, meanLuma: darkMean } = Yolo.getLumaLut(darkRgba, 640, 480);
  assert.equal(darkLut, Yolo.DARK_LUT);
  assert.ok(darkMean < 75);
  assert.ok(darkLut[50] > (50 / 255)); // Gamma < 1 boosts dark shadow contrast

  const brightRgba = new Uint8ClampedArray(640 * 640 * 4);
  for (let i = 0; i < brightRgba.length; i += 4) {
    const v = i < half ? 190 : 245;
    brightRgba[i] = v; brightRgba[i + 1] = v; brightRgba[i + 2] = v; brightRgba[i + 3] = 255;
  }
  const { lut: brightLut, meanLuma: brightMean } = Yolo.getLumaLut(brightRgba, 640, 480);
  assert.equal(brightLut, Yolo.BRIGHT_LUT);
  assert.ok(brightMean > 195);
  assert.ok(brightLut[210] < (210 / 255)); // Gamma > 1 recovers washed-out highlights
});

