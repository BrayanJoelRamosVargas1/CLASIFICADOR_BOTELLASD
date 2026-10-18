/**
 * EcoLens AI — Detector de botellas con YOLOv10 Nano y ONNX Runtime Web
 * Autor: Brayan Joel Ramos Vargas
 * Docente: Ing. Jesús Bautista
 * Arquitectura: cámara 640x480 + ONNX WASM + seguimiento espacial
 */

(() => {
  'use strict';

  // 0. Purga Preventiva de Caché y Service Workers Antiguos (preservando coi-serviceworker)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => {
        const url = (r.active && r.active.scriptURL) || (r.installing && r.installing.scriptURL) || '';
        if (url && !url.includes('coi-serviceworker')) r.unregister();
      });
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => {
      keys.forEach(k => {
        if (k.startsWith('botellas-')) caches.delete(k);
      });
    }).catch(() => {});
  }

  // 1. Configuración de Detección Calibrada de Alto Rendimiento
  const CONFIG = {
    STORAGE_KEY: 'ecolens_inventory_v4',
    DAILY_STORAGE_KEY: 'ecolens_daily_sheets_v1',
    DEFAULT_THRESHOLD: window.BottleDetection.config.threshold,
    MIN_INFERENCE_SCORE: 0.10, // Descarte temprano
    TARGET_INFERENCE_INTERVAL_MS: 60,
    MIN_INFERENCE_PAUSE_MS: 20,
    CONFIRMATION_HITS: 2,      // Visible en frame 1, registrado de inmediato si >= 26%
    TRACK_LOST_MS: 2200,       // Tolerar pérdidas breves o giros de mano sin duplicar la misma botella
    GRAMS_PLASTIC_PER_BOTTLE: 24.5,
    GRAMS_CO2_PER_BOTTLE: 82.3,
    LITERS_WATER_PER_BOTTLE: 3.2
  };

  // Solo la clase bottle; vasos, floreros y cuencos no se contabilizan como botellas.

  // Referencias DOM
  const dom = {
    video: document.getElementById('cameraFeed'),
    canvas: document.getElementById('overlayCanvas'),
    preview: document.getElementById('imagePreview'),
    idleState: document.getElementById('stageIdleState'),
    laser: document.getElementById('laserLine'),
    cameraChip: document.getElementById('hudCameraChip'),
    statusText: document.getElementById('statusText'),
    hardwareBadge: document.getElementById('hardwareBadge'),
    stageViewport: document.querySelector('.stage-viewport'),
    targetReticle: document.getElementById('targetReticle'),
    reticleGuideText: document.getElementById('reticleGuideText'),
    
    // Controles limpios
    btnStartCamera: document.getElementById('btnStartCamera'),
    btnUploadPhoto: document.getElementById('uploadPhotoInput'),
    btnSwitchCamera: document.getElementById('btnSwitchCamera'),
    btnFlashViewport: document.getElementById('btnFlashViewport'),
    btnManualScan: document.getElementById('btnManualScan'),
    
    // Diagnóstico
    resultIcon: document.getElementById('resultIcon'),
    resultLabel: document.getElementById('resultLabel'),
    resultSub: document.getElementById('resultSub'),
    meterFill: document.getElementById('meterFill'),
    meterPct: document.getElementById('meterPct'),
    btnSpeak: document.getElementById('btnSpeakResult'),
    
    // KPIs de Impacto
    kpiTotalCount: document.getElementById('kpiTotalCount'),
    kpiTotalGrams: document.getElementById('kpiTotalGrams'),
    kpiTotalCo2: document.getElementById('kpiTotalCo2'),
    kpiTotalWater: document.getElementById('kpiTotalWater'),
    counterHeader: document.getElementById('counterHeaderNum'),
    
    // HUD Live
    hudInView: document.getElementById('hudInView'),
    hudInTake: document.getElementById('hudInTake'),
    
    // Control Diario de Inventario y Ventas (Planilla con Foto)
    dailyProductInput: document.getElementById('dailyProductInput'),
    dailyInitialInput: document.getElementById('dailyInitialInput'),
    dailyCurrentInput: document.getElementById('dailyCurrentInput'),
    dailySoldPreview: document.getElementById('dailySoldPreview'),
    dailyStatusPreview: document.getElementById('dailyStatusPreview'),
    dailyAiSyncHint: document.getElementById('dailyAiSyncHint'),
    btnSetInitialFromAi: document.getElementById('btnSetInitialFromAi'),
    btnSaveDailyCut: document.getElementById('btnSaveDailyCut'),
    btnExportDailyCsv: document.getElementById('btnExportDailyCsv'),
    btnPrintDailySheet: document.getElementById('btnPrintDailySheet'),
    btnClearDailySheet: document.getElementById('btnClearDailySheet'),
    dailyTableBody: document.getElementById('dailyTableBody'),
    dailyEmptyRow: document.getElementById('dailyEmptyRow'),

    // Inventario
    invTableBody: document.getElementById('invTableBody'),
    invEmpty: document.getElementById('invEmptyRow'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnExportJson: document.getElementById('btnExportJson'),
    btnClearInv: document.getElementById('btnClearInv'),
    invSearch: document.getElementById('invSearchInput'),
    invTotalUnits: document.getElementById('invTotalUnits')
  };

  // Canvas auxiliar de 16x16 para estimación de color
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 16;
  sampleCanvas.height = 16;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  // Estado del Sistema
  let detector = null;
  let stream = null;
  let activeSource = null;
  let facingMode = 'environment';
  let activeThreshold = CONFIG.DEFAULT_THRESHOLD;
  let isDetecting = false;
  let sourceGeneration = 0;
  let isLoopActive = false;
  let animFrameId = null;
  let loopTimeoutId = null;
  let audioCtx = null;
  let lastSpokenText = '';
  let isTorchOn = false;
  
  // Tracking Multi-Objeto 1-a-1 Ultrarrápido
  let trackers = [];
  let visibleBoxes = [];
  let takeCount = 0;
  let nextTrackId = 1;

  // 2. Sintetizador de Sonidos Web Audio API
  function playSound(type = 'chime') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtx) audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;

      if (type === 'chime' || type === 'multi-chime') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(740, now + 0.08); // F#5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.16); // A5
        osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.24); // D6
        gain.gain.setValueAtTime(0.28, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
        osc.start(now);
        osc.stop(now + 0.38);
      } else if (type === 'click') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(950, now);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      }
    } catch (e) {}
  }

  let initPromise = null;

  // 3. Inicialización del modelo YOLOv10, servido desde el propio sitio.
  async function initNeuralEngines() {
    if (detector) return detector;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        if (!window.ort || !window.YoloBottleDetector) {
          throw new Error('ONNX Runtime no cargó');
        }
        dom.statusText.textContent = '⏳ Preparando detector IA (descarga única en caché)...';
        detector = await window.YoloBottleDetector.load('./models/yolov10n/model.onnx?v=19.0');
        dom.statusText.textContent = isLoopActive
          ? '● Cámara activa. Apunta hacia tus botellas.'
          : '● Detector listo. Inicia la cámara o sube una foto para clasificar.';
        const threads = (window.ort && window.ort.env && window.ort.env.wasm && window.ort.env.wasm.numThreads) || 1;
        dom.hardwareBadge.innerHTML = `<span class="dot"></span> YOLO · WASM ${threads > 1 ? threads + 'T' : 'SIMD'}`;
        if (dom.btnManualScan) dom.btnManualScan.disabled = false;
        return detector;
      } catch (error) {
        console.error('Error al inicializar IA:', error);
        dom.statusText.textContent = 'No se pudo cargar el detector. Recarga la página y revisa tu conexión.';
        dom.hardwareBadge.style.background = '#fef2f2';
        dom.hardwareBadge.style.color = '#dc2626';
        dom.hardwareBadge.textContent = 'Detector no disponible';
        initPromise = null;
        return null;
      }
    })();
    return initPromise;
  }

  // 4. Geometría y Clasificación Espectral de Material
  function computeIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function computeMatchScore(a, b, countInFrame = 1) {
    const iou = computeIoU(a, b);
    if (iou > 0.25) return iou;
    const acx = a.x + a.w * 0.5, acy = a.y + a.h * 0.5;
    const bcx = b.x + b.w * 0.5, bcy = b.y + b.h * 0.5;
    const dx = Math.abs(acx - bcx);
    const dy = Math.abs(acy - bcy);
    const maxW = Math.max(a.w, b.w, 1);
    const maxH = Math.max(a.h, b.h, 1);
    const sizeRatio = Math.min(a.w * a.h, b.w * b.h) / Math.max(a.w * a.h, b.w * b.h, 1);
    const limitX = countInFrame === 1 ? Math.max(maxW * 2.2, 220) : maxW * 0.75;
    const limitY = countInFrame === 1 ? Math.max(maxH * 0.85, 180) : maxH * 0.55;
    const minRatio = countInFrame === 1 ? 0.38 : 0.50;
    if (dx < limitX && dy < limitY && sizeRatio > minRatio) {
      const normDist = Math.hypot(dx / limitX, dy / limitY);
      if (normDist < 1) return Math.max(iou, 0.75 * (1 - normDist * 0.6));
    }
    return iou;
  }

  // Heurística visual de material sobre el núcleo central del envase (evitando el fondo de las esquinas).
  function inspectMaterial(bx, by, bw, bh, rawClass) {
    if (rawClass === 'wine glass') {
      return {
        label: 'Botella de Vidrio (Estimado)',
        tagClass: 'glass',
        color: '#a855f7',
        fill: 'rgba(168, 85, 247, 0.22)',
        icon: 'bx-wine'
      };
    }

    if (!activeSource) {
      return {
        label: 'Botella PET (Estimado por Color)',
        tagClass: 'pet',
        color: '#06b6d4',
        fill: 'rgba(6, 182, 212, 0.20)',
        icon: 'bx-water'
      };
    }

    try {
      const srcW = activeSource.videoWidth || activeSource.naturalWidth || 640;
      const srcH = activeSource.videoHeight || activeSource.naturalHeight || 480;

      const coreX = bx + bw * 0.22;
      const coreY = by + bh * 0.18;
      const coreW = bw * 0.56;
      const coreH = bh * 0.64;

      const sx = Math.max(0, Math.min(srcW - 2, Math.floor(coreX)));
      const sy = Math.max(0, Math.min(srcH - 2, Math.floor(coreY)));
      const sw = Math.max(4, Math.min(srcW - sx, Math.floor(coreW)));
      const sh = Math.max(4, Math.min(srcH - sy, Math.floor(coreH)));

      sampleCtx.drawImage(activeSource, sx, sy, sw, sh, 0, 0, 16, 16);
      const imgData = sampleCtx.getImageData(0, 0, 16, 16);
      const d = imgData.data;

      let totalLum = 0;
      let redCount = 0;
      let darkCount = 0;
      let greenCount = 0;
      const total = 16 * 16;

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        totalLum += lum;

        if (r > 105 && r > g * 1.30 && r > b * 1.30) redCount++;
        if (lum < 75) darkCount++;
        if (g > 65 && g > r * 1.20 && g > b * 1.20) greenCount++;
      }

      const avgLum = totalLum / total;
      const redRatio = redCount / total;
      const darkRatio = darkCount / total;
      const greenRatio = greenCount / total;

      // 1. Vidrio (Vino, Cerveza oscura, Tinte verde)
      if (darkRatio > 0.35 || greenRatio > 0.30 || avgLum < 85) {
        return {
          label: 'Botella de Vidrio (Estimado)',
          tagClass: 'glass',
          color: '#a855f7',
          fill: 'rgba(168, 85, 247, 0.22)',
          icon: 'bx-wine'
        };
      }

      // 2. Coca-Cola / Bebida con etiqueta roja
      if (redRatio > 0.035) {
        return {
          label: 'Botella PET (Etiqueta Roja; Estimado)',
          tagClass: 'coca',
          color: '#ef4444',
          fill: 'rgba(239, 68, 68, 0.22)',
          icon: 'bx-recycle'
        };
      }

      // 3. Plástico Transparente (Agua / PET)
      return {
        label: 'Botella PET (Estimado por Color)',
        tagClass: 'pet',
        color: '#06b6d4',
        fill: 'rgba(6, 182, 212, 0.20)',
        icon: 'bx-water'
      };
    } catch (e) {
      return {
        label: 'Botella PET (Estimado por Color)',
        tagClass: 'pet',
        color: '#06b6d4',
        fill: 'rgba(6, 182, 212, 0.20)',
        icon: 'bx-water'
      };
    }
  }

  // 5. Dimensionamiento Exacto del Canvas
  function syncCanvasDimensions() {
    if (!activeSource) return;

    const srcW = activeSource.videoWidth || activeSource.naturalWidth || activeSource.width;
    const srcH = activeSource.videoHeight || activeSource.naturalHeight || activeSource.height;

    if (!srcW || !srcH) return;

    if (dom.canvas.width !== srcW || dom.canvas.height !== srcH) {
      dom.canvas.width = srcW;
      dom.canvas.height = srcH;
    }
  }

  let activeInferencePromise = null;

  // 6. Procesamiento asíncrono de botellas
  async function processVisualFrame(forceWait = false) {
    if (!detector || !activeSource) return;
    if (isDetecting) {
      if (!forceWait || !activeInferencePromise) return;
      try {
        await activeInferencePromise;
      } catch (e) {}
      if (!detector || !activeSource) return;
    }

    const srcW = activeSource.videoWidth || activeSource.naturalWidth || activeSource.width;
    const srcH = activeSource.videoHeight || activeSource.naturalHeight || activeSource.height;

    if (!srcW || !srcH || (activeSource.readyState !== undefined && activeSource.readyState < 2)) {
      return;
    }

    isDetecting = true;
    const generation = sourceGeneration;

    activeInferencePromise = (async () => {
      try {
        // 1. Inferencia Directa sobre activeSource (Sin buffer rígido que cause deformación)
        const rawPredictions = await detector.detect(activeSource, window.BottleDetection.config.maxBoxes, CONFIG.MIN_INFERENCE_SCORE);

        // Descartar resultados de una cámara o fotografía que ya fue cerrada.
        if (generation !== sourceGeneration) return;

        // Compartir exactamente el mismo filtrado con la evaluación de fotografías.
        const filtered = window.BottleDetection.select(rawPredictions, srcW, srcH, activeThreshold);

        // 4. Tracking Espacial 1-a-1 Rápido (Permite cambio inmediato de botella)
        const matchedTrackerIds = new Set();
        const newlyRegistered = [];
        const now = Date.now();
        // Una inferencia lenta no equivale a perder el objeto: exigir una ausencia observada.
        trackers = trackers.filter(t => t.missed === 0 || now - t.lastSeen < CONFIG.TRACK_LOST_MS);

        for (const box of filtered) {
          let bestMatch = null;
          let bestIoU = 0.25; // Requiere coincidencia espacial real

          for (const t of trackers) {
            if (matchedTrackerIds.has(t.id)) continue;

            const score = computeMatchScore(t, box, filtered.length);
            if (score > bestIoU) {
              bestIoU = score;
              bestMatch = t;
            }
          }

          if (bestMatch) {
            bestMatch.x = bestMatch.x * 0.30 + box.x * 0.70;
            bestMatch.y = bestMatch.y * 0.30 + box.y * 0.70;
            bestMatch.w = bestMatch.w * 0.30 + box.w * 0.70;
            bestMatch.h = bestMatch.h * 0.30 + box.h * 0.70;
            bestMatch.score = Math.max(bestMatch.score, box.score);
            bestMatch.lastSeen = now;
            bestMatch.missed = 0;
            bestMatch.hits++;
            matchedTrackerIds.add(bestMatch.id);

            // Confirmación y Auto-Registro en Frame 2 (o inmediato si supera 0.26)
            if ((bestMatch.hits >= CONFIG.CONFIRMATION_HITS || bestMatch.score >= 0.26) && !bestMatch.registered) {
              bestMatch.registered = true;
              newlyRegistered.push(bestMatch);
            }
          } else {
            // Clasificar material 1 sola vez al crear el tracker (sin repetir el muestreo de color)
            const meta = inspectMaterial(box.x, box.y, box.w, box.h, box.rawClass);
            const instantConfirm = isLoopActive && box.score >= 0.26;
            const newTracker = {
              id: `ECO-${String(nextTrackId++).padStart(3, '0')}`,
              x: box.x,
              y: box.y,
              w: box.w,
              h: box.h,
              score: box.score,
              rawClass: box.rawClass,
              meta: meta,
              label: meta.label,
              hits: instantConfirm ? CONFIG.CONFIRMATION_HITS : 1,
              lastSeen: now,
              missed: 0,
              registered: instantConfirm
            };
            trackers.push(newTracker);
            matchedTrackerIds.add(newTracker.id);
            if (instantConfirm) {
              newlyRegistered.push(newTracker);
            }
          }
        }

        // Incrementar missed a trackers no detectados en este frame
        for (const t of trackers) {
          if (!matchedTrackerIds.has(t.id)) {
            t.missed++;
            if (!t.registered && t.missed >= 2) t.hits = 0;
          }
        }

        // Mantener identidad durante pérdidas breves; dibujar solo detecciones actuales.
        visibleBoxes = trackers.filter(t => t.missed === 0);

        dom.hudInView.textContent = visibleBoxes.length;
        if (
          (visibleBoxes.length > 0 || (isLoopActive && takeCount > 0)) &&
          dom.dailyCurrentInput &&
          dom.dailyCurrentInput.value !== undefined &&
          document.activeElement !== dom.dailyCurrentInput
        ) {
          dom.dailyCurrentInput.value = String(visibleBoxes.length);
          updateDailyPreview();
        }

        // Actualizar estado de la Retícula
        const hasActive = visibleBoxes.length > 0;
        if (dom.targetReticle) {
          dom.targetReticle.classList.toggle('reticle-locked', hasActive);
          if (dom.reticleGuideText) {
            dom.reticleGuideText.textContent = hasActive
              ? `✓ ${visibleBoxes.length} Botella(s) en Vista`
              : 'Encuadra tus botellas aquí';
          }
        }

        // Notificar registro de botellas confirmadas
        if (newlyRegistered.length > 0) {
          onNewBottlesRegistered(newlyRegistered);
        } else if (visibleBoxes.length > 0) {
          const labelsList = visibleBoxes.map(b => b.label.split(' ')[0] + ' ' + b.label.split(' ')[1]).join(', ');
          dom.statusText.textContent = `● ${visibleBoxes.length} botella(s): ${labelsList} (${Math.round(visibleBoxes[0].score * 100)}%)`;
        } else {
          dom.statusText.textContent = 'Buscando botellas...';
        }

        if (isLoopActive) renderCanvasHUD();

      } catch (err) {
        console.warn('EcoLens: Advertencia en ciclo de inferencia:', err);
      } finally {
        isDetecting = false;
        activeInferencePromise = null;
      }
    })();

    return activeInferencePromise;
  }

  // 7. Registro de Nuevas Botellas e Inventario
  function onNewBottlesRegistered(items) {
    playSound(items.length > 1 ? 'multi-chime' : 'chime');
    takeCount += items.length;
    dom.hudInTake.textContent = takeCount;

    if (dom.stageViewport) {
      dom.stageViewport.style.outline = '3px solid #10b981';
      setTimeout(() => {
        if (dom.stageViewport) dom.stageViewport.style.outline = 'none';
      }, 400);
    }

    const newRecords = items.map(item => ({
      id: item.id,
      timestamp: new Date().toISOString(),
      label: item.label,
      tagClass: item.meta ? item.meta.tagClass : 'pet',
      confidence: Math.round(item.score * 100),
      gramsPlastic: item.meta && item.meta.tagClass === 'glass' ? 0 : CONFIG.GRAMS_PLASTIC_PER_BOTTLE,
      co2Saved: CONFIG.GRAMS_CO2_PER_BOTTLE
    }));

    const currentInv = loadInventory();
    const updatedInv = [...newRecords, ...currentInv];
    saveInventory(updatedInv);
    renderInventoryTable(updatedInv);
    updateImpactMetrics(updatedInv);

    if (items.length === 1) {
      const first = items[0];
      dom.resultIcon.innerHTML = `<i class="bx ${first.meta ? first.meta.icon : 'bx-recycle'}"></i>`;
      dom.resultLabel.textContent = `¡${first.label} Identificada!`;
      dom.resultSub.textContent = `Código ${first.id} registrado · Confianza: ${Math.round(first.score * 100)}%`;
      
      const pct = Math.round(first.score * 100);
      dom.meterPct.textContent = `${pct}%`;
      dom.meterFill.style.width = `${pct}%`;
      lastSpokenText = `Detectada ${first.label} con confianza del ${pct} por ciento. Guardada en el inventario.`;
    } else {
      dom.resultIcon.innerHTML = `<i class="bx bx-layer"></i>`;
      dom.resultLabel.textContent = `¡${items.length} Botellas Identificadas Juntas!`;
      dom.resultSub.textContent = `${items.map(i => i.id).join(', ')} añadidas simultáneamente al inventario`;
      
      const avgPct = Math.round(items.reduce((acc, i) => acc + i.score, 0) / items.length * 100);
      dom.meterPct.textContent = `${avgPct}% prom.`;
      dom.meterFill.style.width = `${avgPct}%`;
      lastSpokenText = `Detectadas ${items.length} botellas juntas. Añadidas al inventario.`;
    }

    dom.btnSpeak.style.display = 'inline-flex';
  }

  // 8. Renderizado del HUD en Canvas con Colores Específicos por Material
  function renderCanvasHUD() {
    if (!activeSource) return;

    syncCanvasDimensions();

    const canvas = dom.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (visibleBoxes.length === 0) return;

    const baseScale = Math.max(1, canvas.width / 800);

    for (const box of visibleBoxes) {
      const rx = box.x;
      const ry = box.y;
      const rw = box.w;
      const rh = box.h;

      const meta = box.meta || { color: '#10b981', fill: 'rgba(16, 185, 129, 0.18)' };
      const isFaded = box.missed > 0;
      const strokeColor = meta.color;
      const fillColor = isFaded ? 'rgba(0,0,0,0.05)' : meta.fill;
      const tagText = `${box.registered ? '✓' : '●'} ${box.id} · ${box.label} ${Math.round(box.score * 100)}%`;

      // 1. Relleno traslúcido
      ctx.fillStyle = fillColor;
      ctx.fillRect(rx, ry, rw, rh);

      // 2. Borde exterior
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.round(3.5 * baseScale);
      ctx.strokeRect(rx, ry, rw, rh);

      // 3. Esquinas reforzadas
      const corner = Math.min(24 * baseScale, rw / 3, rh / 3);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.round(4.5 * baseScale);
      
      ctx.beginPath();
      ctx.moveTo(rx, ry + corner);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + corner, ry);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx + rw - corner, ry);
      ctx.lineTo(rx + rw, ry);
      ctx.lineTo(rx + rw, ry + corner);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx, ry + rh - corner);
      ctx.lineTo(rx, ry + rh);
      ctx.lineTo(rx + corner, ry + rh);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx + rw - corner, ry + rh);
      ctx.lineTo(rx + rw, ry + rh);
      ctx.lineTo(rx + rw, ry + rh - corner);
      ctx.stroke();

      // 4. Etiqueta flotante
      const fontSize = Math.max(13, Math.round(14 * baseScale));
      ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
      const textMetrics = ctx.measureText(tagText);
      const tagHeight = Math.round(28 * baseScale);
      const tagY = ry > tagHeight + 6 ? ry - tagHeight - 4 : ry + 6;

      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.roundRect(rx, tagY, textMetrics.width + 18 * baseScale, tagHeight, 6 * baseScale);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(tagText, rx + 9 * baseScale, tagY + tagHeight * 0.68);
    }
  }

  // 9. Bucle secuencial: frecuencia objetivo sujeta al rendimiento del dispositivo.
  async function runInferenceLoop(generation = sourceGeneration) {
    if (!isLoopActive || generation !== sourceGeneration) return;

    const startTime = performance.now();
    try {
      await processVisualFrame();
    } catch (e) {
      console.warn('EcoLens: Advertencia en ciclo visual:', e);
    }

    if (!isLoopActive || generation !== sourceGeneration) return;

    // Descontar el tiempo de inferencia y ceder el hilo entre análisis sin acumular trabajo.
    const elapsed = performance.now() - startTime;
    const waitMs = Math.max(CONFIG.MIN_INFERENCE_PAUSE_MS, CONFIG.TARGET_INFERENCE_INTERVAL_MS - elapsed);
    loopTimeoutId = setTimeout(() => runInferenceLoop(generation), waitMs);
  }

  // 10. Control de Linterna LED Física de la Cámara Trasera
  async function toggleTorch() {
    if (!stream) {
      alert('Inicia la cámara primero para encender la linterna LED.');
      return;
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      const nextState = !isTorchOn;

      await track.applyConstraints({
        advanced: [{ torch: nextState }]
      });

      isTorchOn = nextState;
      updateTorchUI();
      playSound('click');
    } catch (err) {
      console.warn('EcoLens: Linterna LED no disponible en este sensor/navegador:', err);
      alert('La linterna LED solo está disponible en la cámara trasera en dispositivos móviles (Android/Brave). Asegúrate de tener la cámara trasera activa.');
      isTorchOn = false;
      updateTorchUI();
    }
  }

  function updateTorchUI() {
    const iconClass = isTorchOn ? 'bxs-sun' : 'bx-sun';

    if (dom.btnFlashViewport) {
      dom.btnFlashViewport.innerHTML = `<i class="bx ${iconClass}"></i>`;
      dom.btnFlashViewport.classList.toggle('flash-active', isTorchOn);
    }
  }

  async function startCamera() {
    stopActiveSource();
    dom.statusText.textContent = 'Conectando sensor óptico...';

    try {
      // Solicitar 640x480; la velocidad real depende de la cámara y el dispositivo.
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      dom.video.srcObject = stream;
      
      await new Promise((resolve) => {
        dom.video.onloadedmetadata = () => {
          dom.video.play().then(resolve);
        };
      });

      activeSource = dom.video;
      syncCanvasDimensions();
      isLoopActive = true;

      dom.idleState.style.display = 'none';
      dom.preview.style.display = 'none';
      dom.video.style.display = 'block';
      dom.canvas.style.display = 'block';
      dom.laser.classList.add('laser-active');
      dom.cameraChip.style.display = 'flex';
      if (dom.targetReticle) dom.targetReticle.style.display = 'flex';
      
      // Mostrar botones flotantes en viewport
      if (dom.btnFlashViewport) dom.btnFlashViewport.style.display = 'flex';
      if (dom.btnSwitchCamera) dom.btnSwitchCamera.style.display = 'flex';

      dom.btnStartCamera.innerHTML = '<i class="bx bx-stop-circle"></i> <span>Detener Cámara</span>';
      dom.btnStartCamera.classList.add('btn-danger');

      updateTorchUI();
      renderCanvasHUD();
      playSound('click');

      if (!detector) {
        dom.statusText.textContent = '⏳ Cámara encendida. Terminando de cargar IA para empezar a detectar...';
        await initNeuralEngines();
        if (!isLoopActive) return;
      }

      runInferenceLoop();
      if (detector) {
        dom.statusText.textContent = '● Cámara activa. Apunta hacia tus botellas.';
      }
    } catch (err) {
      console.error('Error al iniciar cámara:', err);
      dom.statusText.textContent = 'No se pudo activar la cámara. Revisa los permisos en tu navegador.';
      stopActiveSource();
    }
  }

  function stopActiveSource() {
    sourceGeneration++;
    trackers = [];
    visibleBoxes = [];
    takeCount = 0;
    dom.hudInView.textContent = 0;
    dom.hudInTake.textContent = 0;
    isLoopActive = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (loopTimeoutId) clearTimeout(loopTimeoutId);

    if (isTorchOn) {
      isTorchOn = false;
      updateTorchUI();
    }
    if (dom.btnFlashViewport) dom.btnFlashViewport.style.display = 'none';
    if (dom.btnSwitchCamera) dom.btnSwitchCamera.style.display = 'none';
    if (dom.targetReticle) dom.targetReticle.style.display = 'none';

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    if (dom.video.srcObject) {
      dom.video.srcObject = null;
    }

    dom.video.style.display = 'none';
    dom.canvas.style.display = 'none';
    dom.preview.style.display = 'none';
    dom.idleState.style.display = 'flex';
    dom.laser.classList.remove('laser-active');
    dom.cameraChip.style.display = 'none';

    dom.btnStartCamera.innerHTML = '<i class="bx bx-camera"></i> <span>Iniciar Cámara</span>';
    dom.btnStartCamera.classList.remove('btn-danger');
    dom.statusText.textContent = 'Cámara detenida.';
    activeSource = null;
  }

  // 11. Carga de Fotografías
  function handlePhotoUpload(file) {
    if (!file) return;
    stopActiveSource();
    const myGeneration = sourceGeneration;
    dom.statusText.textContent = '⏳ Analizando fotografía con IA...';

    const reader = new FileReader();
    reader.onload = (e) => {
      if (myGeneration !== sourceGeneration) return;
      const img = new Image();
      img.onload = async () => {
        if (myGeneration !== sourceGeneration) return;
        activeSource = img;
        dom.preview.src = e.target.result;
        dom.idleState.style.display = 'none';
        dom.video.style.display = 'none';
        dom.preview.style.display = 'block';
        dom.canvas.style.display = 'block';

        syncCanvasDimensions();

        trackers = [];
        takeCount = 0;
        dom.statusText.textContent = '⏳ Analizando fotografía con IA...';

        if (!detector) {
          await initNeuralEngines();
          if (myGeneration !== sourceGeneration) return;
        }
        await processVisualFrame(true);
        if (myGeneration !== sourceGeneration || activeSource !== img) return;

        if (dom.dailyCurrentInput && dom.dailyCurrentInput.value !== undefined) {
          dom.dailyCurrentInput.value = String(visibleBoxes.length);
          updateDailyPreview();
        }
        // En fotos, confirmar directamente las botellas visibles
        const found = visibleBoxes.filter(t => !t.registered);
        for (const t of found) {
          t.registered = true;
        }
        if (found.length > 0) {
          onNewBottlesRegistered(found);
        }
        renderCanvasHUD();

        if (visibleBoxes.length > 0) {
          dom.statusText.textContent = `✓ ¡${visibleBoxes.length} botella(s) detectada(s) en la fotografía! (${Math.round(visibleBoxes[0].score * 100)}%)`;
        } else {
          dom.statusText.textContent = 'No se distinguieron botellas en la imagen (Quedan: 0).';
          if (dom.resultLabel) dom.resultLabel.textContent = 'Sin botellas en la imagen';
          if (dom.resultSub) dom.resultSub.textContent = 'Objeto descartado o sin envases válidos en escena';
          if (dom.meterPct) dom.meterPct.textContent = '0%';
          if (dom.meterFill) dom.meterFill.style.width = '0%';
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // 12. Captura Inmediata Manual de Botellas Visibles
  async function forceManualScan() {
    if (!activeSource) {
      alert('Primero inicia la cámara o sube una fotografía.');
      return;
    }

    playSound('click');
    dom.statusText.textContent = 'Analizando escena...';

    // 1. Si ya hay botellas visibles, registrarlas de inmediato
    const unreg = visibleBoxes.filter(b => !b.registered && b.missed === 0);
    if (unreg.length > 0) {
      for (const b of unreg) {
        b.registered = true;
      }
      onNewBottlesRegistered(unreg);
      renderCanvasHUD();
      dom.statusText.textContent = `✓ ¡${unreg.length} botella(s) registrada(s) con éxito!`;
      return;
    }

    // Escanear con el mismo umbral y bloqueo que el modo automático.
    try {
      await processVisualFrame(true);

      const newlyFound = visibleBoxes.filter(b => !b.registered && b.missed === 0);
      if (newlyFound.length > 0) {
        for (const b of newlyFound) {
          b.registered = true;
        }
        onNewBottlesRegistered(newlyFound);
        renderCanvasHUD();
        dom.statusText.textContent = `✓ ¡${newlyFound.length} botella(s) registrada(s) con éxito!`;
        return;
      }
    } catch (e) {
      console.warn('Error en escaneo manual:', e);
    }

    dom.statusText.textContent = 'Enfoca tus botellas hacia la cámara para capturarlas.';
  }

  // 13. Persistencia en LocalStorage
  function loadInventory() {
    try {
      const data = localStorage.getItem(CONFIG.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function saveInventory(list) {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function renderInventoryTable(items = loadInventory()) {
    dom.invTableBody.innerHTML = '';
    const total = items.length;
    dom.invTotalUnits.textContent = total;
    dom.counterHeader.textContent = total;

    if (total === 0) {
      dom.invEmpty.style.display = '';
      return;
    }

    dom.invEmpty.style.display = 'none';

    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.className = 'inv-row';

      const timeStr = new Date(item.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      const tagClass = item.tagClass || (item.label.includes('Vidrio') ? 'glass' : item.label.includes('Coca') ? 'coca' : 'pet');
      const iconClass = tagClass === 'glass' ? 'bx-wine' : tagClass === 'coca' ? 'bx-recycle' : 'bx-water';

      tr.innerHTML = `
        <td style="font-weight:700; font-family:var(--font-mono); color:var(--primary);">${item.id}</td>
        <td>
          <span class="material-tag ${tagClass}">
            <i class="bx ${iconClass}"></i>
            ${item.label}
          </span>
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <div style="width:40px; height:6px; background:#e2e8f0; border-radius:999px; overflow:hidden;">
              <div style="height:100%; width:${item.confidence}%; background:${tagClass === 'glass' ? '#a855f7' : tagClass === 'coca' ? '#ef4444' : '#10b981'};"></div>
            </div>
            <strong style="font-size:0.8rem; font-family:var(--font-mono);">${item.confidence}%</strong>
          </div>
        </td>
        <td style="color:var(--text-muted); font-size:0.8rem;">${timeStr}</td>
        <td style="text-align:right;">
          <button class="btn-action-sm btn-danger" data-id="${item.id}" title="Eliminar registro">
            <i class="bx bx-trash"></i>
          </button>
        </td>
      `;

      dom.invTableBody.appendChild(tr);
    });

    dom.invTableBody.querySelectorAll('.btn-danger').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idToDelete = e.currentTarget.dataset.id;
        const current = loadInventory().filter(i => i.id !== idToDelete);
        saveInventory(current);
        renderInventoryTable(current);
        updateImpactMetrics(current);
        playSound('click');
      });
    });
  }

  // 14. Métricas de Impacto Ecológico
  function updateImpactMetrics(items = loadInventory()) {
    const count = items.length;
    const petCount = items.filter(i => i.tagClass !== 'glass').length;
    const gramsPlastic = Math.round(petCount * CONFIG.GRAMS_PLASTIC_PER_BOTTLE);
    const gramsCo2 = Math.round(count * CONFIG.GRAMS_CO2_PER_BOTTLE);
    const litersWater = Math.round(count * CONFIG.LITERS_WATER_PER_BOTTLE * 10) / 10;

    dom.kpiTotalCount.textContent = count;
    dom.kpiTotalGrams.textContent = `${gramsPlastic}g`;
    dom.kpiTotalCo2.textContent = `${gramsCo2}g`;
    dom.kpiTotalWater.textContent = `${litersWater}L`;
  }

  // 15. Exportación CSV y JSON
  function exportCSV() {
    const items = loadInventory();
    if (!items.length) {
      alert('No hay registros en el inventario para exportar.');
      return;
    }

    let csv = 'ID,Material,Confianza,Fecha,Gramos_Plastico,Gramos_CO2\n';
    items.forEach(i => {
      csv += `"${i.id}","${i.label}","${i.confidence}%","${i.timestamp}","${i.gramsPlastic}","${i.co2Saved}"\n`;
    });

    downloadBlob(csv, `EcoLens_Inventario_${Date.now()}.csv`, 'text/csv');
  }

  function exportJSON() {
    const items = loadInventory();
    if (!items.length) {
      alert('No hay registros en el inventario para exportar.');
      return;
    }

    downloadBlob(JSON.stringify(items, null, 2), `EcoLens_Inventario_${Date.now()}.json`, 'application/json');
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 15.B Control Diario de Inventario y Ventas (Planilla con Foto)
  function loadDailySheets() {
    try {
      const raw = localStorage.getItem(CONFIG.DAILY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveDailySheets(list) {
    try {
      // Conservar hasta 40 cortes con miniatura para no exceder la cuota de localStorage
      localStorage.setItem(CONFIG.DAILY_STORAGE_KEY, JSON.stringify(list.slice(0, 40)));
    } catch (e) {}
  }

  function updateDailyPreview() {
    if (!dom.dailyInitialInput || !dom.dailyCurrentInput || !dom.dailySoldPreview) return;
    const cut = window.BottleDetection.computeDailyCut(
      dom.dailyInitialInput.value,
      dom.dailyCurrentInput.value,
      dom.dailyProductInput ? dom.dailyProductInput.value : 'Botellas de Agua'
    );
    if (cut.restockedUnits > 0) {
      dom.dailySoldPreview.textContent = `0 vendidas (+${cut.restockedUnits})`;
    } else {
      dom.dailySoldPreview.textContent = `${cut.soldUnits} vendida${cut.soldUnits === 1 ? '' : 's'}`;
    }
    if (dom.dailyStatusPreview) {
      dom.dailyStatusPreview.textContent = `Quedan ${cut.remainingStock} de ${cut.initialStock} · ${cut.status}`;
    }
  }

  function captureEvidenceSnapshot(cut) {
    try {
      const snap = document.createElement('canvas');
      snap.width = 240;
      snap.height = 160;
      const ctx = snap.getContext('2d');
      if (!ctx || !ctx.fillRect) return '';

      if (activeSource) {
        renderCanvasHUD();
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, snap.width, snap.height);
        ctx.drawImage(activeSource, 0, 0, snap.width, snap.height);
        if (dom.canvas && dom.canvas.width > 0) {
          ctx.drawImage(dom.canvas, 0, 0, snap.width, snap.height);
        }
      } else {
        ctx.fillStyle = '#064e3b';
        ctx.fillRect(0, 0, snap.width, snap.height);
        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 15px sans-serif';
        if (ctx.fillText) {
          ctx.fillText(cut.product.slice(0, 22), 14, 36);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 20px monospace';
          ctx.fillText(`Ini:${cut.initialStock} -> Quedan:${cut.remainingStock}`, 14, 82);
          ctx.fillStyle = '#a7f3d0';
          ctx.font = 'bold 16px sans-serif';
          ctx.fillText(`Vendidas: ${cut.soldUnits} u.`, 14, 122);
        }
      }
      return snap.toDataURL ? snap.toDataURL('image/jpeg', 0.72) : '';
    } catch (e) {
      return '';
    }
  }

  function saveDailyCut() {
    if (!dom.dailyInitialInput || !dom.dailyCurrentInput) return;
    const cut = window.BottleDetection.computeDailyCut(
      dom.dailyInitialInput.value,
      dom.dailyCurrentInput.value,
      dom.dailyProductInput ? dom.dailyProductInput.value : 'Botellas de Agua'
    );
    const currentList = loadDailySheets();
    const record = {
      id: `DIA-${String(currentList.length + 1).padStart(3, '0')}`,
      timestamp: new Date().toISOString(),
      product: cut.product,
      initialStock: cut.initialStock,
      remainingStock: cut.remainingStock,
      soldUnits: cut.soldUnits,
      restockedUnits: cut.restockedUnits,
      status: cut.status,
      photo: captureEvidenceSnapshot(cut)
    };
    const updated = [record, ...currentList];
    saveDailySheets(updated);
    renderDailyTable(updated);
    updateDailyPreview();
    playSound('chime');
    if (dom.statusText) {
      dom.statusText.textContent = `✓ Corte guardado en Planilla: Empezó con ${cut.initialStock}, quedan ${cut.remainingStock} → ${cut.soldUnits} vendida(s).`;
    }
  }

  function renderDailyTable(list = loadDailySheets()) {
    if (!dom.dailyTableBody || !dom.dailyTableBody.appendChild) return;
    dom.dailyTableBody.innerHTML = '';
    if (!list.length) {
      if (dom.dailyEmptyRow) {
        dom.dailyEmptyRow.style.display = '';
        dom.dailyTableBody.appendChild(dom.dailyEmptyRow);
      }
      return;
    }

    list.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = 'inv-row';
      const dateObj = new Date(row.timestamp);
      const dateStr = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

      const statusBg = row.status === 'Agotado'
        ? '#fef2f2; color:#dc2626;'
        : row.status === 'Con Ventas'
          ? '#ecfdf5; color:#059669;'
          : row.status === 'Reposición'
            ? '#eff6ff; color:#2563eb;'
            : '#f1f5f9; color:#475569;';

      const soldLabel = row.restockedUnits > 0
        ? `0 (+${row.restockedUnits} rep.)`
        : `${row.soldUnits} vendida${row.soldUnits === 1 ? '' : 's'}`;

      const photoHtml = row.photo
        ? `<img src="${row.photo}" alt="Evidencia ${row.id}" style="width:72px; height:48px; object-fit:cover; border-radius:8px; border:1px solid #cbd5e1; cursor:pointer;" title="Clic para abrir foto">`
        : `<span style="font-size:0.75rem; color:var(--text-muted);">Sin foto</span>`;

      tr.innerHTML = `
        <td>${photoHtml}</td>
        <td style="font-size:0.8rem; color:var(--text-muted);">
          <strong style="color:var(--text-main); display:block;">${dateStr}</strong>
          <span>${timeStr} · ${row.id}</span>
        </td>
        <td class="daily-prod-cell" style="font-weight:700;"></td>
        <td style="font-family:var(--font-mono); font-weight:700;">${row.initialStock} u.</td>
        <td style="font-family:var(--font-mono); font-weight:700; color:#0284c7;">${row.remainingStock} u.</td>
        <td style="font-family:var(--font-mono); font-weight:800; color:#059669; font-size:0.95rem;">${soldLabel}</td>
        <td>
          <span style="display:inline-block; padding:0.25rem 0.6rem; border-radius:999px; font-size:0.75rem; font-weight:700; background:${statusBg}">
            ${row.status}
          </span>
        </td>
        <td style="text-align:right;">
          <button class="btn-action-sm btn-danger btn-del-daily" data-id="${row.id}" title="Eliminar corte">
            <i class="bx bx-trash"></i>
          </button>
        </td>
      `;
      const prodCell = tr.querySelector('.daily-prod-cell');
      if (prodCell) prodCell.textContent = row.product;

      const imgEl = tr.querySelector('img');
      if (imgEl && row.photo) {
        imgEl.addEventListener('click', () => {
          const w = window.open('', '_blank');
          if (w) {
            w.document.write(`<!doctype html><title>${row.id} - Evidencia</title><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#fff;font-family:sans-serif;"><img src="${row.photo}" style="max-width:90vw;max-height:80vh;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.5);"><p style="margin-top:1rem;"><strong>${row.id}</strong> · Inicial: ${row.initialStock} | Quedan: ${row.remainingStock} | Vendidas: ${row.soldUnits}</p></body>`);
            w.document.close();
          }
        });
      }

      dom.dailyTableBody.appendChild(tr);
    });

    if (dom.dailyTableBody.querySelectorAll) {
      dom.dailyTableBody.querySelectorAll('.btn-del-daily').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.currentTarget.dataset.id;
          const next = loadDailySheets().filter(r => r.id !== id);
          saveDailySheets(next);
          renderDailyTable(next);
          playSound('click');
        });
      });
    }
  }

  function exportDailyCSV() {
    const rows = loadDailySheets();
    if (!rows.length) {
      alert('Aún no hay cortes diarios en la planilla para exportar.');
      return;
    }
    let csv = '\uFEFFID_Corte,Fecha_Hora,Producto,Stock_Inicial,Quedan_Leidas_IA,Vendidas_Calculadas,Reposicion,Estado\n';
    rows.forEach(r => {
      csv += `"${r.id}","${r.timestamp}","${r.product}",${r.initialStock},${r.remainingStock},${r.soldUnits},${r.restockedUnits || 0},"${r.status}"\n`;
    });
    downloadBlob(csv, `Planilla_Control_Inventario_${Date.now()}.csv`, 'text/csv;charset=utf-8');
  }

  function printDailySheet() {
    const rows = loadDailySheets();
    if (!rows.length) {
      alert('Guarda al menos un corte del día para imprimir la planilla.');
      return;
    }
    const w = window.open('', '_blank');
    if (!w) return;
    const trs = rows.map(r => {
      const d = new Date(r.timestamp).toLocaleString('es-ES');
      const img = r.photo ? `<img src="${r.photo}" style="width:90px;height:60px;object-fit:cover;border-radius:6px;border:1px solid #ccc;">` : 'Sin foto';
      return `<tr>
        <td style="text-align:center;">${img}</td>
        <td><strong>${r.id}</strong><br><small>${d}</small></td>
        <td>${r.product}</td>
        <td style="text-align:center;font-weight:bold;">${r.initialStock}</td>
        <td style="text-align:center;font-weight:bold;color:#0284c7;">${r.remainingStock}</td>
        <td style="text-align:center;font-weight:bold;color:#059669;">${r.soldUnits}</td>
        <td style="text-align:center;">${r.status}</td>
      </tr>`;
    }).join('');
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Planilla de Control de Inventario y Ventas</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;color:#0f172a;}h2{margin:0 0 4px;}p{margin:0 0 16px;color:#475569;font-size:13px;}table{width:100%;border-collapse:collapse;font-size:13px;}th,td{border:1px solid #cbd5e1;padding:8px;}th{background:#f1f5f9;text-align:left;}</style>
      </head><body>
      <h2>Planilla de Control Diario de Inventario y Ventas (Visión IA)</h2>
      <p>Estudiante: Brayan Joel Ramos Vargas · Docente: Ing. Jesús Bautista · Generado: ${new Date().toLocaleString('es-ES')}</p>
      <table><thead><tr><th>Foto Evidencia</th><th>Corte / Fecha</th><th>Producto</th><th>Stock Inicial</th><th>Quedan (IA)</th><th>Vendidas</th><th>Estado</th></tr></thead><tbody>${trs}</tbody></table>
      <script>window.onload=()=>window.print();<\/script></body></html>`);
    w.document.close();
  }

  // 16. Configuración de Eventos
  function setupEvents() {
    dom.btnStartCamera.addEventListener('click', () => {
      if (stream) stopActiveSource();
      else startCamera();
    });

    if (dom.btnSwitchCamera) {
      dom.btnSwitchCamera.addEventListener('click', () => {
        facingMode = facingMode === 'environment' ? 'user' : 'environment';
        if (stream) startCamera();
      });
    }

    if (dom.btnFlashViewport) {
      dom.btnFlashViewport.addEventListener('click', toggleTorch);
    }

    dom.btnUploadPhoto.addEventListener('change', (e) => {
      handlePhotoUpload(e.target.files[0]);
      e.target.value = '';
    });

    if (dom.btnManualScan) {
      dom.btnManualScan.addEventListener('click', forceManualScan);
    }

    // Eventos de Planilla de Control Diario
    if (dom.dailyInitialInput && dom.dailyInitialInput.addEventListener) {
      dom.dailyInitialInput.addEventListener('input', updateDailyPreview);
    }
    if (dom.dailyCurrentInput && dom.dailyCurrentInput.addEventListener) {
      dom.dailyCurrentInput.addEventListener('input', updateDailyPreview);
    }
    if (dom.dailyProductInput && dom.dailyProductInput.addEventListener) {
      dom.dailyProductInput.addEventListener('input', updateDailyPreview);
    }
    if (dom.btnSetInitialFromAi && dom.btnSetInitialFromAi.addEventListener) {
      dom.btnSetInitialFromAi.addEventListener('click', () => {
        const currentCount = visibleBoxes.length > 0 ? visibleBoxes.length : Number(dom.dailyCurrentInput.value || 0);
        dom.dailyInitialInput.value = String(currentCount);
        updateDailyPreview();
        playSound('click');
      });
    }
    if (dom.btnSaveDailyCut && dom.btnSaveDailyCut.addEventListener) {
      dom.btnSaveDailyCut.addEventListener('click', saveDailyCut);
    }
    if (dom.btnExportDailyCsv && dom.btnExportDailyCsv.addEventListener) {
      dom.btnExportDailyCsv.addEventListener('click', exportDailyCSV);
    }
    if (dom.btnPrintDailySheet && dom.btnPrintDailySheet.addEventListener) {
      dom.btnPrintDailySheet.addEventListener('click', printDailySheet);
    }
    if (dom.btnClearDailySheet && dom.btnClearDailySheet.addEventListener) {
      dom.btnClearDailySheet.addEventListener('click', () => {
        if (confirm('¿Vaciar todos los cortes diarios guardados en la planilla?')) {
          saveDailySheets([]);
          renderDailyTable([]);
          playSound('click');
        }
      });
    }

    // Síntesis de Voz
    dom.btnSpeak.addEventListener('click', () => {
      if ('speechSynthesis' in window && lastSpokenText) {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(lastSpokenText);
        utter.lang = 'es-ES';
        utter.rate = 1.05;
        window.speechSynthesis.speak(utter);
      }
    });

    // Exportación y Borrado
    dom.btnExportCsv.addEventListener('click', exportCSV);
    dom.btnExportJson.addEventListener('click', exportJSON);
    dom.btnClearInv.addEventListener('click', () => {
      if (confirm('¿Estás seguro de que deseas vaciar todo el inventario de botellas?')) {
        saveInventory([]);
        renderInventoryTable([]);
        updateImpactMetrics([]);
        playSound('click');
      }
    });

    // Búsqueda en Vivo
    dom.invSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const all = loadInventory();
      const filtered = all.filter(i => 
        i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q)
      );
      renderInventoryTable(filtered);
    });

    window.addEventListener('resize', syncCanvasDimensions);
  }

  // Inicialización Automática
  document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
    updateDailyPreview();
    renderDailyTable();
    renderInventoryTable();
    updateImpactMetrics();
    initNeuralEngines();
  });

})();
