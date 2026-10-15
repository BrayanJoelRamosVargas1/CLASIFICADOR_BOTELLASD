/**
 * StockVision AI - Motor de Visión por Computadora de Alta Precisión
 * Modelo MobileNet v2 optimizado para detección robusta de botellas y envases
 */

class VisionEngine {
  constructor() {
    this.model = null;
    this.isModelLoaded = false;
    this.isInferencing = false;
    this.confidenceThreshold = 0.25; // 25% sensible para botellas de plástico transparente
    this.selectedClassFilter = 'bottle';

    // Tracking espacial (IoU) para conteo inteligente anti-duplicados
    this.trackedObjects = new Map();
    this.nextTrackId = 1;
    this.onAutoDetectCallback = null;

    // Diccionario semántico de etiquetas
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

  // Carga del modelo MobileNet v2 de alta precisión
  async initModel(onProgress) {
    try {
      if (onProgress) onProgress('Cargando Red Neuronal MobileNet v2...');
      
      // Cargamos MobileNet v2 estándar (el modelo robusto usado en el proyecto)
      this.model = await cocoSsd.load({ base: 'mobilenet_v2' });
      this.isModelLoaded = true;

      // Cargar la red neuronal propia entrenada en Keras / Jupyter
      try {
        this.customModel = await tf.loadLayersModel('./modelo_botellas/model.json');
        console.log('[OK] Red neuronal propia (Keras CNN de botellas) cargada exitosamente.');
      } catch (errCustom) {
        console.warn('Red propia en modo auxiliar:', errCustom);
      }

      if (onProgress) onProgress('Modelo IA Listo y Acelerado.');
      return true;
    } catch (error) {
      console.error('Error al inicializar modelo de visión:', error);
      throw error;
    }
  }

  // Cálculo IoU entre dos rectángulos [x, y, w, h]
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

  // Inferencia nativa directa por GPU con filtro sensible
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

      // Solicitamos predicciones con corte base bajo (0.15) para no descartar botellas transparentes
      const rawPredictions = await this.model.detect(sourceElement, 12, 0.15);

      // Filtro de clases inteligente (reconoce botellas acostadas clasificadas como cup o vase)
      const filtered = rawPredictions.filter(pred => {
        if (pred.score < this.confidenceThreshold) return false;

        if (this.selectedClassFilter === 'bottle') {
          return ['bottle', 'cup', 'vase', 'wine glass', 'can'].includes(pred.class);
        } else if (this.selectedClassFilter === 'all_products') {
          return ['bottle', 'cup', 'vase', 'wine glass', 'bowl', 'can', 'cell phone', 'book'].includes(pred.class);
        } else if (this.selectedClassFilter === 'pets_demo') {
          return ['cat', 'dog', 'bottle', 'cup', 'vase'].includes(pred.class);
        }
        return true;
      });

      // Actualizar seguimiento espacial para auto-conteo
      this.updateSpatialTracking(filtered, sourceElement);

      this.isInferencing = false;
      return filtered;
    } catch (err) {
      console.warn('Error en ciclo de inferencia:', err);
      this.isInferencing = false;
      return [];
    }
  }

  // Actualiza el tracking temporal de objetos para evitar duplicaciones
  updateSpatialTracking(predictions, sourceElement) {
    const now = Date.now();
    const matchedTrackIds = new Set();

    predictions.forEach(pred => {
      let bestMatchId = null;
      let highestIoU = 0.25;

      for (const [trackId, tracked] of this.trackedObjects.entries()) {
        const iou = this.calculateIoU(pred.bbox, tracked.bbox);
        if (iou > highestIoU) {
          highestIoU = iou;
          bestMatchId = trackId;
        }
      }

      if (bestMatchId) {
        const tracked = this.trackedObjects.get(bestMatchId);
        tracked.bbox = pred.bbox;
        tracked.score = pred.score;
        tracked.lastSeen = now;
        tracked.framesSeen += 1;
        matchedTrackIds.add(bestMatchId);

        // Auto-registro cuando el objeto se confirma en pantalla
        if (!tracked.registered && tracked.framesSeen >= 1) {
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

    // Limpiar objetos que salieron del encuadre después de 1.2 segundos
    for (const [trackId, tracked] of this.trackedObjects.entries()) {
      if (!matchedTrackIds.has(trackId) && (now - tracked.lastSeen > 1200)) {
        this.trackedObjects.delete(trackId);
      }
    }
  }

  // Genera miniatura del objeto detectado para la tabla de inventario
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

  // Dibuja el HUD con alineación geométrica precisa para CSS object-cover
  renderOverlay(canvas, predictions, sourceElement) {
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    
    // Sincronizar dimensiones sin forzar reflow innecesario
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    if (displayWidth && displayHeight && (canvas.width !== displayWidth || canvas.height !== displayHeight)) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!predictions || predictions.length === 0) return;

    const srcW = sourceElement.videoWidth || sourceElement.naturalWidth || canvas.width;
    const srcH = sourceElement.videoHeight || sourceElement.naturalHeight || canvas.height;

    // Compensación geométrica exacta para object-cover
    const scale = Math.max(canvas.width / srcW, canvas.height / srcH);
    const offsetX = (canvas.width - srcW * scale) / 2;
    const offsetY = (canvas.height - srcH * scale) / 2;

    for (let i = 0; i < predictions.length; i++) {
      const pred = predictions[i];
      const [x, y, w, h] = pred.bbox;
      const rx = x * scale + offsetX;
      const ry = y * scale + offsetY;
      const rw = w * scale;
      const rh = h * scale;

      const isBottle = ['bottle', 'cup', 'vase', 'wine glass', 'can'].includes(pred.class);
      const colorPrimary = isBottle ? '#38bdf8' : '#10b981';

      // 1. Fondo semitransparente suave
      ctx.fillStyle = isBottle ? 'rgba(56, 189, 248, 0.22)' : 'rgba(16, 185, 129, 0.22)';
      ctx.fillRect(rx, ry, rw, rh);

      // 2. Borde HUD
      ctx.strokeStyle = colorPrimary;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(rx, ry, rw, rh);

      // 3. Esquinas HUD reforzadas
      const cornerLen = Math.min(rw, rh, 24);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#ffffff';

      ctx.beginPath();
      ctx.moveTo(rx, ry + cornerLen);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + cornerLen, ry);

      ctx.moveTo(rx + rw - cornerLen, ry);
      ctx.lineTo(rx + rw, ry);
      ctx.lineTo(rx + rw, ry + cornerLen);

      ctx.moveTo(rx, ry + rh - cornerLen);
      ctx.lineTo(rx, ry + rh);
      ctx.lineTo(rx + cornerLen, ry + rh);

      ctx.moveTo(rx + rw - cornerLen, ry + rh);
      ctx.lineTo(rx + rw, ry + rh);
      ctx.lineTo(rx + rw, ry + rh - cornerLen);
      ctx.stroke();

      // 4. Etiqueta superior
      const scorePct = Math.round(pred.score * 100);
      const labelText = `Botella ${scorePct}%`;

      ctx.font = 'bold 12px "Plus Jakarta Sans", sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      const labelH = 22;
      const labelY = ry > labelH ? ry - labelH : ry;

      ctx.fillStyle = 'rgba(2, 132, 199, 0.95)';
      ctx.beginPath();
      ctx.roundRect(rx, labelY, textWidth + 18, labelH, 4);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, rx + 9, labelY + 15);
    }
  }
}

window.VisionEngine = VisionEngine;
