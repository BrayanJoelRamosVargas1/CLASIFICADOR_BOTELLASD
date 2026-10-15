/**
 * StockVision AI - Motor de Visión por Computadora e Inferencia
 * Utiliza TensorFlow.js + COCO-SSD (MobileNet) con tracking espacial (IoU) y anti-duplicados.
 */

class VisionEngine {
  constructor() {
    this.model = null;
    this.isModelLoaded = false;
    this.isDetecting = false;
    this.confidenceThreshold = 0.55;
    this.selectedClassFilter = 'bottle'; // 'bottle' | 'all_products' | 'all'

    // Seguimiento espacial (IoU) para evitar registrar duplicados continuos en cámara
    this.trackedObjects = new Map();
    this.nextTrackId = 1;
    this.onAutoDetectCallback = null;

    // Diccionario de traducción amigable de clases COCO
    this.classLabels = {
      bottle: { name: 'Botella (Plástica/Vidrio)', category: 'Bebidas y Envases' },
      cup: { name: 'Vaso / Taza', category: 'Vajilla y Contenedores' },
      wine_glass: { name: 'Copa de Cristal', category: 'Cristalería' },
      bowl: { name: 'Tazón / Bowl', category: 'Vajilla' },
      can: { name: 'Lata de Bebida', category: 'Bebidas y Envases' },
      cell_phone: { name: 'Teléfono Móvil', category: 'Electrónica' },
      book: { name: 'Libro / Cuaderno', category: 'Papelería' },
      cat: { name: 'Gato (Ejemplo Docente)', category: 'Mascotas' },
      dog: { name: 'Perro (Ejemplo Docente)', category: 'Mascotas' }
    };
  }

  // Carga del modelo TensorFlow.js
  async initModel(onProgress) {
    try {
      if (onProgress) onProgress('Descargando arquitectura MobileNet + pesos COCO-SSD...');
      // Cargar modelo base MobileNet v2 optimizado para inferencia en navegador
      this.model = await cocoSsd.load({ base: 'mobilenet_v2' });
      this.isModelLoaded = true;
      if (onProgress) onProgress('Modelo IA cargado exitosamente.');
      return true;
    } catch (error) {
      console.error('Error al cargar modelo de visión:', error);
      throw error;
    }
  }

  // Calcular Intersection over Union (IoU) entre dos rectángulos [x, y, w, h]
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

  // Ejecuta la detección sobre un frame (video o imagen)
  async detectFrame(sourceElement) {
    if (!this.isModelLoaded || !this.model) return [];

    try {
      const predictions = await this.model.detect(sourceElement);
      const filtered = predictions.filter(pred => {
        if (pred.score < this.confidenceThreshold) return false;

        if (this.selectedClassFilter === 'bottle') {
          return pred.class === 'bottle';
        } else if (this.selectedClassFilter === 'all_products') {
          return ['bottle', 'cup', 'wine glass', 'bowl', 'can', 'cell phone', 'book'].includes(pred.class);
        } else if (this.selectedClassFilter === 'pets_demo') {
          return ['cat', 'dog', 'bottle'].includes(pred.class);
        }
        return true;
      });

      // Actualizar tracker espacial para auto-registro
      this.updateSpatialTracking(filtered, sourceElement);

      return filtered;
    } catch (err) {
      console.warn('Fallo en inferencia de frame:', err);
      return [];
    }
  }

  // Actualiza los objetos en seguimiento y dispara auto-conteo cuando un objeto nuevo se estabiliza
  updateSpatialTracking(predictions, sourceElement) {
    const now = Date.now();
    const matchedTrackIds = new Set();

    predictions.forEach(pred => {
      let bestMatchId = null;
      let highestIoU = 0.35; // Umbral de solapamiento para considerar que es el mismo objeto

      for (const [trackId, tracked] of this.trackedObjects.entries()) {
        if (tracked.class === pred.class) {
          const iou = this.calculateIoU(pred.bbox, tracked.bbox);
          if (iou > highestIoU) {
            highestIoU = iou;
            bestMatchId = trackId;
          }
        }
      }

      if (bestMatchId) {
        // Objeto existente que sigue en cuadro
        const tracked = this.trackedObjects.get(bestMatchId);
        tracked.bbox = pred.bbox;
        tracked.score = pred.score;
        tracked.lastSeen = now;
        tracked.framesSeen += 1;
        matchedTrackIds.add(bestMatchId);

        // Si se mantiene estable durante 6 frames consecutivos y no se ha registrado aún:
        if (!tracked.registered && tracked.framesSeen >= 6) {
          tracked.registered = true;
          if (this.onAutoDetectCallback) {
            const thumbnail = this.extractThumbnail(sourceElement, pred.bbox);
            const friendly = this.classLabels[pred.class] || { name: pred.class, category: 'Producto General' };
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
        // Nuevo objeto entrando al cuadro
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

    // Limpiar objetos que desaparecieron del cuadro durante más de 1200ms
    for (const [trackId, tracked] of this.trackedObjects.entries()) {
      if (!matchedTrackIds.has(trackId) && (now - tracked.lastSeen > 1200)) {
        this.trackedObjects.delete(trackId);
      }
    }
  }

  // Extrae un recorte (thumbnail) de alta calidad del bounding box
  extractThumbnail(sourceElement, bbox) {
    try {
      const [bx, by, bw, bh] = bbox;
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');

      // Añadir margen del 10% alrededor del objeto
      const padX = bw * 0.1;
      const padY = bh * 0.1;
      const sx = Math.max(0, bx - padX);
      const sy = Math.max(0, by - padY);
      const sw = Math.min(sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width, bw + padX * 2);
      const sh = Math.min(sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height, bh + padY * 2);

      ctx.drawImage(sourceElement, sx, sy, sw, sh, 0, 0, 120, 120);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      console.warn('No se pudo extraer thumbnail:', e);
      return null;
    }
  }

  // Dibuja los Bounding Boxes interactivos con diseño HUD Industrial
  renderOverlay(canvas, predictions, sourceElement) {
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

      const isBottle = pred.class === 'bottle';
      const colorPrimary = isBottle ? '#38bdf8' : '#10b981';
      const colorGlow = isBottle ? 'rgba(56, 189, 248, 0.3)' : 'rgba(16, 185, 129, 0.3)';

      // 1. Fondo suave translúcido
      ctx.fillStyle = colorGlow;
      ctx.fillRect(rx, ry, rw, rh);

      // 2. Bounding Box Borde
      ctx.strokeStyle = colorPrimary;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);

      // 3. Esquinas reforzadas estilo retícula HUD
      const cornerLen = Math.min(rw, rh) * 0.25;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';

      // Arriba-Izquierda
      ctx.beginPath();
      ctx.moveTo(rx, ry + cornerLen);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + cornerLen, ry);
      ctx.stroke();

      // Arriba-Derecha
      ctx.beginPath();
      ctx.moveTo(rx + rw - cornerLen, ry);
      ctx.lineTo(rx + rw, ry);
      ctx.lineTo(rx + rw, ry + cornerLen);
      ctx.stroke();

      // Abajo-Izquierda
      ctx.beginPath();
      ctx.moveTo(rx, ry + rh - cornerLen);
      ctx.lineTo(rx, ry + rh);
      ctx.lineTo(rx + cornerLen, ry + rh);
      ctx.stroke();

      // Abajo-Derecha
      ctx.beginPath();
      ctx.moveTo(rx + rw - cornerLen, ry + rh);
      ctx.lineTo(rx + rw, ry + rh);
      ctx.lineTo(rx + rw, ry + rh - cornerLen);
      ctx.stroke();

      // 4. Etiqueta superior con nombre y % de certeza
      const friendly = this.classLabels[pred.class] || { name: pred.class };
      const scorePct = Math.round(pred.score * 100);
      const text = `${friendly.name.split(' ')[0]} ${scorePct}%`;

      ctx.font = 'bold 12px "Plus Jakarta Sans", sans-serif';
      const textWidth = ctx.measureText(text).width;

      const labelHeight = 22;
      const labelY = ry > labelHeight ? ry - labelHeight : ry;

      // Caja de texto
      ctx.fillStyle = isBottle ? 'rgba(2, 132, 199, 0.95)' : 'rgba(5, 150, 105, 0.95)';
      ctx.beginPath();
      ctx.roundRect(rx, labelY, textWidth + 24, labelHeight, 4);
      ctx.fill();

      // Punto indicador
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(rx + 8, labelY + labelHeight / 2, 3, 0, Math.PI * 2);
      ctx.fill();

      // Texto
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, rx + 16, labelY + 15);
    });
  }
}

window.VisionEngine = VisionEngine;
