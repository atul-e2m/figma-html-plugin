# Figma → HTML

Two ways to turn a Figma page into a real website, in one repository:

| | Path | What it is | Status |
|---|---|---|---|
| **v2** | [`v2/`](v2/) | **Extract → Plan → Compile → Verify** pipeline. A facts-only Figma plugin writes an IR; a planner (Claude via OpenRouter, or heuristics) writes *decisions*; a deterministic compiler emits HTML/CSS; Playwright pixel-diffs the result against Figma. | Active. All new work goes here. |
| v1 | repo root | The original single plugin: converts a selected frame to HTML/CSS or JSX inside Figma with an AI layout planner. | Kept working, no longer developed. |

The idea behind v2: an agent that edits HTML never accumulates fixes. A compiler does. Every
fidelity or responsive fix is a **rule** in the compiler (or a fact the plugin records), so the next
design gets it for free. The model only ever touches `plan.json` (structure decisions), never pixels.

## Results

Measured with `f2h verify`: the page is rendered in headless Chromium at the design width and
pixel-diffed against Figma's own screenshot. *Layout-only* masks text glyphs so font anti-aliasing
does not count. Height exact on every design.

| Design | Frame | Nodes | Pixel mismatch | Layout-only | Fresh build time |
|---|---|---|---|---|---|
| Edwards Appeals (law firm) | 1920 × 9702 | 280 | 1.17 % | 0.53 % | 3 min 28 s |
| Private Discovery, desktop + mobile frames | 1920 + 390 | 682 | 1.5 % / 4.25 % | 0.84 % / 2.86 % | 4 min 16 s |
| PixeSaaS demo (3447-dot vector map) | 1440 × 9413 | 3939 | 3.39 % | 1.19 % | 2 min 42 s |
| Claude Cowork webinar | 1440 × 4948 | 1285 | 5.0 % | 0.35 % | 2 min 11 s |
| East Coast Custom Pools (HTML-imported design) | 1920 × 7626 | 488 | 4.09 % | 2.4 % | 3 min 13 s |

Build time is a full fresh conversion including the two model calls (plan + responsive review);
the compiler itself runs in 20–240 ms. Single-frame designs also come out responsive (tablet and
phone) with an audit of overflow / clipped / overlapping text at 390, 768, 1024 and 2560 px.

## Quick start (v2)

```bash
cd v2
npm install
npm run build:plugin            # -> v2/plugin/code.js
npm test

cp .env.example .env            # put OPENROUTER_API_KEY=... here (never in the plugin)
```

1. Figma desktop → **Plugins → Development → Import plugin from manifest…** → `v2/plugin/manifest.json`.
2. Select the page frame(s) — several frames (desktop + mobile) export together as breakpoints — run
   **Figma IR Extractor**, Extract, Download ZIP.
3. Convert:

```bash
node src/cli.ts unzip ~/Downloads/<name>-ir.zip <bundle-dir>
node src/cli.ts build <bundle-dir>          # plan → compile → verify → responsive review → verify
open <bundle-dir>/out/index.html
```

Verify needs `python3` with `playwright` (Chromium installed), `Pillow` and `numpy`.
Without an API key `build --no-model` uses the heuristic planner.

Full documentation of the pipeline, the responsive behaviour, interactions (hover/press from Figma
prototype variants), debugging tools and known limits: **[`v2/README.md`](v2/README.md)**.

## Repository layout

```
v2/
  src/plugin/      Figma plugin: extractor (facts only), asset export, screenshots
  src/ir/          IR + plan schemas (figma-ir/1, figma-plan/1)
  src/planner/     outline, prompts, heuristic default plan, Anthropic / OpenRouter clients
  src/compiler/    resolve (IR + plan → element tree), style, responsive, emit
  src/cli.ts       f2h: unzip | plan | compile | verify | refine | responsive | build
  tools/           verify.py (pixel diff), audit.py (responsive audit), crops.py, f2h_inspect.py
  test/            compiler fixture tests (node --test)
  plugin/          manifest.json + ui.html (code.js is built)
src/, ui.html, manifest.json, tools/     v1 plugin (see below)
docs/RESEARCH.md                         background research
```

Exported design bundles, generated sites, zips and result sheets are local test data and are not
committed (see `.gitignore`).

## Contract

- The plugin records **facts** (geometry, auto-layout, fills, text, reactions, exported bytes) and
  never decides layout.
- The planner records **decisions** (page root, sections, flow/grid/overlay per container, tags,
  decorations, text policy, responsive actions) and never a pixel value.
- The compiler is a **pure function** of IR + plan. Same input, same output.
- Nobody edits a generated page. A wrong page means a missing rule.

## v1 plugin (original)

Import `manifest.json` from the repo root in the Figma desktop app, select one frame, run
**Figma to HTML / JSX**, paste an Anthropic or OpenRouter key once (stored in Figma client storage)
for the AI planner, pick HTML or JSX, Generate, Download ZIP. The ZIP contains semantic HTML +
CSS, a React component, the AI layout plan, section specs, tokens, content and every asset.

```bash
npm install
npm run build        # bundle src/code.ts -> code.js
npm run typecheck
```

If `npm run build` hangs or is killed on macOS, clear Gatekeeper's quarantine flag on the esbuild
binaries once:

```bash
xattr -d com.apple.quarantine node_modules/@esbuild/darwin-arm64/bin/esbuild
cp node_modules/@esbuild/darwin-arm64/bin/esbuild node_modules/esbuild/bin/esbuild
```

## Known limits

- Video bytes cannot be exported by the Figma plugin API; a poster frame is written and the node is
  recorded, supply the real file.
- Figma has no CSS animations. Hover and press states come from prototype variants; after-delay,
  drag, overlay and scroll-driven interactions are recorded in the IR but not yet emitted.
- Plans come from a model and vary between runs. The compiler is hardened against every variant
  seen so far, and every bundle is rebuilt after each rule; keep doing that.
