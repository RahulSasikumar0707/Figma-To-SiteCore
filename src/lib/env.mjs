// Minimal .env loader + config resolution (no dependencies).
import fs from 'node:fs';
import path from 'node:path';

// Precedence: a NON-EMPTY value in .env wins over the inherited environment
// (the project file is the explicit, current configuration); an EMPTY .env value
// defers to the environment (this is how FIGMA_NODE_ID is provided per run).
export function loadEnv(rootDir) {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val !== '') {
        if (process.env[key] !== undefined && process.env[key] !== val) {
          console.log(`  [env] ${key}: using .env value (environment had a different one)`);
        }
        process.env[key] = val;
      } else if (process.env[key]) {
        console.log(`  [env] ${key}: empty in .env -> using environment value`);
      }
    }
  }
}

// "C14xdH8bSbAkcSi1QzEOBX/DX" or a full figma.com URL -> bare file key
export function normalizeFileKey(raw) {
  if (!raw) return '';
  let v = String(raw).trim();
  const urlMatch = v.match(/figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return v.split(/[/?#]/)[0];
}

// "1-472", "1:472" or URL with ?node-id=1-472 -> "1:472"; '' if unset
export function normalizeNodeId(raw) {
  if (!raw) return '';
  let v = String(raw).trim();
  const urlMatch = v.match(/node-id=([0-9]+[-:][0-9]+)/);
  if (urlMatch) v = urlMatch[1];
  return v.replace('-', ':');
}

export function getConfig(rootDir) {
  loadEnv(rootDir);
  const cfg = {
    rootDir,
    apiKeyGenerate: process.env.ANTHROPIC_API_KEY_1 || '',
    apiKeyReview: process.env.ANTHROPIC_API_KEY_2 || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    figmaFileKey: normalizeFileKey(process.env.FIGMA_FILE_ID || ''),
    figmaNodeId: normalizeNodeId(process.env.FIGMA_NODE_ID || ''),
    figmaToken: process.env.FIGMA_TOKEN || '',
    figmaMcpUrl: process.env.FIGMA_MCP_URL || 'http://127.0.0.1:3845/mcp',
    maxReviewIterations: Number(process.env.MAX_REVIEW_ITERATIONS || 5),
    reviewPassScore: Number(process.env.REVIEW_PASS_SCORE || 95),
    pixelPassScore: Number(process.env.PIXEL_PASS_SCORE || 95),
    plateauEpsilon: Number(process.env.PLATEAU_EPSILON || 0.8),
    genMaxTokens: Number(process.env.GEN_MAX_TOKENS || 32000),
    specCharBudget: Number(process.env.SPEC_CHAR_BUDGET || 180000),
    edsComponentsDir: path.join(rootDir, 'eds-components'),
    edsNativeCss: path.join(rootDir, 'eds-native.css'),
  };
  // CLI overrides: --node 1:472  --file <key>
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--node' && argv[i + 1]) cfg.figmaNodeId = normalizeNodeId(argv[++i]);
    if (argv[i] === '--file' && argv[i + 1]) cfg.figmaFileKey = normalizeFileKey(argv[++i]);
  }
  const missing = [];
  if (!cfg.apiKeyGenerate) missing.push('ANTHROPIC_API_KEY_1');
  if (!cfg.apiKeyReview) missing.push('ANTHROPIC_API_KEY_2');
  if (!cfg.figmaFileKey) missing.push('FIGMA_FILE_ID');
  if (!cfg.figmaToken) missing.push('FIGMA_TOKEN');
  if (missing.length) throw new Error('Missing required env vars: ' + missing.join(', '));
  return cfg;
}
