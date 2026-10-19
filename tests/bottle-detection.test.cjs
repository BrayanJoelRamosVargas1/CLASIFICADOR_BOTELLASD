const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  select,
  computeDailyCut,
  classifyResinAndBin,
  computeCompactionStatus,
  generateDRSTicket
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

