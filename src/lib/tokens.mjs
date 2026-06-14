// Parse design tokens (CSS custom properties) out of eds-native.css :root blocks,
// and build a reverse color->token map so generated CSS prefers var(--gs-*) over raw hex.
import fs from 'node:fs';

export function parseDesignTokens(cssPath) {
  const css = fs.readFileSync(cssPath, 'utf8');
  const tokens = {};
  const rootRe = /:root\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = rootRe.exec(css)) !== null) {
    const body = m[1];
    const declRe = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(body)) !== null) {
      tokens['--' + d[1]] = d[2].trim();
    }
  }
  return tokens;
}

export function normalizeHex(value) {
  const v = String(value).trim().toUpperCase();
  const m = v.match(/^#([0-9A-F]{3}|[0-9A-F]{6})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return '#' + hex;
}

// hex -> first token name that holds that color
export function buildColorTokenMap(tokens) {
  const map = {};
  for (const [name, value] of Object.entries(tokens)) {
    const hex = normalizeHex(value);
    if (hex && !(hex in map)) map[hex] = name;
  }
  return map;
}

// Compact, prompt-friendly summary of the token system
export function tokensPromptBlock(tokens) {
  const lines = [];
  for (const [name, value] of Object.entries(tokens)) {
    lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}
