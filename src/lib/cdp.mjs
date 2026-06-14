// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Gives the pipeline deterministic control the --screenshot CLI cannot:
// wait for document.fonts.ready, measure exact content height, capture a
// full-page screenshot without white padding, and run layout-probe JS.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sleep, log } from './util.mjs';

export class Cdp {
  constructor(proc, ws, profileDir) {
    this.proc = proc;
    this.ws = ws;
    this.profileDir = profileDir;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async launch(chromePath, { width = 1366, height = 1000 } = {}) {
    const profileDir = path.join(os.tmpdir(), `figma-eds-cdp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const proc = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--no-first-run', '--disable-extensions', '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`, `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    // Chrome writes the chosen ephemeral port to DevToolsActivePort in the profile dir
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 100; i++) {
      try {
        port = parseInt((await fsp.readFile(portFile, 'utf8')).split('\n')[0], 10);
        if (port) break;
      } catch { /* not written yet */ }
      await sleep(150);
    }
    if (!port) { proc.kill(); throw new Error('Chrome did not expose a DevTools port'); }

    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page');
      } catch { await sleep(200); }
    }
    if (!target) { proc.kill(); throw new Error('No CDP page target found'); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    const cdp = new Cdp(proc, ws, profileDir);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    return cdp;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 60000);
    });
  }

  // Evaluate JS in the page; awaits promises; returns the JSON value.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    }
    return r.result?.value;
  }

  async navigate(url, { settleMs = 500 } = {}) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      const state = await this.eval('document.readyState').catch(() => 'loading');
      if (state === 'complete') break;
      await sleep(250);
    }
    // fonts + images settle: screenshots taken mid font-swap are the most
    // common source of phantom pixel diffs
    await this.eval(`(async () => { await document.fonts.ready; await new Promise(r => setTimeout(r, ${settleMs})); return true; })()`);
  }

  async screenshotFullPage({ maxHeight = 14000 } = {}) {
    const h = Math.min(maxHeight, await this.eval('document.body.scrollHeight'));
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: Math.max(600, h), deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return Buffer.from(data, 'base64');
  }

  async close() {
    try { this.ws.close(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already dead */ }
    await sleep(300);
    fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
