# Figma → HTML

Turn a Figma page into a real, responsive website with a pipeline instead of an agent:

```
Figma ──plugin──▶ ir.json (+assets, screenshots) ──planner──▶ plan.json ──compiler──▶ index.html + styles.css ──verify──▶ pixel diff vs Figma
                  FACTS only                        DECISIONS only         deterministic, ms                 Playwright
```

An agent that edits HTML never accumulates fixes; a compiler does. Every fidelity or responsive fix
is a **rule** in the compiler (or a fact the plugin records), so the next design gets it for free.
The model only ever writes `plan.json` (structure decisions), never a pixel, never HTML.

## Results

`f2h verify` renders the page in headless Chromium at the design width and pixel-diffs it against
Figma's own screenshot. *Layout-only* masks text glyphs so font anti-aliasing does not count.
Height exact on every design.

| Design | Frame | Nodes | Pixel mismatch | Layout-only | Fresh build time |
|---|---|---|---|---|---|
| Edwards Appeals (law firm) | 1920 × 9702 | 280 | 1.17 % | 0.53 % | 3 min 28 s |
| Private Discovery, desktop + mobile frames | 1920 + 390 | 682 | 1.5 % / 4.25 % | 0.84 % / 2.86 % | 4 min 16 s |
| PixeSaaS demo (3447-dot vector map) | 1440 × 9413 | 3939 | 3.39 % | 1.19 % | 2 min 42 s |
| Claude Cowork webinar | 1440 × 4948 | 1285 | 5.0 % | 0.35 % | 2 min 11 s |
| East Coast Custom Pools (HTML-imported design) | 1920 × 7626 | 488 | 4.09 % | 2.4 % | 3 min 13 s |
| Famous Vineyards (no auto-layout, licensed fonts not on Google) | 1440 × 6225 | — | 6.49 % | 3.22 % | — |

Build time is a full fresh conversion including the two model calls (plan + responsive review);
the compiler itself runs in 20–240 ms. Single-frame designs come out responsive (tablet and phone)
with an audit of overflow / clipped / overlapping text at 390, 768, 1024 and 2560 px.

## The three stages

- **Extract** (`plugin/`, source in `src/plugin/`) runs inside Figma. It writes `figma-ir/1`: one node
  per layer with resolved auto-layout, sizing, constraints, fills, strokes, effects, text segments,
  reactions and hover/press variant subtrees, plus exported bytes for vectors, images, image fills,
  masked/rotated groups and icon groups, and a full-frame screenshot per selected frame. Select
  several frames (desktop + mobile) to export breakpoints together.
- **Plan** (`src/planner/`) writes `figma-plan/1`: page root, sections, layout kind per container
  (flow / grid / overlay / absolute), semantic tags, links, decorations, text reflow policy, repeaters,
  responsive actions. Heuristics always produce a plan; with an API key, Claude reads the outline +
  screenshot strips and returns a schema-validated plan (`--no-model` forces heuristics). Plans are
  cached per outline hash.
- **Compile** (`src/compiler/`) is a pure function IR + plan → HTML/CSS. Same input, same output.
- **Verify** (`tools/verify.py`, `tools/audit.py`) renders the result, measures section heights,
  overflow, broken images and pixel-diffs against the Figma screenshot; audits the responsive
  renders. `f2h build` feeds the audit back to the planner once.

## Setup

```bash
npm install
npm run build:plugin        # -> plugin/code.js
npm test
```

Figma desktop → Plugins → Development → Import plugin from manifest… → `plugin/manifest.json`.

Verify needs `python3` with `playwright` (chromium installed) and `Pillow`.

## Use

1. In Figma, select the page frame(s), run **Figma IR Extractor**, Extract, Download ZIP.
2. `node src/cli.ts unzip ~/Downloads/<name>-ir.zip` (or unzip it yourself).
3. `node src/cli.ts build <bundle-dir>` — plan → compile → verify. Output in `<bundle-dir>/out/`.

Commands:

```
f2h plan    <bundle> [--no-model|--model claude-opus-5] [--dry-run] [--effort high]
f2h compile <bundle> [--out dir]
f2h elementor <bundle> [--public-base url]  # Elementor Editor V4 template -> out/elementor/ (see below)
f2h verify  <bundle> [--out dir] [--url u]  # writes out/verify/<frame>.report.json + -side.png
f2h refine  <bundle>                        # model corrects the plan from verify measurements
f2h responsive <bundle>                     # model corrects the responsive baseline from the audit
f2h build   <bundle> [--no-model] [--refine 2]
```

## Elementor (Editor V4)

The same IR + plan compiles to an Elementor **Editor V4** page: `src/compiler/elementor.ts` is a second
emitter over the resolved element tree (`resolveDocument`), so every layout rule in `resolve.ts` and
`responsive.ts` applies to both targets. Nothing goes through HTML.

```
Figma ──plugin──▶ ir.json ──planner──▶ plan.json ──resolve──▶ El tree ──┬─▶ index.html + styles.css
                                                                        └─▶ template.json + elementor.css
```

| El | Elementor V4 element |
|---|---|
| container (flow / overlay / absolute) | `e-flexbox`, display / width / min-width / position / padding always stated |
| container (grid) | `e-grid`, tracks + `grid-template-rows: none` + gap always stated |
| h1…h6 | widget `e-heading` |
| p / span / text link | widget `e-paragraph` (+ `link`) |
| a / button with a box | widget `e-button` |
| img, video poster | widget `e-image` (URL; the import uploads it to the media library) |
| svg | widget `e-svg` (file written next to the assets) |

Styles are V4 *local classes*: one style definition per element with `desktop`, `hover`, `tablet`
(≤1024) and `mobile` (≤767) variants — the same breakpoints `responsive.ts` emits — written as typed
prop values (`size`, `dimensions`, `background` with image/gradient overlays, `box-shadow`, `transform`,
`filter`, `transition`, `layout-direction`…) so the client edits them in the editor. What the V4 style
schema cannot hold (`white-space`, `text-box-trim`, a 900px query, `transform: none`, descendant hover
deltas, styled text runs) goes to a companion stylesheet keyed by the element's `_cssid`
(`#f2h-<id>`), which survives the id regeneration Elementor performs on import. `report.json` counts
native vs companion declarations per property, so the companion shrinks as V4 grows.

Defaults matter more than in HTML: atomic containers still carry the legacy `.e-con` rule
(`width: 100%; min-width: 0; position: relative`), the flexbox base style says `display: flex;
padding: 10px`, the grid base is 3 × 2 `1fr` tracks with a 20px gap, and the site Kit uppercases
h1/h2. The emitter states every one of those properties on every element, from the design or as the
CSS default the HTML build relied on. Three more Elementor quirks the emitter works around: a partial
`flex` (only `flex-shrink: 0`) is rendered as `flex: 0 0`, basis 0%, so all three parts are always sent;
the renderer filters PHP-falsy values, so a numeric `z-index: 0` never reaches the stylesheet and goes to
the companion css; and an inline SVG gets `fill="currentColor"` on its root, so the root's own fill is
kept on a wrapping `<g>` (a stroke-only circle otherwise fills with the text colour). A V4 font-family is
a single name, so for a licensed family the extracting machine did not have, the companion `@font-face`
lists local fonts of the same generic (Helvetica Neue / Arial for sans-serif) after the missing file:
the editor still shows the design's family, and the browser falls back the way the HTML build does.

```bash
f2h elementor <bundle> [--public-base https://site/wp-content/uploads/f2h/<slug>]   # -> out/elementor/
tools/elementor_deploy.sh <bundle> ~/Local\ Sites/<site> [--validate-only]          # Local (localwp) site
f2h verify <bundle> --url http://<site>/f2h-<slug>/                                   # pixel diff the live page
python3 tools/f2h_compare.py <bundle> <url> <figma-id ...>                           # same nodes, both renders
```

The deploy script runs wp-cli under the site's own PHP + php.ini, enables Editor V4 (the same
experiment set the editor's opt-in button writes), copies `assets/` + `fonts/` + `elementor.css` to
`wp-content/uploads/f2h/<slug>/`, validates the template against the installed prop schemas
(`tools/elementor_validate.php`), imports it through the Elementor library (images and SVGs are
downloaded into the media library; needs the site reachable at its own URL), turns the template into a
published page at `/f2h-<slug>/` and hooks the companion stylesheet through a one-file mu-plugin.
Re-deploying replaces the page and keeps the media it reuses.

Verified on Elementor 4.2.3 + Pro 4.1.2, Hello Elementor theme (pixel / layout-only mismatch against the Figma screenshot, same verify as the HTML build):

| Design | HTML build | Elementor V4 page |
|---|---|---|
| Edwards Appeals | 1.17 % / 0.53 % | 1.16 % / 0.53 % (height exact) |
| PixeSaaS demo | 3.32 % / 1.14 % | 3.32 % / 1.14 % (height exact) |
| Private Discovery homepage (1920 × 11072, 360 elements) | 2.03 % / 1.29 % | 2.03 % / 1.29 % (height exact) |
| E2M staging homepage (1440 × 10335, 3386 nodes, licensed font missing) | 5.17 % / 2.44 % | 6.83 % / 4.17 % (height +7 px) |

Not done yet: a multi-frame export emits the widest frame only (Elementor's breakpoints take over
below it); video widgets (poster emitted as an image); brightness/contrast filters and skews;
V4 `html-v3` children for styled inline spans (runs use `<span id>` + companion css for now).

## Model planner

Copy `.env.example` to `.env` at the repo root. `ANTHROPIC_API_KEY` (or an `ant auth login` profile) enables the model planner via the Anthropic SDK;
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
add a second break per line). Overlapping sections stack in Figma's paint order along the full layer
path, honouring a container's "reverse z-index" flag (a CTA card that sits over the footer inside one
Footer instance stays on top), and a section with no paint of its own inherits the fill of the painted
wrapper it lives in (two sections grouped in one dark band). A large decoration that does not reach the
section's edges (a dotted pattern behind the content) is anchored to the centred content, not the
viewport's left edge, so it stays centred on wide screens. An attached layer takes its stacking from
Figma's paint order (behind the content or in front of it), and a decoration that spans several sections
(a dotted pattern behind a whole dark band) is attached to each section it covers, clipped to that
section's slice, so it neither stops at the first section nor paints over the previous one.

More rules that came out of re-exports of the same designs: a container tagged `h1`–`h6` (a headline
drawn as several layers plus a highlight block) keeps every descendant as phrasing content, because a
heading start tag inside an open heading closes it in the HTML parser and the rest of the layers end
up positioned against the wrong box; members of an overlap cluster (a layout-less section whose waves,
backdrop and content row overlap) get their designed width, never a percentage cap; in an inferred row
a child that shares the start edge with its siblings is start-aligned even if it is also centred in the
frame (no double offset), children that run past a fixed frame keep their size (`flex-shrink: 0`), and
a wrapping row is ordered line by line; grid cards drawn at different heights are not stretched. The
plugin records the screenshot box from the export's render bounds (a frame's own effect pads the PNG),
and verify centres the box in the pixels when an older export disagrees.

Between the tablet query and the design width nothing used to be measured, and a 1920 design opened
on a 1440 laptop broke in ways verify never saw. The audit now also renders at 1440. Rules from that:
a small composition that holds text (a headline drawn as separate lines plus a highlight block, a
CTA card) scales its text, offsets and sizes with its own width through container-query units, and
fluid type leaves that text alone, so the layers stay aligned at every width; `cqw` is measured on the
container's content box, so the unit is computed against the design width minus the side padding; a
layout-less frame with one centred child centres it (`align-items: center`, and `align-self: center`
on a stretched child) instead of padding it from the left.

Wide screens (2560) on a layout-less design taught three more rules: when every child of a frame
belongs to one overlap cluster that fills the frame, the frame itself is the composition (a wrapper
group would be a fixed-width box that neither centres nor bleeds); a bleed layer keeps `left: 0;
right: 0` through the composition-scaling pass; a card section with near-equal side margins (62 / 59)
centres on wide screens; and a stretch-constrained child with equal insets (a 1271 content row in a
1923 section) is a centred fixed-width box capped at 100%, not two fluid insets that squeeze it on
1440–1900 screens.

Regression corpus: every bundle in the local `v2 tests/` directory (not committed) is rebuilt (`compile` + `verify`) after each
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
and easing. A child's slide is measured inside its own parent, so a bar that slides up carries its title
and arrow with it. A child Figma resizes on hover (the bar growing to reveal copy) gets that size, and a
layer that exists only in the hover variant is rendered in the default tree hidden (`display: none` in
flow, `opacity: 0` when positioned) and revealed in the state, so the bar grows with the copy it reveals.
Every child that changes in the state gets the reaction's transition, and a growing box gets an explicit
resting height, so heights animate instead of jumping. When several instances hover into one shared
component variant while each shows its own picture, the variant's picture is the master's and is never
swapped in. A clipping frame holding two copies of one icon (one parked outside the clip) is a swap rig:
it is kept as elements so the arrows fly on hover instead of being flattened into one picture.

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
