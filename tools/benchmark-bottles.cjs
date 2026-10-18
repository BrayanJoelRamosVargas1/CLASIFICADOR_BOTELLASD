// Run: node tools/benchmark-bottles.cjs [output.json]
// Requires Playwright (or NODE_PATH pointing to the bundled runtime packages).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dataset/evaluation/manifest.json')));

(async () => {
  const server = http.createServer((req, res) => {
    const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(filename, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      const ext = path.extname(filename).toLowerCase();
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' })[ext] || 'application/octet-stream');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.exposeFunction('reportProgress', message => console.log(message));
    page.setDefaultTimeout(180000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + '/tools/benchmark.html');
    await page.waitForFunction(() => window.tf && window.cocoSsd && window.BottleDetection);
    const results = await page.evaluate(async ({ images, backend, models }) => {
      await tf.setBackend(backend);
      await tf.ready();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const runs = [];
      for (const base of models) {
        await window.reportProgress('Loading ' + base);
        const model = base === 'yolov10n' ? await YoloBottleDetector.load('/models/yolov10n/model.onnx') : await cocoSsd.load({ base });
        const rows = [];
        for (const { file } of images) {
          const img = new Image();
          img.src = '/dataset/evaluation/' + file;
          await img.decode();
          const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const started = performance.now();
          const predictions = await model.detect(canvas, BottleDetection.config.maxBoxes, BottleDetection.config.minScore);
          const elapsedMs = Math.round(performance.now() - started);
          const boxes = BottleDetection.select(predictions, canvas.width, canvas.height);
          rows.push({ file, elapsedMs, bottles: boxes.length, boxes,
            rawBottles: predictions.filter(p => p.class === 'bottle') });
          await window.reportProgress(`${base}: ${file}, ${boxes.length} bottles, ${elapsedMs} ms`);
        }
        await model.dispose();
        runs.push({ base, backend: base === 'yolov10n' ? 'wasm' : tf.getBackend(),
          imagesWithDetections: rows.filter(r => r.bottles > 0).length, rows });
      }
      return { backend: tf.getBackend(), userAgent: navigator.userAgent, config: BottleDetection.config, runs };
    }, { ...manifest, backend: process.env.BENCHMARK_BACKEND || 'cpu',
      models: (process.env.BENCHMARK_MODELS || 'lite_mobilenet_v2,mobilenet_v2,yolov10n').split(',') });
    results.datasetRevision = manifest.revision;
    results.note = 'Image detection coverage only; no ground-truth boxes or negatives, so this is not precision, recall or mAP. Headless desktop timings are not mobile camera timings.';
    const output = process.argv[2] || path.join(root, 'dataset/evaluation/results.json');
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    for (const run of results.runs) console.log(run.base, `${run.imagesWithDetections}/${manifest.images.length} images with bottle detections`);
    if (process.env.SMOKE_APP === '1') {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/index.html');
      await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Detector listo'));
      await page.locator('#uploadPhotoInput').setInputFiles(path.join(root, 'dataset/evaluation/16.jpeg'));
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('ecolens_inventory_v4') || '[]').length === 1);
      await page.locator('#btnManualScan').click();
      await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Enfoca'));
      const count = await page.evaluate(() => JSON.parse(localStorage.getItem('ecolens_inventory_v4')).length);
      if (count !== 1 || errors.length) throw new Error(JSON.stringify({ count, errors }));
      console.log('APP SMOKE OK: real page loads YOLO, photo registers once, manual scan does not duplicate, no uncaught errors.');
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
