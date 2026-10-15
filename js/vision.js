/**
 * StockVision AI - Motor de Visión por Computadora Ultra Optimizado
 * Utiliza TensorFlow.js + COCO-SSD (lite_mobilenet_v2) para máximo rendimiento móvil.
 */

class VisionEngine {
  constructor() {
    this.model = null;
    this.isModelLoaded = false;
    this.isInferencing = false;
    this.confidenceThreshold = 0.30; // Calibrado óptimo para botellas transparentes acostadas (PET / Vital)
    this.selectedClassFilter = 'bottle';

    // Tracking espacial (IoU) para anti-duplicados
    this.trackedObjects = new Map();
    this.nextTrackId = 1;
    this.onAutoDetectCallback = null;

    // Canvas interno reducido para inferencia ultrarrápida (320x240)
    this.inferenceCanvas = document.createElement('canvas');
    this.inferenceCtx = this.inferenceCanvas.getContext('2d', { willReadFrequently: true });
    this.inferenceWidth = 320;
    this.inferenceHeight = 240;
    this.inferenceCanvas.width = this.inferenceWidth;
    this.inferenceCanvas.height = this.inferenceHeight;

    // Etiquetas y categorías
    this.classLabels = {
      bottle: { name: 'Botella Plástica / Vidrio', category: 'Bebidas y Envases' },
      cup: { name: 'Botella / Envase', category: 'Bebidas y Envases' },
      vase: { name: 'Botella / Envase', category: 'Bebidas y Envases' },
      wine_glass: { name: 'Copa / Botella de Vidrio', category: 'Cristalería' },
      can: { name: 'Lata de Bebida', category: 'Bebidas y Envases' },
      cell_phone: { name: 'Teléfono Móvil', category: 'Electrónica' },
      book: { name: 'Libro / Cuaderno', category: 'Papelería' },
      cat: { name: 'Gato (Ejemplo Docente)', category: 'Mascotas' },
      dog: { name: 'Perro (Ejemplo Docente)', category: 'Mascotas' }
    };
  }

  // Carga del modelo ultraliviano lite_mobilenet_v2
  async initModel(onProgress) {
    try {
      if (onProgress) onProgress('Configurando aceleración WebGL...');
      
      // Asegurar backend WebGL para aceleración por GPU móvil
      try {
        if (window.tf) {
          await tf.setBackend('webgl');
          await tf.ready();
        }
      } catch (e) {
        console.warn('WebGL fallback a CPU:', e);
      }

      if (onProgress) onProgress('Cargando Red Neuronal Ultraligera (Lite MobileNet)...');
      
      // lite_mobilenet_v2 es hasta 4x más rápida y no congela la cámara
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      this.isModelLoaded = true;
      
      if (onProgress) onProgress('Modelo IA Listo y Acelerado.');
      return true;
    } catch (error) {
      console.error('Error al cargar modelo de visión:', error);
      throw error;
    }
  }

  // IoU entre rectángulos [x, y, w, h]
  calculateIoU(boxA, boxB) {
    const xA = Math.max(boxA[0], boxB[0]);
    const yA = Math.max(boxA[1], boxB[1]);
    const xB = Math.min(boxA[0] + boxA[2], boxB[0] + boxB[2]);
    const yB = Math.min(boxA[1] + boxA[3], boxB[1] + boxB[3]);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const boxAArea = boxA[2] * boxA[3];
    const boxBArea = boxB[2] * boxB[3];

    const unionArea = boxAArea + boxBArea - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  // Detección asíncrona optimizada con downscaling a 320x240
  async detectFrame(sourceElement) {
    if (!this.isModelLoaded || !this.model || this.isInferencing) return null;

    this.isInferencing = true;
    try {
      const srcW = sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width;
      const srcH = sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height;

      if (!srcW || !srcH) {
        this.isInferencing = false;
        return [];
      }

      // Dibujar en canvas reducido para que la inferencia tome < 50ms en celulares
      this.inferenceCtx.drawImage(sourceElement, 0, 0, this.inferenceWidth, this.inferenceHeight);

      // Inferencia sobre resolución optimizada
      const rawPredictions = await this.model.detect(this.inferenceCanvas, 10, this.confidenceThreshold);

      // Re-escalar coordenadas de la caja a la resolución original del video
      const scaleX = srcW / this.inferenceWidth;
      const scaleY = srcH / this.inferenceHeight;

      const predictions = rawPredictions.map(p => ({
        class: p.class,
        score: p.score,
        bbox: [
          p.bbox[0] * scaleX,
          p.bbox[1] * scaleY,
          p.bbox[2] * scaleX,
          p.bbox[3] * scaleY
        ]
      }));

      // Filtro de clases inteligente (para botellas transparentes acostadas que a veces COCO llama 'cup' o 'vase')
      const filtered = predictions.filter(pred => {
        if (pred.score < this.confidenceThreshold) return false;

        if (this.selectedClassFilter === 'bottle') {
          // Acepta botella, vaso o jarrón/cilindro (clave para botellas transparentes acostadas)
          return ['bottle', 'cup', 'vase', 'wine glass', 'can'].includes(pred.class);
        } else if (this.selectedClassFilter === 'all_products') {
          return ['bottle', 'cup', 'vase', 'wine glass', 'bowl', 'can', 'cell phone', 'book'].includes(pred.class);
        } else if (this.selectedClassFilter === 'pets_demo') {
          return ['cat', 'dog', 'bottle', 'cup', 'vase'].includes(pred.class);
        }
        return true;
      });

      // Actualizar tracker espacial para auto-registro
      this.updateSpatialTracking(filtered, sourceElement);

      this.isInferencing = false;
      return filtered;
    } catch (err) {
      console.warn('Error en inferencia:', err);
      this.isInferencing = false;
      return [];
    }
  }

  // Actualiza los objetos en seguimiento y dispara auto-conteo rápido
  updateSpatialTracking(predictions, sourceElement) {
    const now = Date.now();
    const matchedTrackIds = new Set();

    predictions.forEach(pred => {
      let bestMatchId = null;
      let highestIoU = 0.30;

      for (const [trackId, tracked] of this.trackedObjects.entries()) {
        const iou = this.calculateIoU(pred.bbox, tracked.bbox);
        if (iou > highestIoU) {
          highestIoU = iou;
          bestMatchId = trackId;
        }
      }

      if (bestMatchId) {
        // Objeto que sigue visible
        const tracked = this.trackedObjects.get(bestMatchId);
        tracked.bbox = pred.bbox;
        tracked.score = pred.score;
        tracked.lastSeen = now;
        tracked.framesSeen += 1;
        matchedTrackIds.add(bestMatchId);

        // Registro rápido: solo 2 detecciones seguidas son suficientes
        if (!tracked.registered && tracked.framesSeen >= 2) {
          tracked.registered = true;
          if (this.onAutoDetectCallback) {
            const thumbnail = this.extractThumbnail(sourceElement, pred.bbox);
            const friendly = this.classLabels[pred.class] || { name: 'Botella Plástica', category: 'Bebidas' };
            this.onAutoDetectCallback({
              label: friendly.name,
              category: friendly.category,
              confidence: pred.score,
              thumbnail,
              box: pred.bbox,
              rawClass: pred.class
            });
          }
        }
      } else {
        // Nuevo objeto
        const newId = this.nextTrackId++;
        this.trackedObjects.set(newId, {
          id: newId,
          class: pred.class,
          bbox: pred.bbox,
          score: pred.score,
          firstSeen: now,
          lastSeen: now,
          framesSeen: 1,
          registered: false
        });
        matchedTrackIds.add(newId);
      }
    });

    // Limpiar objetos que desaparecieron por más de 1 segundo
    for (const [trackId, tracked] of this.trackedObjects.entries()) {
      if (!matchedTrackIds.has(trackId) && (now - tracked.lastSeen > 1000)) {
        this.trackedObjects.delete(trackId);
      }
    }
  }

  // Extrae thumbnail del bounding box
  extractThumbnail(sourceElement, bbox) {
    try {
      const [bx, by, bw, bh] = bbox;
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');

      const padX = bw * 0.1;
      const padY = bh * 0.1;
      const sx = Math.max(0, bx - padX);
      const sy = Math.max(0, by - padY);
      const sw = Math.min(sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width, bw + padX * 2);
      const sh = Math.min(sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height, bh + padY * 2);

      ctx.drawImage(sourceElement, sx, sy, sw, sh, 0, 0, 100, 100);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch (e) {
      return null;
    }
  }

  // Dibuja los Bounding Boxes fluidamente a 60 FPS
  renderOverlay(canvas, predictions, sourceElement) {
    if (!canvas || !predictions) return;

    const ctx = canvas.getContext('2d');
    const displayWidth = canvas.clientWidth || canvas.width;
    const displayHeight = canvas.clientHeight || canvas.height;

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const srcW = sourceElement.videoWidth || sourceElement.naturalWidth || canvas.width;
    const srcH = sourceElement.videoHeight || sourceElement.naturalHeight || canvas.height;
    const scaleX = canvas.width / srcW;
    const scaleY = canvas.height / srcH;

    predictions.forEach(pred => {
      const [x, y, w, h] = pred.bbox;
      const rx = x * scaleX;
      const ry = y * scaleY;
      const rw = w * scaleX;
      const rh = h * scaleY;

      const isBottle = ['bottle', 'cup', 'vase', 'wine glass', 'can'].includes(pred.class);
      const colorPrimary = isBottle ? '#38bdf8' : '#10b981';

      // 1. Fondo suave
      ctx.fillStyle = isBottle ? 'rgba(56, 189, 248, 0.25)' : 'rgba(16, 185, 129, 0.25)';
      ctx.fillRect(rx, ry, rw, rh);

      // 2. Borde HUD
      ctx.strokeStyle = colorPrimary;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);

      // 3. Esquinas reforzadas
      const cornerLen = Math.min(rw, rh) * 0.25;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#ffffff';

      ctx.beginPath();
      ctx.moveTo(rx, ry + cornerLen);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + cornerLen, ry);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx + rw - cornerLen, ry);
      ctx.lineTo(rx + rw, ry);
      ctx.lineTo(rx + rw, ry + cornerLen);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx, ry + rh - cornerLen);
      ctx.lineTo(rx, ry + rh);
      ctx.lineTo(rx + cornerLen, ry + rh);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx + rw - cornerLen, ry + rh);
      ctx.lineTo(rx + rw, ry + rh);
      ctx.lineTo(rx + rw, ry + rh - cornerLen);
      ctx.stroke();

      // 4. Etiqueta superior
      const friendly = this.classLabels[pred.class] || { name: 'Botella' };
      const scorePct = Math.round(pred.score * 100);
      const labelText = `${friendly.name.split(' ')[0]} ${scorePct}%`;

      ctx.font = 'bold 12px "Plus Jakarta Sans", sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      const labelH = 22;
      const labelY = ry > labelH ? ry - labelH : ry;

      ctx.fillStyle = 'rgba(2, 132, 199, 0.95)';
      ctx.beginPath();
      ctx.roundRect(rx, labelY, textWidth + 20, labelH, 4);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, rx + 10, labelY + 15);
    });
  }
}

window.VisionEngine = VisionEngine;
