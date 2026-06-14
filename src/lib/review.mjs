// Review side of the pipeline (ANTHROPIC_API_KEY_2): an independent Claude
// instance compares the generated code against the Figma design (screenshots +
// spec digest) and returns a structured verdict used to drive the fix loop.
import { extractJson, log } from './util.mjs';
import { sectionDigest } from './spec.mjs';
import { attachScreenshots, attachComparisonStrips } from './generate.mjs';

export async function reviewGeneratedPage(claude, {
  files, sections, pageScreenshot, sectionScreenshots, renderScreenshot, tokensBlock, assetsBlock, mapping, edsManifest, passScore, pixel, layoutFailures,
}) {
  const signatures = (edsManifest || [])
    .filter((c) => c.signature && mapping.some((m) => m.eds === c.component))
    .map((c) => `${c.component} -> requires class "${c.signature}"`);
  const measuredBlock = (pixel || (layoutFailures && layoutFailures.length))
    ? `\nOBJECTIVE MEASUREMENTS (deterministic — ground your verdict in these, do not contradict them):
${pixel ? `- Pixel-match score (design vs actual browser render, neighborhood-tolerant): ${pixel.score}%
- Worst mismatch regions (design y-ranges @1366 artboard): ${JSON.stringify(pixel.regions)}` : ''}
${layoutFailures && layoutFailures.length ? `- Computed-style assertion failures (measured in the browser vs design spec):\n${JSON.stringify(layoutFailures, null, 1)}` : '- Computed-style assertions: all passed'}
Your score should be consistent with the pixel-match score: do not score more than ~5 points above it.\n`
    : '';
  const digests = sections.map((s) => sectionDigest(s, 10));
  const fileList = Object.entries(files)
    .map(([p, c]) => `===FILE: ${p}===\n${c}`)
    .join('\n');

  const content = [
    { type: 'text', text: `You are a ruthless design-QA reviewer. Compare the GENERATED CODE against the ORIGINAL FIGMA DESIGN and find every mismatch.

Check, in priority order:
1. Section completeness & order — every design section present, in order, none invented.
2. Text fidelity — headings, body copy, button labels, superscripts, footnotes character-exact.
3. VISUAL match (when DESIGN/RENDER strip pairs are provided, this is your primary evidence) — compare each region: section background colors/panels, image placement and size, spacing, typography scale, alignment. Every visible difference between a DESIGN strip and its RENDER strip is an issue.
4. Layout & alignment — grid columns, image/text placement, gaps, paddings vs the spec numbers (px @1366 artboard).
5. Color & typography — must use the design tokens (var(--gs-*) etc.) where one exists; font sizes/weights/line-heights match. IMPORTANT: if a design color has NO matching token in the token list below, a raw hex value is CORRECT — do not deduct for it and do not suggest substituting a token with a different color.
6. Assets — every image/icon/vector from the manifest that appears in the design is referenced with the correct path, sizing and alignment (no placeholders, no broken paths, nothing hotlinked).
7. EDS usage — every mapped section MUST be built on its EDS component's canonical markup and carry its signature class. A page missing ANY of these signature classes cannot score above 75:
${signatures.length ? signatures.map((s) => '   - ' + s).join('\n') : '   (no signature classes to enforce)'}
   Custom utility classes are acceptable only IN ADDITION to the EDS classes, never instead of them. Bootstrap 5.1.3 grid/utilities/JS used appropriately.
8. Responsiveness — sensible stacking <768px, no horizontal overflow at 375px.

SECTION -> EDS MAPPING (authoritative):
${JSON.stringify(mapping)}

DESIGN SPEC DIGEST (per section):
${JSON.stringify(digests, null, 1)}

DESIGN TOKENS:
${tokensBlock.slice(0, 12000)}

ASSET MANIFEST:
${assetsBlock}

${measuredBlock}
GENERATED CODE:
${fileList}

Score the match 0-100 (100 = pixel-perfect). A page with any missing section or wrong text cannot score above 70. A page with broken asset paths cannot score above 80.
Reply with ONLY this JSON:
{"score": <0-100>, "pass": <true if score >= ${passScore}>, "summary": "<2 sentences>", "issues": [{"severity":"critical|major|minor","area":"<section or file>","expected":"<what the design shows / spec value>","actual":"<what the code does>","fix":"<concrete instruction>"}]}` },
  ];

  // Prefer paired DESIGN-vs-RENDER strips (the strongest evidence); fall back
  // to the design screenshots alone when no render is available.
  let attached = attachComparisonStrips(content, pageScreenshot, renderScreenshot, 5);
  if (!attached) attached = attachScreenshots(content, pageScreenshot, sectionScreenshots);
  if (!attached) log.warn('review is running without any design screenshots (spec/code comparison only)');

  const text = await claude.complete({
    system: 'You are a meticulous design-QA reviewer. You reply with strict JSON only.',
    messages: [{ role: 'user', content }],
    maxTokens: 8000,
  });
  const verdict = extractJson(text);
  verdict.score = Number(verdict.score) || 0;
  verdict.issues = Array.isArray(verdict.issues) ? verdict.issues : [];
  // a zero score with no issues and no summary is a malformed reply, not a verdict
  if (verdict.score === 0 && !verdict.issues.length && !verdict.summary) {
    throw new Error('malformed review verdict (score 0, no issues, no summary)');
  }
  // pass on score alone — "no issues listed" with a low score is a malformed
  // verdict, not a pass
  verdict.pass = verdict.score >= passScore;
  if (!attached) verdict.note = 'review ran without screenshots';
  return verdict;
}
