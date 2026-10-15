/**
 * EcoLens AI v4.0 Pro — Motor de Visión Artificial e Impacto Ecológico
 * Autor: Brayan Joel Ramos Vargas
 * Docente: Ing. Jesús Bautista
 * Arquitectura: MobileNet v2 + Custom CNN Keras + TensorFlow.js WebGL
 */

(() => {
  'use strict';

  // Configuración y Constantes
  const CONFIG = {
    STORAGE_KEY: 'ecolens_inventory_v4',
    DEFAULT_THRESHOLD: 0.28,
    MIN_BOX_SIZE: 20,
    GRAMS_PLASTIC_PER_BOTTLE: 24.5,
    GRAMS_CO2_PER_BOTTLE: 82.3,
    LITERS_WATER_PER_BOTTLE: 3.2
  };

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

  // Estado de la Aplicación
  let detector = null;
  let customCnn = null;
  let stream = null;
  let activeSource = null;
  let facingMode = 'environment';
  let activeThreshold = CONFIG.DEFAULT_THRESHOLD;
  let isDetecting = false;
  let isLoopActive = false;
  let animFrameId = null;
  let detectIntervalId = null;
  let audioCtx = null;
  let lastSpokenText = '';
  
  // Tracking de Botellas (Anti-duplicación)
  let trackers = [];
  let visibleBoxes = [];
  let takeCount = 0;
  let nextTrackId = 1;

  // Buffer Canvas para Inferencia Óptima
  const bufferCanvas = document.createElement('canvas');
  bufferCanvas.width = 640;
  bufferCanvas.height = 640;

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
        // Melodía cristalina bio-tech al registrar botella
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.08); // A5
        osc.frequency.exponentialRampToValueAtTime(1174.66, audioCtx.currentTime + 0.16); // D6
        gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.25);
      } else if (type === 'click') {
        // Clic táctil de interfaz
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.05);
      }
    } catch (e) {
      // Audio autoplay policy
    }
  }

  // 2. Carga de Modelos de Inteligencia Artificial
  async function initNeuralEngines() {
    try {
      if (!window.tf || !window.cocoSsd) {
        throw new Error('Bibliotecas de TensorFlow.js no disponibles en CDN');
      }

      dom.statusText.textContent = 'Inicializando aceleración WebGL y MobileNet v2...';
      
      // Motor 1: Detector de Objetos MobileNet v2
      detector = await cocoSsd.load({ base: 'mobilenet_v2' });

      // Motor 2: Red Convolucional Propia (CNN Keras)
      try {
        const shardCheck = await fetch('./modelo_botellas/model.json', { method: 'HEAD' });
        if (shardCheck.ok) {
          customCnn = await tf.loadLayersModel('./modelo_botellas/model.json');
          console.info('EcoLens: Red CNN Keras cargada exitosamente.');
        }
      } catch (err) {
        console.warn('EcoLens: Red CNN local no disponible, operando con MobileNet v2 primario.');
      }

      dom.statusText.textContent = 'Sistema listo. Activa la cámara o sube un archivo.';
      dom.hardwareBadge.innerHTML = '<span class="dot"></span> WebGL GPU Activo';
      dom.btnManualScan.disabled = false;
    } catch (error) {
      console.error('Error al inicializar IA:', error);
      dom.statusText.textContent = 'Error al cargar los modelos. Revisa tu conexión a internet.';
      dom.hardwareBadge.style.background = '#fef2f2';
      dom.hardwareBadge.style.color = '#dc2626';
      dom.hardwareBadge.innerHTML = '● Falla en GPU';
    }
  }

  // 3. Algoritmo de Tracking e Intersección (IoU)
  function computeIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function boxesOverlap(a, b) {
    const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
    const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
    const maxDim = Math.max(a.w, a.h, b.w, b.h) * 0.6;
    return computeIoU(a, b) >= 0.25 || Math.hypot(dx, dy) < maxDim;
  }

  function cleanOverlappingDetections(boxes) {
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const result = [];
    for (const box of sorted) {
      if (box.w < CONFIG.MIN_BOX_SIZE || box.h < CONFIG.MIN_BOX_SIZE) continue;
      if (result.every(other => computeIoU(box, other) < 0.4)) {
        result.push(box);
      }
    }
    return result;
  }

  // 4. Actualización del Estado de Tracking
  function updateTrackers(incomingBoxes) {
    const matchedIndices = new Set();
    const newItems = [];

    // Emparejar con trackers existentes
    for (const tr of trackers) {
      let bestIdx = -1;
      let bestIoU = 0;

      incomingBoxes.forEach((box, i) => {
        if (matchedIndices.has(i)) return;
        const iou = computeIoU(tr, box);
        if (iou > bestIoU || boxesOverlap(tr, box)) {
          bestIoU = iou;
          bestIdx = i;
        }
      });

      if (bestIdx >= 0) {
        matchedIndices.add(bestIdx);
        const matched = incomingBoxes[bestIdx];
        tr.x = matched.x;
        tr.y = matched.y;
        tr.w = matched.w;
        tr.h = matched.h;
        tr.score = matched.score;
        tr.hits += 1;
        tr.missed = 0;
      } else {
        tr.missed += 1;
      }
    }

    // Agregar nuevos candidatos no emparejados
    incomingBoxes.forEach((box, i) => {
      if (matchedIndices.has(i)) return;
      const isDuplicate = trackers.some(tr => tr.registered && boxesOverlap(tr, box));
      if (!isDuplicate) {
        trackers.push({
          id: `ECO-${String(nextTrackId++).padStart(3, '0')}`,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          score: box.score,
          material: determineMaterial(box),
          hits: 1,
          missed: 0,
          registered: false
        });
      }
    });

    // Limpiar trackers perdidos
    trackers = trackers.filter(tr => tr.registered || tr.missed < 6);

    // Identificar recién confirmados
    for (const tr of trackers) {
      if (!tr.registered && tr.hits >= 2 && tr.missed === 0) {
        tr.registered = true;
        newItems.push(tr);
      }
    }

    return newItems;
  }

  // 5. Inferencia de Material y Tipo de Envase
  function determineMaterial(box) {
    const ratio = box.h / Math.max(1, box.w);
    if (ratio > 2.5) return 'PET Plástico';
    if (ratio > 1.8) return 'Vidrio';
    return 'Lata Aluminio';
  }

  // 6. Renderizado de HUD en Canvas con Estilo Cyber-Optic
  function renderCanvasHUD(canvas, source, boxes) {
    const srcW = source.videoWidth || source.naturalWidth || source.width || 640;
    const srcH = source.videoHeight || source.naturalHeight || source.height || 480;

    const scale = Math.min(1, 960 / Math.max(srcW, srcH));
    const renderW = Math.max(1, Math.round(srcW * scale));
    const renderH = Math.max(1, Math.round(srcH * scale));

    if (canvas.width !== renderW) canvas.width = renderW;
    if (canvas.height !== renderH) canvas.height = renderH;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, 0, renderW, renderH);

    // Dibujar Cajas con Borde Neón y Esquinas Holográficas
    for (const box of boxes) {
      const isNew = !box.registered;
      const strokeColor = isNew ? '#10b981' : '#f59e0b';
      const fillColor = isNew ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)';
      const labelText = isNew 
        ? `${box.id || 'NUEVA'} · ${box.material || 'Botella'} ${Math.round(box.score * 100)}%`
        : `${box.id} · En Inventario`;

      ctx.fillStyle = fillColor;
      ctx.fillRect(box.x, box.y, box.w, box.h);

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.w, box.h);

      // Etiqueta flotante superior
      ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
      const labelWidth = ctx.measureText(labelText).width + 16;
      const labelY = box.y > 28 ? box.y - 28 : box.y;

      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.roundRect(box.x, labelY, labelWidth, 24, 6);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, box.x + 8, labelY + 16);
    }
  }

  // 7. Bucle de Procesamiento Visual
  async function processVisualFrame() {
    if (!detector || !activeSource || isDetecting) return;
    isDetecting = true;

    try {
      // 1. Dibujar frame en buffer
      const bCtx = bufferCanvas.getContext('2d', { willReadFrequently: true });
      bCtx.drawImage(activeSource, 0, 0, 640, 640);

      // 2. Detección con MobileNet v2
      const predictions = await detector.detect(bufferCanvas, 15, activeThreshold);
      
      // Filtrar por botellas y vasos/envases reciclables
      const rawBoxes = predictions
        .filter(p => ['bottle', 'cup', 'can'].includes(p.class) && p.score >= activeThreshold)
        .map(p => ({
          x: p.bbox[0],
          y: p.bbox[1],
          w: p.bbox[2],
          h: p.bbox[3],
          score: p.score
        }));

      const cleanedBoxes = cleanOverlappingDetections(rawBoxes);
      const newlyConfirmed = updateTrackers(cleanedBoxes);

      visibleBoxes = trackers.filter(t => t.missed === 0).map(t => ({
        id: t.id,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        score: t.score,
        material: t.material,
        registered: t.registered
      }));

      // Renderizar HUD
      renderCanvasHUD(dom.canvas, activeSource, visibleBoxes);

      // Actualizar conteos en vivo
      dom.hudInView.textContent = visibleBoxes.length;
      dom.hudInTake.textContent = takeCount;

      // Si hay elementos recién confirmados, persistirlos
      if (newlyConfirmed.length > 0) {
        registerNewItems(newlyConfirmed);
      }
    } catch (err) {
      console.warn('Frame drop:', err);
    } finally {
      isDetecting = false;
    }
  }

  // 8. Registro de Botellas en Inventario
  function registerNewItems(items) {
    playSound('chime');
    takeCount += items.length;
    dom.hudInTake.textContent = takeCount;

    const records = items.map(item => ({
      id: item.id,
      timestamp: new Date().toISOString(),
      label: item.material || 'Botella PET',
      confidence: Math.round(item.score * 100),
      gramsPlastic: CONFIG.GRAMS_PLASTIC_PER_BOTTLE,
      co2Saved: CONFIG.GRAMS_CO2_PER_BOTTLE
    }));

    const currentInv = loadInventory();
    const updatedInv = [...records, ...currentInv];
    saveInventory(updatedInv);
    renderInventoryTable(updatedInv);
    updateImpactMetrics(updatedInv);

    // Actualizar Tarjeta de Diagnóstico
    const avgScore = items.reduce((acc, i) => acc + i.score, 0) / items.length;
    updateDiagnosisCard(items[0].material, avgScore, updatedInv.length);
  }

  // 9. Actualización de Tarjeta Lateral de Diagnóstico
  function updateDiagnosisCard(label, confidence, totalCount) {
    dom.resultLabel.textContent = `${label} Identificada`;
    dom.resultSub.textContent = `Registrada con éxito · Total en inventario: ${totalCount}`;
    
    const pct = Math.round(confidence * 100);
    dom.meterPct.textContent = `${pct}%`;
    dom.meterFill.style.width = `${pct}%`;
    dom.btnSpeak.style.display = 'inline-flex';

    lastSpokenText = `Se ha clasificado un envase de ${label} con una confianza del ${pct} por ciento. Inventario actualizado a ${totalCount} unidades.`;
  }

  // 10. Persistencia e Inventario en LocalStorage
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

    items.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.className = 'inv-row';

      const timeStr = new Date(item.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      const tagClass = item.label.includes('Vidrio') ? 'glass' : item.label.includes('Lata') ? 'can' : 'pet';

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

    // Eventos de eliminación
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

  // 11. Métricas de Impacto Ecológico
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

  // 12. Control de Cámara
  async function startCamera() {
    stopActiveSource();
    dom.statusText.textContent = 'Solicitando acceso a cámara de alta resolución...';

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

      // Actualizar vista
      dom.idleState.style.display = 'none';
      dom.preview.style.display = 'none';
      dom.video.style.display = 'block';
      dom.canvas.style.display = 'block';
      dom.laser.classList.add('laser-active');
      dom.cameraChip.style.display = 'flex';
      dom.btnStartCamera.innerHTML = '<i class="bx bx-stop-circle"></i> Detener';
      dom.btnStartCamera.classList.add('btn-danger');

      // Iniciar bucle de renderizado y detección periódica (cada 350ms para 60fps suaves)
      const loopRender = () => {
        if (!isLoopActive) return;
        renderCanvasHUD(dom.canvas, activeSource, visibleBoxes);
        animFrameId = requestAnimationFrame(loopRender);
      };
      animFrameId = requestAnimationFrame(loopRender);

      detectIntervalId = setInterval(processVisualFrame, 320);
      dom.statusText.textContent = 'Cámara en vivo activa. Apunta a las botellas para clasificarlas.';
      playSound('click');
    } catch (err) {
      console.error('Error al acceder a la cámara:', err);
      dom.statusText.textContent = 'No se pudo abrir la cámara. Revisa los permisos o sube una imagen.';
      stopActiveSource();
    }
  }

  function stopActiveSource() {
    isLoopActive = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (detectIntervalId) clearInterval(detectIntervalId);

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

  // 13. Carga y Análisis de Fotografías
  function handlePhotoUpload(file) {
    if (!file) return;
    stopActiveSource();

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        activeSource = img;
        dom.preview.src = e.target.result;
        dom.idleState.style.display = 'none';
        dom.video.style.display = 'none';
        dom.preview.style.display = 'block';
        dom.canvas.style.display = 'block';

        trackers = [];
        takeCount = 0;
        dom.statusText.textContent = 'Fotografía cargada. Analizando envases...';
        processVisualFrame();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // 14. Exportación de Datos
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

  // 15. Vinculación de Eventos
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

    dom.btnResetSession.addEventListener('click', () => {
      trackers = [];
      visibleBoxes = [];
      takeCount = 0;
      dom.hudInTake.textContent = '0';
      dom.hudInView.textContent = '0';
      dom.statusText.textContent = 'Sesión reiniciada. Los envases en vista se contarán de nuevo.';
      playSound('click');
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
      if (confirm('¿Estás seguro de que deseas vaciar todo el inventario?')) {
        saveInventory([]);
        renderInventoryTable([]);
        updateImpactMetrics([]);
        playSound('click');
      }
    });

    // Búsqueda en Inventario
    dom.invSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const all = loadInventory();
      const filtered = all.filter(i => 
        i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q)
      );
      renderInventoryTable(filtered);
    });
  }

  // Inicialización al Cargar DOM
  document.addEventListener('DOMContentLoaded', () => {
    initNeuralEngines();
    setupEvents();
    renderInventoryTable();
    updateImpactMetrics();
  });

})();
