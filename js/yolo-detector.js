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
    static async fetchModelCached(url) {
      // Cache ONNX binary in IndexedDB so even Ctrl+F5 reloads in <50ms without 14MB network wait
      if (typeof indexedDB === 'undefined' || typeof fetch === 'undefined') return url;
      const dbName = 'ecolens_onnx_model_cache_v1';
      const storeName = 'models';
      const openDb = () => new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(storeName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const db = await openDb();
        const cached = await new Promise((resolve) => {
          const tx = db.transaction(storeName, 'readonly');
          const getReq = tx.objectStore(storeName).get(url);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        });
        if (cached && cached.byteLength > 1000000) {
          db.close();
          return new Uint8Array(cached);
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        try {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(buf, url);
        } catch (e) {}
        db.close();
        return new Uint8Array(buf);
      } catch (e) {
        return url;
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
          const modelSource = await YoloBottleDetector.fetchModelCached(fp16Url);
          session = await ort.InferenceSession.create(modelSource, {
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
        const modelSource = await YoloBottleDetector.fetchModelCached(resolvedUrl);
        session = await ort.InferenceSession.create(modelSource, {
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
      this.lastTargetBox = null;
      this.lastTargetAge = 0;
    }
    rememberTarget(preds, threshold) {
      let best = null;
      for (const p of preds) {
        if (p.score >= threshold && (!best || p.score > best.score)) best = p;
      }
      if (best) {
        this.lastTargetBox = best.bbox;
        this.lastTargetAge = 0;
      } else {
        this.lastTargetAge++;
      }
      return preds;
    }
    async detect(source, maxBoxes = 30, minScore = 0.1) {
      const direct = await this.detectOnce(source, maxBoxes, minScore);
      const threshold = (window.BottleDetection && window.BottleDetection.config.threshold) || 0.15;
      const bestDirect = direct.reduce((m, p) => Math.max(m, p.score), 0);
      const isVideo = Boolean(source.videoWidth);
      if (isVideo && bestDirect >= threshold) {
        this.lastAuxMode = null;
        return this.rememberTarget(direct, threshold);
      }
      if (!isVideo && bestDirect >= 0.65) {
        return direct;
      }
      const width = source.videoWidth || source.naturalWidth || source.width;
      const height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height) return direct;

      if (isVideo) {
        // On WebGPU live camera, test Foveated HD crop / Perifoveal zoomout first if not locked onto a mode,
        // and if the first pass misses, immediately test the next auxiliary mode in the same cycle.
        if (this.backend === 'webgpu') {
          const allModes = ['crop', 'zoomout', 'rot90', 'rot180', 'rot270'];
          const primaryMode = this.lastAuxMode || allModes[(++this.videoFrameCount) % 2];
          const aux1 = await this.runAuxPass(primaryMode, source, width, height, maxBoxes, minScore);
          if (aux1.some(p => p.score >= threshold)) {
            this.lastAuxMode = primaryMode;
            return this.rememberTarget(YoloBottleDetector.fuseBoxes(direct.concat(aux1)), threshold);
          }
          const secondaryModes = allModes.filter(m => m !== primaryMode);
          const secondaryMode = secondaryModes[this.videoFrameCount % secondaryModes.length];
          const aux2 = await this.runAuxPass(secondaryMode, source, width, height, maxBoxes, minScore);
          this.lastAuxMode = aux2.some(p => p.score >= threshold) ? secondaryMode : null;
          return this.rememberTarget(YoloBottleDetector.fuseBoxes(direct.concat(aux1, aux2)), threshold);
        }
        // WASM fallback: throttle auxiliary pass to every 2nd empty frame
        const modes = ['crop', 'zoomout', 'rot90', 'rot180', 'rot270'];
        let mode = this.lastAuxMode;
        if (!mode) {
          if (++this.videoFrameCount % 2 !== 0) return direct;
          mode = modes[(this.videoFrameCount >> 1) % modes.length];
        }
        const aux = await this.runAuxPass(mode, source, width, height, maxBoxes, minScore);
        this.lastAuxMode = aux.some(p => p.score >= threshold) ? mode : null;
        const fusedVideo = YoloBottleDetector.fuseBoxes(direct.concat(aux));
        return this.rememberTarget(fusedVideo, threshold);
      }

      // Static image multi-orientation, SAHI crop & Perifoveal zoomout synthesis with ZFTurbo WBF
      const rot90 = await this.runAuxPass('rot90', source, width, height, maxBoxes, minScore);
      const rot180 = await this.runAuxPass('rot180', source, width, height, maxBoxes, minScore);
      const combined = YoloBottleDetector.fuseBoxes(direct.concat(rot90, rot180));
      if (combined.some(p => p.score >= threshold)) return combined;
      const crop = await this.runAuxPass('crop', source, width, height, maxBoxes, minScore);
      const withCrop = YoloBottleDetector.fuseBoxes(combined.concat(crop));
      if (withCrop.some(p => p.score >= threshold)) return withCrop;
      const zoomout = await this.runAuxPass('zoomout', source, width, height, maxBoxes, minScore);
      const withZoomout = YoloBottleDetector.fuseBoxes(withCrop.concat(zoomout));
      if (withZoomout.some(p => p.score >= threshold)) return withZoomout;
      const rot270 = await this.runAuxPass('rot270', source, width, height, maxBoxes, minScore);
      return YoloBottleDetector.fuseBoxes(withZoomout.concat(rot270));
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
        // Foveated Adaptive ROI + SAHI zoom crop: center on last known target if recent, else center reticle
        const cropW = Math.round(width * 0.62);
        const cropH = Math.round(height * 0.76);
        let cropX = Math.round((width - cropW) * 0.5);
        let cropY = Math.round((height - cropH) * 0.5);
        if (this.lastTargetBox && this.lastTargetAge <= 5) {
          const [tx, ty, tw, th] = this.lastTargetBox;
          const cx = tx + tw * 0.5;
          const cy = ty + th * 0.5;
          cropX = Math.max(0, Math.min(width - cropW, Math.round(cx - cropW * 0.5)));
          cropY = Math.max(0, Math.min(height - cropH, Math.round(cy - cropH * 0.5)));
        }
        this.auxCanvas.width = cropW;
        this.auxCanvas.height = cropH;
        if ('filter' in ctx) ctx.filter = 'contrast(1.12) saturate(1.08)';
        ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        if ('filter' in ctx) ctx.filter = 'none';
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, Math.max(minScore, 0.16));
        return preds.map(p => ({
          ...p,
          bbox: [cropX + p.bbox[0], cropY + p.bbox[1], p.bbox[2], p.bbox[3]]
        }));
      }
      if (mode === 'zoomout') {
        // Bio-inspired Perifoveal Context Scale (0.58x): when a bottle is held very close to the webcam
        // (filling 85%-100% of frame height), it exceeds YOLOv10's stride-32 receptive field. Shrinking it
        // onto a neutral #727272 surround restores cap/base margin context and recovers detection.
        const scale = 0.58;
        const scaledW = Math.round(width * scale);
        const scaledH = Math.round(height * scale);
        const padX = Math.round((width - scaledW) * 0.5);
        const padY = Math.round((height - scaledH) * 0.5);
        this.auxCanvas.width = width;
        this.auxCanvas.height = height;
        ctx.fillStyle = '#727272';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height, padX, padY, scaledW, scaledH);
        const preds = await this.detectOnce(this.auxCanvas, maxBoxes, Math.max(minScore, 0.15));
        return preds.map(p => {
          const x1 = Math.max(0, Math.min(width, (p.bbox[0] - padX) / scale));
          const y1 = Math.max(0, Math.min(height, (p.bbox[1] - padY) / scale));
          const x2 = Math.max(0, Math.min(width, (p.bbox[0] + p.bbox[2] - padX) / scale));
          const y2 = Math.max(0, Math.min(height, (p.bbox[1] + p.bbox[3] - padY) / scale));
          return {
            ...p,
            bbox: [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)]
          };
        });
      }
      return [];
    }
    static fuseBoxes(boxes) {
      // ZFTurbo Weighted Boxes Fusion (WBF): fuse overlapping multi-pass detections by confidence weight
      if (boxes.length <= 1) return boxes;
      const sorted = boxes.slice().sort((a, b) => b.score - a.score);
      const clusters = [];
      for (const box of sorted) {
        let matched = null;
        for (const c of clusters) {
          if (YoloBottleDetector.boxIoU(box.bbox, c.bbox) >= 0.45) {
            matched = c;
            break;
          }
        }
        if (!matched) {
          clusters.push({
            class: box.class,
            maxScore: box.score,
            weightSum: box.score,
            wx: box.bbox[0] * box.score,
            wy: box.bbox[1] * box.score,
            ww: box.bbox[2] * box.score,
            wh: box.bbox[3] * box.score,
            count: 1,
            bbox: box.bbox.slice()
          });
        } else {
          const w = box.score;
          matched.weightSum += w;
          matched.wx += box.bbox[0] * w;
          matched.wy += box.bbox[1] * w;
          matched.ww += box.bbox[2] * w;
          matched.wh += box.bbox[3] * w;
          matched.count++;
          matched.bbox = [
            matched.wx / matched.weightSum,
            matched.wy / matched.weightSum,
            matched.ww / matched.weightSum,
            matched.wh / matched.weightSum
          ];
        }
      }
      return clusters.map(c => ({
        class: c.class,
        score: c.count > 1
          ? Math.min(0.99, c.maxScore + 0.06 * (c.count - 1) * (1 - c.maxScore))
          : c.maxScore,
        bbox: c.bbox
      }));
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
    static buildGammaLut(gamma) {
      const lut = new Float32Array(256);
      for (let v = 0; v < 256; v++) {
        lut[v] = gamma === 1 ? v / 255 : Math.pow(v / 255, gamma);
      }
      return lut;
    }
    static getLumaLut(rgba, resizedW, resizedH) {
      // Bio-inspired Retinal Adaptation (Naka-Rushton / Weber-Fechner photoreceptor gain control):
      // sample active image region luminance; if backlit/dark (<75) or overexposed (>195) with real
      // contrast variance, normalize via adaptive gamma LUT so bottle silhouettes and clear PET edges stand out.
      let sum = 0;
      let count = 0;
      let minL = 255;
      let maxL = 0;
      const step = 16;
      const maxY = Math.min(640, Math.max(1, resizedH));
      const maxX = Math.min(640, Math.max(1, resizedW));
      for (let y = 0; y < maxY; y += step) {
        const rowOffset = y * 640 * 4;
        for (let x = 0; x < maxX; x += step) {
          const idx = rowOffset + x * 4;
          const luma = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;
          sum += luma;
          count++;
          if (luma < minL) minL = luma;
          if (luma > maxL) maxL = luma;
        }
      }
      if (count === 0 || (maxL - minL) < 15) return { lut: YoloBottleDetector.IDENTITY_LUT, meanLuma: 128 };
      const meanLuma = Math.round(sum / count);
      if (meanLuma < 75) return { lut: YoloBottleDetector.DARK_LUT, meanLuma };
      if (meanLuma > 195) return { lut: YoloBottleDetector.BRIGHT_LUT, meanLuma };
      return { lut: YoloBottleDetector.IDENTITY_LUT, meanLuma };
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
      const { lut, meanLuma } = YoloBottleDetector.getLumaLut(rgba, resizedW, resizedH);
      this.lastMeanLuma = meanLuma;
      for (let i = 0; i < plane; i++) {
        const idx = i * 4;
        pixels[i] = lut[rgba[idx]];
        pixels[plane + i] = lut[rgba[idx + 1]];
        pixels[2 * plane + i] = lut[rgba[idx + 2]];
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
          } else if (classId === 75 && score >= 0.28 && Math.max(bbox[2], bbox[3]) > Math.min(bbox[2], bbox[3]) * 1.40) {
            // Slender glass/clear bottles (any orientation) that COCO backbones occasionally activate as class 75
            bottles.push({ class: 'bottle', score: score * 0.85, bbox });
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
  YoloBottleDetector.IDENTITY_LUT = YoloBottleDetector.buildGammaLut(1);
  YoloBottleDetector.DARK_LUT = YoloBottleDetector.buildGammaLut(0.72);
  YoloBottleDetector.BRIGHT_LUT = YoloBottleDetector.buildGammaLut(1.25);
  window.YoloBottleDetector = YoloBottleDetector;
})();
