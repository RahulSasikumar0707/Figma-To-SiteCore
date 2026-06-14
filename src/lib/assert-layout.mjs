// Layout assertions: turn the design spec into measurable expectations
// (image sizes/positions, text font-size/weight/color), measure the rendered
// page via a CDP-evaluated probe, and report precise numeric failures the
// fixer can act on mechanically — "unit tests" for the layout.
import { normalizeHex } from './tokens.mjs';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Walk the spec accumulating absolute positions; collect expectations.
export function buildExpectations(spec, tokens, { maxTexts = 60 } = {}) {
  const exps = [];
  const seenTexts = new Set();
  (function walk(node, absX, absY) {
    const x = absX + (node.box?.x ?? 0);
    const y = absY + (node.box?.y ?? 0);
    const assetFile = node.asset || node.bgAsset;
    if (assetFile && node.box) {
      exps.push({
        key: `img:${exps.length}`, kind: 'image',
        file: assetFile.split('/').pop(),
        x: Math.round(x), w: Math.round(node.box.w), h: Math.round(node.box.h),
        name: node.name,
      });
    }
    if (node.text && node.font && exps.filter((e) => e.kind === 'text').length < maxTexts) {
      const text = norm(node.text).slice(0, 60);
      if (text.length >= 8 && !seenTexts.has(text)) {
        seenTexts.add(text);
        let color = node.font.color || null;
        if (color && color.startsWith('var(')) {
          color = tokens[color.slice(4, -1)] || null;
        }
        exps.push({
          key: `txt:${exps.length}`, kind: 'text', text,
          size: node.font.size, weight: node.font.weight,
          color: color && normalizeHex(color) ? normalizeHex(color) : color,
        });
      }
    }
    for (const c of node.children || []) walk(c, x, y);
  })(spec, -(spec.box?.x ?? 0), -(spec.box?.y ?? 0));
  return exps;
}

// JS evaluated inside the page; returns one measurement per expectation.
export function probeExpression(expectations) {
  return `(function (EXP) {
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const allEls = [...document.querySelectorAll('body *')];
  for (const e of EXP) {
    if (e.kind === 'image') {
      let el = [...document.images].find((i) => (i.getAttribute('src') || '').split('/').pop() === e.file);
      if (!el) el = allEls.find((n) => (getComputedStyle(n).backgroundImage || '').includes(e.file));
      if (!el) { out.push({ key: e.key, found: false }); continue; }
      const r = el.getBoundingClientRect();
      out.push({ key: e.key, found: true, x: Math.round(r.x + window.scrollX), w: Math.round(r.width), h: Math.round(r.height) });
    } else {
      let best = null;
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        if (norm(tw.currentNode.nodeValue).includes(e.text)) { best = tw.currentNode.parentElement; break; }
      }
      if (!best && norm(document.body.innerText).includes(e.text)) {
        let el = document.body, moved = true;
        while (moved) {
          moved = false;
          for (const c of el.children) {
            if (norm(c.innerText).includes(e.text)) { el = c; moved = true; break; }
          }
        }
        best = el;
      }
      if (!best) { out.push({ key: e.key, found: false }); continue; }
      const cs = getComputedStyle(best);
      out.push({ key: e.key, found: true, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color });
    }
  }
  return out;
})(${JSON.stringify(expectations)})`;
}

function parseColor(c) {
  if (!c) return null;
  const hex = normalizeHex(c);
  if (hex) return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// Compare expectations with probe measurements -> failures list.
export function compareLayout(expectations, measured) {
  const byKey = new Map(measured.map((m) => [m.key, m]));
  const failures = [];
  for (const e of expectations) {
    const m = byKey.get(e.key);
    if (!m) continue;
    if (e.kind === 'image') {
      if (!m.found) {
        failures.push({ severity: 'critical', type: 'missing-image', file: e.file, expected: `${e.w}x${e.h} ("${e.name}")`, fix: `Add <img src="...${e.file}"> (or background-image) sized ${e.w}x${e.h}px` });
        continue;
      }
      const wOff = Math.abs(m.w - e.w), hOff = Math.abs(m.h - e.h);
      if (wOff > Math.max(8, e.w * 0.06) || hOff > Math.max(8, e.h * 0.06)) {
        failures.push({ severity: 'major', type: 'image-size', file: e.file, expected: `${e.w}x${e.h}px`, actual: `${m.w}x${m.h}px`, fix: `Resize to ${e.w}x${e.h}px (design value)` });
      }
      if (Math.abs(m.x - e.x) > 28) {
        failures.push({ severity: 'minor', type: 'image-x-position', file: e.file, expected: `x=${e.x}px @1366 artboard`, actual: `x=${m.x}px`, fix: `Shift horizontally to x≈${e.x}px (check column/alignment classes)` });
      }
    } else {
      if (!m.found) {
        failures.push({ severity: 'critical', type: 'missing-text', text: e.text, fix: 'Add this text content exactly as written' });
        continue;
      }
      // non-integer Figma font sizes come from scaled component instances —
      // the reported size is pre-scale and would assert the wrong value
      const sizeReliable = e.size && e.size >= 8 && Math.abs(e.size - Math.round(e.size)) < 0.05;
      if (sizeReliable && Math.abs(m.fontSize - e.size) > 1.5) {
        failures.push({ severity: 'major', type: 'font-size', text: e.text.slice(0, 40), expected: `${e.size}px`, actual: `${m.fontSize}px`, fix: `Set font-size to ${e.size}px (use the matching token/heading class)` });
      }
      if (e.weight && Math.abs(parseInt(m.fontWeight, 10) - e.weight) >= 100) {
        failures.push({ severity: 'minor', type: 'font-weight', text: e.text.slice(0, 40), expected: String(e.weight), actual: String(m.fontWeight), fix: `Set font-weight to ${e.weight}` });
      }
      const expC = parseColor(e.color), actC = parseColor(m.color);
      if (expC && actC) {
        const d = Math.abs(expC[0] - actC[0]) + Math.abs(expC[1] - actC[1]) + Math.abs(expC[2] - actC[2]);
        if (d > 60) {
          failures.push({ severity: 'major', type: 'text-color', text: e.text.slice(0, 40), expected: e.color, actual: m.color, fix: `Set color to ${e.color} (or its token)` });
        }
      }
    }
  }
  return failures;
}
