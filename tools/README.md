# Visual QA tools (used to hand-match `frame-4804-export 2/html` to Figma)

Requires `python3` with `playwright` (chromium) and `Pillow`/`numpy`.

- `pixdiff.py <index.html> <tag>` — renders the page at 1920px in headless Chromium
  (scrolls to load lazy images), composites the Figma PNG on white at exact 0.5 scale,
  and prints per-200px-band mismatch plus overall %. Writes `<tag>-html.png`,
  `<tag>-side.png` (Figma left, HTML right) and `<tag>-report.json`.
  Edit `FIG` at the top to point at the Figma full-frame export (2x PNG).
- `sbs.py <tag>` — per-section side-by-side crops (`<tag>-sbs-<section>.png`); section
  offsets are hardcoded for Frame 4804 (header 0, hero 111, about 1110, …).
- `match.py` — `search(region, image, scales, flip)` template-matches an image inside a
  region of the Figma PNG (gradient NCC at 1/8 res). Used to find exact photo crops
  (map layers, why-us background) instead of guessing.

Section offsets: each Figma section overlaps the previous by 1px, so section N starts at
sum(heights) − N. Frame 4804: header 112, hero 1000, about 944, tours 1855, why 1403,
testimonials+regions 1672, news 1446, instagram 703, cta+footer 1945 → 11072 total.
