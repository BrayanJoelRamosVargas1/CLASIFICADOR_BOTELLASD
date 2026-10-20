// scripts/test-satellite-cdp.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'edge-cdp-sat-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testPage(url) {
  console.log(`\n=== Testing ${url} ===`);
  const proc = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=9223',
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url
  ]);

  try {
    await sleep(2500);
    const res = await fetch('http://localhost:9223/json');
    const pages = await res.json();
    const page = pages.find(p => p.type === 'page' && p.url.includes(url.split(':8080')[1]));
    if (!page) {
      console.error('Page not found in:', pages);
      return;
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const errors = [];
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          errors.push('[CONSOLE ERROR] ' + JSON.stringify(msg.params.args));
        } else if (msg.method === 'Runtime.exceptionThrown') {
          errors.push('[EXCEPTION] ' + JSON.stringify(msg.params.exceptionDetails));
        } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
          errors.push(`[NETWORK ${msg.params.response.status}] ` + msg.params.response.url);
        }
      } catch {}
    };

    let id = 1;
    const send = (method, params = {}) => new Promise((resolve) => {
      const curId = id++;
      const handler = (event) => {
        const m = JSON.parse(event.data);
        if (m.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(m.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    await sleep(3000);

    const titleEval = await send('Runtime.evaluate', {
      expression: 'document.title'
    });
    console.log('Page Title:', titleEval.result.value);

    if (errors.length > 0) {
      console.error('Errors found in page:');
      for (const e of errors) console.error(e);
    } else {
      console.log('Zero errors found! Clean load.');
    }

    ws.close();
  } finally {
    proc.kill();
    await sleep(500);
  }
}

async function run() {
  await testPage('http://localhost:8080/manaco/index.html');
  await testPage('http://localhost:8080/cuaderno/index.html');
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

run().catch(console.error);
