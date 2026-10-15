/**
 * StockVision AI - Controlador Principal de la Aplicación
 * Orquesta cámara web/móvil, canvas HUD, gestión de eventos y reactividad
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Instancias de módulos
  const inventory = new window.InventoryManager();
  const vision = new window.VisionEngine();
  const liveness = new window.LivenessInspector();

  // Elementos DOM principales
  const video = document.getElementById('cameraFeed');
  const overlayCanvas = document.getElementById('overlayCanvas');
  const staticImage = document.getElementById('staticImage');
  const statusBadge = document.getElementById('modelStatusBadge');
  const statusText = document.getElementById('modelStatusText');
  const autoModeToggle = document.getElementById('autoModeToggle');
  const confidenceSlider = document.getElementById('confidenceSlider');
  const confidenceVal = document.getElementById('confidenceVal');
  if (confidenceSlider && confidenceVal) {
    confidenceSlider.value = 0.25;
    confidenceVal.textContent = '25%';
  }
  const categoryFilter = document.getElementById('categoryFilter');
  const cameraSelectBtn = document.getElementById('cameraSelectBtn');
  const manualScanBtn = document.getElementById('manualScanBtn');
  const resetCameraBtn = document.getElementById('resetCameraBtn');
  const fileInput = document.getElementById('fileInput');

  // KPIs
  const kpiTotalUnits = document.getElementById('kpiTotalUnits');
  const kpiConfidence = document.getElementById('kpiConfidence');
  const kpiLastTime = document.getElementById('kpiLastTime');
  const kpiUniqueItems = document.getElementById('kpiUniqueItems');

  // Tabla
  const inventoryTableBody = document.getElementById('inventoryTableBody');
  const emptyInventoryState = document.getElementById('emptyInventoryState');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportJsonBtn = document.getElementById('exportJsonBtn');
  const clearInventoryBtn = document.getElementById('clearInventoryBtn');

  // Modal Liveness
  const livenessModal = document.getElementById('livenessModal');
  const openLivenessBtn = document.getElementById('openLivenessBtn');
  const closeLivenessBtn = document.getElementById('closeLivenessBtn');

  // Estado de la cámara
  let currentStream = null;
  let useFacingMode = 'environment'; // 'environment' (trasera) o 'user' (frontal)
  let isProcessingVideo = false;
  let lastPredictions = [];
  let audioCtx = null;
  let inferenceTimeoutId = null;
  let isInferencingStep = false;

  // Sincronizar dimensiones del canvas en resize sin provocar reflow continuo
  window.addEventListener('resize', () => {
    if (overlayCanvas && overlayCanvas.clientWidth && overlayCanvas.clientHeight) {
      overlayCanvas.width = overlayCanvas.clientWidth;
      overlayCanvas.height = overlayCanvas.clientHeight;
    }
  });

  // Sintetizador Web Audio API para feedback sonoro industrial sin dependencias
  function playBeep(success = true) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (success) {
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // La5
        osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.15);
      }
    } catch (e) {
      // Restricción autoplay de audio en navegadores
    }
  }

  // Notificación Toast
  function showToast(title, message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl transition-all duration-300 transform translate-y-10 opacity-0 ${
      type === 'success' ? 'bg-emerald-950/90 border border-emerald-500/50 text-emerald-200' : 'bg-sky-950/90 border border-sky-500/50 text-sky-200'
    }`;
    toast.innerHTML = `
      <div class="w-2.5 h-2.5 rounded-full ${type === 'success' ? 'bg-emerald-400' : 'bg-sky-400'} pulse-indicator"></div>
      <div>
        <div class="text-xs font-semibold uppercase tracking-wider">${title}</div>
        <div class="text-sm font-medium">${message}</div>
      </div>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.remove('translate-y-10', 'opacity-0');
    }, 50);

    setTimeout(() => {
      toast.classList.add('translate-y-10', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Actualización de reactividad de la UI desde el Inventario
  inventory.subscribe((items, metrics) => {
    kpiTotalUnits.textContent = metrics.totalUnits;
    kpiConfidence.textContent = metrics.avgConfidence > 0 ? `${metrics.avgConfidence}%` : '--%';
    kpiLastTime.textContent = metrics.lastDetected;
    kpiUniqueItems.textContent = `${metrics.uniqueItems} SKU`;

    if (items.length === 0) {
      inventoryTableBody.innerHTML = '';
      emptyInventoryState.classList.remove('hidden');
    } else {
      emptyInventoryState.classList.add('hidden');
      renderInventoryTable(items);
    }
  });

  // Renderizar filas de la tabla de inventario
  function renderInventoryTable(items) {
    inventoryTableBody.innerHTML = items.map(item => `
      <tr class="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
        <td class="py-3 px-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg overflow-hidden bg-slate-800 border border-slate-700 flex-shrink-0 flex items-center justify-center">
              ${item.thumbnail
                ? `<img src="${item.thumbnail}" class="w-full h-full object-cover" alt="Recorte">`
                : `<span class="text-xs text-slate-500">N/A</span>`}
            </div>
            <div>
              <div class="font-medium text-white text-sm">${item.label}</div>
              <div class="text-xs text-slate-400 font-mono">${item.id}</div>
            </div>
          </div>
        </td>
        <td class="py-3 px-4 text-xs text-slate-300">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-sky-400 border border-slate-700">
            ${item.category}
          </span>
        </td>
        <td class="py-3 px-4">
          <div class="flex items-center gap-2">
            <button class="btn-qty-minus text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition" data-id="${item.id}">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"/></svg>
            </button>
            <span class="font-bold text-white text-sm w-6 text-center font-mono">${item.quantity}</span>
            <button class="btn-qty-plus text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition" data-id="${item.id}">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            </button>
          </div>
        </td>
        <td class="py-3 px-4">
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-mono font-medium ${
            item.confidence >= 80 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' :
            item.confidence >= 60 ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' :
            'bg-rose-500/10 text-rose-400 border border-rose-500/30'
          }">
            <span class="w-1.5 h-1.5 rounded-full ${item.confidence >= 80 ? 'bg-emerald-400' : 'bg-amber-400'}"></span>
            ${item.confidence}%
          </span>
        </td>
        <td class="py-3 px-4 text-xs text-slate-400 font-mono">
          ${item.formattedTime}
        </td>
        <td class="py-3 px-4 text-right">
          <button class="btn-delete-item text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition" data-id="${item.id}" title="Eliminar">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </td>
      </tr>
    `).join('');

    // Listeners de botones de la tabla
    document.querySelectorAll('.btn-qty-plus').forEach(b => {
      b.onclick = () => inventory.updateQuantity(b.dataset.id, 1);
    });
    document.querySelectorAll('.btn-qty-minus').forEach(b => {
      b.onclick = () => inventory.updateQuantity(b.dataset.id, -1);
    });
    document.querySelectorAll('.btn-delete-item').forEach(b => {
      b.onclick = () => inventory.deleteItem(b.dataset.id);
    });
  }

  // Callback para auto-registro desde visión espacial
  vision.onAutoDetectCallback = (detectionData) => {
    if (!autoModeToggle.checked) return;

    inventory.registerDetection(detectionData);
    playBeep(true);
    showToast('Auto-Registrado', `${detectionData.label} (+1 en inventario)`, 'success');
  };

  // Inicializar Cámara con resolución ágil y fluida
  async function startCamera() {
    try {
      if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
      }

      // 640x480 es 3x más rápido que 720p/1080p y corre a 60 FPS estables sin saturar CPU móvil
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: useFacingMode },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      };

      try {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err1) {
        currentStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: useFacingMode }
        });
      }

      video.srcObject = currentStream;
      video.classList.remove('hidden');
      staticImage.classList.add('hidden');

      video.onloadedmetadata = () => {
        video.play();
        isProcessingVideo = true;

        if (overlayCanvas && overlayCanvas.clientWidth && overlayCanvas.clientHeight) {
          overlayCanvas.width = overlayCanvas.clientWidth;
          overlayCanvas.height = overlayCanvas.clientHeight;
        }

        startAsyncVisionLoops();
      };
    } catch (err) {
      console.error('Error al acceder a la cámara:', err);
      showToast('Error de Cámara', 'Permite el acceso a la cámara o sube una imagen.', 'error');
    }
  }

  // Doble bucle desacoplado: 60 FPS limpios para UI + inferencia holgada sin congelar
  function startAsyncVisionLoops() {
    // 1. Loop de renderizado continuo (HUD a 60 FPS fluidos)
    function renderLoop() {
      if (!isProcessingVideo) return;
      if (video.readyState >= 2 && !video.classList.contains('hidden')) {
        vision.renderOverlay(overlayCanvas, lastPredictions, video);
      }
      requestAnimationFrame(renderLoop);
    }
    requestAnimationFrame(renderLoop);

    // 2. Loop de inferencia IA adaptativo (cada 400ms)
    // Permite que la CPU y GPU descansen 75% del tiempo entre detecciones
    if (inferenceTimeoutId) clearTimeout(inferenceTimeoutId);

    async function runInferenceStep() {
      if (!isProcessingVideo) return;

      if (vision.isModelLoaded && !isInferencingStep && video.readyState >= 2 && !video.classList.contains('hidden')) {
        isInferencingStep = true;
        try {
          const predictions = await vision.detectFrame(video);
          if (predictions !== null) {
            lastPredictions = predictions;
          }
        } catch (e) {
          console.warn('Inference step warning:', e);
        } finally {
          isInferencingStep = false;
        }
      }

      if (isProcessingVideo) {
        inferenceTimeoutId = setTimeout(runInferenceStep, 400);
      }
    }

    inferenceTimeoutId = setTimeout(runInferenceStep, 250);
  }

  // Escaneo manual al presionar botón
  function triggerManualScan() {
    const sourceEl = !video.classList.contains('hidden') ? video : staticImage;

    if (lastPredictions.length === 0) {
      showToast('Sin Detección', 'Coloca un producto visible (ej. botella) frente a la cámara.', 'error');
      return;
    }

    lastPredictions.forEach(pred => {
      const friendly = vision.classLabels[pred.class] || { name: pred.class, category: 'Producto General' };
      const thumbnail = vision.extractThumbnail(sourceEl, pred.bbox);

      inventory.registerDetection({
        label: friendly.name,
        category: friendly.category,
        confidence: pred.score,
        thumbnail,
        box: pred.bbox
      });
    });

    playBeep(true);
    showToast('Registro Manual', `${lastPredictions.length} producto(s) sumados al inventario.`, 'success');
  }

  // Procesamiento de imagen cargada por archivo
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      staticImage.src = event.target.result;
      staticImage.classList.remove('hidden');
      video.classList.add('hidden');

      if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        isProcessingVideo = false;
      }

      staticImage.onload = async () => {
        overlayCanvas.width = overlayCanvas.clientWidth || staticImage.naturalWidth;
        overlayCanvas.height = overlayCanvas.clientHeight || staticImage.naturalHeight;
        lastPredictions = await vision.detectFrame(staticImage);
        vision.renderOverlay(overlayCanvas, lastPredictions, staticImage);

        if (lastPredictions.length > 0) {
          showToast('Imagen Analizada', `Se detectaron ${lastPredictions.length} objetos en la foto.`);
        } else {
          showToast('Sin Resultados', 'No se identificaron botellas con la confianza actual.', 'error');
        }
      };
    };
    reader.readAsDataURL(file);
  });

  // Alternar cámara frontal/trasera en smartphones
  cameraSelectBtn.addEventListener('click', () => {
    useFacingMode = (useFacingMode === 'environment') ? 'user' : 'environment';
    showToast('Cámara', `Cambiando a lente ${useFacingMode === 'environment' ? 'trasero' : 'frontal'}...`);
    startCamera();
  });

  // Slider de confianza
  confidenceSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    vision.confidenceThreshold = val;
    confidenceVal.textContent = `${Math.round(val * 100)}%`;
  });

  // Filtro de categorías
  categoryFilter.addEventListener('change', (e) => {
    vision.selectedClassFilter = e.target.value;
  });

  // Botones de acción
  manualScanBtn.addEventListener('click', triggerManualScan);
  resetCameraBtn.addEventListener('click', () => {
    staticImage.classList.add('hidden');
    startCamera();
  });
  exportCsvBtn.addEventListener('click', () => inventory.exportCSV());
  exportJsonBtn.addEventListener('click', () => inventory.exportJSON());
  clearInventoryBtn.addEventListener('click', () => {
    if (confirm('¿Deseas reiniciar el contador y vaciar todo el inventario?')) {
      inventory.clearAll();
      showToast('Inventario Vacío', 'Se han restablecido los registros.', 'success');
    }
  });

  // Modal Liveness
  openLivenessBtn.addEventListener('click', () => {
    const def = liveness.getTechnicalDefenseExplanation();
    document.getElementById('livenessTitle').textContent = def.title;
    document.getElementById('livenessConcept').textContent = def.concept;
    document.getElementById('livenessSummary').textContent = def.summary;

    const listContainer = document.getElementById('livenessSolutions');
    listContainer.innerHTML = def.solutions.map(sol => `
      <div class="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700/60">
        <div class="font-semibold text-sky-400 text-sm mb-1">${sol.name}</div>
        <div class="text-xs text-slate-300 leading-relaxed">${sol.desc}</div>
      </div>
    `).join('');

    livenessModal.classList.remove('hidden');
  });

  closeLivenessBtn.addEventListener('click', () => {
    livenessModal.classList.add('hidden');
  });

  // Iniciar carga del modelo de visión
  try {
    statusText.textContent = 'Descargando IA ultraligera...';
    await vision.initModel((msg) => {
      statusText.textContent = msg;
    });

    statusBadge.className = 'w-2 h-2 rounded-full bg-emerald-400 pulse-indicator';
    statusText.textContent = 'Modelo Listo (MobileNet v2 Alta Precisión)';
    statusText.className = 'text-xs font-mono text-emerald-400';

    // Iniciar cámara por defecto
    startCamera();
  } catch (err) {
    statusBadge.className = 'w-2 h-2 rounded-full bg-rose-500';
    statusText.textContent = 'Error al cargar IA';
    statusText.className = 'text-xs font-mono text-rose-400';
  }
});
