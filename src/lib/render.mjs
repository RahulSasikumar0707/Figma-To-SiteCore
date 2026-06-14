// Render the generated page with headless Chrome and capture a full-page
// screenshot — the rendered result is what the reviewer compares against the
// Figma design (code-only review cannot see CSS interactions with eds-native).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { log } from './util.mjs';
import { Cdp } from './cdp.mjs';
import { probeExpression, compareLayout } from './assert-layout.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.json': 'application/json',
};

export function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.normalize(path.join(dir, urlPath === '/' ? 'index.html' : urlPath));
        if (!file.startsWith(path.normalize(dir))) { res.writeHead(403).end(); return; }
        const body = await fsp.readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Preferred capture path: one CDP session per capture — waits for
// document.fonts.ready, screenshots at exact content height (no padding),
// and runs the layout-assertion probe. Falls back to the --screenshot CLI
// (no layout data) when CDP fails for any reason.
export async function captureAndMeasure(outDir, { width = 1366, expectations = null } = {}) {
  const chrome = findChrome();
  if (!chrome) {
    log.warn('Chrome not found — skipping rendered-page capture (set CHROME_PATH to enable)');
    return { screenshot: null, layoutFailures: null };
  }
  const server = await serveDir(outDir);
  const port = server.address().port;
  let cdp = null;
  try {
    cdp = await Cdp.launch(chrome, { width });
    await cdp.navigate(`http://127.0.0.1:${port}/index.html`);
    const screenshot = await cdp.screenshotFullPage();
    let layoutFailures = null;
    if (expectations && expectations.length) {
      try {
        const measured = await cdp.eval(probeExpression(expectations));
        layoutFailures = compareLayout(expectations, measured);
      } catch (err) {
        log.warn('layout probe failed: ' + err.message);
      }
    }
    return { screenshot, layoutFailures };
  } catch (err) {
    log.warn(`CDP capture failed (${err.message}) — falling back to CLI screenshot`);
    server.close();
    const screenshot = await renderPage(outDir, { width });
    return { screenshot, layoutFailures: null };
  } finally {
    if (cdp) await cdp.close();
    try { server.close(); } catch { /* already closed */ }
  }
}

// Returns the PNG buffer of the rendered page, or null when Chrome is missing
// or the capture fails (the pipeline then degrades to code-only review).
export async function renderPage(outDir, { width = 1366, height = 5400, timeoutMs = 60000 } = {}) {
  const chrome = findChrome();
  if (!chrome) {
    log.warn('Chrome not found — skipping rendered-page capture (set CHROME_PATH to enable)');
    return null;
  }
  const server = await serveDir(outDir);
  const port = server.address().port;
  const shotPath = path.join(os.tmpdir(), `figma-eds-render-${Date.now()}.png`);
  const profileDir = path.join(os.tmpdir(), `figma-eds-chrome-${Date.now()}`);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--disable-extensions', `--user-data-dir=${profileDir}`,
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=15000', `--screenshot=${shotPath}`,
    `http://127.0.0.1:${port}/index.html`,
  ];
  try {
    await new Promise((resolve, reject) => {
      execFile(chrome, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
    });
    return await fsp.readFile(shotPath);
  } catch (err) {
    log.warn('rendered-page capture failed: ' + err.message);
    return null;
  } finally {
    server.close();
    fsp.rm(shotPath, { force: true }).catch(() => {});
    fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
