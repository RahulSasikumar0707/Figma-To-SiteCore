// Build a manifest of the EDS component library by scanning eds-components/*/ *.html.
// Each component file embeds its canonical markup inside <main id="eds-main"> plus
// documentation comments describing modifier classes — both are captured for prompting.
import fs from 'node:fs';
import path from 'node:path';

// Extract a balanced outer block for the first tag matching `openRe` (depth-counted).
function extractBalanced(html, tagName, openRe) {
  const open = openRe.exec(html);
  if (!open) return '';
  const tokenRe = new RegExp(`<${tagName}\\b|<\\/${tagName}>`, 'gi');
  tokenRe.lastIndex = open.index;
  let depth = 0;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open.index, tokenRe.lastIndex);
  }
  return html.slice(open.index);
}

// A component's canonical markup can live in <main id="eds-main"> (most),
// <header id="header"> (header variants) or <footer class="eds-footer"> (footer).
function extractMarkup(html) {
  const main = html.match(/<main[^>]*id=["']eds-main["'][^>]*>([\s\S]*?)<\/main>/i);
  let markup = main ? main[1].trim() : '';
  if (markup.length < 500) {
    const header = extractBalanced(html, 'header', /<header[^>]*id=["'](?:eds-)?header["'][^>]*>/i);
    const footer = extractBalanced(html, 'footer', /<footer[^>]*class=["'][^"']*eds-footer[^"']*["'][^>]*>/i);
    markup = [markup, header, footer].filter((s) => s && s.length >= 200).join('\n') || markup || html;
  }
  // drop the demo-page title chrome and inline styles — they are not part of
  // the component pattern and waste prompt budget
  return markup
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocComments(html) {
  const docs = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    // keep only meaningful documentation comments (modifiers, notes, attr lists)
    if (/modifier|note|attr|class|variant/i.test(text) && text.length > 40) docs.push(text);
  }
  return docs.join('\n---\n');
}

function extractEdsClasses(html) {
  const classes = new Set();
  const re = /class=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    for (const cls of m[1].split(/\s+/)) {
      if (/^(eds-|cmp-)/.test(cls)) classes.add(cls);
    }
  }
  return [...classes];
}

// Demo-page chrome classes that appear in EVERY component file and must not be
// mistaken for a component's own signature.
const CHROME_CLASSES = new Set(['eds-header', 'eds-footer', 'cmp-details', 'cmp-rich-text']);

function deriveSignature(component, markupAll) {
  if (component === 'header') return 'eds-header';
  if (component === 'footer') return 'eds-footer';
  // exact eds-<folder-name> class present in the component's own markup?
  const exact = `eds-${component}`;
  if (new RegExp(`class=["'][^"']*\\b${exact}\\b`, 'i').test(markupAll)) return exact;
  // else: the most frequent non-generic eds-* class in the markup
  const counts = {};
  for (const m of markupAll.matchAll(/class=["']([^"']+)["']/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (/^eds-/.test(cls) && !CHROME_CLASSES.has(cls) && cls !== 'eds-link' && cls !== 'eds-btn') {
        counts[cls] = (counts[cls] || 0) + 1;
      }
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null; // null = composition pattern, nothing to enforce
}

export function buildEdsManifest(componentsDir) {
  const manifest = [];
  for (const folder of fs.readdirSync(componentsDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(componentsDir, folder.name);
    const variants = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(dir, file), 'utf8');
      variants.push({
        file: `${folder.name}/${file}`,
        markup: extractMarkup(html),
        docs: extractDocComments(html),
        classes: extractEdsClasses(html),
      });
    }
    if (variants.length) {
      const markupAll = variants.map((v) => v.markup).join('\n');
      manifest.push({
        component: folder.name,
        variants,
        classes: [...new Set(variants.flatMap((v) => v.classes))],
        signature: deriveSignature(folder.name, markupAll),
      });
    }
  }
  return manifest;
}

// One-line-per-component index used by the section->component mapping prompt.
export function edsIndexPromptBlock(manifest) {
  return manifest
    .map((c) => {
      const files = c.variants.map((v) => v.file).join(', ');
      const cls = c.classes.slice(0, 8).join(' ');
      return `- ${c.component} (files: ${files}) key classes: ${cls}`;
    })
    .join('\n');
}

// Markup + docs for a chosen subset of components. The budget is split FAIRLY
// across components — one oversized component must never starve the others
// (cards.html alone is 75k chars; with first-come allocation the generator
// never saw hero-banner/header/footer markup at all).
export function edsDetailPromptBlock(manifest, componentNames, charBudget = 110000) {
  const wanted = manifest.filter((c) => componentNames.includes(c.component));
  if (!wanted.length) return '';
  const perComponent = Math.max(6000, Math.floor(charBudget / wanted.length));
  const out = [];
  for (const c of wanted) {
    let remaining = perComponent;
    let block = `### EDS component: ${c.component}` + (c.signature ? ` — signature class: "${c.signature}"` : ' — composition pattern (no single signature class)') + '\n';
    for (const v of c.variants) {
      if (remaining <= 400) break;
      const docs = v.docs ? `Documentation (${v.file}):\n${v.docs.slice(0, Math.min(2500, remaining / 3))}\n` : '';
      let markup = v.markup;
      const allowance = remaining - docs.length - 200;
      if (markup.length > allowance) markup = markup.slice(0, allowance) + '\n<!-- ...truncated; follow the same pattern -->';
      const piece = `${docs}Canonical markup (${v.file}):\n\`\`\`html\n${markup}\n\`\`\`\n`;
      block += piece;
      remaining -= piece.length;
    }
    out.push(block);
  }
  return out.join('\n');
}
