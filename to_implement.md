# To implement

Backlog of known gaps, each with the observed problem and the agreed design. Nothing here is
started unless marked.

## 1. Multi-page and page × viewport exports

**Observed (2026-09-16, coast pool re-export).** The user selected the full page frame
(1920 × 7626) and the 36px top utility bar frame (1920 × 36) in one export. The pipeline's only
multi-frame mode is "several viewports of one page": it sorted the frames by width, made the 36px bar
the desktop breakpoint and the full page the ≤1023px breakpoint, and emitted
`.page-root[data-bp="header-header"] { display: none }` on desktop. Both frames compiled correctly;
on a desktop screen only the bar was visible, which looked like "only the header was converted".

**Consequence today.** Any export with more than one frame is treated as breakpoints of one page.
Two pages (Home, About) or a page plus a component are merged with the wrong one hidden. Pages ×
viewports (Home/Desktop, Home/Mobile, About/Desktop, About/Mobile) are scrambled.

**Design.**

Frames in one export mean one of three things; group them before planning:

1. *Same page, different widths* → breakpoints of one `index.html` (works today).
2. *Different pages, same width* → one HTML file per page (`index.html`, `about.html`, …), one shared
   `styles.css`, prototype `navigate` reactions between frames resolved to relative links.
3. *Pages × viewports* → group frames into pages, then breakpoints inside each group.

Grouping rule:

- Frames with the **same width are never breakpoints of each other** → separate pages.
- Frames with **different widths** whose names match after stripping viewport words
  (`Desktop`, `Tablet`, `Mobile`, `Phone`, `Web`, `App`, `1920`, `1440`, `390`, `375`, separators)
  → one page.
- Anything ambiguous → its own page. A frame whose height is under ~200px is flagged as a component,
  not a page, and reported in the plugin UI (this 36px bar should never have been selected).

Where it lands:

- **Plugin UI**: before Export, list the selected frames grouped as *page → viewport* with the
  rule's guess; the user can rename a page or drag a frame to another page. Written into
  `ir.meta.pages: [{ name, slug, frames: [{ frameId, viewport }] }]`.
- **Responsive plan**: `breakpoints` becomes per page (`pages[].breakpoints`); `sectionPairs` stays
  per page.
- **Compiler** (`src/compiler/index.ts`): `compileDocument` assembles one document per page; shared
  class dedupe across pages so `styles.css` is written once; `navigate` interactions whose
  `destinationId` is another page's frame become `href="<slug>.html"`.
- **CLI / verify**: `build` iterates pages; verify reports per page; audit only the widest frame of
  each page at widths no sibling frame covers (as today, per page).
- **Test corpus**: needs one real export with two pages and two viewports each to verify end to
  end. None on disk yet.

Estimate: compiler + CLI a few hours with the current bundles; plugin UI grouping half a day;
end-to-end verification blocked on a two-page export from the user.

## 2. JavaScript-driven interactions

Prototype reactions other than hover/press (`after-delay` carousels, `drag`, overlays, scroll-driven
motion) are recorded in the IR (`interactions[]` with trigger, action, destination, transition) but
nothing is emitted for them. Design: a small runtime (`out/app.js`) generated only when such
reactions exist; each reaction type maps to one deterministic behaviour (after-delay → timed
class toggle between variants, open-overlay → dialog with backdrop, scroll → IntersectionObserver
class). Hover/press already compile to CSS and stay CSS.

## 3. Hover-reveal layers need the re-export

Layers parked outside their clipping parent (the practice-card arrow button on Edwards) exported as
a 1 × 1 PNG under the old plugin. The plugin fix (detached-copy export) is in `src/plugin/assets.ts`
but the Edwards bundle in `v2 tests/edward-v3` predates it. One re-export verifies it.

## 4. Merged DOM for multi-frame designs (`sectionPairs`)

Case 1 today compiles each frame into its own `.page-root[data-bp]` and switches by media query.
Merging matched sections of desktop and mobile frames into one DOM (so content is not duplicated
for crawlers and screen readers) is designed (`sectionPairs` in the responsive plan) but not built.

## 5. Plan variance guard

Plans come from a model and differ run to run; the same export has swung from 1.2% to 30% under a
different plan wording (fixed in the compiler each time). Design: `build` compiles the model plan
and the heuristic plan, verifies both, keeps the better one, and logs the delta; large deltas are
the signal for a new compiler rule.

## 6. Regression command

`f2h regress` — rebuild and verify every bundle under `v2 tests/`, compare against the last stored
numbers (`v2 tests/baseline.json`), fail on any pixel or layout-only regression above a threshold.
Today this sweep is run by hand after each rule.
