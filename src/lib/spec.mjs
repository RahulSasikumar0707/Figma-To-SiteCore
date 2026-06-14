// Convert the raw Figma node tree into a compact, lossless-enough "design spec"
// for LLM consumption: relative boxes, resolved colors (+ design-token names),
// auto-layout, typography, exact text, effects. Exported asset subtrees collapse
// to { asset: "<file>" } references.
import { round1 } from './util.mjs';
import { normalizeHex } from './tokens.mjs';

function colorToCss(color, opacity = 1) {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  // alpha needs 2 decimals — round1 would turn 0.04 into 0 (invisible)
  const a = Math.round((color.a !== undefined ? color.a : 1) * opacity * 100) / 100;
  if (a >= 1) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function paintToSpec(paint, colorTokenMap) {
  if (!paint || paint.visible === false) return null;
  if (paint.type === 'SOLID') {
    const css = colorToCss(paint.color, paint.opacity ?? 1);
    const token = colorTokenMap[normalizeHex(css) || ''] || null;
    return token ? { color: css, token } : { color: css };
  }
  if (paint.type && paint.type.startsWith('GRADIENT')) {
    return {
      gradient: paint.type.replace('GRADIENT_', '').toLowerCase(),
      stops: (paint.gradientStops || []).map((s) => ({
        color: colorToCss(s.color), at: round1(s.position),
      })),
      handles: (paint.gradientHandlePositions || []).map((p) => ({ x: round1(p.x), y: round1(p.y) })),
    };
  }
  if (paint.type === 'IMAGE') return { image: true, scaleMode: paint.scaleMode };
  return null;
}

export function buildDesignSpec(root, { collapsed = new Set(), assetByNodeId = new Map(), colorTokenMap = {} } = {}) {
  function visit(node, parentBox) {
    if (!node || node.visible === false) return null;
    const b = node.absoluteBoundingBox;
    const out = { id: node.id, name: node.name, type: node.type };

    if (b) {
      out.box = {
        x: round1(b.x - (parentBox ? parentBox.x : b.x)),
        y: round1(b.y - (parentBox ? parentBox.y : b.y)),
        w: round1(b.width),
        h: round1(b.height),
      };
    }

    const asset = assetByNodeId.get(node.id);
    if (collapsed.has(node.id)) {
      if (asset && asset.file) out.asset = asset.file;
      // still record fills color context for image overlays
      if (node.cornerRadius) out.radius = node.cornerRadius;
      return out;
    }
    // container with an exported background image (not collapsed -> children continue below)
    if (asset && asset.file) out.bgAsset = asset.file;

    // positioning context the box numbers alone cannot express
    if (node.layoutPositioning === 'ABSOLUTE') out.abs = true;
    const c = node.constraints;
    if (c && (c.horizontal !== 'LEFT' || c.vertical !== 'TOP')) out.constraints = `${c.horizontal}/${c.vertical}`;
    const sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
    if (sizing.some((s) => s && s !== 'FIXED')) out.sizing = sizing.map((s) => s || 'FIXED').join('/');
    if (Math.abs(node.rotation || 0) > 0.01) out.rotation = round1(node.rotation * 180 / Math.PI);

    // auto layout
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      out.layout = {
        dir: node.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
        gap: node.itemSpacing ?? 0,
        pad: [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0],
        align: [node.primaryAxisAlignItems || 'MIN', node.counterAxisAlignItems || 'MIN'].join('/'),
      };
      if (node.layoutWrap === 'WRAP') out.layout.wrap = true;
    }

    // fills / strokes / radius / effects
    const fills = (node.fills || []).map((p) => paintToSpec(p, colorTokenMap)).filter(Boolean);
    if (fills.length && node.type !== 'TEXT') out.bg = fills.length === 1 ? fills[0] : fills;
    const strokes = (node.strokes || []).map((p) => paintToSpec(p, colorTokenMap)).filter(Boolean);
    if (strokes.length) {
      out.border = { ...strokes[0], width: node.strokeWeight ?? 1 };
      if (node.strokeDashes && node.strokeDashes.length) out.border.dashed = true;
    }
    if (node.cornerRadius) out.radius = node.cornerRadius;
    if (node.rectangleCornerRadii && node.rectangleCornerRadii.some((r) => r)) {
      out.radius = node.rectangleCornerRadii;
    }
    const shadows = (node.effects || []).filter((e) => e.visible !== false && /SHADOW/.test(e.type));
    if (shadows.length) {
      out.shadow = shadows.map((e) =>
        `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${Math.round(e.offset?.x || 0)}px ${Math.round(e.offset?.y || 0)}px ${Math.round(e.radius || 0)}px ${Math.round(e.spread || 0)}px ${colorToCss(e.color || { r: 0, g: 0, b: 0, a: 0.25 })}`
      ).join(', ');
    }
    if (node.opacity !== undefined && node.opacity < 1) out.opacity = round1(node.opacity);

    // typography
    if (node.type === 'TEXT') {
      out.text = node.characters || '';
      const s = node.style || {};
      out.font = {
        family: s.fontFamily,
        size: s.fontSize,
        weight: s.fontWeight,
        lh: s.lineHeightPx ? round1(s.lineHeightPx) : undefined,
        ls: s.letterSpacing ? round1(s.letterSpacing) : undefined,
        align: s.textAlignHorizontal !== 'LEFT' ? s.textAlignHorizontal : undefined,
        case: s.textCase && s.textCase !== 'ORIGINAL' ? s.textCase : undefined,
      };
      const fill = fills[0];
      if (fill) out.font.color = fill.token ? `var(${fill.token})` : fill.color;
      Object.keys(out.font).forEach((k) => out.font[k] === undefined && delete out.font[k]);

      // mixed-style text: split characters into runs so bold/colored/superscript
      // spans inside one TEXT node survive compaction
      const overrides = node.characterStyleOverrides || [];
      const table = node.styleOverrideTable || {};
      if (overrides.length && Object.keys(table).length) {
        const runs = [];
        let runStart = 0;
        const chars = out.text;
        const idAt = (i) => overrides[i] || 0;
        for (let i = 1; i <= chars.length; i++) {
          if (i === chars.length || idAt(i) !== idAt(runStart)) {
            const styleId = idAt(runStart);
            const run = { text: chars.slice(runStart, i) };
            const ov = table[styleId];
            if (ov) {
              if (ov.fontWeight && ov.fontWeight !== s.fontWeight) run.weight = ov.fontWeight;
              if (ov.fontSize && ov.fontSize !== s.fontSize) run.size = ov.fontSize;
              if (ov.italic) run.italic = true;
              if (ov.textDecoration && ov.textDecoration !== 'NONE') run.deco = ov.textDecoration;
              if (ov.hyperlink?.url) run.href = ov.hyperlink.url;
              const ovFill = (ov.fills || []).map((p) => paintToSpec(p, colorTokenMap)).filter(Boolean)[0];
              if (ovFill) run.color = ovFill.token ? `var(${ovFill.token})` : ovFill.color;
            }
            runs.push(run);
            runStart = i;
          }
        }
        if (runs.length > 1) out.runs = runs;
      }
    }

    const children = (node.children || [])
      .map((c) => visit(c, b || parentBox))
      .filter(Boolean);
    if (children.length) out.children = children;
    return out;
  }

  return visit(root, null);
}

// Top-level "sections" of the page = container-ish direct children of the target
// frame, top-to-bottom. Decorative strays (divider lines, floating shapes) are
// folded into the section they overlap; a full-bleed background rect becomes the
// page background instead of a bogus section.
const CONTAINERISH = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'GROUP']);

export function splitSections(spec) {
  const kids = (spec.children || []).filter((c) => c.box);
  const rootW = spec.box?.w || 0;
  const rootH = spec.box?.h || 0;
  const isSection = (c) => CONTAINERISH.has(c.type) && c.box.h >= 40 && (!rootW || c.box.w >= rootW * 0.4);
  const candidates = kids.filter(isSection);
  if (!candidates.length) return [...kids].sort((a, b) => a.box.y - b.box.y); // flat artboard fallback
  const sections = [...candidates].sort((a, b) => a.box.y - b.box.y);

  for (const stray of kids.filter((c) => !isSection(c))) {
    // full-bleed background: hoist onto the page instead of folding anywhere
    if (rootH && stray.box.h >= rootH * 0.9 && stray.bg && !spec.bg) {
      spec.bg = stray.bg;
      continue;
    }
    // fold into the section with the largest vertical overlap (else nearest center)
    const overlap = (s) => Math.max(0, Math.min(s.box.y + s.box.h, stray.box.y + stray.box.h) - Math.max(s.box.y, stray.box.y));
    let best = sections[0];
    let bestScore = -1;
    for (const s of sections) {
      const o = overlap(s);
      if (o > bestScore) { bestScore = o; best = s; }
    }
    if (bestScore <= 0) {
      const center = (n) => n.box.y + n.box.h / 2;
      best = sections.reduce((p, s) => (Math.abs(center(s) - center(stray)) < Math.abs(center(p) - center(stray)) ? s : p));
    }
    // child boxes are parent-relative: re-offset from root-space into the section
    const adjusted = { ...stray, box: { ...stray.box, x: stray.box.x - best.box.x, y: stray.box.y - best.box.y } };
    best.children = [...(best.children || []), adjusted];
  }
  // strays now live inside sections — drop the root-level originals so the
  // single-pass spec doesn't contain every folded node twice
  spec.children = sections;
  return sections;
}

// Short digest of a section used in the mapping prompt.
export function sectionDigest(section, maxTexts = 6) {
  const texts = [];
  (function walk(n) {
    if (texts.length >= maxTexts) return;
    if (n.text) texts.push(n.text.slice(0, 70));
    (n.children || []).forEach(walk);
  })(section);
  const assets = [];
  (function walk2(n) {
    if (n.asset) assets.push(n.asset.split('/').pop());
    (n.children || []).forEach(walk2);
  })(section);
  return {
    id: section.id,
    name: section.name,
    box: section.box,
    texts,
    assets: assets.slice(0, 6),
  };
}
