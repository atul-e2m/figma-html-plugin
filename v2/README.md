# Figma IR pipeline (v2)

Three stages, three files, one direction:

```
Figma ──plugin──▶ ir.json (+assets, screenshots) ──planner──▶ plan.json ──compiler──▶ index.html + styles.css
                  FACTS only                        DECISIONS only         deterministic, ms
```

- **Extract** (`plugin/`) runs inside Figma. It writes `figma-ir/1`: one node per layer with resolved
  auto-layout, sizing, constraints, fills, strokes, effects, text segments, reactions, plus exported
  bytes for vectors, images, image fills, masked/rotated groups and icon groups, and a full-frame
  screenshot per selected frame. Select several frames (desktop + mobile) to export breakpoints together.
- **Plan** (`src/planner/`) writes `figma-plan/1`: page root, sections, layout kind per container
  (flow / grid / overlay / absolute), semantic tags, links, decorations, text reflow policy, repeaters.
  Heuristics always produce a plan; with an API key, Claude reads the outline + screenshot strips and
  returns a schema-validated plan (`--no-model` forces heuristics). Plans are cached per outline hash.
- **Compile** (`src/compiler/`) is a pure function IR + plan → HTML/CSS. Same input, same output.
  Every fix here is a rule that applies to every future design.
- **Verify** (`tools/verify.py`) renders the result in headless Chromium at the frame width, measures
  section heights / overflow / broken images and pixel-diffs against the Figma screenshot.
  `f2h build --refine N` feeds those measurements back to the planner.

## Setup

```bash
cd v2
npm install
npm run build:plugin        # -> plugin/code.js
npm test
```

Figma desktop → Plugins → Development → Import plugin from manifest… → `v2/plugin/manifest.json`.

Verify needs `python3` with `playwright` (chromium installed) and `Pillow`.

## Use

1. In Figma, select the page frame(s), run **Figma IR Extractor**, Extract, Download ZIP.
2. `node src/cli.ts unzip ~/Downloads/<name>-ir.zip` (or unzip it yourself).
3. `node src/cli.ts build <bundle-dir>` — plan → compile → verify. Output in `<bundle-dir>/out/`.

Commands:

```
f2h plan    <bundle> [--no-model|--model claude-opus-5] [--dry-run] [--effort high]
f2h compile <bundle> [--out dir]
f2h verify  <bundle> [--out dir]            # writes out/verify/<frame>.report.json + -side.png
f2h refine  <bundle>                        # model corrects the plan from verify measurements
f2h responsive <bundle>                     # model corrects the responsive baseline from the audit
f2h build   <bundle> [--no-model] [--refine 2]
```

`ANTHROPIC_API_KEY` (or an `ant auth login` profile) enables the model planner via the Anthropic SDK;
`OPENROUTER_API_KEY` enables it via OpenRouter (`anthropic/claude-opus-5`, OpenAI chat format, strict
`response_format` json_schema). `--provider` / `--model` override the auto-detection. Model calls opt into
server-side refusal fallbacks and retry without them if the account does not accept the parameter.

## Bundle layout

```
<bundle>/
  ir.json                 figma-ir/1 (src/ir/schema.ts)
  assets/                 exported png / svg
  screenshots/<frame>.png full-frame render at ir.frames[].screenshotScale
  plans/<frame>.plan.json figma-plan/1 (src/ir/plan.ts) — hand-editable
  plans/responsive.plan.json  breakpoints when several frames were extracted
  out/index.html, out/styles.css, out/assets/, out/report.json, out/verify/
```

## Responsive behaviour

Two cases, both handled:

**Several frames were exported (desktop + tablet + mobile).** Each frame compiles into its own
`.page-root[data-bp]` and media queries switch between them at the breakpoints in
`plans/responsive.plan.json` (defaults: phone ≤767, tablet ≤1023, else desktop). The design is the
authority at every width it was drawn for: a frame gets no responsive transforms at or above its own
width, nor for widths another frame serves (`pruneMedia`). Verify diffs each frame against its own
screenshot and audits the desktop frame only at widths no other frame covers. Tested end to end on a
1920 + 390 export. Merging the frames into one DOM (`sectionPairs`) is the next step and not done yet.

**Screens wider than the design.** The page root is not capped. Every full-width section is split
into an outer box that bleeds to the viewport edges (its background, backdrop photo, torn edges,
stripes, spanning panels) and a centred inner box of the design width that holds the content. Sections
made of full-width bands (stripes + navbar) bleed band by band. Below the design width the inner is
100% wide, so nothing changes there.

**One frame only.** The compiler makes it responsive in two layers:

1. *Deterministic baseline* (`src/compiler/responsive.ts`). At the design width nothing changes.
   Below it: side padding, gaps, offsets and large type scale with the viewport; grids drop columns
   (4+ → 2 on tablets, everything → 1 on phones; 3 narrow columns stay 3); text rows wrap; content
   rows with 2–3 wide columns share the width on tablets and stack from portrait tablets (≤900) down;
   overlays (text on a photo) become a stacked column over their backdrop on phones; text-less
   compositions (photo + plate + badge) scale as one picture; a *collage* (a container whose picture
   is its own background image, or one covering image, with small captions over it) also scales as
   one picture, its captions shrinking with it through container-query units, and on phones the
   picture keeps its box (as top padding) with the captions in flow beneath it; fixed heights that hold
   text open up; absolutely placed badges/photos inside flowing content are hidden (small) or join the
   flow (large); nowrap text may wrap; a header that overlaps the hero pushes the hero's stack down;
   a header row (logo | links | actions) too wide for a portrait tablet drops its `<nav>` to its own
   centred line; four or six small equal items (counters) wrap 2-up instead of 3 + 1; hug-width
   containers may shrink below the design width so fixed-width text inside them wraps instead of
   overflowing; an image never grows past its designed width when it goes "full width" or stacks;
   only an image that carries its column goes fluid (an avatar or icon beside text keeps its size).
2. *Model corrections* (`f2h responsive`, part of `f2h build`). The model sees the design, the
   baseline's own tablet/phone renders and the audit of them, and returns per-node decisions in a
   closed vocabulary — `stack`, `row`, `wrap`, `columns N`, `hide`, `full-width`, `center`, `keep` —
   stored in `plan.responsive` and applied under the matching media query. Hand-editable like the
   rest of the plan. `columns N` on a flex row wraps it with each item `100%/N` minus the row's gap
   expression; a `stack` on a collage is ignored (the picture already handles phones).

`f2h verify` renders single-frame designs at 1024, 768 and 390 and writes
`out/verify/<frame>-vp<width>.png` plus `<frame>.audit.json`: horizontal overflow, clipped text,
overlapping text, text under 12px, and a score. Zero is the goal; the audit is what the model reads.

## Robustness to the plan and to imported designs

Plans are written by a model and differ from run to run. The compiler must produce the same page
from any reasonable plan, so every plan-induced collapse is fixed in the compiler, never by editing
the plan: a `grid` on a column of transparent row wrappers uses the grandchildren as cells (the
column's gap between rows, the wrapper's gap between columns); an `overlay` on a photo card with a
caption scales as a picture whose width is the design width capped at 100% (never `width: 100%`,
which collapses inside a hug parent). HTML-imported designs record auto-layout their boxes
contradict, and the boxes win: a child drawn before the previous one ends is positioned (the frame
keeps its designed height); a child sitting at the far or middle of the cross axis is aligned there;
an edge decoration (palm frond) overlapping a bigger sibling in a layout-less section is pinned, not
flowed; a paragraph whose every line ends in a hard break never soft-wraps (the browser's font would
add a second break per line).

Regression corpus: every bundle directory beside `v2/` is rebuilt (`compile` + `verify`) after each
rule, and once per session each is also rebuilt with `--replan` in a scratch copy to expose plan
variance. Numbers today: edward-v3 1.17 / 0.53, pd-multi-ir-3 1.5 / 0.84 (mobile 4.25 / 2.86),
home-page-v2 3.39 / 1.19, webinar-ir 5.0 / 0.35, coast-pool-ir 4.09 / 2.4 (pixel / layout-only %).

## Where rules live

| Concern | File |
|---|---|
| IR types, walk/index helpers | `src/ir/schema.ts` |
| Plan types, JSON schema, normalisation | `src/ir/plan.ts` |
| What gets bytes exported | `src/plugin/extract.ts` (export policy block) |
| Flow / grid / overlay / absolute, sizing, text runs | `src/compiler/resolve.ts` |
| IR → CSS values (fills, strokes, effects, text) | `src/compiler/style.ts` |
| Fluid baseline / media queries | `src/compiler/responsive.ts` |
| Class allocation, HTML, CSS text | `src/compiler/emit.ts` |
| Heuristic plan, outline, prompts, model call | `src/planner/` |

## Re-extracting with rasterisation

`f2h raster-list <bundle>` prints the node ids the plan wants flattened but the bundle has no bytes
for. Paste that JSON (or the whole `plan.json`) into the plugin's Rasterize box and extract again.

## What the plugin records beyond geometry

- `readingOrder` on every frame without auto-layout (row-major reading order; Figma stores paint order).
- Pattern groups (≥ 24 equal shapes) as one PNG; regular stripes are still rebuilt as a CSS gradient.
- `meta.fonts`: every family used and whether the extracting machine had it.
- Screenshots at exactly the frame's box (a non-clipping frame is exported through a clipped clone),
  with `screenshotBox` recorded.
- Instance fills through a temporary rectangle, so cropped image fills survive on instances.

Verify prints two numbers: `pixel mismatch` (everything) and `layout only` (text boxes masked out),
so a missing font never reads as a layout error.

## Debugging a mismatch

```bash
python3 tools/crops.py <bundle>                 # out/verify/sec-<section>.png: Figma left, HTML right
python3 tools/f2h_inspect.py <bundle> <node-id | name or text substring>   # ancestor chain: IR facts + emitted CSS
```

Read the crops first, find the section, then inspect the node. Fix the rule in `src/compiler/`, re-run
`f2h compile` + `f2h verify` (no re-plan needed; plans are cached), and check the number moved.

## Fonts

Every family the design uses gets a Google Fonts link (one per family) **and** an `@font-face` with
`src: local("Family"), url("fonts/<family>-<weight>[-italic].woff2")`. Licensed fonts that are not on
Google Fonts therefore render correctly on a machine that has them installed, or once you drop the
files into `out/fonts/` with the names listed under `fontFiles` in `out/report.json`. Until then the
browser falls back to a generic face and text wraps differently; verify's pixel mismatch reflects that.

## Interactions

Figma has no CSS animations, but it has prototype reactions. The plugin records every reaction
(trigger, action, transition duration/easing, destination) and, for a hover or press reaction that
changes an instance to another variant of the same component set, extracts that variant as a
`states.hover` / `states.press` subtree. The compiler resolves the state with the same rules and
diffs it against the default: root deltas become `.cls:hover` (or `:active`), descendant deltas
become `.cls:hover [data-figma-id="…"]`, and a child that moved gets a `translate` (composed with
its resting transform). Children are paired by layer name, not index, because variants reorder
layers; a layer the variant drops fades out (`opacity: 0`), and an image whose variant export differs
(a darker overlay baked into the PNG) is swapped with `content: url(…)`. The root's own size is never
a hover delta when both variants have the same box. The transition uses the reaction's own duration
and easing. A child that exists only in the hover variant is reported as a warning and not styled.

A hover-reveal layer that rests fully outside its clipping parent (a button parked below the card)
has no render bounds in Figma and exports as a 1×1 image in place. The plugin detects this and
exports a detached copy instead (cloning the outermost instance and detaching it when needed).

Not covered: after-delay triggers (auto-playing carousels), drag, overlays, scroll-driven motion.
Those need JavaScript and are recorded in the IR for a later pass.

## Known limits

- Video bytes cannot be exported by the Plugin API; a poster is written and `<video poster>` emitted.
- Figma has no responsive information beyond constraints and fill/hug; real breakpoints need real frames.
- Rasterising a node the planner picks after extraction needs a re-extract with that id in the
  plugin's "Rasterize node ids" box (the compiler warns when the asset is missing).
- Text list styles (bullets) and paragraph spacing are recorded in the IR but not yet emitted.
