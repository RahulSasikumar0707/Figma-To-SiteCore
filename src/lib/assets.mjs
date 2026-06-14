// Discover and export every image, icon and vector under the target node.
//   - nodes with IMAGE fills            -> assets/images/*.png (original fill bitmap when possible)
//   - vector subtrees, max side <= 64px -> assets/icons/*.svg
//   - vector subtrees, larger           -> assets/vectors/*.svg
// A node id -> asset record index is produced so the design-spec builder can
// collapse exported subtrees into a single { asset: "..." } reference.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { slugify, log, pool } from './util.mjs';

const VECTOR_TYPES = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'POLYGON', 'REGULAR_POLYGON',
]);
const CONTAINER_TYPES = new Set(['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT']);
const ICON_MAX_SIDE = 64;

function hasImageFill(node) {
  return Array.isArray(node.fills) && node.fills.some((f) => f.type === 'IMAGE' && f.visible !== false);
}

function imageRefOf(node) {
  const f = (node.fills || []).find((f) => f.type === 'IMAGE' && f.visible !== false);
  return f ? f.imageRef : null;
}

// True if every visible leaf under node is a pure vector shape (no text, no image fills)
function isVectorOnlySubtree(node) {
  if (node.visible === false) return true;
  if (node.type === 'TEXT') return false;
  if (hasImageFill(node)) return false;
  if (VECTOR_TYPES.has(node.type)) return true;
  if (node.type === 'RECTANGLE') return true; // shape leaf without image fill
  if (CONTAINER_TYPES.has(node.type) || node.type === 'SECTION') {
    const kids = (node.children || []).filter((c) => c.visible !== false);
    if (!kids.length) return false;
    return kids.every(isVectorOnlySubtree);
  }
  return false;
}

function sideOf(node) {
  const b = node.absoluteBoundingBox;
  return b ? Math.max(b.width, b.height) : Infinity;
}

function looksLikeIconName(name) {
  return /icon|logo|arrow|chevron|close|search|play|pause|social|glyph/i.test(name);
}

// Walk the tree and classify which node ids become exported assets.
export function discoverAssets(root) {
  const assets = []; // {nodeId, name, kind: image|icon|vector, format, imageRef?, w, h}
  const collapsed = new Set(); // node ids whose subtrees are replaced by an asset

  function visit(node, depth) {
    if (!node || node.visible === false) return;
    const b = node.absoluteBoundingBox || { width: 0, height: 0 };

    if (hasImageFill(node)) {
      assets.push({
        nodeId: node.id, name: node.name, kind: 'image', format: 'png',
        imageRef: imageRefOf(node), w: Math.round(b.width), h: Math.round(b.height),
      });
      const kids = (node.children || []);
      if (!kids.length) {
        collapsed.add(node.id);
        return; // plain image leaf
      }
      // container with a background photo: keep the asset as its background
      // and KEEP RECURSING so text/buttons inside it stay in the spec
      for (const child of kids) visit(child, depth + 1);
      return;
    }

    const isLeafVector = VECTOR_TYPES.has(node.type);
    // size cap applies only to the icon/vector kind split — a cohesive
    // vector-only illustration of any size must export as ONE svg, never shatter
    const isVectorGroup =
      depth > 0 &&
      CONTAINER_TYPES.has(node.type) &&
      (node.children || []).length > 0 &&
      isVectorOnlySubtree(node) &&
      (sideOf(node) <= ICON_MAX_SIDE || looksLikeIconName(node.name) || (node.children || []).length > 1);

    if (isLeafVector || isVectorGroup) {
      const kind = sideOf(node) <= ICON_MAX_SIDE ? 'icon' : 'vector';
      assets.push({
        nodeId: node.id, name: node.name, kind, format: 'svg',
        w: Math.round(b.width), h: Math.round(b.height),
      });
      collapsed.add(node.id);
      return;
    }

    for (const child of node.children || []) visit(child, depth + 1);
  }

  visit(root, 0);
  return { assets, collapsed };
}

// Export + download all discovered assets into <outDir>/assets/{images,icons,vectors}.
// Mutates each asset record with .file (path relative to outDir) on success.
export async function downloadAssets(figma, assets, outDir) {
  const subdirFor = { image: 'images', icon: 'icons', vector: 'vectors' };
  for (const sub of Object.values(subdirFor)) {
    await fsp.mkdir(path.join(outDir, 'assets', sub), { recursive: true });
  }

  const seenNames = new Set();
  for (const a of assets) {
    // node ids of nested instances look like "I68484:1066;68467:7021" — strip
    // every character Windows filenames cannot contain
    const safeId = a.nodeId.replace(/[^A-Za-z0-9_-]+/g, '-');
    let base = `${slugify(a.name)}_${safeId}`;
    while (seenNames.has(base)) base += '_x';
    seenNames.add(base);
    a.file = `assets/${subdirFor[a.kind]}/${base}.${a.format === 'svg' ? 'svg' : 'png'}`;
  }

  // 1) original bitmaps for image fills
  const fillAssets = assets.filter((a) => a.kind === 'image' && a.imageRef);
  let fillUrls = {};
  if (fillAssets.length) {
    try { fillUrls = await figma.getImageFillUrls(); }
    catch (err) { log.warn('image-fill url fetch failed: ' + err.message); }
  }

  // 2) rendered exports for everything else (and image nodes whose fill URL is missing)
  const needRenderPng = assets.filter((a) => a.kind === 'image' && !(a.imageRef && fillUrls[a.imageRef]));
  const needRenderSvg = assets.filter((a) => a.format === 'svg');
  const pngUrls = needRenderPng.length
    ? await figma.renderImages(needRenderPng.map((a) => a.nodeId), { format: 'png', scale: 2 })
    : {};
  const svgUrls = needRenderSvg.length
    ? await figma.renderImages(needRenderSvg.map((a) => a.nodeId), { format: 'svg' })
    : {};

  const jobs = [];
  for (const a of assets) {
    let url = null;
    if (a.kind === 'image' && a.imageRef && fillUrls[a.imageRef]) url = fillUrls[a.imageRef];
    else if (a.format === 'svg') url = svgUrls[a.nodeId];
    else url = pngUrls[a.nodeId];
    if (!url) {
      log.warn(`no export URL for ${a.kind} "${a.name}" (${a.nodeId}) — skipping`);
      a.file = null;
      continue;
    }
    const dest = path.join(outDir, a.file);
    jobs.push(async () => {
      try {
        const buf = await figma.downloadBinary(url, a.file);
        await fsp.writeFile(dest, buf);
        return { file: a.file, bytes: buf.length };
      } catch (err) {
        // a failed download must not stay in the manifest pointing at a ghost file
        log.warn(`asset download failed (${a.file}): ${err.message}`);
        a.file = null;
        return { error: err.message };
      }
    });
  }
  const results = await pool(jobs, 8);
  const ok = results.filter((r) => r && !r.error).length;
  log.info(`assets downloaded: ${ok}/${jobs.length}`);
  return assets.filter((a) => a.file);
}

// Compact manifest block for prompts
export function assetsPromptBlock(assets) {
  return assets
    .filter((a) => a.file)
    .map((a) => `- ${a.file}  (${a.kind}, ${a.w}x${a.h}, figma node ${a.nodeId}, name: "${a.name}")`)
    .join('\n');
}
