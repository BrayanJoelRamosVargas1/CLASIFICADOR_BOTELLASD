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

  function evaluateCapAlignment(leftScore, rightScore) {
    const l = Math.max(0, Number(leftScore) || 0);
    const r = Math.max(0, Number(rightScore) || 0);
    const avg = (l + r) / 2;
    if (avg < 0.20) {
      return {
        hasCap: false,
        status: 'Sin Tapa',
        integrity: 'Falta Tapa / Destapada',
        tiltDegrees: 0,
        isAccepted: false
      };
    }
    const maxVal = Math.max(l, r);
    const diff = Math.abs(l - r);
    const asymmetry = maxVal > 0 ? diff / maxVal : 0;
    if (asymmetry > 0.38) {
      const tilt = Math.round(asymmetry * 15);
      return {
        hasCap: true,
        status: 'Tapa Desalineada/Chueca',
        integrity: `Alerta: Inclinación ~${tilt}°`,
        tiltDegrees: tilt,
        isAccepted: false
      };
    }
    return {
      hasCap: true,
      status: 'Con Tapa Correcta',
      integrity: 'Sellado Correcto',
      tiltDegrees: 0,
      isAccepted: true
    };
  }

  function evaluateLiquidFill(fillPercent) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(fillPercent) || 0)));
    if (pct <= 5) {
      return {
        fillPercent: pct,
        status: 'Vacía (0%)',
        rvmDecision: 'ACEPTADA',
        warning: null,
        canCompact: true
      };
    }
    if (pct <= 20) {
      return {
        fillPercent: pct,
        status: `Residuo Mínimo (${pct}%)`,
        rvmDecision: 'ACEPTADA_CON_DRENAJE',
        warning: 'Líquido residual leve detectado',
        canCompact: true
      };
    }
    return {
      fillPercent: pct,
      status: `Con Contenido (${pct}%)`,
      rvmDecision: 'RECHAZADA_POR_CONTENIDO',
      warning: 'Riesgo de derrame en tolva de trituración',
      canCompact: false
    };
  }

  function computeConveyorMetrics(historyDetections = []) {
    const records = Array.isArray(historyDetections) ? historyDetections : [];
    if (records.length < 2) {
      return { bpm: 0, velocityPxS: 0, cadence: 'Estática / Reposo' };
    }
    const recent = records.slice(-8);
    const t0 = new Date(recent[0].timestamp).getTime();
    const t1 = new Date(recent[recent.length - 1].timestamp).getTime();
    const deltaSec = (t1 - t0) / 1000;
    if (deltaSec <= 0.2) {
      return { bpm: 0, velocityPxS: 0, cadence: 'Calculando...' };
    }
    const count = recent.length;
    const bpm = Math.round((count / deltaSec) * 60);
    let cadence = 'Baja (Kiosco / Manual)';
    if (bpm > 25) cadence = 'Alta (Cinta Industrial)';
    else if (bpm > 10) cadence = 'Media (Flujo Continuo)';
    return {
      bpm: Math.min(120, bpm),
      velocityPxS: Math.round(count * 50 / deltaSec),
      cadence
    };
  }

  function generateBarcodeSVG(codeText = 'DRS-RVM-001', options = {}) {
    const clean = String(codeText).replace(/[^A-Z0-9-]/gi, '').toUpperCase() || 'DRS-CODE';
    const width = options.width || 280;
    const height = options.height || 64;
    let rects = '';
    let x = 12;
    const barWidths = [2, 3, 1, 4, 2, 1, 3, 2];
    for (let i = 0; i < clean.length; i++) {
      const charCode = clean.charCodeAt(i);
      const w1 = barWidths[(charCode + i) % barWidths.length];
      const w2 = barWidths[(charCode * 3 + i) % barWidths.length];
      rects += `<rect x="${x}" y="4" width="${w1}" height="${height - 20}" fill="#0f172a" />`;
      x += w1 + 2;
      rects += `<rect x="${x}" y="4" width="${w2}" height="${height - 20}" fill="#0f172a" />`;
      x += w2 + 3;
    }
    rects += `<rect x="${x}" y="4" width="2" height="${height - 20}" fill="#0f172a" />`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(x + 16, width)} ${height}" width="100%" height="${height}" style="display:block; margin:0 auto;"><rect width="100%" height="100%" fill="#ffffff"/>${rects}<text x="50%" y="${height - 4}" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="#334155">${clean}</text></svg>`;
  }

  function classifyBottleColorGrade(rgbSample = {}, materialType = 'pet') {
    const r = Number(rgbSample.r) || 0;
    const g = Number(rgbSample.g) || 0;
    const b = Number(rgbSample.b) || 0;
    const lum = Number(rgbSample.lum) || (0.299 * r + 0.587 * g + 0.114 * b);
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

    if (materialType === 'glass') {
      if (g > 60 && g > r * 1.15 && g > b) {
        return {
          colorGrade: 'Vidrio Verde (Esmeralda)',
          colorFraction: 'GL-71 (Verde)',
          flakeValueBsKg: 1.00,
          qualityTier: 'Retornable / Reutilización',
          badgeColor: '#15803d'
        };
      }
      if (r > 70 && r > b * 1.30 && lum < 95) {
        return {
          colorGrade: 'Vidrio Ámbar (Marrón Cerveza)',
          colorFraction: 'GL-72 (Ámbar)',
          flakeValueBsKg: 1.00,
          qualityTier: 'Retornable UV / Protección',
          badgeColor: '#b45309'
        };
      }
      return {
        colorGrade: 'Vidrio Transparente / Blanco',
        colorFraction: 'GL-70 (Blanco)',
        flakeValueBsKg: 1.20,
        qualityTier: 'Alta Pureza (Flint)',
        badgeColor: '#64748b'
      };
    }

    if (b > 60 && b > r * 1.15 && b > g * 1.05) {
      return {
        colorGrade: 'PET Azul Claro / Mineral',
        colorFraction: 'Fracción B (Azul)',
        flakeValueBsKg: 3.80,
        qualityTier: 'Grado Fibras & Flejes',
        badgeColor: '#0284c7'
      };
    }
    if (g > 55 && g > r * 1.12 && g > b) {
      return {
        colorGrade: 'PET Verde (Sprite / Cítricos)',
        colorFraction: 'Fracción C (Verde)',
        flakeValueBsKg: 3.00,
        qualityTier: 'Grado Fleje Industrial',
        badgeColor: '#059669'
      };
    }
    if (r > 60 && r > b * 1.35 && lum < 105) {
      return {
        colorGrade: 'PET Ámbar / Farmacéutico',
        colorFraction: 'Fracción D (Ámbar)',
        flakeValueBsKg: 2.20,
        qualityTier: 'Grado Técnico UV',
        badgeColor: '#d97706'
      };
    }
    return {
      colorGrade: 'PET Cristal (Transparente Natural)',
      colorFraction: 'Fracción A (Cristal rPET)',
      flakeValueBsKg: 4.50,
      qualityTier: 'Grado Alimentario Bottle-to-Bottle (FDA/EFSA)',
      badgeColor: '#0ea5e9'
    };
  }

  function computePneumaticEjectorChannel(bottleCenterX, frameWidth = 640, numValves = 8) {
    const x = Math.max(0, Math.min(frameWidth, Number(bottleCenterX) || 0));
    const normalized = x / Math.max(1, frameWidth);
    const valveId = Math.min(numValves, Math.max(1, Math.floor(normalized * numValves) + 1));
    const delayMs = 120;
    return {
      valveId,
      totalValves: numValves,
      triggerDelayMs: delayMs,
      label: `Válvula Neumática #${valveId} (Disparo ${delayMs}ms)`
    };
  }

  function evaluateNeckFinishOvality(neckW, neckH) {
    const w = Number(neckW) || 0;
    const h = Number(neckH) || 0;
    if (w <= 0 || h <= 0) return { isConforming: true, ovalityIndex: 1.0, status: 'Boca Conforme (Circular)' };
    const ratio = w / (h * 2.2);
    const deviation = Math.abs(ratio - 1.0);
    if (deviation > 0.28) {
      return {
        isConforming: false,
        ovalityIndex: Number(ratio.toFixed(2)),
        status: 'Boca Deformada / Ovalada (Alerta de Rosca)'
      };
    }
    return {
      isConforming: true,
      ovalityIndex: Number(ratio.toFixed(2)),
      status: 'Boca Conforme (Circular)'
    };
  }

  function estimatePcrRecycledContent(opticalVariance = 0, luma = 120) {
    const v = Math.max(0, Number(opticalVariance) || 0);
    const lum = Math.max(0, Math.min(255, Number(luma) || 120));
    let pcrPercent = 0;
    if (v > 45 || lum < 100) {
      pcrPercent = Math.min(100, Math.round(25 + (v / 2) + ((140 - lum) / 2)));
    } else {
      pcrPercent = Math.min(25, Math.round(v / 3));
    }
    return {
      pcrPercent,
      label: pcrPercent >= 50 ? `rPET Alto Contenido (${pcrPercent}% PCR)` : (pcrPercent > 10 ? `rPET Mezcla (${pcrPercent}% PCR)` : 'PET Virgen (0-10% PCR)'),
      isFoodGradeCertified: pcrPercent <= 75
    };
  }

  function computeHighQualityRecoveryIndex({ returnRate = 0.77, qualityScore = 0.95, yieldScore = 0.845 } = {}) {
    const R = Math.max(0, Math.min(1.0, Number(returnRate) || 0.77));
    const Q = Math.max(0, Math.min(1.0, Number(qualityScore) || 0.95));
    const Y = Math.max(0, Math.min(1.0, Number(yieldScore) || 0.845));

    // HQR = R * Q * Y (Orynycz et al., Materials 2026, doi:10.3390/ma19173669)
    const rawHqr = R * Q * Y;
    const hqrPercent = Number((rawHqr * 100).toFixed(1));

    let hqrRating = 'Deficiente (Downcycling/Rechazo)';
    if (hqrPercent >= 65) {
      hqrRating = 'Excelente (Grado Alimentario FDA/EFSA)';
    } else if (hqrPercent >= 40) {
      hqrRating = 'Aceptable (Fibra Textil/Termoformado)';
    }

    return {
      hqrPercent,
      hqrFraction: Number(rawHqr.toFixed(3)),
      hqrRating,
      scientificCitation: 'Orynycz et al. (2026), Materials 19(17):3669',
      factors: {
        returnRate: Number(R.toFixed(2)),
        qualityFactor: Number(Q.toFixed(2)),
        yieldFactor: Number(Y.toFixed(3))
      }
    };
  }

  function getBottleMaterialSpecs(materialType = 'pet') {
    const mat = String(materialType).toLowerCase().includes('vidrio') || String(materialType).toLowerCase().includes('glass')
      ? 'glass'
      : 'pet';

    if (mat === 'glass') {
      return {
        materialType: 'Soda-Lime-Silica Glass Packaging',
        resinCode: 'GL-70 / GL-71',
        recyclingBin: 'Contenedor Verde (Vidrio)',
        chemicalFormula: 'SiO2 (~72%) + Na2CO3 (~14%) + CaCO3 (~10%)',
        densityGcm3: 2.52,
        meltingPointC: 1450,
        glassTransitionC: 550,
        pubchemCids: [24261, 10340, 10112],
        is100PercentClosedLoop: true,
        reuseLifespanCycles: '30 a 50 ciclos de lavado industrial',
        reprocessingYield: 0.95
      };
    }

    return {
      materialType: 'Polyethylene Terephthalate (PET)',
      resinCode: '♳ PET-1',
      recyclingBin: 'Contenedor Azul (PET)',
      chemicalFormula: '(C10H8O4)n',
      densityGcm3: 1.38,
      meltingPointC: 255,
      glassTransitionC: 76,
      monomers: 'Terephthalic acid (PubChem CID 7489) + Ethylene glycol (PubChem CID 174)',
      pubchemCids: [7489, 174],
      foodGradeStandard: 'FDA 21 CFR 177.1630 / EFSA 2011/10/EC',
      intrinsicViscosityFoodGrade: '0.74 - 0.84 dL/g',
      reprocessingYield: 0.845
    };
  }

  const api = Object.freeze({
    config,
    iou,
    select,
    computeDailyCut,
    classifyResinAndBin,
    computeCompactionStatus,
    generateDRSTicket,
    evaluateCapAlignment,
    evaluateLiquidFill,
    computeConveyorMetrics,
    generateBarcodeSVG,
    classifyBottleColorGrade,
    computePneumaticEjectorChannel,
    evaluateNeckFinishOvality,
    estimatePcrRecycledContent,
    computeHighQualityRecoveryIndex,
    getBottleMaterialSpecs
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BottleDetection = api;
})();
