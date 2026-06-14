// Generation side of the pipeline (ANTHROPIC_API_KEY_1):
//   1. map page sections -> EDS components (manifest-driven)
//   2. generate index.html + overrides CSS + JS, section by section or single-shot,
//      strictly following the design spec, design tokens, EDS markup and Bootstrap 5.1.3.
import { extractJson, parseFileBlocks, log } from './util.mjs';
import { imageBlock, MAX_IMAGES_PER_REQUEST } from './claude.mjs';
import { edsDetailPromptBlock } from './eds.mjs';
import { sectionDigest } from './spec.mjs';
import { slicePngVertical, pngSize } from './png.mjs';

// Attach at most `max` images to a content array (page shot counts first).
// Tall page screenshots are sliced into strips — a 4400px-tall image gets
// downscaled by the API to unreadable, while 3 strips stay sharp.
export function attachScreenshots(content, pageScreenshot, sectionScreenshots, max = MAX_IMAGES_PER_REQUEST) {
  let used = 0;
  if (pageScreenshot) {
    const size = pngSize(pageScreenshot);
    const strips = size && size.height > 2200 ? slicePngVertical(pageScreenshot, Math.min(4, Math.ceil(size.height / 1500))) : [];
    if (strips.length) {
      content.push({ type: 'text', text: `FULL-PAGE design screenshot, split into ${strips.length} vertical strips (top to bottom):` });
      for (let i = 0; i < strips.length && used < max; i++) {
        const img = imageBlock(strips[i]);
        if (img) { content.push({ type: 'text', text: `Design strip ${i + 1}/${strips.length}:` }, img); used++; }
      }
    } else {
      const shot = imageBlock(pageScreenshot);
      if (shot) { content.push({ type: 'text', text: 'FULL-PAGE screenshot of the target design:' }, shot); used++; }
    }
  }
  for (const s of sectionScreenshots || []) {
    if (used >= max) {
      log.warn(`image cap (${max}) reached — ${(sectionScreenshots.length - used + 1)} section screenshots not attached`);
      break;
    }
    const img = imageBlock(s.buffer);
    if (img) {
      content.push({ type: 'text', text: `Screenshot of section "${s.name}" (${s.id}):` }, img);
      used++;
    }
  }
  return used;
}

// Attach interleaved DESIGN-vs-RENDER strip pairs so a vision reviewer can
// compare the original design with the actual rendered output region by region.
export function attachComparisonStrips(content, designScreenshot, renderScreenshot, numStrips = 5) {
  const design = designScreenshot ? slicePngVertical(designScreenshot, numStrips) : [];
  const render = renderScreenshot ? slicePngVertical(renderScreenshot, numStrips) : [];
  if (!design.length || !render.length) return 0;
  let used = 0;
  content.push({
    type: 'text',
    text: `VISUAL COMPARISON — both pages are split into ${numStrips} vertical strips, top to bottom. For each region you get the ORIGINAL FIGMA DESIGN strip first, then the CURRENT RENDERED OUTPUT strip of the generated code in a real browser. The pages may differ slightly in total height, so content can be offset by a few percent between corresponding strips — compare by matching content, not exact pixel rows.`,
  });
  for (let i = 0; i < numStrips; i++) {
    const d = design[i] && imageBlock(design[i]);
    const r = render[i] && imageBlock(render[i]);
    if (d) { content.push({ type: 'text', text: `DESIGN strip ${i + 1}/${numStrips}:` }, d); used++; }
    if (r) { content.push({ type: 'text', text: `RENDER strip ${i + 1}/${numStrips} (actual browser output):` }, r); used++; }
  }
  return used;
}

const COMMON_RULES = `
HARD RULES — follow every one of them:
1. Tech stack: HTML5 + Bootstrap 5.1.3 (CSS+JS via CDN, already linked) + the provided EDS design system ("eds-native.css", already linked) + one small overrides stylesheet (assets/css/styles.css) + one script (assets/js/script.js).
2. EDS FIRST — THIS IS THE MOST IMPORTANT RULE: every section MUST be built from the mapped EDS component's canonical markup, copying its EXACT class names and nesting (e.g. a hero section's root is <div class="component eds-hero-banner ...">, cards use <div class="eds-card card"> with card-img/card-body/card-body-footer/card-footer, accordions use <div class="eds-accordion accordion">, the ISI tray uses <div class="eds-isi ...">, the footer is <footer class="eds-footer">, buttons are <a class="eds-btn ...">, links are <a class="eds-link ...">). Apply the documented modifier classes matching the design variant. NEVER invent a parallel class system (no custom prefixes like lv-*, page-*, my-*) — custom classes are allowed ONLY as additive free-text classes alongside the EDS classes, exactly like the [free-text-class] slot in the component docs. A section that does not carry its EDS component's signature class is WRONG even if it looks correct. When a component has LAYOUT VARIANTS, pick the variant whose rendered layout matches the design screenshot — e.g. eds-header header-variant-one renders logo and nav links inline on ONE row, while header-variant-three stacks a centered logo ABOVE the nav (flex-direction: column on desktop); a one-row header design therefore requires header-variant-one. Check the variant's CSS behavior described in the docs, not just its name.
3. DESIGN TOKENS: when a color/typography value exists as a CSS custom property in the token list, ALWAYS use var(--token) instead of the raw value. Raw hex values are allowed only for colors with no token. NEVER invent token names.
4. BOOTSTRAP: use the grid (container/container-fluid, row, col-*) and utilities (d-flex, gap, mb-*, text-*, align-items-*) for layout and spacing wherever they match the spec values; use Bootstrap JS components (accordion/collapse, carousel, modal, dropdown) for interactive sections.
5. EXACTNESS: text content must match the design spec EXACTLY (every heading, paragraph, button label, superscript, footnote — character for character). Sizes, paddings, gaps, colors, border-radius and shadows must match the spec numbers. The "box" values are px at a 1366px-wide desktop artboard.
6. ASSETS: reference images/icons/vectors ONLY from the provided asset manifest, using their relative paths exactly (e.g. assets/images/xxx.png). Every <img> needs a meaningful alt and explicit width/height or CSS sizing matching the spec. Never hotlink, never use placeholders. Align images precisely as shown in the design (object-fit, positioning).
7. RESPONSIVE: desktop spec is 1366px. Make the page fully responsive: stack columns on <768px, use Bootstrap breakpoints, fluid images (img-fluid where appropriate), and the EDS mobile token values. Nothing may overflow horizontally on 375px wide screens.
8. CSS overrides go in assets/css/styles.css scoped under a page class (e.g. .figma-page) or section classes — do NOT restyle global EDS classes destructively. Keep specificity low.
`;

const PAGE_OUTPUT_FORMAT = `
OUTPUT FORMAT — exactly these three blocks, nothing else (no commentary before, between or after, no code fences around the markers):
===FILE: index.html===
<full file>
===FILE: assets/css/styles.css===
<full file>
===FILE: assets/js/script.js===
<full file>
`;

const SECTION_OUTPUT_FORMAT = `
OUTPUT FORMAT — exactly these three blocks, nothing else (no commentary, no code fences around the markers). Do NOT output index.html — only the fragment files:
===FILE: section.html===
<the section fragment — no <html>/<head>/<body>>
===FILE: section.css===
<styles for this section only — may be empty>
===FILE: section.js===
<behavior for this section only, wrapped in an IIFE — may be empty>
`;

export function pageSkeleton({ title }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet" />
<link href="assets/css/eds-native.css" rel="stylesheet" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=Material+Symbols+Outlined&family=Material+Symbols+Rounded&display=swap" rel="stylesheet" />
<link href="assets/css/styles.css" rel="stylesheet" />
</head>
<body>
<div id="eds-wrapper" class="figma-page">
<!--SECTIONS-->
</div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="assets/js/script.js"></script>
</body>
</html>
`;
}

// ---- Step 1: map sections to EDS components -------------------------------
export async function mapSectionsToEds(claude, { sections, edsIndex, componentNames, pageScreenshot }) {
  const digests = sections.map((s) => sectionDigest(s));
  const prompt = `You are mapping the top-to-bottom sections of a Figma page design onto a fixed library of EDS components.

EDS COMPONENT LIBRARY (${componentNames.length} components):
${edsIndex}

PAGE SECTIONS (top to bottom, with size, sample texts and asset filenames):
${JSON.stringify(digests, null, 1)}

For EVERY section pick the single best-matching EDS component (by visual pattern: hero at top -> hero-banner, nav bar -> header, FAQ rows -> accordion, card grids -> cards, quote blocks -> testimonial, bottom links/legal -> footer, etc.). Use component folder names exactly as listed. If truly nothing matches, use "content-block".

Reply with ONLY a JSON array:
[{"sectionId":"<id>","sectionName":"<name>","eds":"<component-folder-name>","modifiers":["optional-modifier-classes"],"why":"<8 words max>"}]`;

  const content = [{ type: 'text', text: prompt }];
  const shot = pageScreenshot && imageBlock(pageScreenshot);
  if (shot) content.push({ type: 'text', text: 'Full-page screenshot for reference:' }, shot);

  const text = await claude.complete({
    system: 'You map design sections to component libraries. You reply with strict JSON only.',
    messages: [{ role: 'user', content }],
    maxTokens: 4000,
  });
  const mapping = extractJson(text);
  if (!Array.isArray(mapping)) throw new Error('mapping response was not a JSON array');

  // never trust component names verbatim: fuzzy-match against the manifest so a
  // near-miss ("hero" vs "hero-banner") doesn't silently strip all EDS reference
  const resolve = (name) => {
    const n = String(name || '').toLowerCase().trim();
    if (componentNames.includes(n)) return n;
    const starts = componentNames.find((c) => c.startsWith(n) || n.startsWith(c));
    if (starts) return starts;
    const contains = componentNames.find((c) => c.includes(n) || n.includes(c));
    if (contains) return contains;
    log.warn(`mapping: unknown EDS component "${name}" — coerced to content-block`);
    return 'content-block';
  };
  for (const m of mapping) m.eds = resolve(m.eds);
  // and make sure every section is covered
  const covered = new Set(mapping.map((m) => m.sectionId));
  for (const s of sections) {
    if (!covered.has(s.id)) {
      log.warn(`mapping: section "${s.name}" (${s.id}) missing — defaulted to content-block`);
      mapping.push({ sectionId: s.id, sectionName: s.name, eds: 'content-block', modifiers: [] });
    }
  }
  return mapping;
}

// ---- Step 2: generate the page --------------------------------------------
function buildGenContext({ tokensBlock, assetsBlock, edsManifest, mapping, mcpContext, mcpVariables }) {
  const mappedComponents = [...new Set(mapping.map((m) => m.eds))];
  const edsDetails = edsDetailPromptBlock(edsManifest, mappedComponents);
  let ctx = `DESIGN TOKENS available in eds-native.css (use var(--name)):
${tokensBlock}

ASSET MANIFEST (all files already exist on disk — use these exact relative paths):
${assetsBlock || '(no assets were extracted)'}

SECTION -> EDS COMPONENT MAPPING (authoritative):
${JSON.stringify(mapping, null, 1)}

EDS COMPONENT REFERENCES for the mapped components:
${edsDetails}`;
  if (mcpVariables) ctx += `\n\nFIGMA VARIABLES on this node (from Figma Dev Mode MCP):\n${mcpVariables.slice(0, 8000)}`;
  if (mcpContext) ctx += `\n\nREFERENCE CODE from Figma Dev Mode MCP (structure/layout hints only — your output MUST use EDS+Bootstrap markup instead of this):\n${mcpContext.slice(0, 40000)}`;
  return ctx;
}

export async function generateSinglePass(claude, opts) {
  const { spec, pageScreenshot, sectionScreenshots, title } = opts;
  const context = buildGenContext(opts);
  const content = [
    { type: 'text', text: `Convert this Figma design into a pixel-exact, responsive web page.\n\n${COMMON_RULES}\n${PAGE_OUTPUT_FORMAT}\n${context}\n\nFULL DESIGN SPEC (px @1366 artboard; "asset" fields reference manifest files; "bgAsset" = background image of that container; "token" fields are the design-token equivalents):\n${JSON.stringify(spec)}\n\nUse this exact page skeleton (fill the <!--SECTIONS--> area; keep the head/scripts as-is):\n${pageSkeleton({ title })}` },
  ];
  attachScreenshots(content, pageScreenshot, sectionScreenshots);
  const text = await claude.complete({
    system: 'You are an expert front-end engineer producing pixel-exact, production-quality EDS + Bootstrap pages from Figma specs. You output only the requested file blocks.',
    messages: [{ role: 'user', content }],
  });
  return parseFileBlocks(text);
}

// Resolve a generated block by exact name, falling back to the single key with
// a matching extension (models occasionally rename "section.html" to "index.html").
function resolveBlock(files, exact, ext) {
  if (files[exact] && files[exact].trim()) return files[exact];
  const matches = Object.keys(files).filter((k) => k.endsWith(ext) && files[k].trim());
  return matches.length === 1 ? files[matches[0]] : null;
}

export async function generateSectionwise(claude, opts) {
  const { sections, sectionScreenshots, title, mapping } = opts;
  const shotById = new Map((sectionScreenshots || []).map((s) => [s.id, s.buffer]));
  const mapById = new Map(mapping.map((m) => [m.sectionId, m]));
  const htmlParts = [];
  const cssParts = [];
  const jsParts = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const m = mapById.get(section.id) || { eds: 'content-block', modifiers: [] };
    log.info(`generating section ${i + 1}/${sections.length}: "${section.name}" -> ${m.eds}`);
    // section mode: no full-page MCP context (it re-bills 40k chars per section)
    const context = buildGenContext({ ...opts, mapping: [m], mcpContext: null });
    const content = [
      { type: 'text', text: `You are generating ONE SECTION of a larger page (section ${i + 1} of ${sections.length}, named "${section.name}", mapped to EDS component "${m.eds}"). The fragment will be inserted into <div id="eds-wrapper"> of a page that already loads Bootstrap 5.1.3, eds-native.css, styles.css and script.js.

${COMMON_RULES}
${SECTION_OUTPUT_FORMAT}
Wrap the fragment in a semantic landmark when appropriate (<header> for the nav/header section, <footer> for the footer, otherwise a <section> or <div> with the EDS component classes).

${context}

SECTION DESIGN SPEC:
${JSON.stringify(section)}` },
    ];
    const img = imageBlock(shotById.get(section.id));
    if (img) content.push({ type: 'text', text: 'Screenshot of this exact section:' }, img);

    const system = 'You are an expert front-end engineer producing pixel-exact EDS + Bootstrap sections from Figma specs. You output only the requested file blocks.';
    let text = await claude.complete({ system, messages: [{ role: 'user', content }] });
    let files = parseFileBlocks(text);
    let html = resolveBlock(files, 'section.html', '.html');
    if (!html) {
      log.warn(`section "${section.name}": no section.html block — retrying with format reminder`);
      text = await claude.complete({
        system,
        messages: [
          { role: 'user', content },
          { role: 'assistant', content: text.slice(0, 2000) },
          { role: 'user', content: 'Your previous reply did not contain a ===FILE: section.html=== block. Reply again with the COMPLETE output using EXACTLY the three markers ===FILE: section.html===, ===FILE: section.css===, ===FILE: section.js=== and no other text.' },
        ],
      });
      files = parseFileBlocks(text);
      html = resolveBlock(files, 'section.html', '.html');
    }
    if (!html) throw new Error(`section "${section.name}" (${section.id}) produced no section.html after retry`);
    htmlParts.push(`<!-- section: ${section.name} (${section.id}) | eds: ${m.eds} -->\n${html.trim()}`);
    const css = resolveBlock(files, 'section.css', '.css');
    if (css) cssParts.push(`/* ===== section: ${section.name} (${m.eds}) ===== */\n${css.trim()}`);
    const js = resolveBlock(files, 'section.js', '.js');
    if (js) jsParts.push(`// ===== section: ${section.name} (${m.eds}) =====\n${js.trim()}`);
  }

  const html = pageSkeleton({ title }).replace('<!--SECTIONS-->', htmlParts.join('\n\n'));
  return {
    'index.html': html,
    'assets/css/styles.css': cssParts.join('\n\n') + '\n',
    'assets/js/script.js': jsParts.join('\n\n') + '\n',
  };
}

// ---- EDS conformance gate ---------------------------------------------------
// Programmatic (free) check: every mapped component with a signature class must
// actually appear in the generated HTML. Returns a list of violations.
export function checkEdsConformance(files, mapping, edsManifest) {
  const html = files['index.html'] || '';
  const bySig = new Map(edsManifest.map((c) => [c.component, c.signature]));
  const violations = [];
  const checked = new Set();
  for (const m of mapping) {
    const sig = bySig.get(m.eds);
    if (!sig || checked.has(m.eds)) continue;
    checked.add(m.eds);
    const present = m.eds === 'header'
      ? /id=["'](?:eds-)?header["']|class=["'][^"']*\beds-header\b/.test(html)
      : new RegExp(`class=["'][^"']*\\b${sig}\\b`).test(html);
    if (!present) {
      violations.push({
        component: m.eds,
        signature: sig,
        sections: mapping.filter((x) => x.eds === m.eds).map((x) => x.sectionName),
      });
    }
  }
  return violations;
}

// One targeted fix call: rebuild only the non-conformant sections using the
// full canonical markup of the offending components.
export async function applyEdsConformanceFixes(claude, { files, violations, edsManifest, tokensBlock, assetsBlock }) {
  const componentsToFix = violations.map((v) => v.component);
  const edsDetails = edsDetailPromptBlock(edsManifest, componentsToFix, 100000);
  const fileList = Object.entries(files).map(([p, c]) => `===FILE: ${p}===\n${c}`).join('\n');
  const content = [
    { type: 'text', text: `Your generated page FAILED the EDS conformance check. These mapped EDS components' signature classes are missing from the HTML:
${JSON.stringify(violations, null, 1)}

Rewrite the affected sections so each one is built from its EDS component's canonical markup below — same root element, same class names (including the signature class), same nesting. Keep all text content, asset paths and visual styling EXACTLY as they are; move custom classes onto the EDS structure as additive classes. Do not touch sections that are not listed.
${COMMON_RULES}
${PAGE_OUTPUT_FORMAT}
CANONICAL EDS MARKUP for the components to fix:
${edsDetails}

DESIGN TOKENS:
${tokensBlock.slice(0, 8000)}

ASSET MANIFEST:
${assetsBlock}

CURRENT FILES:
${fileList}

Output the corrected versions of ALL THREE files in the exact ===FILE: ...=== format.` },
  ];
  const text = await claude.complete({
    system: 'You are an expert front-end engineer restructuring markup onto a design system\'s canonical component patterns without changing content or visuals. You output only the requested file blocks.',
    messages: [{ role: 'user', content }],
  });
  const fixed = parseFileBlocks(text);
  for (const key of Object.keys(files)) {
    if (!fixed[key] || !fixed[key].trim()) fixed[key] = files[key];
  }
  return fixed;
}

// Attach zoomed paired crops of the worst pixel-diff regions.
export function attachDiffRegionCrops(content, crops) {
  if (!crops || !crops.length) return 0;
  let used = 0;
  content.push({ type: 'text', text: 'WORST VISUAL DIFF REGIONS (measured by pixel comparison) — zoomed paired crops. These exact areas differ the most; make the render match the design:' });
  for (let i = 0; i < crops.length; i++) {
    const d = imageBlock(crops[i].design);
    const r = imageBlock(crops[i].render);
    if (d && r) {
      content.push(
        { type: 'text', text: `Diff region ${i + 1} — DESIGN (${crops[i].label}):` }, d,
        { type: 'text', text: `Diff region ${i + 1} — CURRENT RENDER:` }, r,
      );
      used += 2;
    }
  }
  return used;
}

// ---- Step 3: apply reviewer fixes ------------------------------------------
export async function applyReviewFixes(claude, { files, review, spec, tokensBlock, assetsBlock, pageScreenshot, sectionScreenshots, renderScreenshot, layoutFailures, diffCrops, pixelScore }) {
  const fileList = Object.entries(files)
    .map(([p, c]) => `===FILE: ${p}===\n${c}`)
    .join('\n');
  const measuredBlock = layoutFailures && layoutFailures.length
    ? `\nMEASURED LAYOUT FAILURES (deterministic, from computed styles in a real browser — fix each one precisely; if a measurement seems to contradict the design screenshots, the screenshots win):\n${JSON.stringify(layoutFailures, null, 1)}\n`
    : '';
  const pixelBlock = pixelScore != null
    ? `\nCurrent objective pixel-match score vs the design: ${pixelScore}% — your fixes must raise this.\n`
    : '';
  const content = [
    { type: 'text', text: `A design reviewer compared your generated page against the original Figma design and found these issues (JSON):
${JSON.stringify(review.issues, null, 1)}
${measuredBlock}${pixelBlock}
Fix EVERY issue. Keep everything that was not flagged byte-identical where possible.
SPECIFICITY WARNING: if a measured failure persists although styles.css already sets the right value, your selector is LOSING to an eds-native.css rule (e.g. ".eds-card.card .card-img img { width: 100% }" is 0-3-1). Match or exceed that specificity (prefix the EDS classes, e.g. ".figma-page .eds-card.card .card-img img.my-class"), or use "width: revert" to fall back to the HTML width/height attributes — do NOT just repeat the same losing rule.
${COMMON_RULES}
${PAGE_OUTPUT_FORMAT}
DESIGN TOKENS:
${tokensBlock}

ASSET MANIFEST:
${assetsBlock}

FULL DESIGN SPEC (ground truth for any content/layout the issues reference):
${JSON.stringify(spec)}

CURRENT FILES:
${fileList}

Output the corrected versions of ALL THREE files in the exact ===FILE: ...=== format.` },
  ];
  // show the fixer what its code actually looks like next to the design,
  // plus zoomed crops of the regions the pixel diff measured as worst
  const paired = attachComparisonStrips(content, pageScreenshot, renderScreenshot, 5);
  if (!paired) attachScreenshots(content, pageScreenshot, sectionScreenshots);
  attachDiffRegionCrops(content, diffCrops);
  const text = await claude.complete({
    system: 'You are an expert front-end engineer fixing review findings with surgical precision. You output only the requested file blocks.',
    messages: [{ role: 'user', content }],
  });
  const fixed = parseFileBlocks(text);
  // never lose a file: fall back to previous content if the model dropped or
  // truncated one (a "fixed" file under half the original size is suspect
  // unless the reviewer actually asked for removals)
  for (const key of Object.keys(files)) {
    if (!fixed[key] || !fixed[key].trim()) fixed[key] = files[key];
  }
  return fixed;
}
