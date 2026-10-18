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
    }
    async detect(source, maxBoxes = 30, minScore = 0.1) {
      const direct = await this.detectOnce(source, maxBoxes, minScore);
      const threshold = (window.BottleDetection && window.BottleDetection.config.threshold) || 0.18;
      if (direct.some(p => p.score >= threshold)) return direct;
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return direct;
      // On live video streams, only run the rotated second pass every 6th empty frame to keep FPS high.
      if (source.videoWidth && (++this.videoFrameCount % 6 !== 0)) return direct;
      if (!this.rotated) this.rotated = document.createElement('canvas');
      this.rotated.width = height;
      this.rotated.height = width;
      const ctx = this.rotated.getContext('2d');
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(height, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, 0, 0, width, height);
      const rotated = await this.detectOnce(this.rotated, maxBoxes, minScore);
      return direct.concat(rotated.map(p => ({ ...p,
        bbox: YoloBottleDetector.unrotateBox(p.bbox, height) })));
    }
    static unrotateBox([x, y, w, h], originalHeight) {
      return [y, originalHeight - x - w, h, w];
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
        const predictions = [];
        const data = output.data;
        for (let i = 0; i < data.length; i += 6) {
          const [x1, y1, x2, y2, score, classId] = data.subarray(i, i + 6);
          if (classId !== 39 || score < minScore) continue;
          predictions.push({ class: 'bottle', score,
            bbox: [x1 * width / resizedW, y1 * height / resizedH,
              (x2 - x1) * width / resizedW, (y2 - y1) * height / resizedH] });
        }
        return predictions.sort((a, b) => b.score - a.score).slice(0, maxBoxes);
      } finally {
        input.dispose();
        if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      }
    }
    async dispose() { await this.session.release(); }
  }
  window.YoloBottleDetector = YoloBottleDetector;
})();
