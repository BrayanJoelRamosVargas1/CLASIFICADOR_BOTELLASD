/**
 * EcoLens AI v4.0 Pro — Motor de Visión Artificial Multi-Objeto
 * Autor: Brayan Joel Ramos Vargas
 * Docente: Ing. Jesús Bautista
 * Arquitectura: Multi-Object SSD-Lite MobileNet v2 (GPU WebGL) + 1-to-1 Smooth IoU Tracking
 */

(() => {
  'use strict';

  // 0. Purga Preventiva de Caché y Service Workers
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => {
      keys.forEach(k => {
        if (k.startsWith('botellas-')) caches.delete(k);
      });
    }).catch(() => {});
  }

  // 1. Configuración Global de Rendimiento y Detección Simultánea
  const CONFIG = {
    STORAGE_KEY: 'ecolens_inventory_v4',
    DEFAULT_THRESHOLD: 0.10,   // 10% ultra-sensible para detectar múltiples botellas juntas
    MIN_INFERENCE_SCORE: 0.03, // Captura temprana de contornos secundarios
    INFERENCE_WIDTH: 480,      // Buffer 480x360: Resolución óptima para captar botellas pequeñas juntas a 30 FPS
    INFERENCE_HEIGHT: 360,
    INFERENCE_INTERVAL_MS: 85, // ~12 inferencias por segundo (tiempo real suave)
    NMS_IOU_THRESHOLD: 0.65,   // Permite objetos distintos juntos o tocándose sin descartarlos
    MAX_MISSED_FRAMES: 8,      // Persistencia temporal (sin parpadeos)
    MIN_BOX_SIZE: 14,
    GRAMS_PLASTIC_PER_BOTTLE: 24.5,
    GRAMS_CO2_PER_BOTTLE: 82.3,
    LITERS_WATER_PER_BOTTLE: 3.2
  };

  // Clases válidas del dataset COCO que corresponden a envases reciclables
  const RECYCLABLE_CLASSES = ['bottle', 'cup', 'wine glass', 'vase', 'bowl'];

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
    
    // Controles
    btnStartCamera: document.getElementById('btnStartCamera'),
    btnUploadPhoto: document.getElementById('uploadPhotoInput'),
    btnUploadVideo: document.getElementById('uploadVideoInput'),
    btnSwitchCamera: document.getElementById('btnSwitchCamera'),
    btnToggleFlash: document.getElementById('btnToggleFlash'),
    btnFlashViewport: document.getElementById('btnFlashViewport'),
    screenTorch: document.getElementById('screenTorchOverlay'),
    btnManualScan: document.getElementById('btnManualScan'),
    btnResetSession: document.getElementById('btnResetSession'),
    
    // Sensibilidad
    sensOptions: document.querySelectorAll('.toggle-option'),
    
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
    
    // Inventario
    invTableBody: document.getElementById('invTableBody'),
    invEmpty: document.getElementById('invEmptyRow'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnExportJson: document.getElementById('btnExportJson'),
    btnClearInv: document.getElementById('btnClearInv'),
    invSearch: document.getElementById('invSearchInput'),
    invTotalUnits: document.getElementById('invTotalUnits')
  };

  // Buffer Offscreen de 480x360 para captar múltiples objetos con nitidez sin saturar GPU
  const offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = CONFIG.INFERENCE_WIDTH;
  offscreenCanvas.height = CONFIG.INFERENCE_HEIGHT;
  const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

  // Estado del Sistema
  let detector = null;
  let customCnn = null;
  let stream = null;
  let activeSource = null;
  let facingMode = 'environment';
  let activeThreshold = CONFIG.DEFAULT_THRESHOLD;
  let isDetecting = false;
  let isLoopActive = false;
  let animFrameId = null;
  let loopTimeoutId = null;
  let audioCtx = null;
  let lastSpokenText = '';
  let isTorchOn = false;
  
  // Tracking Multi-Objeto 1-a-1 con Suavizado
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

  // 3. Inicialización del Motor de IA (SSD-Lite MobileNet v2 en WebGL GPU)
  async function initNeuralEngines() {
    try {
      if (!window.tf || !window.cocoSsd) {
        throw new Error('TensorFlow.js o COCO-SSD no cargaron desde CDN');
      }

      if (tf.getBackend() !== 'webgl') {
        await tf.setBackend('webgl').catch(() => tf.setBackend('cpu'));
      }
      console.info('EcoLens: Backend TensorFlow.js activo:', tf.getBackend());

      dom.statusText.textContent = 'Cargando motor multi-objeto SSD-Lite en GPU...';
      
      // Cargar SSD-Lite MobileNet v2 optimizado para visión simultánea en vivo
      detector = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

      try {
        customCnn = await tf.loadLayersModel('./modelo_botellas/model.json');
        console.info('EcoLens: Red CNN Keras personalizada conectada.');
      } catch (err) {
        console.info('EcoLens: Modo detector estándar activo.');
      }

      dom.statusText.textContent = '● Detector multi-objeto listo. Apunta a una o varias botellas juntas.';
      dom.hardwareBadge.innerHTML = '<span class="dot"></span> WebGL GPU Activo';
      if (dom.btnManualScan) dom.btnManualScan.disabled = false;
    } catch (error) {
      console.error('Error al inicializar IA:', error);
      dom.statusText.textContent = 'Error al conectar GPU. Revisa tu conexión a internet.';
      dom.hardwareBadge.style.background = '#fef2f2';
      dom.hardwareBadge.style.color = '#dc2626';
      dom.hardwareBadge.innerHTML = '● Falla en GPU';
    }
  }

  // 4. Geometría y Clasificación de Materiales Multi-Objeto
  function computeIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  // Clasificador de Material y Apariencia
  function classifyMaterial(rawClass, w, h) {
    const ratioHtoW = h / Math.max(1, w);
    const ratioWtoH = w / Math.max(1, h);

    if (rawClass === 'wine glass') {
      return {
        label: 'Botella / Copa de Vidrio',
        tagClass: 'glass',
        color: '#a855f7', // Púrpura Vidrio
        fill: 'rgba(168, 85, 247, 0.18)',
        icon: 'bx-wine'
      };
    }
    if (rawClass === 'cup') {
      return {
        label: 'Lata de Aluminio / Vaso',
        tagClass: 'can',
        color: '#06b6d4', // Cyan Metálico
        fill: 'rgba(6, 182, 212, 0.18)',
        icon: 'bx-coffee-togo'
      };
    }
    if (rawClass === 'bowl' || rawClass === 'vase') {
      return {
        label: 'Envase Rígido / Recipiente',
        tagClass: 'container',
        color: '#f59e0b', // Ámbar Contenedor
        fill: 'rgba(245, 158, 11, 0.18)',
        icon: 'bx-box'
      };
    }
    // Detección de orientación de botellas PET
    if (ratioWtoH > 1.35) {
      return {
        label: 'Botella PET (Horizontal)',
        tagClass: 'pet',
        color: '#10b981', // Verde Esmeralda Neón
        fill: 'rgba(16, 185, 129, 0.18)',
        icon: 'bx-recycle'
      };
    }
    if (ratioHtoW > 1.45) {
      return {
        label: 'Botella PET (Vertical)',
        tagClass: 'pet',
        color: '#10b981',
        fill: 'rgba(16, 185, 129, 0.18)',
        icon: 'bx-recycle'
      };
    }
    return {
      label: 'Botella PET Plástico',
      tagClass: 'pet',
      color: '#10b981',
      fill: 'rgba(16, 185, 129, 0.18)',
      icon: 'bx-recycle'
    };
  }

  // 5. Dimensionamiento Exacto y Desacoplado del Canvas
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

  // 6. Procesamiento Asíncrono Multi-Objeto Simultáneo
  async function processVisualFrame() {
    if (!detector || !activeSource || isDetecting) return;

    const srcW = activeSource.videoWidth || activeSource.naturalWidth || activeSource.width;
    const srcH = activeSource.videoHeight || activeSource.naturalHeight || activeSource.height;

    if (!srcW || !srcH || (activeSource.readyState !== undefined && activeSource.readyState < 2)) {
      return;
    }

    isDetecting = true;

    try {
      // 1. Dibujar en buffer offscreen de 480x360
      offscreenCtx.drawImage(activeSource, 0, 0, CONFIG.INFERENCE_WIDTH, CONFIG.INFERENCE_HEIGHT);

      // 2. Detección simultánea de múltiples candidatos (hasta 20 objetos)
      const rawPredictions = await detector.detect(offscreenCanvas, 20, CONFIG.MIN_INFERENCE_SCORE);

      // 3. Proyectar coordenadas del buffer a la resolución de la cámara
      const scaleX = srcW / CONFIG.INFERENCE_WIDTH;
      const scaleY = srcH / CONFIG.INFERENCE_HEIGHT;

      const candidates = [];
      for (const p of rawPredictions) {
        if (!RECYCLABLE_CLASSES.includes(p.class)) continue;
        if (p.score < activeThreshold) continue;

        const bx = p.bbox[0] * scaleX;
        const by = p.bbox[1] * scaleY;
        const bw = p.bbox[2] * scaleX;
        const bh = p.bbox[3] * scaleY;

        if (bw < CONFIG.MIN_BOX_SIZE || bh < CONFIG.MIN_BOX_SIZE) continue;

        const meta = classifyMaterial(p.class, bw, bh);

        candidates.push({
          x: bx,
          y: by,
          w: bw,
          h: bh,
          score: p.score,
          rawClass: p.class,
          meta: meta,
          label: meta.label
        });
      }

      // 4. Non-Maximum Suppression (NMS) permisivo para objetos contiguos (IoU < 0.65)
      candidates.sort((a, b) => b.score - a.score);
      const filtered = [];
      for (const c of candidates) {
        if (filtered.every(other => computeIoU(c, other) < CONFIG.NMS_IOU_THRESHOLD)) {
          filtered.push(c);
        }
      }

      // 5. Tracking Multi-Objeto 1-a-1 Estricto (Sin absorción de botellas vecinas)
      const matchedTrackerIds = new Set();
      const newlyRegistered = [];

      for (const box of filtered) {
        let bestMatch = null;
        let bestIoU = 0;

        for (const t of trackers) {
          // Si el tracker ya fue reclamado por otra botella en este frame, saltarlo
          if (matchedTrackerIds.has(t.id)) continue;

          const iou = computeIoU(t, box);
          if (iou > bestIoU) {
            bestIoU = iou;
            bestMatch = t;
          }
        }

        // Si coincide con una botella previa (IoU >= 0.18)
        if (bestMatch && bestIoU >= 0.18) {
          bestMatch.x = bestMatch.x * 0.35 + box.x * 0.65;
          bestMatch.y = bestMatch.y * 0.35 + box.y * 0.65;
          bestMatch.w = bestMatch.w * 0.35 + box.w * 0.65;
          bestMatch.h = bestMatch.h * 0.35 + box.h * 0.65;
          bestMatch.score = box.score;
          bestMatch.meta = box.meta;
          bestMatch.label = box.meta.label;
          bestMatch.missed = 0;
          bestMatch.hits++;
          matchedTrackerIds.add(bestMatch.id);
        } else {
          // Nueva botella / envase individual detectado: Asignarle ID exclusivo
          const newTracker = {
            id: `ECO-${String(nextTrackId++).padStart(3, '0')}`,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
            score: box.score,
            meta: box.meta,
            label: box.meta.label,
            hits: 1,
            missed: 0,
            registered: true
          };
          trackers.push(newTracker);
          matchedTrackerIds.add(newTracker.id);
          newlyRegistered.push(newTracker);
        }
      }

      // Incrementar frames perdidos a los trackers no avistados
      for (const t of trackers) {
        if (!matchedTrackerIds.has(t.id)) {
          t.missed++;
        }
      }

      // Mantener en pantalla los objetos visibles con persistencia temporal
      trackers = trackers.filter(t => t.missed < CONFIG.MAX_MISSED_FRAMES * 2);
      visibleBoxes = trackers.filter(t => t.missed < CONFIG.MAX_MISSED_FRAMES);

      dom.hudInView.textContent = visibleBoxes.length;

      // Acciones al registrar nuevas botellas
      if (newlyRegistered.length > 0) {
        onNewBottlesRegistered(newlyRegistered);
      } else if (visibleBoxes.length > 0) {
        const labelsList = visibleBoxes.map(b => b.label.split(' ')[0]).join(', ');
        dom.statusText.textContent = `● ${visibleBoxes.length} envase(s) fijado(s): ${labelsList} (${Math.round(visibleBoxes[0].score * 100)}%)`;
      } else {
        dom.statusText.textContent = `Buscando envases... (Sensibilidad: ${Math.round(activeThreshold * 100)}%)`;
      }

    } catch (err) {
      console.warn('EcoLens: Advertencia en ciclo de inferencia:', err);
    } finally {
      isDetecting = false;
    }
  }

  // 7. Registro de Nuevas Botellas e Inventario Multi-Objeto
  function onNewBottlesRegistered(items) {
    playSound(items.length > 1 ? 'multi-chime' : 'chime');
    takeCount += items.length;
    dom.hudInTake.textContent = takeCount;

    // Destello de captura exitosa
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
      gramsPlastic: CONFIG.GRAMS_PLASTIC_PER_BOTTLE,
      co2Saved: CONFIG.GRAMS_CO2_PER_BOTTLE
    }));

    const currentInv = loadInventory();
    const updatedInv = [...newRecords, ...currentInv];
    saveInventory(updatedInv);
    renderInventoryTable(updatedInv);
    updateImpactMetrics(updatedInv);

    // Actualizar tarjeta lateral de dictamen
    if (items.length === 1) {
      const first = items[0];
      dom.resultIcon.innerHTML = `<i class="bx ${first.meta ? first.meta.icon : 'bx-recycle'}"></i>`;
      dom.resultLabel.textContent = `¡${first.label} Identificada!`;
      dom.resultSub.textContent = `Código ${first.id} registrado · Confianza: ${Math.round(first.score * 100)}%`;
      
      const pct = Math.round(first.score * 100);
      dom.meterPct.textContent = `${pct}%`;
      dom.meterFill.style.width = `${pct}%`;
      lastSpokenText = `Detectada ${first.label} con confianza del ${pct} por ciento. Guardada en el inventario ecológico.`;
    } else {
      dom.resultIcon.innerHTML = `<i class="bx bx-layer"></i>`;
      dom.resultLabel.textContent = `¡${items.length} Envases Identificados Juntos!`;
      dom.resultSub.textContent = `${items.map(i => i.id).join(', ')} añadidos simultáneamente al inventario`;
      
      const avgPct = Math.round(items.reduce((acc, i) => acc + i.score, 0) / items.length * 100);
      dom.meterPct.textContent = `${avgPct}% prom.`;
      dom.meterFill.style.width = `${avgPct}%`;
      lastSpokenText = `Detectados ${items.length} envases reciclables juntos. Añadidos al inventario.`;
    }

    dom.btnSpeak.style.display = 'inline-flex';
  }

  // 8. Renderizado del HUD en Canvas con Colores Exclusivos por Material
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
      const tagText = `✓ ${box.id} · ${box.label} ${Math.round(box.score * 100)}%`;

      // 1. Relleno traslúcido diferenciado por material
      ctx.fillStyle = fillColor;
      ctx.fillRect(rx, ry, rw, rh);

      // 2. Borde exterior neón
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.round(3.5 * baseScale);
      ctx.strokeRect(rx, ry, rw, rh);

      // 3. Esquinas cibernéticas reforzadas en blanco brillante
      const corner = Math.min(24 * baseScale, rw / 3, rh / 3);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.round(4.5 * baseScale);
      
      // Top-Left
      ctx.beginPath();
      ctx.moveTo(rx, ry + corner);
      ctx.lineTo(rx, ry);
      ctx.lineTo(rx + corner, ry);
      ctx.stroke();

      // Top-Right
      ctx.beginPath();
      ctx.moveTo(rx + rw - corner, ry);
      ctx.lineTo(rx + rw, ry);
      ctx.lineTo(rx + rw, ry + corner);
      ctx.stroke();

      // Bottom-Left
      ctx.beginPath();
      ctx.moveTo(rx, ry + rh - corner);
      ctx.lineTo(rx, ry + rh);
      ctx.lineTo(rx + corner, ry + rh);
      ctx.stroke();

      // Bottom-Right
      ctx.beginPath();
      ctx.moveTo(rx + rw - corner, ry + rh);
      ctx.lineTo(rx + rw, ry + rh);
      ctx.lineTo(rx + rw, ry + rh - corner);
      ctx.stroke();

      // 4. Etiqueta flotante con el color del material
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

  // 9. Bucle de Inferencia No-Bloqueante
  async function runInferenceLoop() {
    if (!isLoopActive) return;
    await processVisualFrame();
    if (isLoopActive) {
      loopTimeoutId = setTimeout(runInferenceLoop, CONFIG.INFERENCE_INTERVAL_MS);
    }
  }

  // 10. Control de la Cámara Web / Móvil y Linterna Flash
  async function toggleTorch() {
    if (!stream) {
      alert('Inicia la cámara primero para encender la linterna / flash.');
      return;
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};

      // Si el sensor y navegador soportan torch en hardware (Android / navegadores móviles compatibles)
      if (caps && caps.torch) {
        isTorchOn = !isTorchOn;
        await track.applyConstraints({
          advanced: [{ torch: isTorchOn }]
        });
        updateTorchUI();
        playSound('click');
        return;
      }

      // Fallback: Softbox de Pantalla para iluminar botellas en dispositivos sin flash accesible
      isTorchOn = !isTorchOn;
      if (dom.screenTorch) {
        dom.screenTorch.style.display = isTorchOn ? 'block' : 'none';
      }
      updateTorchUI();
      playSound('click');
    } catch (err) {
      console.warn('EcoLens: Linterna hardware no disponible, usando softbox de pantalla:', err);
      isTorchOn = !isTorchOn;
      if (dom.screenTorch) {
        dom.screenTorch.style.display = isTorchOn ? 'block' : 'none';
      }
      updateTorchUI();
      playSound('click');
    }
  }

  function updateTorchUI() {
    const iconClass = isTorchOn ? 'bxs-sun' : 'bx-sun';

    if (dom.btnToggleFlash) {
      dom.btnToggleFlash.innerHTML = `<i class="bx ${iconClass}"></i> <span>${isTorchOn ? 'Flash ON' : 'Flash'}</span>`;
      dom.btnToggleFlash.classList.toggle('flash-active', isTorchOn);
    }

    if (dom.btnFlashViewport) {
      dom.btnFlashViewport.innerHTML = `<i class="bx ${iconClass}"></i>`;
      dom.btnFlashViewport.classList.toggle('flash-active', isTorchOn);
      dom.btnFlashViewport.style.display = stream ? 'flex' : 'none';
    }
  }

  async function startCamera() {
    stopActiveSource();
    dom.statusText.textContent = 'Conectando sensor óptico...';

    try {
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
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
      dom.btnStartCamera.innerHTML = '<i class="bx bx-stop-circle"></i> Detener Cámara';
      dom.btnStartCamera.classList.add('btn-danger');

      // Mostrar botón de flash en viewport y actualizar estado
      if (dom.btnFlashViewport) dom.btnFlashViewport.style.display = 'flex';
      updateTorchUI();

      const animLoop = () => {
        if (!isLoopActive) return;
        renderCanvasHUD();
        animFrameId = requestAnimationFrame(animLoop);
      };
      animFrameId = requestAnimationFrame(animLoop);

      runInferenceLoop();
      dom.statusText.textContent = '● Cámara activa. Sostén una o varias botellas juntas.';
      playSound('click');
    } catch (err) {
      console.error('Error al iniciar cámara:', err);
      dom.statusText.textContent = 'No se pudo activar la cámara. Revisa los permisos o sube una fotografía.';
      stopActiveSource();
    }
  }

  function stopActiveSource() {
    isLoopActive = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (loopTimeoutId) clearTimeout(loopTimeoutId);

    // Apagar flash si estaba encendido
    if (isTorchOn) {
      isTorchOn = false;
      if (dom.screenTorch) dom.screenTorch.style.display = 'none';
      updateTorchUI();
    }
    if (dom.btnFlashViewport) dom.btnFlashViewport.style.display = 'none';

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

    dom.btnStartCamera.innerHTML = '<i class="bx bx-camera"></i> Iniciar Cámara';
    dom.btnStartCamera.classList.remove('btn-danger');
    dom.statusText.textContent = 'Cámara detenida.';
    activeSource = null;
  }

  // 11. Carga de Fotografías y Video Multi-Objeto
  function handlePhotoUpload(file) {
    if (!file) return;
    stopActiveSource();

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        activeSource = img;
        dom.preview.src = e.target.result;
        dom.idleState.style.display = 'none';
        dom.video.style.display = 'none';
        dom.preview.style.display = 'block';
        dom.canvas.style.display = 'block';

        syncCanvasDimensions();

        trackers = [];
        takeCount = 0;
        dom.statusText.textContent = 'Analizando fotografía con IA multi-objeto...';

        await processVisualFrame();
        renderCanvasHUD();

        if (visibleBoxes.length === 0) {
          activeThreshold = 0.05;
          await processVisualFrame();
          renderCanvasHUD();
          activeThreshold = CONFIG.DEFAULT_THRESHOLD;
        }

        if (visibleBoxes.length === 0) {
          dom.statusText.textContent = 'No se distinguieron botellas en la imagen. Intenta con una foto con mejor iluminación.';
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // 12. Forzar Registro Manual Inmediato Multi-Objeto
  async function forceManualScan() {
    if (!activeSource) {
      alert('Primero inicia la cámara o sube una fotografía.');
      return;
    }

    playSound('click');
    dom.statusText.textContent = 'Escaneando todos los envases en cuadro...';

    const prevThreshold = activeThreshold;
    activeThreshold = 0.04; // Escaneo profundo
    await processVisualFrame();
    activeThreshold = prevThreshold;

    // Si aún no detectó automáticamente, registrar los cuadrantes de escena
    if (visibleBoxes.length === 0) {
      const srcW = activeSource.videoWidth || activeSource.naturalWidth || 640;
      const srcH = activeSource.videoHeight || activeSource.naturalHeight || 480;

      const manualBox = {
        id: `ECO-${String(nextTrackId++).padStart(3, '0')}`,
        x: srcW * 0.2,
        y: srcH * 0.15,
        w: srcW * 0.6,
        h: srcH * 0.7,
        score: 0.95,
        meta: classifyMaterial('bottle', srcW * 0.6, srcH * 0.7),
        label: 'Botella PET Plástico (Captura Manual)',
        hits: 1,
        missed: 0,
        registered: true
      };

      trackers.push(manualBox);
      visibleBoxes = [manualBox];
      onNewBottlesRegistered([manualBox]);
    }

    renderCanvasHUD();
    dom.statusText.textContent = `✓ ¡${visibleBoxes.length} envase(s) registrado(s) con éxito!`;
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

      const tagClass = item.tagClass || (item.label.includes('Vidrio') ? 'glass' : item.label.includes('Lata') || item.label.includes('Vaso') ? 'can' : item.label.includes('Envase') ? 'container' : 'pet');

      tr.innerHTML = `
        <td style="font-weight:700; font-family:var(--font-mono); color:var(--primary);">${item.id}</td>
        <td>
          <span class="material-tag ${tagClass}">
            <i class="bx ${tagClass === 'glass' ? 'bx-wine' : tagClass === 'can' ? 'bx-coffee-togo' : tagClass === 'container' ? 'bx-box' : 'bx-recycle'}"></i>
            ${item.label}
          </span>
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <div style="width:40px; height:6px; background:#e2e8f0; border-radius:999px; overflow:hidden;">
              <div style="height:100%; width:${item.confidence}%; background:#10b981;"></div>
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

  // 14. Métricas de Impacto
  function updateImpactMetrics(items = loadInventory()) {
    const count = items.length;
    const gramsPlastic = Math.round(count * CONFIG.GRAMS_PLASTIC_PER_BOTTLE);
    const gramsCo2 = Math.round(count * CONFIG.GRAMS_CO2_PER_BOTTLE);
    const litersWater = Math.round(count * CONFIG.LITERS_WATER_PER_BOTTLE * 10) / 10;

    dom.kpiTotalCount.textContent = count;
    dom.kpiTotalGrams.textContent = `${gramsPlastic}g`;
    dom.kpiTotalCo2.textContent = `${gramsCo2}g`;
    dom.kpiTotalWater.textContent = `${litersWater}L`;
  }

  // 15. Exportación
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

  // 16. Configuración de Eventos
  function setupEvents() {
    dom.btnStartCamera.addEventListener('click', () => {
      if (stream) stopActiveSource();
      else startCamera();
    });

    dom.btnSwitchCamera.addEventListener('click', () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      if (stream) startCamera();
    });

    if (dom.btnToggleFlash) {
      dom.btnToggleFlash.addEventListener('click', toggleTorch);
    }

    if (dom.btnFlashViewport) {
      dom.btnFlashViewport.addEventListener('click', toggleTorch);
    }

    dom.btnUploadPhoto.addEventListener('change', (e) => {
      handlePhotoUpload(e.target.files[0]);
    });

    if (dom.btnManualScan) {
      dom.btnManualScan.addEventListener('click', forceManualScan);
    }

    dom.btnResetSession.addEventListener('click', () => {
      trackers = [];
      visibleBoxes = [];
      takeCount = 0;
      dom.hudInTake.textContent = '0';
      dom.hudInView.textContent = '0';
      dom.statusText.textContent = 'Nueva toma iniciada. Los envases en vista se contarán nuevamente.';
      playSound('click');
      renderCanvasHUD();
    });

    // Control de Sensibilidad
    dom.sensOptions.forEach(opt => {
      opt.addEventListener('click', () => {
        dom.sensOptions.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        activeThreshold = parseFloat(opt.dataset.threshold);
        dom.statusText.textContent = `Sensibilidad ajustada a ${Math.round(activeThreshold * 100)}% (Multi-Objeto)`;
        playSound('click');
      });
    });

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
      if (confirm('¿Estás seguro de que deseas vaciar todo el inventario de envases?')) {
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
    initNeuralEngines();
    setupEvents();
    renderInventoryTable();
    updateImpactMetrics();
  });

})();
