// Deterministic visual comparison of the Figma design render vs the browser
// render. The two pages have different total heights (flow layout vs fixed
// artboard), so a naive same-row comparison drifts; instead each horizontal
// band of the design is locally aligned to the render via grayscale row
// profiles, then compared pixel-by-pixel with a small neighborhood tolerance
// (absorbs 1px shifts and font antialiasing noise).
import { decodePng, cropPng, encodePng } from './png.mjs';

function rowProfile(img, step = 6) {
  const prof = new Float64Array(img.height);
  const { width, channels, pixels } = img;
  for (let y = 0; y < img.height; y++) {
    let sum = 0, n = 0;
    const row = y * width * channels;
    for (let x = 0; x < width; x += step) {
      const p = row + x * channels;
      sum += pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114;
      n++;
    }
    prof[y] = sum / n;
  }
  return prof;
}

function bandMismatch(A, B, ay0, by0, h, tol) {
  const w = A.width;
  const ca = A.channels, cb = B.channels;
  let bad = 0, total = 0;
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let dy = 0; dy < h; dy++) {
    const ay = ay0 + dy;
    const arow = ay * w * ca;
    for (let x = 1; x < w - 1; x += 1) {
      const ap = arow + x * ca;
      const ar = A.pixels[ap], ag = A.pixels[ap + 1], ab = A.pixels[ap + 2];
      let matched = false;
      for (const [dx, dyy] of offsets) {
        const by = by0 + dy + dyy;
        if (by < 0 || by >= B.height) continue;
        const bp = (by * w + x + dx) * cb;
        if (
          Math.abs(ar - B.pixels[bp]) <= tol &&
          Math.abs(ag - B.pixels[bp + 1]) <= tol &&
          Math.abs(ab - B.pixels[bp + 2]) <= tol
        ) { matched = true; break; }
      }
      if (!matched) bad++;
      total++;
    }
  }
  return total ? bad / total : 0;
}

// Returns { score (0-100, % of design that matches), bands, regions } or null
// when either PNG is unsupported / widths differ.
export function diffPages(designBuf, renderBuf, {
  bandH = 48, search = 280, tol = 46, regionThreshold = 0.10, maxRegions = 4,
} = {}) {
  const A = decodePng(designBuf);
  const B = decodePng(renderBuf);
  if (!A || !B || A.width !== B.width) return null;
  const profA = rowProfile(A);
  const profB = rowProfile(B);

  const bands = [];
  let offset = 0;
  const heightDelta = B.height - A.height;
  const maxAbsOff = Math.abs(heightDelta) + search + 100;
  for (let y0 = 0; y0 + 8 <= A.height; y0 += bandH) {
    const h = Math.min(bandH, A.height - y0);
    // search around BOTH the previous band's offset (local continuity) and the
    // proportional baseline (global anchor) — pages full of repeating blocks
    // can trap a purely-sequential tracker on a wrong lock it never escapes
    const propOff = Math.round((y0 * heightDelta) / Math.max(1, A.height));
    let bestOff = offset, bestCost = Infinity;
    for (const center of [offset, propOff]) {
      for (let off = center - search; off <= center + search; off += 2) {
        if (Math.abs(off) > maxAbsOff) continue;
        const by0 = y0 + off;
        if (by0 < 0 || by0 + h > B.height) continue;
        let cost = 0;
        for (let r = 0; r < h; r += 4) cost += Math.abs(profA[y0 + r] - profB[by0 + r]);
        if (cost < bestCost) { bestCost = cost; bestOff = off; }
      }
    }
    offset = bestOff;
    const mismatch = bandMismatch(A, B, y0, y0 + bestOff, h, tol);
    bands.push({ y0, h, off: bestOff, mismatch: Math.round(mismatch * 1000) / 1000 });
  }

  const score = bands.length
    ? Math.round((1 - bands.reduce((s, b) => s + b.mismatch * b.h, 0) / bands.reduce((s, b) => s + b.h, 0)) * 1000) / 10
    : 0;

  // merge consecutive bad bands into regions, rank by badness x size
  const regions = [];
  let cur = null;
  for (const b of bands) {
    if (b.mismatch > regionThreshold) {
      if (cur) { cur.designY1 = b.y0 + b.h; cur.worst = Math.max(cur.worst, b.mismatch); cur.offs.push(b.off); }
      else cur = { designY0: b.y0, designY1: b.y0 + b.h, worst: b.mismatch, offs: [b.off] };
    } else if (cur) { regions.push(cur); cur = null; }
  }
  if (cur) regions.push(cur);
  for (const r of regions) {
    r.renderY0 = r.designY0 + Math.min(...r.offs);
    r.renderY1 = r.designY1 + Math.max(...r.offs);
    r.mismatchPct = Math.round(r.worst * 100);
    delete r.offs; delete r.worst;
  }
  regions.sort((a, b) => (b.mismatchPct * (b.designY1 - b.designY0)) - (a.mismatchPct * (a.designY1 - a.designY0)));
  return { score, bands, regions: regions.slice(0, maxRegions) };
}

// Produce paired zoomed crops (design + render) for each diff region.
export function diffRegionCrops(designBuf, renderBuf, regions, pad = 60) {
  const A = decodePng(designBuf);
  const B = decodePng(renderBuf);
  if (!A || !B) return [];
  const crops = [];
  for (const r of regions) {
    const dTop = Math.max(0, r.designY0 - pad);
    const dH = Math.min(A.height - dTop, r.designY1 - r.designY0 + pad * 2);
    const rTop = Math.max(0, r.renderY0 - pad);
    const rH = Math.min(B.height - rTop, r.renderY1 - r.renderY0 + pad * 2);
    const d = cropPng(A, dTop, dH);
    const g = cropPng(B, rTop, rH);
    if (d && g) {
      crops.push({
        label: `design y ${r.designY0}-${r.designY1} (${r.mismatchPct}% mismatch)`,
        design: encodePng(d),
        render: encodePng(g),
      });
    }
  }
  return crops;
}
