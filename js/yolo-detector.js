/* YOLOv10n ONNX adapter. Original weights and preprocessing are documented in models/yolov10n. */
(() => {
  'use strict';
  class YoloBottleDetector {
    static async load(modelUrl = './models/yolov10n/model.onnx') {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
      // Single-thread WASM + SIMD + Web Worker proxy prevents blocking the browser UI thread.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = typeof Worker !== 'undefined';
      const resolvedUrl = typeof location !== 'undefined' && location.href
        ? new URL(modelUrl, location.href).href
        : modelUrl;
      const session = await ort.InferenceSession.create(resolvedUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      return new YoloBottleDetector(session);
    }
    constructor(session) {
      this.session = session;
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.canvas.height = 640;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.pixels = new Float32Array(3 * 640 * 640);
      this.videoFrameCount = 0;
      this.lastRotatedHit = false;
    }
    async detect(source, maxBoxes = 30, minScore = 0.1) {
      const direct = await this.detectOnce(source, maxBoxes, minScore);
      const threshold = (window.BottleDetection && window.BottleDetection.config.threshold) || 0.21;
      if (direct.some(p => p.score >= threshold)) {
        this.lastRotatedHit = false;
        return direct;
      }
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return direct;
      // On live video streams, throttle the rotated pass to every 6th empty frame unless the previous frame found a horizontal bottle.
      if (source.videoWidth && !this.lastRotatedHit && (++this.videoFrameCount % 6 !== 0)) return direct;
      if (!this.rotated) this.rotated = document.createElement('canvas');
      this.rotated.width = height;
      this.rotated.height = width;
      const ctx = this.rotated.getContext('2d');
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(height, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, 0, 0, width, height);
      const rotated = await this.detectOnce(this.rotated, maxBoxes, minScore);
      this.lastRotatedHit = rotated.some(p => p.score >= threshold);
      return direct.concat(rotated.map(p => ({ ...p,
        bbox: YoloBottleDetector.unrotateBox(p.bbox, height) })));
    }
    static unrotateBox([x, y, w, h], originalHeight) {
      return [y, originalHeight - x - w, h, w];
    }
    static boxIoU([ax, ay, aw, ah], [bx, by, bw, bh]) {
      const interW = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
      const interH = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
      const inter = interW * interH;
      const union = aw * ah + bw * bh - inter;
      return union > 0 ? inter / union : 0;
    }
    static isDominatedByOtherClass(bottle, other) {
      const [bx, by, bw, bh] = bottle.bbox;
      const [ox, oy, ow, oh] = other.bbox;
      const interW = Math.max(0, Math.min(bx + bw, ox + ow) - Math.max(bx, ox));
      const interH = Math.max(0, Math.min(by + bh, oy + oh) - Math.max(by, oy));
      const inter = interW * interH;
      if (inter <= 0) return false;
      const bArea = Math.max(bw * bh, 1);
      const oArea = Math.max(ow * oh, 1);
      const iou = inter / (bArea + oArea - inter);
      const containment = inter / Math.min(bArea, oArea);
      if (other.classId !== 0) {
        if (iou >= 0.35 && other.score >= bottle.score * 0.85) return true;
        if (containment >= 0.65 && other.score > bottle.score) return true;
        return false;
      }
      const insidePerson = inter / bArea;
      return insidePerson >= 0.80 && other.score > 0.55 && bottle.score < 0.42;
    }
    async detectOnce(source, maxBoxes = 30, minScore = 0.1) {
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return [];
      const scale = 640 / Math.max(width, height);
      const resizedW = Math.round(width * scale), resizedH = Math.round(height * scale);
      // Same preprocessing as the source processor: preserve aspect ratio, pad right/bottom with zero.
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, 640, 640);
      this.ctx.drawImage(source, 0, 0, resizedW, resizedH);
      const rgba = this.ctx.getImageData(0, 0, 640, 640).data;
      const plane = 640 * 640;
      if (!this.pixels || this.pixels.length !== 3 * plane) {
        this.pixels = new Float32Array(3 * plane);
      }
      const pixels = this.pixels;
      const inv255 = 1 / 255;
      for (let i = 0; i < plane; i++) {
        const idx = i * 4;
        pixels[i] = rgba[idx] * inv255;
        pixels[plane + i] = rgba[idx + 1] * inv255;
        pixels[2 * plane + i] = rgba[idx + 2] * inv255;
      }
      const input = new ort.Tensor('float32', pixels, [1, 3, 640, 640]);
      let outputs;
      try {
        outputs = await this.session.run({ [this.session.inputNames[0]]: input });
        const output = outputs[this.session.outputNames[0]];
        if (output.dims.length !== 3 || output.dims[2] !== 6) throw new Error('Formato YOLOv10 inesperado');
        const bottles = [];
        const otherClasses = [];
        const data = output.data;
        for (let i = 0; i < data.length; i += 6) {
          const [x1, y1, x2, y2, score, classId] = data.subarray(i, i + 6);
          if (score < minScore) continue;
          const bbox = [x1 * width / resizedW, y1 * height / resizedH,
            (x2 - x1) * width / resizedW, (y2 - y1) * height / resizedH];
          if (classId === 39) {
            bottles.push({ class: 'bottle', score, bbox });
          } else {
            otherClasses.push({ classId, score, bbox });
          }
        }
        const dominantBottles = bottles.filter(b =>
          !otherClasses.some(o => YoloBottleDetector.isDominatedByOtherClass(b, o))
        );
        return dominantBottles.sort((a, b) => b.score - a.score).slice(0, maxBoxes);
      } finally {
        input.dispose();
        if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      }
    }
    async dispose() { await this.session.release(); }
  }
  window.YoloBottleDetector = YoloBottleDetector;
})();
