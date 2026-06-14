#!/usr/bin/env node
// Figma -> EDS component HTML/CSS/JS conversion pipeline.
//
//   node src/run.mjs                 (uses FIGMA_FILE_ID / FIGMA_NODE_ID from .env)
//   node src/run.mjs --node 1:472    (override target node)
//
// Stages: extract (MCP + REST) -> assets -> design spec -> EDS mapping (Claude key 1)
//         -> generate (key 1) -> review loop (key 2 reviews, key 1 fixes) -> Output_N
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConfig } from './lib/env.mjs';
import { log } from './lib/util.mjs';
import { FigmaRest } from './lib/figma-rest.mjs';
import { FigmaMcp } from './lib/mcp.mjs';
import { parseDesignTokens, buildColorTokenMap, tokensPromptBlock } from './lib/tokens.mjs';
import { buildEdsManifest, edsIndexPromptBlock } from './lib/eds.mjs';
import { discoverAssets, downloadAssets, assetsPromptBlock } from './lib/assets.mjs';
import { buildDesignSpec, splitSections } from './lib/spec.mjs';
import { Claude } from './lib/claude.mjs';
import { mapSectionsToEds, generateSinglePass, generateSectionwise, applyReviewFixes, checkEdsConformance, applyEdsConformanceFixes } from './lib/generate.mjs';
import { reviewGeneratedPage } from './lib/review.mjs';
import { allocateOutputDir, writeFiles, writeReport, findBrokenAssetRefs } from './lib/output.mjs';
import { captureAndMeasure } from './lib/render.mjs';
import { diffPages, diffRegionCrops } from './lib/pixeldiff.mjs';
import { buildExpectations } from './lib/assert-layout.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const t0 = Date.now();
  const cfg = getConfig(rootDir);
  console.log('Figma -> EDS conversion pipeline');
  console.log(`  model: ${cfg.model} | file: ${cfg.figmaFileKey} | node: ${cfg.figmaNodeId || '(auto)'}`);

  const figma = new FigmaRest(cfg.figmaFileKey, cfg.figmaToken);
  const mcp = new FigmaMcp(cfg.figmaMcpUrl);
  const genClaude = new Claude({ apiKey: cfg.apiKeyGenerate, model: cfg.model, maxTokens: cfg.genMaxTokens, label: 'generator(key1)' });
  const revClaude = new Claude({ apiKey: cfg.apiKeyReview, model: cfg.model, maxTokens: cfg.genMaxTokens, label: 'reviewer(key2)' });

  // ---- Output dir ----------------------------------------------------------
  const { dir: outDir, n: runNumber } = allocateOutputDir(rootDir);
  log.step(`Run #${runNumber} -> ${path.basename(outDir)}`);

  // ---- Resolve target node -------------------------------------------------
  let nodeId = cfg.figmaNodeId;
  let pageTitle = 'Figma Design';
  if (!nodeId) {
    log.step('FIGMA_NODE_ID empty — auto-selecting first top-level frame');
    const shallow = await figma.getFileShallow(2);
    const firstPage = shallow.document.children?.[0];
    const firstFrame = (firstPage?.children || []).find((c) => c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION');
    if (!firstFrame) throw new Error('No top-level frame found in the file. Set FIGMA_NODE_ID in .env.');
    nodeId = firstFrame.id;
    pageTitle = firstFrame.name;
    log.info(`selected "${firstFrame.name}" (${nodeId})`);
  }

  // ---- Extract: REST node tree + MCP context -------------------------------
  log.step('Extracting design from Figma (MCP + REST)');
  await mcp.connect();
  const [nodes, mcpContext, mcpVariables] = await Promise.all([
    figma.getNodes([nodeId]),
    mcp.getDesignContext(nodeId),
    mcp.getVariableDefs(nodeId),
  ]);
  const root = nodes[nodeId];
  if (!root) throw new Error(`Node ${nodeId} not found in file ${cfg.figmaFileKey}`);
  if (pageTitle === 'Figma Design') pageTitle = root.name || pageTitle;
  log.info(`node tree loaded: "${root.name}" | MCP context: ${mcpContext ? mcpContext.length + ' chars' : 'unavailable'} | MCP variables: ${mcpVariables ? 'yes' : 'no'}`);

  // ---- Assets ---------------------------------------------------------------
  log.step('Extracting images, icons and vectors');
  const { assets: discovered, collapsed } = discoverAssets(root);
  log.info(`discovered: ${discovered.filter(a => a.kind === 'image').length} images, ${discovered.filter(a => a.kind === 'icon').length} icons, ${discovered.filter(a => a.kind === 'vector').length} vectors`);
  const assets = await downloadAssets(figma, discovered, outDir);
  const assetByNodeId = new Map(assets.map((a) => [a.nodeId, a]));
  await writeReport(outDir, 'assets.json', assets);

  // ---- Tokens + EDS manifest ------------------------------------------------
  log.step('Parsing design tokens and EDS component library');
  const tokens = parseDesignTokens(cfg.edsNativeCss);
  const colorTokenMap = buildColorTokenMap(tokens);
  const tokensBlock = tokensPromptBlock(tokens);
  const edsManifest = buildEdsManifest(cfg.edsComponentsDir);
  const edsIndex = edsIndexPromptBlock(edsManifest);
  log.info(`${Object.keys(tokens).length} design tokens | ${edsManifest.length} EDS components`);
  await fsp.copyFile(cfg.edsNativeCss, path.join(outDir, 'assets', 'css', 'eds-native.css'));

  // ---- Design spec ----------------------------------------------------------
  log.step('Building compact design spec');
  const spec = buildDesignSpec(root, { collapsed, assetByNodeId, colorTokenMap });
  const sections = splitSections(spec);
  if (!sections.length) throw new Error('Design spec produced zero sections — the target node may be a flat image or empty frame. Check FIGMA_NODE_ID.');
  const specJson = JSON.stringify(spec);
  log.info(`spec: ${(specJson.length / 1000).toFixed(0)}k chars, ${sections.length} top-level sections`);
  await writeReport(outDir, 'design-spec.json', spec);

  // ---- Screenshots (full page + per section) --------------------------------
  log.step('Rendering reference screenshots');
  const shotIds = [nodeId, ...sections.map((s) => s.id)];
  const shotUrls = await figma.renderImages(shotIds, { format: 'png', scale: 1 });
  async function fetchShot(id, label) {
    if (!shotUrls[id]) return null;
    try { return await figma.downloadBinary(shotUrls[id], label); }
    catch (err) { log.warn(`screenshot ${label} failed: ${err.message}`); return null; }
  }
  // REST first — the MCP get_screenshot returns a low-res thumbnail (~316px
  // wide) that is useless as a design reference; the REST render is full-scale
  const pageScreenshot = (await fetchShot(nodeId, 'page screenshot'))
    || (await mcp.getScreenshot(nodeId).then(s => s ? Buffer.from(s.data, 'base64') : null).catch(() => null));
  const sectionScreenshots = [];
  for (const s of sections) {
    const buf = await fetchShot(s.id, `section "${s.name}"`);
    if (buf) sectionScreenshots.push({ id: s.id, name: s.name, buffer: buf });
  }
  if (pageScreenshot) await fsp.writeFile(path.join(outDir, 'report', 'figma-page.png'), pageScreenshot);
  log.info(`screenshots: page=${pageScreenshot ? 'ok' : 'missing'}, sections=${sectionScreenshots.length}/${sections.length}`);

  // ---- Map sections -> EDS components (Claude key 1) ------------------------
  log.step('Mapping sections to EDS components (Claude key 1)');
  const componentNames = edsManifest.map((c) => c.component);
  const mapping = await mapSectionsToEds(genClaude, { sections, edsIndex, componentNames, pageScreenshot });
  for (const m of mapping) log.info(`"${m.sectionName}" -> ${m.eds} ${m.modifiers?.length ? '[' + m.modifiers.join(' ') + ']' : ''}`);
  await writeReport(outDir, 'mapping.json', mapping);

  // ---- Generate (Claude key 1) ----------------------------------------------
  const genOpts = {
    spec, sections, mapping, edsManifest, tokensBlock,
    assetsBlock: assetsPromptBlock(assets),
    mcpContext, mcpVariables,
    pageScreenshot, sectionScreenshots,
    title: pageTitle,
  };
  // gate on the REAL single-pass request size, not spec chars alone:
  // spec + EDS details (<=90k) + tokens + MCP context (<=48k) + rules/skeleton
  const estimatedPromptChars = specJson.length + tokensBlock.length + 90000 + (mcpContext ? 48000 : 0) + 8000;
  const totalImages = (pageScreenshot ? 1 : 0) + sectionScreenshots.length;
  let files;
  if (estimatedPromptChars > cfg.specCharBudget + 150000 || totalImages > 20) {
    log.step(`Generating page section-by-section (~${(estimatedPromptChars / 1000).toFixed(0)}k prompt chars, ${totalImages} images) — Claude key 1`);
    files = await generateSectionwise(genClaude, genOpts);
  } else {
    log.step(`Generating page in a single pass (~${(estimatedPromptChars / 1000).toFixed(0)}k prompt chars, ${totalImages} images) — Claude key 1`);
    files = await generateSinglePass(genClaude, genOpts);
  }
  if (!files['index.html']) throw new Error('Generation did not produce index.html');
  files['assets/css/styles.css'] = files['assets/css/styles.css'] || '/* no overrides */\n';
  files['assets/js/script.js'] = files['assets/js/script.js'] || '// no page script\n';
  await writeFiles(outDir, files);

  // ---- EDS conformance gate (free check + targeted fix, before paid review) --
  for (let attempt = 1; attempt <= 2; attempt++) {
    const violations = checkEdsConformance(files, mapping, edsManifest);
    if (!violations.length) {
      log.info('EDS conformance: PASS (all mapped signature classes present)');
      break;
    }
    log.warn(`EDS conformance: ${violations.length} component(s) missing signature classes: ${violations.map((v) => v.signature).join(', ')}`);
    if (attempt === 2) {
      log.warn('EDS conformance still failing after fix — leaving for the review loop');
      break;
    }
    log.step('Restructuring non-conformant sections onto EDS markup (Claude key 1)');
    files = await applyEdsConformanceFixes(genClaude, {
      files, violations, edsManifest, tokensBlock, assetsBlock: assetsPromptBlock(assets),
    });
    await writeFiles(outDir, files);
  }

  // ---- Measured review loop (objective pixel diff + layout assertions) -------
  // Each round: render in headless Chrome (CDP: fonts settled, exact height),
  // pixel-diff against the design, assert computed styles against the spec,
  // then let key 2 review with the measurements and key 1 fix with zoomed
  // diff-region crops. The loop stops on objective pass or score plateau and
  // always keeps the version with the best MEASURED score.
  const expectations = buildExpectations(spec, tokens);
  const measure = async (label) => {
    const { screenshot, layoutFailures } = await captureAndMeasure(outDir, { expectations });
    let pixel = null;
    if (screenshot) {
      await fsp.writeFile(path.join(outDir, 'report', `render-${label}.png`), screenshot);
      if (pageScreenshot) pixel = diffPages(pageScreenshot, screenshot);
    }
    const critical = (layoutFailures || []).filter((f) => f.severity === 'critical').length;
    log.info(`measured [${label}]: pixel=${pixel ? pixel.score + '%' : 'n/a'} | layout failures=${layoutFailures ? layoutFailures.length : 'n/a'} (${critical} critical)`);
    return { render: screenshot, pixel, layoutFailures: layoutFailures || [], critical };
  };

  let m = await measure('initial');
  const reviewHistory = [];
  const pixelHistory = [];
  let best = { pixelScore: m.pixel?.score ?? -1, files };
  if (m.pixel) pixelHistory.push(m.pixel.score);

  for (let iter = 1; iter <= cfg.maxReviewIterations; iter++) {
    // objective pass check before spending review tokens
    if (m.pixel && m.pixel.score >= cfg.pixelPassScore && m.critical === 0) {
      log.info(`objective PASS: pixel ${m.pixel.score}% >= ${cfg.pixelPassScore}% with no critical layout failures`);
      break;
    }
    log.step(`Design review iteration ${iter}/${cfg.maxReviewIterations} (Claude key 2)`);
    let verdict;
    try {
      verdict = await reviewGeneratedPage(revClaude, {
        files, sections, pageScreenshot, sectionScreenshots, renderScreenshot: m.render,
        tokensBlock, assetsBlock: assetsPromptBlock(assets), mapping, edsManifest,
        passScore: cfg.reviewPassScore, pixel: m.pixel, layoutFailures: m.layoutFailures,
      });
    } catch (err) {
      // a failed/malformed review must not end the loop — the measured layout
      // failures alone are enough to drive a useful fix round
      log.warn('review failed (' + err.message.slice(0, 120) + ') — continuing with measurements only');
      verdict = { score: m.pixel?.score ?? 0, pass: false, summary: 'review unavailable; fixing measured failures', issues: [] };
    }
    reviewHistory.push(verdict);
    await writeReport(outDir, `review-iter-${iter}.json`, { ...verdict, pixelScore: m.pixel?.score, layoutFailures: m.layoutFailures });
    log.info(`review: ${verdict.score}/100 | issues: ${verdict.issues.length} | ${verdict.summary || ''}`);
    if (verdict.pass && (!m.pixel || m.pixel.score >= cfg.pixelPassScore - 3)) {
      log.info('review PASSED');
      break;
    }
    if (iter === cfg.maxReviewIterations) {
      log.warn('max review iterations reached');
      break;
    }

    log.step(`Applying fixes: ${verdict.issues.length} review issues + ${m.layoutFailures.length} measured failures (Claude key 1)`);
    const diffCrops = m.pixel && m.render ? diffRegionCrops(pageScreenshot, m.render, m.pixel.regions) : [];
    files = await applyReviewFixes(genClaude, {
      files, review: verdict, spec, tokensBlock, assetsBlock: assetsPromptBlock(assets),
      pageScreenshot, sectionScreenshots, renderScreenshot: m.render,
      layoutFailures: m.layoutFailures, diffCrops, pixelScore: m.pixel?.score,
    });
    await writeFiles(outDir, files);
    m = await measure(`iter-${iter}`);
    if (m.pixel) {
      pixelHistory.push(m.pixel.score);
      if (m.pixel.score > best.pixelScore) best = { pixelScore: m.pixel.score, files };
      // convergence stop: no meaningful improvement across the last two rounds
      const n = pixelHistory.length;
      if (n >= 3 && pixelHistory[n - 1] - pixelHistory[n - 3] < cfg.plateauEpsilon) {
        log.warn(`pixel score plateaued (${pixelHistory.slice(-3).join(' -> ')}) — stopping`);
        break;
      }
    }
  }

  // keep whichever version MEASURED best
  const lastPixel = pixelHistory.length ? pixelHistory[pixelHistory.length - 1] : -1;
  if (best.pixelScore > lastPixel && best.files !== files) {
    log.info(`restoring version with best measured pixel score (${best.pixelScore}% > ${lastPixel}%)`);
    files = best.files;
    await writeFiles(outDir, files);
    m = await measure('final-restored');
  }
  await writeReport(outDir, 'pixel-history.json', { pixelHistory, finalPixelScore: m.pixel?.score ?? null, finalLayoutFailures: m.layoutFailures });

  // ---- Final verification + summary ------------------------------------------
  const broken = findBrokenAssetRefs(outDir, files);
  if (broken.length) {
    log.warn(`broken asset references: ${broken.map((b) => b.ref).join(', ')}`);
    await writeReport(outDir, 'broken-asset-refs.json', broken);
  }

  const finalScore = reviewHistory.length ? reviewHistory[reviewHistory.length - 1].score : null;
  const finalPixel = m.pixel?.score ?? null;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const summary = `# Run #${runNumber} — ${pageTitle}

- Target: file \`${cfg.figmaFileKey}\`, node \`${nodeId}\` ("${pageTitle}")
- Output: \`${path.basename(outDir)}/index.html\`
- Sections: ${sections.length} | Assets: ${assets.length} (${assets.filter(a=>a.kind==='image').length} images, ${assets.filter(a=>a.kind==='icon').length} icons, ${assets.filter(a=>a.kind==='vector').length} vectors)
- **Measured pixel match: ${finalPixel ?? 'n/a'}%** (history: ${pixelHistory.join(' -> ') || 'n/a'})
- Layout assertion failures remaining: ${m.layoutFailures.length} (${m.critical} critical)
- Review iterations: ${reviewHistory.length} | Last reviewer score: ${finalScore ?? 'n/a'}/100
- Broken asset refs: ${broken.length}
- Generator usage (key 1): ${genClaude.usage.calls} calls, ${genClaude.usage.input_tokens} in / ${genClaude.usage.output_tokens} out tokens
- Reviewer usage (key 2): ${revClaude.usage.calls} calls, ${revClaude.usage.input_tokens} in / ${revClaude.usage.output_tokens} out tokens
- Duration: ${mins} min

## Section -> EDS mapping
${mapping.map((m) => `- ${m.sectionName} -> **${m.eds}**${m.modifiers?.length ? ' (' + m.modifiers.join(', ') + ')' : ''}`).join('\n')}
`;
  await writeReport(outDir, 'summary.md', summary);

  console.log('\n' + '='.repeat(60));
  console.log(`DONE -> ${path.basename(outDir)}\\index.html`);
  console.log(`Measured pixel match: ${finalPixel ?? 'n/a'}% (${pixelHistory.join(' -> ') || 'no history'})`);
  console.log(`Reviewer score: ${finalScore ?? 'n/a'}/100 after ${reviewHistory.length} review iteration(s)`);
  console.log(`Open: file:///${path.join(outDir, 'index.html').replace(/\\/g, '/')}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
