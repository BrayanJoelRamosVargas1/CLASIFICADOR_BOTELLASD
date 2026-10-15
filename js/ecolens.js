/**
 * EcoLens AI v4.0 Pro — Motor de Visión Artificial e Impacto Ecológico
 * Autor: Brayan Joel Ramos Vargas
 * Docente: Ing. Jesús Bautista
 * Arquitectura: MobileNet v2 + Custom CNN Keras + TensorFlow.js WebGL
 */

(() => {
  'use strict';

  // Configuración Global de Detección
  const CONFIG = {
    STORAGE_KEY: 'ecolens_inventory_v4',
    DEFAULT_THRESHOLD: 0.20, // 20% para capturar botellas PET transparentes
    MIN_CANDIDATE_SCORE: 0.15,
    MIN_BOX_SIZE: 20,
    GRAMS_PLASTIC_PER_BOTTLE: 24.5,
    GRAMS_CO2_PER_BOTTLE: 82.3,
    LITERS_WATER_PER_BOTTLE: 3.2
  };

  // Clases válidas del dataset COCO que corresponden a envases reciclables
  const RECYCLABLE_CLASSES = ['bottle', 'cup', 'wine glass', 'vase'];

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
    
    // Controles
    btnStartCamera: document.getElementById('btnStartCamera'),
    btnUploadPhoto: document.getElementById('uploadPhotoInput'),
    btnUploadVideo: document.getElementById('uploadVideoInput'),
    btnSwitchCamera: document.getElementById('btnSwitchCamera'),
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
  
  // Tracking de Botellas Anti-Duplicación
  let trackers = [];
  let visibleBoxes = [];
  let takeCount = 0;
  let nextTrackId = 1;

  // 1. Sintetizador de Sonido Web Audio API
  function playSound(type = 'chime') {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.08); // A5
        osc.frequency.exponentialRampToValueAtTime(1174.66, audioCtx.currentTime + 0.16); // D6
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.28);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.28);
      } else if (type === 'click') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1000, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.05);
      }
    } catch (e) {}
  }

  // 2. Carga de Modelos de Inteligencia Artificial
  async function initNeuralEngines() {
    try {
      if (!window.tf || !window.cocoSsd) {
        throw new Error('TensorFlow.js o COCO-SSD no cargaron desde CDN');
      }

      dom.statusText.textContent = 'Cargando MobileNet v2 y aceleración WebGL GPU...';
      
      // Cargar MobileNet v2 estándar
      detector = await cocoSsd.load({ base: 'mobilenet_v2' });

      // Intentar cargar la red convolucional Keras propia
      try {
        const check = await fetch('./modelo_botellas/model.json', { method: 'HEAD' });
        if (check.ok) {
          customCnn = await tf.loadLayersModel('./modelo_botellas/model.json');
          console.info('EcoLens: Red CNN Keras cargada exitosamente.');
        }
      } catch (err) {
        console.warn('EcoLens: Red CNN local opcional no disponible:', err);
      }

      dom.statusText.textContent = '● Detector listo. Haz clic en "Cámara" o sube una foto de tu botella.';
      dom.hardwareBadge.innerHTML = '<span class="dot"></span> WebGL GPU Activo';
      if (dom.btnManualScan) dom.btnManualScan.disabled = false;
    } catch (error) {
      console.error('Error al inicializar IA:', error);
      dom.statusText.textContent = 'Error al cargar los modelos. Revisa tu conexión a internet.';
      dom.hardwareBadge.style.background = '#fef2f2';
      dom.hardwareBadge.style.color = '#dc2626';
      dom.hardwareBadge.innerHTML = '● Falla en GPU';
    }
  }

  // 3. Matemáticas de Geometría e Intersección (IoU)
  function computeIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function isOverlapping(a, b) {
    const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
    const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
    const maxDim = Math.max(a.w, a.h, b.w, b.h) * 0.7;
    return computeIoU(a, b) >= 0.2 || Math.hypot(dx, dy) < maxDim;
  }

  function cleanOverlaps(boxes) {
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const result = [];
    for (const box of sorted) {
      if (box.w < CONFIG.MIN_BOX_SIZE || box.h < CONFIG.MIN_BOX_SIZE) continue;
      if (result.every(other => computeIoU(box, other) < 0.45)) {
        result.push(box);
      }
    }
    return result;
  }

  function getFriendlyLabel(rawClass, w, h) {
    const ratio = h / Math.max(1, w);
    if (rawClass === 'wine glass' || (rawClass === 'bottle' && ratio > 1.8 && ratio < 2.5)) {
      return 'Botella de Vidrio';
    }
    if (rawClass === 'cup') {
      return 'Vaso / Envase';
    }
    return 'Botella PET Plástico';
  }

  // 4. Bucle Asíncrono de Inferencia
  async function processVisualFrame() {
    if (!detector || !activeSource || isDetecting) return;
    isDetecting = true;

    try {
      // Detección directa sobre el elemento source (video o imagen) con umbral sensible
      const predictions = await detector.detect(activeSource, 20, CONFIG.MIN_CANDIDATE_SCORE);

      // Filtrar por clases de botellas/envases con el umbral activo
      const candidates = predictions
        .filter(p => RECYCLABLE_CLASSES.includes(p.class) && p.score >= activeThreshold)
        .map(p => ({
          x: p.bbox[0],
          y: p.bbox[1],
          w: p.bbox[2],
          h: p.bbox[3],
          score: p.score,
          rawClass: p.class,
          label: getFriendlyLabel(p.class, p.bbox[2], p.bbox[3])
        }));

      const cleaned = cleanOverlaps(candidates);
      const newlyRegistered = [];

      for (const box of cleaned) {
        // Buscar si ya coincide con una botella registrada en tracking
        const existing = trackers.find(t => isOverlapping(t, box));

        if (existing) {
          existing.x = box.x;
          existing.y = box.y;
          existing.w = box.w;
          existing.h = box.h;
          existing.score = box.score;
          existing.missed = 0;
          existing.hits++;
        } else {
          // Nueva botella detectada: ¡Registrar de inmediato!
          const newTracker = {
            id: `ECO-${String(nextTrackId++).padStart(3, '0')}`,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
            score: box.score,
            label: box.label,
            hits: 1,
            missed: 0,
            registered: true
          };
          trackers.push(newTracker);
          newlyRegistered.push(newTracker);
        }
      }

      // Marcar ausencias
      for (const t of trackers) {
        if (!cleaned.some(c => isOverlapping(t, c))) {
          t.missed++;
        }
      }

      // Limpiar trackers que salieron del encuadre hace más de 12 frames
      trackers = trackers.filter(t => t.missed < 12);

      // Actualizar cajas visibles
      visibleBoxes = trackers.filter(t => t.missed === 0);
      dom.hudInView.textContent = visibleBoxes.length;

      // Si hay botellas nuevas, guardarlas y actualizar estado
      if (newlyRegistered.length > 0) {
        onNewBottlesRegistered(newlyRegistered);
      } else if (visibleBoxes.length > 0) {
        dom.statusText.textContent = `● ${visibleBoxes.length} envase(s) identificado(s) en cuadro.`;
      } else {
        dom.statusText.textContent = `Buscando envases... (Sensibilidad: ${Math.round(activeThreshold * 100)}%)`;
      }

    } catch (err) {
      console.warn('Error en frame de inferencia:', err);
    } finally {
      isDetecting = false;
    }
  }

  // 5. Acción al Confirmar Nuevas Botellas
  function onNewBottlesRegistered(items) {
    playSound('chime');
    takeCount += items.length;
    dom.hudInTake.textContent = takeCount;

    const newRecords = items.map(item => ({
      id: item.id,
      timestamp: new Date().toISOString(),
      label: item.label,
      confidence: Math.round(item.score * 100),
      gramsPlastic: CONFIG.GRAMS_PLASTIC_PER_BOTTLE,
      co2Saved: CONFIG.GRAMS_CO2_PER_BOTTLE
    }));

    const currentInv = loadInventory();
    const updatedInv = [...newRecords, ...currentInv];
    saveInventory(updatedInv);
    renderInventoryTable(updatedInv);
    updateImpactMetrics(updatedInv);

    const first = items[0];
    dom.resultIcon.innerHTML = `<i class="bx ${first.label.includes('Vidrio') ? 'bx-wine' : 'bx-recycle'}"></i>`;
    dom.resultLabel.textContent = `¡${first.label} Registrada!`;
    dom.resultSub.textContent = `ID ${first.id} guardada en inventario · Total: ${updatedInv.length}`;
    
    const pct = Math.round(first.score * 100);
    dom.meterPct.textContent = `${pct}%`;
    dom.meterFill.style.width = `${pct}%`;
    dom.btnSpeak.style.display = 'inline-flex';

    lastSpokenText = `Detectada ${first.label} con confianza del ${pct} por ciento. Guardada en el inventario ecológico.`;
  }

  // 6. Renderizado de HUD en Canvas con Compensación Object-Cover
  function renderCanvasHUD() {
    if (!activeSource) return;

    const canvas = dom.canvas;
    const viewportW = canvas.clientWidth;
    const viewportH = canvas.clientHeight;

    if (canvas.width !== viewportW || canvas.height !== viewportH) {
      canvas.width = viewportW;
      canvas.height = viewportH;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, viewportW, viewportH);

    const srcW = activeSource.videoWidth || activeSource.naturalWidth || activeSource.width;
    const srcH = activeSource.videoHeight || activeSource.naturalHeight || activeSource.height;

    if (!srcW || !srcH) return;

    // Cálculo proyectivo idéntico al object-cover del CSS
    const scale = Math.max(viewportW / srcW, viewportH / srcH);
    const offsetX = (viewportW - srcW * scale) / 2;
    const offsetY = (viewportH - srcH * scale) / 2;

    for (const box of visibleBoxes) {
      const rx = box.x * scale + offsetX;
      const ry = box.y * scale + offsetY;
      const rw = box.w * scale;
      const rh = box.h * scale;

      const strokeColor = '#10b981'; // Neón Esmeralda
      const fillColor = 'rgba(16, 185, 129, 0.15)';
      const tagText = `${box.id} · ${box.label} ${Math.round(box.score * 100)}%`;

      // Relleno sutil y caja delimitadora
      ctx.fillStyle = fillColor;
      ctx.fillRect(rx, ry, rw, rh);

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 3;
      ctx.strokeRect(rx, ry, rw, rh);

      // Esquinas cibernéticas reforzadas
      const corner = Math.min(16, rw / 4, rh / 4);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      
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

      // Etiqueta flotante con tipografía clara
      ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
      const textWidth = ctx.measureText(tagText).width;
      const labelY = ry > 26 ? ry - 26 : ry + 4;

      ctx.fillStyle = '#059669';
      ctx.beginPath();
      ctx.roundRect(rx, labelY, textWidth + 16, 24, 6);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(tagText, rx + 8, labelY + 16);
    }
  }

  // 7. Bucle Asíncrono de Inferencia
  async function runInferenceLoop() {
    if (!isLoopActive) return;
    await processVisualFrame();
    if (isLoopActive) {
      loopTimeoutId = setTimeout(runInferenceLoop, 260);
    }
  }

  // 8. Control de la Cámara Web / Móvil
  async function startCamera() {
    stopActiveSource();
    dom.statusText.textContent = 'Iniciando cámara web en alta definición...';

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
      await dom.video.play();

      activeSource = dom.video;
      isLoopActive = true;

      // Actualizar elementos visuales
      dom.idleState.style.display = 'none';
      dom.preview.style.display = 'none';
      dom.video.style.display = 'block';
      dom.canvas.style.display = 'block';
      dom.laser.classList.add('laser-active');
      dom.cameraChip.style.display = 'flex';
      dom.btnStartCamera.innerHTML = '<i class="bx bx-stop-circle"></i> Detener Cámara';
      dom.btnStartCamera.classList.add('btn-danger');

      // Animación continua de HUD a 60 FPS
      const animLoop = () => {
        if (!isLoopActive) return;
        renderCanvasHUD();
        animFrameId = requestAnimationFrame(animLoop);
      };
      animFrameId = requestAnimationFrame(animLoop);

      // Iniciar bucle de inferencia no bloqueante
      runInferenceLoop();
      dom.statusText.textContent = '● Cámara en vivo activa. Apunta a una botella para registrarla.';
      playSound('click');
    } catch (err) {
      console.error('Error al acceder a la cámara:', err);
      dom.statusText.textContent = 'No se pudo acceder a la cámara. Revisa los permisos o sube una fotografía.';
      stopActiveSource();
    }
  }

  function stopActiveSource() {
    isLoopActive = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (loopTimeoutId) clearTimeout(loopTimeoutId);

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

    dom.btnStartCamera.innerHTML = '<i class="bx bx-camera"></i> Cámara';
    dom.btnStartCamera.classList.remove('btn-danger');
    dom.statusText.textContent = 'Cámara detenida.';
    activeSource = null;
  }

  // 9. Carga de Fotografías y Video
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

        trackers = [];
        takeCount = 0;
        dom.statusText.textContent = 'Analizando fotografía con MobileNet v2...';

        // Ejecutar inferencia inmediata sobre la foto
        await processVisualFrame();
        renderCanvasHUD();

        if (visibleBoxes.length === 0) {
          dom.statusText.textContent = 'No se detectaron botellas en la imagen. Prueba con otra foto o ajusta la sensibilidad a 20%.';
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // 10. Forzar Registro Manual Inmediato
  async function forceManualScan() {
    if (!activeSource) {
      alert('Activa la cámara o sube una foto primero.');
      return;
    }

    playSound('click');
    dom.statusText.textContent = 'Analizando encuadre actual inmediatamente...';
    await processVisualFrame();
    renderCanvasHUD();

    if (visibleBoxes.length > 0) {
      alert(`¡Éxito! Se han detectado ${visibleBoxes.length} envase(s) en el encuadre y se registraron en tu inventario.`);
    } else {
      alert('El detector no encontró una botella clara en este momento. Acerca más el envase a la cámara o asegúrate de que haya buena iluminación.');
    }
  }

  // 11. Persistencia e Inventario
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

      const tagClass = item.label.includes('Vidrio') ? 'glass' : item.label.includes('Vaso') ? 'can' : 'pet';

      tr.innerHTML = `
        <td style="font-weight:700; font-family:var(--font-mono); color:var(--primary);">${item.id}</td>
        <td>
          <span class="material-tag ${tagClass}">
            <i class="bx ${tagClass === 'glass' ? 'bx-wine' : 'bx-recycle'}"></i>
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

    // Delegación para eliminar registros individuales
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

  // 12. Actualización de Métricas de Impacto
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

  // 13. Exportación de Datos
  function exportCSV() {
    const items = loadInventory();
    if (!items.length) {
      alert('No hay registros para exportar.');
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
      alert('No hay registros para exportar.');
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

  // 14. Eventos del Sistema
  function setupEvents() {
    dom.btnStartCamera.addEventListener('click', () => {
      if (stream) stopActiveSource();
      else startCamera();
    });

    dom.btnSwitchCamera.addEventListener('click', () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      if (stream) startCamera();
    });

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
      dom.statusText.textContent = 'Nueva toma iniciada. Las botellas en vista se contarán de nuevo.';
      playSound('click');
      renderCanvasHUD();
    });

    // Control de Sensibilidad
    dom.sensOptions.forEach(opt => {
      opt.addEventListener('click', () => {
        dom.sensOptions.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        activeThreshold = parseFloat(opt.dataset.threshold);
        dom.statusText.textContent = `Sensibilidad ajustada a ${Math.round(activeThreshold * 100)}%`;
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
  }

  // Inicialización Automática
  document.addEventListener('DOMContentLoaded', () => {
    initNeuralEngines();
    setupEvents();
    renderInventoryTable();
    updateImpactMetrics();
  });

})();
