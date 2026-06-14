# Figma → EDS Component Conversion Pipeline

Converts a Figma design into a **pixel-exact, responsive web page** built from the
**EDS component library** (37 components in `eds-components/`), **eds-native.css design
tokens**, and **Bootstrap 5.1.3** — using two Claude API keys: one to extract/generate,
one to independently review until the output matches the design.

## Run

```bash
node src/run.mjs              # target from .env (FIGMA_FILE_ID / FIGMA_NODE_ID)
node src/run.mjs --node 1:472 # override the target node for this run
```

Each run writes to the next free folder: `Output_1`, `Output_2`, `Output_3`, …

```
Output_N/
├─ index.html               ← open this in a browser
├─ assets/
│  ├─ images/  *.png        ← image fills exported from Figma
│  ├─ icons/   *.svg        ← small vectors (≤64px)
│  ├─ vectors/ *.svg        ← larger vector artwork
│  ├─ css/eds-native.css    ← copied design-system CSS
│  ├─ css/styles.css        ← page-scoped overrides only
│  └─ js/script.js          ← page behavior (Bootstrap components do the rest)
└─ report/
   ├─ summary.md            ← score, mapping table, stats
   ├─ mapping.json          ← section → EDS component decisions
   ├─ design-spec.json      ← compact spec extracted from Figma
   ├─ assets.json           ← asset manifest
   ├─ figma-page.png        ← reference screenshot
   └─ review-iter-N.json    ← reviewer verdicts per iteration
```

## How it works

1. **Extract** — Figma Dev Mode **MCP server** (`get_design_context`, `get_variable_defs`,
   screenshot) when the desktop app is running, plus the **REST API** for the full node
   tree, per-section screenshots and asset export. If `FIGMA_NODE_ID` is empty, the first
   top-level frame of the first page is used.
2. **Assets** — every image fill, icon and vector under the node is exported
   (PNG for bitmaps, SVG for vectors) into `Output_N/assets/`.
3. **Design spec** — the raw tree is compacted: relative boxes (px @1366 artboard),
   auto-layout, exact text, fonts, colors resolved to hex **and matched to eds-native.css
   design tokens** (`var(--gs-*)`).
4. **EDS mapping** — Claude (**key 1**) maps each page section to one of the 37 EDS
   components using a manifest auto-built from `eds-components/` (canonical markup +
   documented modifier classes).
5. **Generate** — Claude (**key 1**) produces `index.html` + overrides CSS + JS.
   Large designs are generated **section-by-section** with per-section screenshots,
   then assembled into a fixed skeleton (Bootstrap 5.1.3 CDN + eds-native.css + Inter
   + Material Symbols).
6. **Measured review loop** — each round the page is rendered in headless Chrome
   (DevTools protocol: waits for `document.fonts.ready`, exact content height), then:
   - **pixel diff**: the design and render are band-aligned and compared
     pixel-by-pixel (1px-neighborhood tolerant) → objective match % + worst regions;
   - **layout assertions**: image sizes/positions and text font/size/color from the
     design spec are checked against computed styles in the browser → precise failures;
   - Claude (**key 2**) reviews with these measurements + DESIGN-vs-RENDER strips;
   - Claude (**key 1**) fixes with the failures list + zoomed diff-region crops.
   The loop ends early at `PIXEL_PASS_SCORE` (default 95%), stops on plateau
   (`PLATEAU_EPSILON`), caps at `MAX_REVIEW_ITERATIONS` (default 5), and always
   keeps the best-measured version. History in `report/pixel-history.json`.
7. **Verify** — asset references in the final files are checked against disk;
   broken refs are reported in `report/`.

> Note: the pixel score's practical ceiling on text-heavy pages is ~92–95%, because
> Figma and Chrome rasterize fonts differently. Treat the layout-assertion count
> (target: 0) as the precision metric and the pixel score as the trend metric.

## Configuration (.env)

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY_1` | generator/extractor key |
| `ANTHROPIC_API_KEY_2` | independent reviewer key |
| `ANTHROPIC_MODEL` | default `claude-opus-4-8` |
| `FIGMA_FILE_ID` | file key (raw key, `key/Name`, or full URL) |
| `FIGMA_NODE_ID` | target node (`1:472`, `1-472`, URL, or empty = first frame) |
| `FIGMA_TOKEN` | Figma personal access token |
| `FIGMA_MCP_URL` | Dev Mode MCP server (default `http://127.0.0.1:3845/mcp`) |
| `MAX_REVIEW_ITERATIONS` | review/fix rounds, default 3 |
| `REVIEW_PASS_SCORE` | accept threshold, default 95 |
| `GEN_MAX_TOKENS` | per-call output cap, default 32000 (auto-continues) |
| `SPEC_CHAR_BUDGET` | above this spec size, generation goes section-by-section |

Requires Node 18+ (no npm install needed — zero dependencies).

> ⚠️ The keys currently in `.env` were shared in chat — **rotate them** in the
> Anthropic console and Figma settings, then paste the new values into `.env`.
