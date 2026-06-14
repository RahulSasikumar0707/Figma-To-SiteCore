// Smoke test for all non-LLM stages: config, tokens, EDS manifest, REST tree,
// MCP connectivity, asset discovery, spec building. Costs zero Claude tokens.
// Usage: node src/dry-run.mjs [--node 1:472] [--download]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig } from './lib/env.mjs';
import { log } from './lib/util.mjs';
import { FigmaRest } from './lib/figma-rest.mjs';
import { FigmaMcp } from './lib/mcp.mjs';
import { parseDesignTokens, buildColorTokenMap } from './lib/tokens.mjs';
import { buildEdsManifest, edsIndexPromptBlock } from './lib/eds.mjs';
import { discoverAssets, downloadAssets } from './lib/assets.mjs';
import { buildDesignSpec, splitSections, sectionDigest } from './lib/spec.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = getConfig(rootDir);

const tokens = parseDesignTokens(cfg.edsNativeCss);
const colorTokenMap = buildColorTokenMap(tokens);
log.info(`tokens: ${Object.keys(tokens).length}, color tokens: ${Object.keys(colorTokenMap).length}`);

const manifest = buildEdsManifest(cfg.edsComponentsDir);
log.info(`EDS components: ${manifest.length}, variants: ${manifest.reduce((n, c) => n + c.variants.length, 0)}`);
console.log(edsIndexPromptBlock(manifest).split('\n').slice(0, 5).join('\n'));

const figma = new FigmaRest(cfg.figmaFileKey, cfg.figmaToken);
let nodeId = cfg.figmaNodeId;
if (!nodeId) {
  const shallow = await figma.getFileShallow(2);
  const firstPage = shallow.document.children?.[0];
  nodeId = (firstPage?.children || []).find((c) => ['FRAME', 'COMPONENT', 'SECTION'].includes(c.type))?.id;
  log.info(`auto node: ${nodeId}`);
}

const mcp = new FigmaMcp(cfg.figmaMcpUrl);
await mcp.connect();

const nodes = await figma.getNodes([nodeId]);
const root = nodes[nodeId];
if (!root) throw new Error('node not found: ' + nodeId);
log.info(`root: "${root.name}" type=${root.type} children=${root.children?.length}`);

const { assets, collapsed } = discoverAssets(root);
const byKind = { image: 0, icon: 0, vector: 0 };
for (const a of assets) byKind[a.kind]++;
log.info(`assets discovered: ${JSON.stringify(byKind)} (collapsed nodes: ${collapsed.size})`);
for (const a of assets.slice(0, 12)) console.log('   ', a.kind, a.nodeId, JSON.stringify(a.name), `${a.w}x${a.h}`);

if (process.argv.includes('--download')) {
  const tmp = path.join(rootDir, '.dry-assets');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const ok = await downloadAssets(figma, assets, tmp);
  log.info(`downloaded ${ok.length}/${assets.length}`);
}

const assetByNodeId = new Map(assets.map((a) => [a.nodeId, a]));
for (const a of assets) a.file = a.file || `assets/x/${a.nodeId}.png`; // fake paths if not downloaded
const spec = buildDesignSpec(root, { collapsed, assetByNodeId, colorTokenMap });
const json = JSON.stringify(spec);
const sections = splitSections(spec);
log.info(`spec: ${(json.length / 1000).toFixed(1)}k chars, sections: ${sections.length}`);
for (const s of sections) {
  const d = sectionDigest(s);
  console.log('   section:', s.name, JSON.stringify(s.box), '| texts:', d.texts.length, '| assets:', d.assets.length);
}
log.info('dry run OK');
