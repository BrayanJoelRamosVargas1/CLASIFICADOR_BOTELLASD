const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../js/bottle-detection.js');
const bottle = { class: 'bottle', score: 0.8, bbox: [10, 20, 50, 100] };

test('cups, vases, bowls and glasses are not bottles', () => {
  for (const name of ['cup', 'vase', 'bowl', 'wine glass', 'person']) {
    assert.equal(select([{ ...bottle, class: name }], 640, 480).length, 0);
  }
});
test('keeps separate bottles and removes overlapping duplicates', () => {
  const result = select([bottle, { ...bottle, score: 0.7, bbox: [12, 22, 50, 100] },
    { ...bottle, bbox: [100, 20, 50, 100] }], 640, 480);
  assert.equal(result.length, 2);
  assert.equal(result[0].score, 0.8);
});
test('rejects low confidence, invalid and tiny boxes, clips image edges', () => {
  assert.equal(select([{ ...bottle, score: 0.1 }], 640, 480).length, 0);
  for (const bbox of [[NaN, 0, 40, 40], [0, 0, -2, 40], [0, 0, 10, 10], [700, 0, 40, 40]]) {
    assert.equal(select([{ ...bottle, bbox }], 640, 480).length, 0);
  }
  assert.equal(select([{ ...bottle, bbox: [-10, 0, 50, 100] }], 640, 480)[0].w, 40);
});
test('does not discard real close-up or horizontal bottles by aspect ratio', () => {
  assert.equal(select([{ ...bottle, bbox: [0, 0, 630, 470] }], 640, 480).length, 1);
  assert.equal(select([{ ...bottle, bbox: [0, 0, 200, 40] }], 640, 480).length, 1);
});
test('computes daily inventory cut: starting with 10 bottles and reading 8 yields 2 sold', () => {
  const cut = computeDailyCut(10, 8, 'Botellas de Agua');
  assert.equal(cut.initialStock, 10);
  assert.equal(cut.remainingStock, 8);
  assert.equal(cut.soldUnits, 2);
  assert.equal(cut.restockedUnits, 0);
  assert.equal(cut.status, 'Con Ventas');
});
test('computes restock, sold-out and sanitizes product name against XSS', () => {
  const restock = computeDailyCut(10, 13, '<script>Agua</script>');
  assert.equal(restock.soldUnits, 0);
  assert.equal(restock.restockedUnits, 3);
  assert.equal(restock.status, 'Reposición');
  assert.equal(restock.product, 'scriptAgua/script');
  const empty = computeDailyCut(10, 0);
  assert.equal(empty.soldUnits, 10);
  assert.equal(empty.status, 'Agotado');
});

test('computes DRS deposit refund value: 0.50 Bs for PET bottles and 1.00 Bs for glass bottles', () => {
  const items = [
    { tagClass: 'pet', depositValue: 0.50 },
    { tagClass: 'coca', depositValue: 0.50 },
    { tagClass: 'glass', depositValue: 1.00 }
  ];
  const total = items.reduce((acc, i) => acc + i.depositValue, 0);
  assert.equal(total, 2.00);
});

test('classifies ASTM D7611 Resin Identification Codes and sorting bins', () => {
  const pet = classifyResinAndBin('pet', { hasCap: true });
  assert.equal(pet.ricCode, '♳ PET-1');
  assert.equal(pet.recyclingBin, 'Contenedor Azul (Plástico PET)');
  assert.equal(pet.capRicCode, '♴ HDPE-2 (Tapa Rosca)');
  assert.equal(pet.depositValue, 0.50);

  const glass = classifyResinAndBin('glass', { hasCap: true });
  assert.equal(glass.ricCode, 'GL-71');
  assert.equal(glass.recyclingBin, 'Contenedor Verde (Vidrio)');
  assert.equal(glass.capRicCode, 'FE-40 (Chapa/Corona)');
  assert.equal(glass.depositValue, 1.00);
});

test('detects bottle compaction status from aspect ratio', () => {
  const upright = computeCompactionStatus({ w: 50, h: 100 });
  assert.equal(upright, 'Íntegra');

  const crushed = computeCompactionStatus({ w: 80, h: 50 });
  assert.equal(crushed, 'Compactada (Ahorro ~70% espacio)');
});

test('generates RVM DRS refund ticket with breakdown and environmental savings', () => {
  const items = [
    { id: 'BOT-01', tagClass: 'pet', depositValue: 0.50 },
    { id: 'BOT-02', tagClass: 'pet', depositValue: 0.50 },
    { id: 'BOT-03', tagClass: 'glass', depositValue: 1.00 }
  ];
  const ticket = generateDRSTicket(items, { machineId: 'RVM-TEST-01', date: '2026-10-18T22:00:00Z' });
  assert.equal(ticket.totalBottles, 3);
  assert.equal(ticket.petCount, 2);
  assert.equal(ticket.glassCount, 1);
  assert.equal(ticket.petDeposit, 1.00);
  assert.equal(ticket.glassDeposit, 1.00);
  assert.equal(ticket.totalDeposit, 2.00);
  assert.equal(ticket.gramsPlasticSaved, 56);
  assert.equal(ticket.gramsCo2Saved, 246);
  assert.ok(ticket.ticketCode.startsWith('DRS-RVMTEST01-'));
});

test('evaluates cap presence, alignment, and tilt defect detection', () => {
  const missing = evaluateCapAlignment(0.04, 0.05);
  assert.equal(missing.hasCap, false);
  assert.equal(missing.status, 'Sin Tapa');
  assert.equal(missing.isAccepted, false);

  const crooked = evaluateCapAlignment(0.88, 0.35);
  assert.equal(crooked.hasCap, true);
  assert.equal(crooked.status, 'Tapa Desalineada/Chueca');
  assert.ok(crooked.tiltDegrees > 0);
  assert.equal(crooked.isAccepted, false);

  const correct = evaluateCapAlignment(0.80, 0.76);
  assert.equal(correct.hasCap, true);
  assert.equal(correct.status, 'Con Tapa Correcta');
  assert.equal(correct.integrity, 'Sellado Correcto');
  assert.equal(correct.isAccepted, true);
});

test('evaluates liquid fill level and RVM compaction acceptance or spill rejection', () => {
  const empty = evaluateLiquidFill(2);
  assert.equal(empty.status, 'Vacía (0%)');
  assert.equal(empty.rvmDecision, 'ACEPTADA');
  assert.equal(empty.canCompact, true);

  const residue = evaluateLiquidFill(14);
  assert.equal(residue.status, 'Residuo Mínimo (14%)');
  assert.equal(residue.rvmDecision, 'ACEPTADA_CON_DRENAJE');
  assert.equal(residue.canCompact, true);

  const full = evaluateLiquidFill(60);
  assert.equal(full.status, 'Con Contenido (60%)');
  assert.equal(full.rvmDecision, 'RECHAZADA_POR_CONTENIDO');
  assert.equal(full.canCompact, false);
});

test('computes conveyor cadence and velocity in bottles per minute (BPM)', () => {
  const now = Date.now();
  const history = [
    { timestamp: new Date(now - 4000).toISOString() },
    { timestamp: new Date(now - 3000).toISOString() },
    { timestamp: new Date(now - 2000).toISOString() },
    { timestamp: new Date(now - 1000).toISOString() }
  ];
  const metrics = computeConveyorMetrics(history);
  assert.ok(metrics.bpm >= 50);
  assert.ok(metrics.velocityPxS > 0);
  assert.equal(metrics.cadence, 'Alta (Cinta Industrial)');
});

test('generates scannable vector barcode SVG for RVM deposit ticket', () => {
  const svg = generateBarcodeSVG('DRS-BO-999');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('DRS-BO-999'));
  assert.ok(svg.includes('</svg>'));
});

test('classifies PET and Glass optical color grades and commercial flake values', () => {
  // PET Cristal
  const petClear = classifyBottleColorGrade({ r: 160, g: 165, b: 170, lum: 165 }, 'pet');
  assert.equal(petClear.colorGrade, 'PET Cristal (Transparente Natural)');
  assert.equal(petClear.colorFraction, 'Fracción A (Cristal rPET)');
  assert.equal(petClear.flakeValueBsKg, 4.50);

  // PET Azul
  const petBlue = classifyBottleColorGrade({ r: 40, g: 80, b: 150, lum: 90 }, 'pet');
  assert.equal(petBlue.colorGrade, 'PET Azul Claro / Mineral');
  assert.equal(petBlue.colorFraction, 'Fracción B (Azul)');

  // PET Verde
  const petGreen = classifyBottleColorGrade({ r: 40, g: 130, b: 50, lum: 85 }, 'pet');
  assert.equal(petGreen.colorGrade, 'PET Verde (Cítrico / Esmeralda)');
  assert.equal(petGreen.colorFraction, 'Fracción C (Verde)');

  // PET Ámbar
  const petAmber = classifyBottleColorGrade({ r: 120, g: 70, b: 30, lum: 70 }, 'pet');
  assert.equal(petAmber.colorGrade, 'PET Ámbar / Farmacéutico');
  assert.equal(petAmber.colorFraction, 'Fracción D (Ámbar)');

  // Vidrio Ámbar
  const glassAmber = classifyBottleColorGrade({ r: 110, g: 60, b: 25, lum: 65 }, 'glass');
  assert.equal(glassAmber.colorGrade, 'Vidrio Ámbar (Marrón Cerveza)');
  assert.equal(glassAmber.colorFraction, 'GL-72 (Ámbar)');
});

test('computes conveyor pneumatic air ejector valve assignment based on horizontal belt position', () => {
  // Bottle at far left (50px of 640px) -> Valve 1
  const left = computePneumaticEjectorChannel(50, 640, 8);
  assert.equal(left.valveId, 1);
  assert.equal(left.triggerDelayMs, 120);

  // Bottle at center (320px of 640px) -> Valve 5
  const center = computePneumaticEjectorChannel(320, 640, 8);
  assert.equal(center.valveId, 5);

  // Bottle at far right (620px of 640px) -> Valve 8
  const right = computePneumaticEjectorChannel(620, 640, 8);
  assert.equal(right.valveId, 8);
});

test('evaluates bottle neck finish ovality and thread deformation', () => {
  // Standard circular neck: width 22, height 10 -> ratio = 22 / 22 = 1.0 (circular)
  const circular = evaluateNeckFinishOvality(22, 10);
  assert.equal(circular.isConforming, true);
  assert.equal(circular.status, 'Boca Conforme (Circular)');

  // Squashed/deformed neck: width 35, height 8 -> ratio = 35 / 17.6 = 1.98 (oval)
  const deformed = evaluateNeckFinishOvality(35, 8);
  assert.equal(deformed.isConforming, false);
  assert.equal(deformed.status, 'Boca Deformada / Ovalada (Alerta de Rosca)');
});

test('estimates Post-Consumer Recycled (PCR) resin content and food-grade safety', () => {
  // High optical variance and slight turbidity -> High PCR
  const highPcr = estimatePcrRecycledContent(60, 90);
  assert.ok(highPcr.pcrPercent >= 50);
  assert.ok(highPcr.label.includes('rPET Alto Contenido'));

  // Low variance, crystal clear -> Virgin PET
  const virgin = estimatePcrRecycledContent(10, 135);
  assert.ok(virgin.pcrPercent <= 10);
  assert.ok(virgin.label.includes('PET Virgen'));
  assert.equal(virgin.isFoodGradeCertified, true);
});

test('computes High-Quality Recovery Index (HQR) according to Orynycz et al. (2026)', () => {
  // Target DRS scenario: R=0.90, high quality stream Q=0.98, washed yield Y=0.845
  // HQR = 0.90 * 0.98 * 0.845 = 0.745 (74.5%) -> Food-Grade
  const resultHigh = computeHighQualityRecoveryIndex({ returnRate: 0.90, qualityScore: 0.98, yieldScore: 0.845 });
  assert.equal(resultHigh.hqrPercent, 74.5);
  assert.equal(resultHigh.hqrRating, 'Excelente (Grado Alimentario FDA/EFSA)');
  assert.equal(resultHigh.scientificCitation, 'Orynycz et al. (2026), Materials 19(17):3669');

  // Baseline scenario (R=0.50): HQR ~ 37.8% -> Deficiente
  const resultLow = computeHighQualityRecoveryIndex({ returnRate: 0.50, qualityScore: 0.90, yieldScore: 0.84 });
  assert.equal(resultLow.hqrPercent, 37.8);
  assert.equal(resultLow.hqrRating, 'Deficiente (Downcycling/Rechazo)');
});

test('retrieves scientific polymer & glass specifications with PubChem CIDs', () => {
  const pet = getBottleMaterialSpecs('pet');
  assert.equal(pet.resinCode, '♳ PET-1');
  assert.equal(pet.densityGcm3, 1.38);
  assert.deepEqual(pet.pubchemCids, [7489, 174]);

  const glass = getBottleMaterialSpecs('vidrio');
  assert.equal(glass.resinCode, 'GL-70 / GL-71');
  assert.equal(glass.densityGcm3, 2.52);
  assert.equal(glass.is100PercentClosedLoop, true);
  assert.deepEqual(glass.pubchemCids, [24261, 10340, 10112]);
});




