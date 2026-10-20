// scripts/test-browser-cdp.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'edge-cdp-smoke-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(edgePath, [
  '--headless=new',
  '--remote-debugging-port=9224',
  `--user-data-dir=${tempDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'http://localhost:8080/index.html'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let nextId = 1;
function sendCdp(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function run() {
  await sleep(2500);

  const res = await fetch('http://localhost:9224/json');
  const pages = await res.json();
  const targetPage = pages.find(p => p.type === 'page' && p.url.includes('8080'));
  if (!targetPage) {
    console.error('[CDP] Page not found');
    cleanup();
    process.exit(1);
  }

  const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  await sendCdp(ws, 'Page.enable');
  await sendCdp(ws, 'Runtime.enable');

  await sleep(4000);

  // Test sensitivity buttons in DOM
  const sensTest = await sendCdp(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const highBtn = document.getElementById('sensHigh');
      const medBtn = document.getElementById('sensMedium');
      const strictBtn = document.getElementById('sensStrict');
      if (!highBtn || !medBtn || !strictBtn) return { success: false, reason: 'Buttons missing' };
      
      highBtn.click();
      const highActive = highBtn.classList.contains('active');
      const statusAfterHigh = document.getElementById('statusText')?.textContent;
      
      medBtn.click();
      const medActive = medBtn.classList.contains('active');
      
      return {
        success: true,
        highActive,
        medActive,
        statusAfterHigh
      };
    })()`,
    returnByValue: true
  });
  console.log('[CDP] Sensitivity UI test:', sensTest.result.value);

  // Test detection of 15.jpeg (the low-confidence bottle from benchmark)
  const imgBuffer = readFileSync('dataset/evaluation/15.jpeg');
  const imgBase64 = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');

  const detectTest = await sendCdp(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const detector = await window.YoloBottleDetector.load('./models/yolov10n/model.onnx?v=43.0');
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = '${imgBase64}'; });
      const results = await detector.detect(img, 30, 0.08);
      return {
        count: results.length,
        bestScore: results[0] ? results[0].score : null,
        bestClass: results[0] ? results[0].class : null
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('[CDP] 15.jpeg detection in browser:', detectTest.result.value);

  ws.close();
  cleanup();
}

function cleanup() {
  try { proc.kill(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

run().catch(err => {
  console.error('[CDP Error]', err);
  cleanup();
  process.exit(1);
});
