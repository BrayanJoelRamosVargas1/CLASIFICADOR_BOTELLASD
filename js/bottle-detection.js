/* Shared by the camera and the reproducible image benchmark. */
(() => {
  'use strict';
  const config = Object.freeze({
    modelBase: 'yolov10n',
    minScore: 0.10,
    threshold: 0.15,
    maxBoxes: 30,
    nmsIoU: 0.45
  });

  function iou(a, b) {
    const intersection = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const union = a.w * a.h + b.w * b.h - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function select(predictions, width, height, threshold = config.threshold) {
    const candidates = predictions.filter(p => p.class === 'bottle' && p.score >= threshold)
      .map(p => {
        const [x, y, w, h] = p.bbox;
        const left = Math.max(0, x), top = Math.max(0, y);
        return { x: left, y: top, w: Math.min(width, x + w) - left,
          h: Math.min(height, y + h) - top, score: p.score, rawClass: p.class };
      })
      .filter(b => [b.x, b.y, b.w, b.h, b.score].every(Number.isFinite) && b.w >= 14 && b.h >= 14)
      .sort((a, b) => b.score - a.score);
    const selected = [];
    for (const box of candidates) {
      if (selected.every(other => iou(box, other) < config.nmsIoU)) selected.push(box);
    }
    return selected;
  }

  function computeDailyCut(initialStock, currentStock, productName = 'Botellas de Agua') {
    const initial = Math.max(0, Math.floor(Number(initialStock) || 0));
    const remaining = Math.max(0, Math.floor(Number(currentStock) || 0));
    const sold = Math.max(0, initial - remaining);
    const restocked = Math.max(0, remaining - initial);
    const cleanProduct = String(productName || 'Botellas de Agua').replace(/[<>"]/g, '').trim() || 'Botellas de Agua';
    let status = 'Sin Cambios';
    if (remaining === 0 && initial > 0) status = 'Agotado';
    else if (sold > 0) status = 'Con Ventas';
    else if (restocked > 0) status = 'Reposición';
    return {
      product: cleanProduct,
      initialStock: initial,
      remainingStock: remaining,
      soldUnits: sold,
      restockedUnits: restocked,
      status
    };
  }

  function classifyResinAndBin(tagClass, options = {}) {
    const isGlass = tagClass === 'glass';
    if (isGlass) {
      return {
        ricCode: 'GL-71',
        ricSymbol: 'GL-71',
        resinName: 'Vidrio (Silicato Sódico-Cálcico)',
        recyclingBin: 'Contenedor Verde (Vidrio)',
        depositValue: 1.00,
        isReturnable: true,
        capRicCode: options.hasCap ? 'FE-40 (Chapa/Corona)' : null
      };
    }
    return {
      ricCode: '♳ PET-1',
      ricSymbol: '♳',
      resinName: 'Polietileno Tereftalato (PET)',
      recyclingBin: 'Contenedor Azul (Plástico PET)',
      depositValue: 0.50,
      isReturnable: false,
      capRicCode: options.hasCap ? '♴ HDPE-2 (Tapa Rosca)' : null
    };
  }

  function computeCompactionStatus(box) {
    if (!box || !Number.isFinite(box.w) || !Number.isFinite(box.h) || box.w <= 0 || box.h <= 0) {
      return 'Íntegra';
    }
    const aspectRatio = box.h / box.w;
    if (aspectRatio < 1.20) {
      return 'Compactada (Ahorro ~70% espacio)';
    }
    return 'Íntegra';
  }

  function generateDRSTicket(inventoryItems = [], options = {}) {
    const items = Array.isArray(inventoryItems) ? inventoryItems : [];
    const petItems = items.filter(i => i.tagClass !== 'glass');
    const glassItems = items.filter(i => i.tagClass === 'glass');

    const petDeposit = petItems.reduce((acc, i) => acc + (typeof i.depositValue === 'number' ? i.depositValue : 0.50), 0);
    const glassDeposit = glassItems.reduce((acc, i) => acc + (typeof i.depositValue === 'number' ? i.depositValue : 1.00), 0);
    const totalDeposit = petDeposit + glassDeposit;

    const totalGramsPlastic = Math.round(petItems.length * 28);
    const totalGramsCo2 = Math.round(items.length * 82);

    const date = options.date || new Date().toISOString();
    const machineId = options.machineId || 'RVM-STK-01';
    const seed = (items.length * 997 + Math.round(totalDeposit * 100)).toString(16).toUpperCase().padStart(4, '0');
    const ticketCode = `DRS-${machineId.replace(/[^A-Z0-9]/gi, '')}-${seed}-${(Date.now() % 10000).toString().padStart(4, '0')}`;

    return {
      ticketCode,
      machineId,
      timestamp: date,
      totalBottles: items.length,
      petCount: petItems.length,
      glassCount: glassItems.length,
      petDeposit: Number(petDeposit.toFixed(2)),
      glassDeposit: Number(glassDeposit.toFixed(2)),
      totalDeposit: Number(totalDeposit.toFixed(2)),
      currency: 'Bs.',
      gramsPlasticSaved: totalGramsPlastic,
      gramsCo2Saved: totalGramsCo2,
      itemsBreakdown: [
        {
          ricCode: '♳ PET-1',
          material: 'Envases Plásticos PET',
          bin: 'Contenedor Azul',
          quantity: petItems.length,
          unitRefund: 0.50,
          subtotal: Number(petDeposit.toFixed(2))
        },
        {
          ricCode: 'GL-71',
          material: 'Botellas de Vidrio Retornables',
          bin: 'Contenedor Verde',
          quantity: glassItems.length,
          unitRefund: 1.00,
          subtotal: Number(glassDeposit.toFixed(2))
        }
      ]
    };
  }

  const api = Object.freeze({
    config,
    iou,
    select,
    computeDailyCut,
    classifyResinAndBin,
    computeCompactionStatus,
    generateDRSTicket
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BottleDetection = api;
})();
