/* YOLOv10n ONNX adapter. Original weights and preprocessing are documented in models/yolov10n. */
(() => {
  'use strict';
  const scriptDir = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
    ? new URL('./', document.currentScript.src).href
    : (typeof location !== 'undefined' && location.href ? new URL('./js/', location.href).href : '');
  class YoloBottleDetector {
    static async hasWebGPU() {
      try {
        if (typeof navigator === 'undefined' || !navigator.gpu) return false;
        const adapter = await navigator.gpu.requestAdapter();
        return Boolean(adapter);
      } catch (e) {
        return false;
      }
    }
    static async load(modelUrl = './models/yolov10n/model.onnx') {
      ort.env.wasm.wasmPaths = scriptDir
        ? new URL('./ort/', scriptDir).href
        : './js/ort/';
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const hwThreads = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      ort.env.wasm.numThreads = isolated ? Math.min(4, Math.max(2, hwThreads)) : 1;
      ort.env.wasm.simd = true;
      const resolvedUrl = (typeof location !== 'undefined' && location.href)
        ? new URL(modelUrl, location.href).href
        : modelUrl;

      let session = null;
      let backend = 'wasm';
      if (await YoloBottleDetector.hasWebGPU()) {
        try {
          ort.env.wasm.proxy = false;
          const fp16Url = resolvedUrl.replace(/model\.onnx(\?.*)?$/, 'model_fp16.onnx$1');
          session = await ort.InferenceSession.create(fp16Url, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all'
          });
          backend = 'webgpu';
        } catch (e) {
          session = null;
        }
      }
      if (!session) {
        ort.env.wasm.proxy = !isolated && typeof Worker !== 'undefined';
        session = await ort.InferenceSession.create(resolvedUrl, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        backend = 'wasm';
      }

      const detector = new YoloBottleDetector(session, backend);
      // Warm-up pass (pattern from nomi30701/yolo-object-detection-onnxruntime-web) so frame 1 never stalls.
      try {
        const warmInput = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
        const warmOut = await session.run({ [session.inputNames[0]]: warmInput });
        warmInput.dispose();
        for (const t of Object.values(warmOut)) t.dispose();
      } catch (e) {}
      return detector;
    }
    constructor(session, backend = 'wasm') {
      this.session = session;
      this.backend = backend;
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.canvas.height = 640;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.pixels = new Float32Array(3 * 640 * 640);
      this.videoFrameCount = 0;
      this.lastAuxMode = null;
    }
    async detect(source, maxBoxes = 30, minScore = 0.1) {
      const direct = await this.detectOnce(source, maxBoxes, minScore);
      const threshold = (window.BottleDetection && window.BottleDetection.config.threshold) || 0.21;
      const bestDirect = direct.reduce((m, p) => Math.max(m, p.score), 0);
      const isVideo = Boolean(source.videoWidth);
      if (isVideo && bestDirect >= threshold) {
        this.lastAuxMode = null;
        return direct;
      }
      if (!isVideo && bestDirect >= 0.65) {
        return direct;
      }
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return direct;

      if (isVideo) {
        // On live camera, if locked onto an auxiliary mode, repeat it immediately; otherwise cycle.
        const modes = ['crop', 'rot90', 'rot180', 'rot270'];
        let mode = this.lastAuxMode;
        if (!mode) {
          if (this.backend !== 'webgpu' && ++this.videoFrameCount % 2 !== 0) return direct;
          const step = this.backend === 'webgpu' ? ++this.videoFrameCount : (this.videoFrameCount >> 1);
          mode = modes[step % modes.length];
        }
        const aux = await this.runAuxPass(mode, source, width, height, maxBoxes, minScore);
        this.lastAuxMode = aux.some(p => p.score >= threshold) ? mode : null;
        return direct.concat(aux);
      }

      // Static image multi-orientation & SAHI crop synthesis (0° + 90° + 180° + center zoom + 270° fallback)
      const rot90 = await this.runAuxPass('rot90', source, width, height, maxBoxes, minScore);
      const rot180 = await this.runAuxPass('rot180', source, width, height, maxBoxes, minScore);
      const combined = direct.concat(rot90, rot180);
      if (combined.some(p => p.score >= threshold)) return combined;
      const crop = await this.runAuxPass('crop', source, width, height, maxBoxes, minScore);
      const withCrop = combined.concat(crop);
      if (withCrop.some(p => p.score >= threshold)) return withCrop;
      const rot270 = await this.runAuxPass('rot270', source, width, height, maxBoxes, minScore);
      return withCrop.concat(rot270);
    }
    async runAuxPass(mode, source, width, height, maxBoxes, minScore) {
      if (!this.auxCanvas) this.auxCanvas = document.createElement('canvas');
      const ctx = this.auxCanvas.getContext('2d');
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (mode === 'rot90') {
        this.auxCanvas.width = height;
        this.auxCanvas.height = width;
        ctx.translate(height, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(source, 0, 0, width, height);
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, minScore);
        return preds.map(p => ({ ...p, bbox: YoloBottleDetector.unrotateBox(p.bbox, height) }));
      }
      if (mode === 'rot270') {
        this.auxCanvas.width = height;
        this.auxCanvas.height = width;
        ctx.translate(0, width);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(source, 0, 0, width, height);
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, minScore);
        return preds.map(p => ({ ...p, bbox: YoloBottleDetector.unrotateBox270(p.bbox, width) }));
      }
      if (mode === 'rot180') {
        this.auxCanvas.width = width;
        this.auxCanvas.height = height;
        ctx.translate(width, height);
        ctx.rotate(Math.PI);
        ctx.drawImage(source, 0, 0, width, height);
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, minScore);
        return preds.map(p => ({ ...p, bbox: YoloBottleDetector.unrotateBox180(p.bbox, width, height) }));
      }
      if (mode === 'crop') {
        // SAHI (Slicing Aided Hyper Inference) center-reticle zoom crop + refraction edge contrast for clear PET bottles
        const cropW = Math.round(width * 0.62);
        const cropH = Math.round(height * 0.76);
        const cropX = Math.round((width - cropW) * 0.5);
        const cropY = Math.round((height - cropH) * 0.5);
        this.auxCanvas.width = cropW;
        this.auxCanvas.height = cropH;
        if ('filter' in ctx) ctx.filter = 'contrast(1.12) saturate(1.08)';
        ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        if ('filter' in ctx) ctx.filter = 'none';
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, Math.max(minScore, 0.24));
        return preds.map(p => ({
          ...p,
          bbox: [cropX + p.bbox[0], cropY + p.bbox[1], p.bbox[2], p.bbox[3]]
        }));
      }
      return [];
    }
    static unrotateBox([x, y, w, h], originalHeight) {
      return [y, originalHeight - x - w, h, w];
    }
    static unrotateBox270([x, y, w, h], originalWidth) {
      return [originalWidth - y - h, x, h, w];
    }
    static unrotateBox180([x, y, w, h], originalWidth, originalHeight) {
      return [originalWidth - x - w, originalHeight - y - h, w, h];
    }
    static boxIoU([ax, ay, aw, ah], [bx, by, bw, bh]) {
      const interW = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
      const interH = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
      const inter = interW * interH;
      const union = aw * ah + bw * bh - inter;
      return union > 0 ? inter / union : 0;
    }
    static isDominatedByOtherClass(bottle, other) {
      // Only suppress when the SAME physical object bounding box (IoU >= 0.50) has a
      // strictly higher score on a true non-bottle handheld/container lookalike class
      // (10: fire hydrant/cylinder, 41: cup/mug, 64: mouse, 65: remote, 67: cell phone,
      // 76: scissors, 78: hair drier, 79: toothbrush).
      // Never suppress bottles in front of background furniture, desks, monitors, or people!
      if (!YoloBottleDetector.HARD_NEGATIVE_CLASSES.has(other.classId)) return false;
      const iou = YoloBottleDetector.boxIoU(bottle.bbox, other.bbox);
      return iou >= 0.50 && other.score > bottle.score * 1.15;
    }
    async detectOnce(source, maxBoxes = 30, minScore = 0.1) {
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return [];
      const scale = 640 / Math.max(width, height);
      const resizedW = Math.round(width * scale), resizedH = Math.round(height * scale);
      // Ultralytics LetterBox standard neutral gray padding rgb(114, 114, 114) = #727272 so dark bottles near edges don't blend into black.
      this.ctx.fillStyle = '#727272';
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
  YoloBottleDetector.HARD_NEGATIVE_CLASSES = new Set([10, 41, 64, 65, 67, 76, 78, 79]);
  window.YoloBottleDetector = YoloBottleDetector;
})();
