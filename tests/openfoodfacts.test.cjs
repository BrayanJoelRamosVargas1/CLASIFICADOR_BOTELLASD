const { test } = require('node:test');
const assert = require('node:assert/strict');

test('fetches real official bottle metadata from Open Food Facts API', async () => {
  const barcode = '5449000000996'; // Coca-Cola
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,packaging,packaging_tags`, {
    headers: { 'User-Agent': 'EcoLensAI-BottleClassifier - v25.0' }
  });
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.status, 1);
  assert.ok(data.product);
  assert.match(data.product.product_name, /coca-cola/i);
});
