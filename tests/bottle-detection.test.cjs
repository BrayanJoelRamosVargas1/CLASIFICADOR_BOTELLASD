const { test } = require('node:test');
const assert = require('node:assert/strict');
const { select } = require('../js/bottle-detection.js');
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
