/**
 * Responsive behaviour for a frame that was designed at ONE width.
 *
 * Three layers:
 *  1. Fluid baseline — at the design width nothing changes; below it values
 *     scale instead of overflowing (padding, gaps, offsets, type).
 *  2. Content-driven restructuring — every row, grid and overlay is given the
 *     viewport width at which its content stops fitting (from the design boxes
 *     and the text), and the transform a designer would apply there (rows
 *     become columns or wrap, grids lose columns, overlays stack over their
 *     backdrop, fixed heights open up, images go fluid) is emitted under the
 *     nearest breakpoint bucket ABOVE that width, so it is in force before the
 *     content breaks. The buckets are Elementor's device set (laptop 1366,
 *     tablet 1200/1024, mobile 880/767) so both emitters share one ladder.
 *  3. Stretching — a frame narrower than the viewports it must serve (a 390
 *     phone frame shown at 700) grows to the viewport instead of sitting as a
 *     centred column of its design width.
 *
 * The plan can override any transform per node (`responsive` entries); the
 * heuristics here are what runs when it says nothing. Hints from a paired
 * narrower frame (the designer's own phone layout) drive stacking order and
 * alignment where they exist.
 */
import type { El, Section } from "./resolve.ts";
import { hasText } from "./resolve.ts";
import { px } from "./style.ts";

/* -------------------------------------------------------------- buckets */

/** Breakpoint buckets (max-width), widest first. Elementor: laptop, tablet_extra, tablet, mobile_extra, mobile. */
export const BUCKETS: readonly number[] = [1366, 1200, 1024, 880, 767];
export const mq = (w: number) => `(max-width: ${w}px)`;
export const TABLET = mq(1024);
/** Portrait tablets: two wide columns no longer fit side by side. */
export const TABLET_SM = mq(880);
export const PHONE = mq(767);
/** Names the plan uses for the buckets. */
export const BUCKET_BY_NAME: Record<string, number> = { laptop: 1366, "tablet-lg": 1200, tablet: 1024, "tablet-sm": 880, phone: 767 };
export type BucketName = "laptop" | "tablet-lg" | "tablet" | "tablet-sm" | "phone";
export const atQuery = (at: string): string => mq(BUCKET_BY_NAME[at] ?? 767);
/** Narrowest viewport a bucket must still hold: one above the next bucket, or a small phone. */
export function bucketFloor(b: number): number { const i = BUCKETS.indexOf(b); return i >= 0 && i + 1 < BUCKETS.length ? BUCKETS[i + 1] + 1 : 320; }
/**
 * The query a transform fires under so that it is already in force when the viewport is `breakW`
 * wide: the smallest bucket at or above `breakW`, below the design width. Content that breaks
 * above the widest usable bucket is restructured from that bucket down; between the design width
 * and it the fluid layer and the column shares keep it from overflowing.
 */
export function bucketAtOrAbove(breakW: number, W: number): string {
  const usable = BUCKETS.filter((b) => b < W);
  if (!usable.length) return mq(W - 1);
  for (let i = usable.length - 1; i >= 0; i--) if (usable[i] >= breakW) return mq(usable[i]);
  return mq(usable[0]);
}
const queryMax = (q: string): number => parseInt(q.match(/max-width:\s*(\d+)px/)?.[1] || "0", 10);
/** The wider of two max-width queries (the one that fires first). */
const widerQ = (a: string, b: string): string => (queryMax(a) >= queryMax(b) ? a : b);

export type ResponsiveAction = "stack" | "wrap" | "hide" | "columns" | "full-width" | "center" | "keep" | "row";
export interface ResponsiveDecision { at: string; action: ResponsiveAction; columns?: number }
export type ResponsiveIndex = Map<string, ResponsiveDecision[]>;

/**
 * What a paired narrower frame (the designer's phone layout) says about nodes of this frame:
 * the vertical order of matched content, its text alignment, and content the designer dropped.
 */
export interface FrameHints {
  /** node id -> rank in the narrow frame's reading order (smaller = earlier) */
  order: Map<string, number>;
  /** text node id -> text-align in the narrow frame */
  align: Map<string, string>;
  /** node ids (text-bearing) that have no counterpart in the narrow frame */
  dropped: Set<string>;
}

const vw = (v: number, W: number) => `min(${px(v)}, ${Math.round((v / W) * 10000) / 100}vw)`;
const num = (v: string | undefined): number | null => { if (!v) return null; if (v === "0") return 0; const m = v.match(/^(-?[\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
/** Column-gap expression of a flex container: the last token, or the whole value when it is a math function (`min(77px, 5.35vw)`). */
const gapExprOf = (e: El, fallback = "0px"): string => { const g = e.style["gap"]; if (!g) return fallback; return g.includes("(") ? g : g.split(/\s+/).pop() || fallback; };
/** The design gap in px; a fluid gap `min(123px, 6.41vw)` counts as 123. */
const gapPx = (e: El): number => { const t = gapExprOf(e); return num(t) ?? parseFloat(t.match(/([\d.]+)px/)?.[1] || "0") ?? 0; };
const media = (e: El, q: string, st: Record<string, string>) => { e.media[q] = { ...(e.media[q] || {}), ...st }; };
const decided = (idx: ResponsiveIndex, e: El, at: string): ResponsiveDecision[] => (idx.get(e.id) || []).filter((d) => d.at === at);
/** A `keep` at `at` or any wider bucket freezes the node from that bucket down. */
const keep = (idx: ResponsiveIndex, e: El, at: string): boolean => {
  const w = BUCKET_BY_NAME[at] ?? 767;
  return (idx.get(e.id) || []).some((d) => d.action === "keep" && (BUCKET_BY_NAME[d.at] ?? 767) >= w);
};
const textOf = (e: El): string => (e.text ?? (e.runs ? e.runs.map((r) => r.text).join("") : "")).trim();
/**
 * A layer parked entirely outside its clipping parent (a hover-reveal excerpt
 * or arrow button that slides in) is invisible by design. Once the overlay
 * restacks or grows it must stay hidden instead of joining the flow.
 */
const restsOutside = (k: El, e: El): boolean =>
  e.style["overflow"] === "hidden" && k.style["position"] === "absolute" &&
  (k.box.y >= e.box.h - 1 || k.box.x >= e.box.w - 1 || k.box.y + k.box.h <= 1 || k.box.x + k.box.w <= 1);

/**
 * A container whose children are all placed by coordinates behaves as an absolute composition
 * whatever the plan called it: a frame without auto-layout (or an HTML import whose boxes
 * contradict its auto-layout) with a designed height that its content cannot grow.
 */
export function absoluteLike(e: El): boolean {
  if (e.layoutKind === "overlay" || e.layoutKind === "absolute") return true;
  if (e.isText || !e.children.length) return false;
  return e.children.every((k) => k.style["position"] === "absolute") && hasText(e);
}

/* ------------------------------------------------------- content model */

/** Text-ish rows (nav links, tags, buttons, meta) wrap; content rows stack. */
function textishRow(e: El, kids: El[]): boolean {
  return e.tag === "nav" || e.tag === "ul" || e.tag === "ol" || kids.every((k) => k.isText || k.tag === "a" || k.tag === "button" || (k.box.h <= 56 && k.box.w <= 260));
}

/**
 * The narrowest width a node still reads at, from its design box and content. A label keeps
 * its line; a paragraph wraps down to its longest word but not below a phone column; a
 * picture that carries a column shrinks to a third; icons keep their size; a row needs its
 * children side by side (a wrapping or text row only its widest child). Absolute layers cost 0.
 */
export function minWidth(e: El, self = false): number {
  if (!self && e.style["position"] === "absolute") return 0;
  const w = e.box.w;
  if (e.isText) {
    const fs = num(e.style["font-size"]) ?? 16;
    const text = textOf(e);
    const longest = Math.max(1, ...text.split(/\s+/).map((s) => s.length)) * fs * 0.58;
    const lh = num(e.style["line-height"]) ?? (/^[\d.]+$/.test(e.style["line-height"] || "") ? parseFloat(e.style["line-height"]) * fs : fs * 1.3);
    const lines = e.box.h / Math.max(1, lh);
    // A label keeps its line: its own width, which is the glyph run, not the (fill) box it sits in.
    if (e.style["white-space"] === "nowrap") return w;
    if (lines < 1.6 && text.length <= 28) return Math.min(w, Math.max(longest, text.length * fs * 0.55));
    return Math.min(w, Math.max(longest, 240));
  }
  const picture = e.tag === "img" || e.tag === "svg" || e.tag === "video" || (e.hasAsset && !hasText(e));
  if (picture) return w < 120 ? w : Math.min(w, Math.max(w * 0.35, 160));
  const padX = sidePadding(e.style["padding"]);
  const kids = e.children.filter((k) => k.style["position"] !== "absolute");
  if (!kids.length) return Math.min(w, Math.max(w * 0.4, 120));
  if (absoluteLike(e)) return Math.min(w, Math.max(w * 0.5, 280));
  if (e.style["display"] === "grid") return Math.max(...kids.map((k) => minWidth(k))) + padX;
  if (e.style["display"] === "flex" && e.style["flex-direction"] === "row") {
    if (e.style["flex-wrap"] || textishRow(e, kids)) return Math.max(...kids.map((k) => minWidth(k))) + padX;
    return kids.reduce((n, k) => n + minWidth(k), 0) + gapPx(e) * (kids.length - 1) + padX;
  }
  return Math.max(...kids.map((k) => minWidth(k))) + padX;
}

/**
 * Viewport width below which a box of design width `boxW` has less than `need` px. Below the
 * design width the fluid padding and gaps keep every box a constant share of the viewport, so
 * the box is `boxW * V / W` wide at viewport `V`. Slightly pessimistic (fixed small paddings
 * shrink nothing) so the transform fires before, never after, the content breaks.
 */
export function breakWidth(boxW: number, need: number, W: number): number {
  return W * (need / Math.max(1, boxW)) * 1.08;
}

/** Columns of `cols` cells that fit a grid of design width `gridW` at viewport `V`. */
function colsAt(gridW: number, itemMin: number, gap: number, cols: number, V: number, W: number): number {
  const avail = (gridW * V) / W;
  return Math.max(1, Math.min(cols, Math.floor((avail + gap) / Math.max(1, itemMin + gap))));
}

/* ------------------------------------------------------------ fluid */

function fluidPadding(e: El, W: number): void {
  const p = e.style["padding"]; if (!p) return;
  const parts = p.split(/\s+/).map(num);
  if (parts.length !== 4 || parts.some((v) => v === null)) return;
  const [t, r, b, l] = parts as number[];
  const f = (v: number) => (v >= 40 ? vw(v, W) : px(v));
  if (r >= 40 || l >= 40) e.style["padding"] = `${px(t)} ${f(r)} ${px(b)} ${f(l)}`;
  if (e.inferredPad) {
    // Offsets read from a child's position are placement, not design padding.
    media(e, PHONE, { padding: `${px(Math.min(t, 24))} ${px(Math.min(r, 16))} ${px(Math.min(b, 24))} ${px(Math.min(l, 16))}` });
    return;
  }
  // Tall section padding shrinks on phones.
  if (t >= 60 || b >= 60) media(e, PHONE, { "padding-top": px(Math.max(24, Math.round(t * 0.4))), "padding-bottom": px(Math.max(24, Math.round(b * 0.4))) });
}

function fluidGap(e: El, W: number): void {
  const g = e.style["gap"]; if (!g) return;
  const parts = g.split(/\s+/).map(num);
  if (parts.some((v) => v === null)) return;
  if (!(parts as number[]).some((v) => v >= 40)) return;
  e.style["gap"] = (parts as number[]).map((v) => (v >= 40 ? vw(v, W) : px(v))).join(" ");
}

function fluidAbsolute(e: El, W: number, parent: El | null): void {
  if (e.style["position"] !== "absolute") return;
  const left = num(e.style["left"]), right = num(e.style["right"]);
  // A band overhanging both edges of the design bleeds to the viewport edges below it.
  if (left !== null && right !== null && left < 0 && right < 0) { media(e, mq(W - 1), { left: "0", right: "0" }); return; }
  // A centred box capped at 100% of a padded parent would touch the viewport: keep the parent's side padding.
  if ((e.style["left"] || "").includes("50%") && e.style["max-width"] === "100%" && parent?.style["padding"]) {
    const tokens = parent.style["padding"].match(/min\([^)]*\)|[-\d.]+px|0/g) || [];
    const r = tokens.length >= 4 ? tokens[1] : tokens.length >= 2 ? tokens[1] : tokens[0], l = tokens.length >= 4 ? tokens[3] : r;
    if (r && l && r !== "0" && l !== "0") e.style["max-width"] = `calc(100% - ${l} - ${r})`;
  }
  if (left !== null && left >= 40 && right === null) {
    e.style["left"] = vw(left, W);
    e.style["max-width"] = `calc(100% - ${vw(left, W)})`;
  } else if (left !== null && right !== null && (left >= 40 || right >= 40)) {
    // Pinned to both edges: the insets shrink together, the box keeps its share.
    if (left >= 40) e.style["left"] = vw(left, W);
    if (right >= 40) e.style["right"] = vw(right, W);
  }
}

function fluidType(e: El, W: number): void {
  if (compositionText.has(e)) return;
  const fs = num(e.style["font-size"]);
  if (fs === null || fs < 28) return;
  const min = Math.round(fs * 0.6);
  e.style["font-size"] = `clamp(${px(min)}, ${Math.round((fs / W) * 10000) / 100}vw, ${px(fs)})`;
  const lh = num(e.style["line-height"]);
  if (lh !== null) e.style["line-height"] = String(Math.round((lh / fs) * 100) / 100);
}

/* ------------------------------------------------------ transforms */

/** Grids lose columns at the bucket where their cells stop fitting; the plan can pin a count per bucket. */
function collapseGrid(e: El, idx: ResponsiveIndex, W: number): void {
  const m = e.style["grid-template-columns"]?.match(/^repeat\((\d+), /);
  if (!m) return;
  const cols = parseInt(m[1], 10);
  if (cols <= 1) return;
  const cells = e.children.filter((c) => c.style["position"] !== "absolute");
  const itemMin = Math.max(120, ...cells.map((k) => minWidth(k)));
  const gap = gapPx(e);
  const gridW = Math.max(1, e.box.w - sidePadding(e.style["padding"]));
  let prev = cols;
  for (const b of BUCKETS) {
    if (b >= W) continue;
    const name = Object.keys(BUCKET_BY_NAME).find((k) => BUCKET_BY_NAME[k] === b)!;
    if (keep(idx, e, name)) continue;
    const forced = decided(idx, e, name).find((d) => d.action === "columns")?.columns;
    let n = forced || colsAt(gridW, itemMin, gap, cols, bucketFloor(b), W);
    // An even count never drops to an odd one (4 -> 3 leaves an orphan): 4 -> 2.
    if (!forced && cols % 2 === 0 && n % 2 === 1 && n < cols && n > 1) n -= 1;
    if (n < prev) { media(e, mq(b), { "grid-template-columns": `repeat(${n}, minmax(0, 1fr))` }); prev = n; }
  }
}

/**
 * Rows. A text-ish row (nav links, tags, buttons) wraps where its items stop fitting. A row of
 * three or more alike items (cards, counters, logos) behaves as a grid and loses columns bucket
 * by bucket. A content row (copy beside a picture, two columns) shares the width in
 * proportion once its designed widths stop fitting, and stacks at the bucket where its
 * content needs more than the row has.
 */
function rows(e: El, idx: ResponsiveIndex, W: number, hints: FrameHints | null): void {
  if (e.style["display"] !== "flex" || e.style["flex-direction"] !== "row") return;
  const kids = e.children.filter((c) => c.style["position"] !== "absolute");
  if (kids.length < 2) return;
  const gap = gapPx(e);
  const total = kids.reduce((n, k) => n + k.box.w, 0) + gap * (kids.length - 1);
  const need = minWidth(e, true);
  const breakW = breakWidth(e.box.w, need, W);
  const tightW = breakWidth(e.box.w, total + sidePadding(e.style["padding"]), W);
  const tall = Math.max(...kids.map((k) => k.box.h));
  const textish = textishRow(e, kids);
  const decisions = idx.get(e.id) || [];
  const forced = decisions.filter((d) => d.action === "stack" || d.action === "wrap");
  // A plan decision owns its bucket and every narrower one: no heuristic stacking or wrapping
  // there (the plan said what happens). Wider buckets still get the heuristics, so a `wrap` at
  // phone does not leave a tablet unhandled. `row` keeps the children side by side in equal shares.
  const ownedFrom = Math.max(0, ...decisions.filter((d) => d.action !== "hide" && d.action !== "center" && d.action !== "full-width").map((d) => BUCKET_BY_NAME[d.at] ?? 767));
  const covered = (q: string) => ownedFrom >= queryMax(q);
  for (const d of decisions) if (d.action === "row") {
    const q = atQuery(d.at);
    media(e, q, { "flex-direction": "row", "flex-wrap": "nowrap" });
    for (const k of kids) media(k, q, cellStyle(k, "0%", "1 1"));
    // Kept side by side on a narrow screen: a label wraps inside its cell rather than run out of it.
    const unwrap = (n: El) => { if (n.isText && n.style["white-space"] === "nowrap") media(n, q, { "white-space": "normal" }); n.children.forEach(unwrap); };
    kids.forEach(unwrap);
  }
  const frozenPhone = keep(idx, e, "phone");
  const linkCount = (n: El): number => (n.tag === "a" || n.tag === "button" ? 1 : 0) + n.children.reduce((c, k) => c + linkCount(k), 0);
  // The link list of a header: a <nav>, or (when the <nav> wraps the whole header) the kid that is
  // a horizontal list of three or more links beside a logo.
  const navKid = kids.find((k) => k.tag === "nav") || (kids.some((k) => k.hasAsset || k.tag === "img" || k.tag === "svg")
    ? kids.find((k) => !k.isText && k.box.w > 200 && k.box.h <= 80 && linkCount(k) >= 3 && textishRow(k, k.children.filter((c) => c.style["position"] !== "absolute"))) : undefined);
  if (navKid && !forced.length && !frozenPhone && !ownedFrom && linkCount(navKid) >= 3) {
    // Header (logo | links | actions). HTML: the link list becomes a menu behind a button from the
    // bucket where the row stops fitting (phones at the latest); the emitter builds the toggle.
    // Elementor (no toggle): the link list drops to its own centred line instead.
    const q = tightW > BUCKETS[0] * 1.05 && W > BUCKETS[0] ? mq(W - 1) : widerQ(PHONE, bucketAtOrAbove(tightW, W));
    e.attrs["data-menu-row"] = String(queryMax(q));
    navKid.attrs["data-menu"] = "1";
    const firstText = (n: El): El | null => { if (n.isText) return n; for (const c of n.children) { const t = firstText(c); if (t) return t; } return null; };
    const t = firstText(navKid); if (t && t.style["color"]) e.attrs["data-menu-color"] = t.style["color"];
    media(e, q, { "flex-wrap": "wrap", "row-gap": "16px" });
    media(navKid, q, { order: "3", flex: "1 0 100%", "justify-content": "center", "flex-wrap": "wrap" });
    return;
  }
  const alike = !textish && kids.length >= 3 && Math.max(...kids.map((k) => k.box.w)) <= Math.min(...kids.map((k) => k.box.w)) * 1.3 && !navKid;

  for (const d of forced) {
    if (d.action === "wrap") media(e, atQuery(d.at), { "flex-wrap": "wrap", "row-gap": "12px" });
    else if (d.action === "stack") stackRow(e, atQuery(d.at), hints);
  }
  if (!frozenPhone && need > 340) {
    const wrapQ = bucketAtOrAbove(breakW, W), stackQ = wrapQ;
    if (textish) { if (!covered(wrapQ)) media(e, wrapQ, { "flex-wrap": "wrap", "row-gap": "12px" }); }
    else if (alike) rowAsGrid(e, kids, idx, W, hints, covered);
    else if (kids.length >= 4 && !navKid) {
      // Four or more unequal columns (a footer: brand, two link lists, newsletter) wrap into two
      // lines once their designed widths stop fitting, and stack when a pair no longer fits.
      const mins = kids.map((k) => minWidth(k)).sort((a, b) => b - a);
      const pairNeed = mins[0] + mins[1] + gap + sidePadding(e.style["padding"]);
      const q1 = bucketAtOrAbove(tightW, W), q2 = bucketAtOrAbove(breakWidth(e.box.w, pairNeed, W), W);
      if (!covered(q1)) media(e, q1, { "flex-wrap": "wrap", "row-gap": "24px" });
      if (!covered(q2)) stackRow(e, q2, hints);
    }
    else if (!covered(stackQ)) stackRow(e, stackQ, hints);
  } else if (!frozenPhone && textish && total > 340 && tall <= 80) {
    // Fits a phone once everything around it has stacked, but may be squeezed on the way: let it wrap.
    const q = bucketAtOrAbove(breakW, W);
    if (!covered(q)) media(e, q, { "flex-wrap": "wrap", "row-gap": "12px" });
  }

  if (keep(idx, e, "tablet") || alike || e.style["flex-wrap"]) return;
  if (kids.length >= 4 && !textish) return; // wraps instead of sharing (a share never wraps: basis 0)
  if (textish || total <= 800) return;
  // Shares: the columns keep their designed proportions from the width where the designed
  // widths stop fitting (for a row that fills its container, right below the design width).
  const contentW = Math.max(1, e.box.w - sidePadding(e.style["padding"]));
  const fills = total >= contentW * 0.95 || e.style["justify-content"] === "space-between";
  const q = fills ? mq(W - 1) : bucketAtOrAbove(tightW, W);
  const weights = kids.map((k) => Math.max(1, Math.round(k.box.w)));
  const padR = sidePadding(e.style["padding"]) / 2;
  kids.forEach((k, i) => {
    // A small picture (logo, icon) keeps its designed size; `width: auto` would let the
    // browser crop or restretch it. The columns around it share the rest.
    const smallAsset = (k.tag === "img" || k.tag === "svg" || k.tag === "video" || (k.hasAsset && !hasText(k))) && k.box.w < 300;
    if (smallAsset) { media(k, q, { flex: "0 0 auto", "max-width": "100%" }); return; }
    // Below its own minimum a column would squeeze its labels: it stops there and the row stacks
    // at the bucket where the minimums no longer fit (breakW is computed from the same numbers).
    media(k, q, { flex: `${weights[i]} 1 0%`, "min-width": "0", width: "auto", "max-width": "100%" });
    // Laptops squeeze the columns a little; from the widest bucket down each keeps its minimum
    // (breakW, computed from the same minimums, stacks the row where they stop fitting).
    const usable = BUCKETS.filter((b) => b < W);
    if (usable.length) media(k, mq(usable[0]), { "min-width": `min(100%, ${px(Math.round(minWidth(k)))})` });
    if (k.style["display"] === "flex" && k.style["flex-direction"] === "row" && !k.style["flex-wrap"]) {
      // A row that ends at the right edge (a link list with its CTA) keeps that edge when it wraps.
      const endAligned = k.box.x + k.box.w >= e.box.w - padR - 2;
      media(k, q, { "flex-wrap": "wrap", "row-gap": "8px", ...(endAligned ? { "justify-content": "flex-end" } : {}) });
    }
  });
  fluidImages(e, q);
}

/** A row of alike items wraps into fewer columns bucket by bucket, one column at the last. */
/** A flex cell of `basis` width: a picture follows the cell (its designed size is the cap), a box takes it. */
function cellStyle(k: El, basis: string, growShrink = "0 0"): Record<string, string> {
  const h = num(k.style["height"]);
  if (k.tag === "img" || k.tag === "video") return { flex: `${growShrink} ${basis}`, width: basis === "0%" ? "auto" : basis, "max-width": px(Math.round(k.box.w)), height: "auto", "min-width": "0", ...(h ? { "aspect-ratio": `${Math.round(k.box.w)} / ${Math.round(h)}` } : {}) };
  return { flex: `${growShrink} ${basis}`, width: "auto", "max-width": "100%", "min-width": "0" };
}

function rowAsGrid(e: El, kids: El[], idx: ResponsiveIndex, W: number, hints: FrameHints | null, covered: (q: string) => boolean = () => false): void {
  const cols = kids.length;
  const itemMin = Math.max(120, ...kids.map((k) => minWidth(k)));
  const gap = gapPx(e);
  const gapExpr = gapExprOf(e, "16px");
  const gridW = Math.max(1, e.box.w - sidePadding(e.style["padding"]));
  // Fixed-size items share the row equally as soon as their designed widths stop fitting.
  const total = kids.reduce((n, k) => n + k.box.w, 0) + gap * (cols - 1);
  const q0 = bucketAtOrAbove(breakWidth(e.box.w, total, W), W);
  if (!covered(q0)) { const basis0 = `calc(${Math.round(10000 / cols) / 100}% - ${gapExpr} * ${Math.round(((cols - 1) / cols) * 100) / 100})`; for (const k of kids) media(k, q0, cellStyle(k, basis0)); }
  let prev = cols;
  for (const b of BUCKETS) {
    if (b >= W) continue;
    const name = Object.keys(BUCKET_BY_NAME).find((k) => BUCKET_BY_NAME[k] === b)!;
    if (keep(idx, e, name)) continue;
    let n = colsAt(gridW, itemMin, gap, cols, bucketFloor(b), W);
    // Even counts wrap evenly (six counters 3 + 3 or 2 + 2 + 2, never 4 + 2).
    if (cols % 2 === 0 && n % 2 === 1 && n < cols && n > 1) n -= 1;
    if (n >= prev) continue;
    prev = n;
    if (covered(mq(b))) continue;
    if (n === 1) { stackRow(e, mq(b), hints); continue; }
    media(e, mq(b), { "flex-wrap": "wrap", "row-gap": "16px", "justify-content": "center", "align-items": "flex-start" });
    const basis = `calc(${Math.round(10000 / n) / 100}% - ${gapExpr} * ${Math.round(((n - 1) / n) * 100) / 100})`;
    for (const k of kids) media(k, mq(b), cellStyle(k, basis));
  }
}

/**
 * A flex row becomes a column at `q`; children take the full width (small assets keep theirs).
 * Hints from the designer's own narrow frame set the order and the text alignment.
 */
function stackRow(e: El, q: string, hints: FrameHints | null): void {
  const kids = e.children.filter((c) => c.style["position"] !== "absolute");
  media(e, q, { "flex-direction": "column", "align-items": "stretch" });
  const ranks = hints ? kids.map((k) => hintRank(k, hints)) : [];
  const reorder = hints && ranks.every((r) => r !== null) && ranks.some((r, i) => i > 0 && (r as number) < (ranks[i - 1] as number));
  kids.forEach((k, i) => {
    const small = (k.hasAsset || k.tag === "svg" || k.tag === "img") && k.box.w < 300;
    const picture = !small && (k.tag === "img" || k.tag === "video" || (!!k.style["aspect-ratio"] && !hasText(k)));
    const st: Record<string, string> = small
      ? { flex: "0 0 auto", "align-self": "flex-start", "margin-left": "0", "margin-right": "0" }
      : picture
        ? { width: "100%", "max-width": `min(100%, ${px(Math.round(k.box.w))})`, flex: "0 0 auto", "align-self": "center", "margin-left": "0", "margin-right": "0" }
        : { width: "100%", "max-width": "100%", flex: "0 0 auto", "margin-left": "0", "margin-right": "0" };
    if (k.isText) st["text-align"] = (hints && hints.align.get(k.id)) || k.style["text-align"] || "left";
    if (reorder) st["order"] = String(ranks[i]);
    // Decoration the designer left out of the narrow layout has no place in the stack.
    if (hints && !hasText(k) && !k.hasAsset && hints.dropped.has(k.id)) st["display"] = "none";
    media(k, q, st);
  });
  if (hints) alignStacked(e, q, hints);
}

/** Rank of a node in the narrow frame: the earliest rank among its matched text. */
function hintRank(k: El, hints: FrameHints): number | null {
  let best: number | null = null;
  const visit = (n: El) => { const r = hints.order.get(n.id); if (r !== undefined && (best === null || r < best)) best = r; n.children.forEach(visit); };
  visit(k);
  return best;
}

/** Text inside a stacked row takes the alignment the designer gave it on the narrow frame. */
function alignStacked(e: El, q: string, hints: FrameHints): void {
  const visit = (n: El, depth: number) => {
    if (depth > 0 && n.isText) { const a = hints.align.get(n.id); if (a && a !== (n.style["text-align"] || "left")) media(n, q, { "text-align": a }); }
    if (depth > 0 && n.style["display"] === "flex" && n.style["flex-direction"] === "column") {
      // A column whose texts all centre on the narrow frame centres its items too.
      const texts = n.children.filter((c) => c.isText);
      if (texts.length && texts.every((t) => hints.align.get(t.id) === "center")) media(n, q, { "align-items": "center" });
    }
    n.children.forEach((c) => visit(c, depth + 1));
  };
  visit(e, 0);
}

/** Images inside a shared row keep their ratio and fill their column. */
function fluidImages(e: El, q: string = TABLET): void {
  const visit = (k: El, parent: El) => {
    const w = num(k.style["width"]), h = num(k.style["height"]);
    // Only a picture that carries its column goes fluid; an avatar or icon beside text keeps its size.
    const fills = k.box.w >= parent.box.w * 0.5;
    if ((k.tag === "img" || k.tag === "video") && w !== null && fills && k.style["position"] !== "absolute") media(k, q, { width: "100%", "max-width": px(Math.round(k.box.w)), height: "auto", ...(h ? { "aspect-ratio": `${Math.round(w)} / ${Math.round(h)}` } : {}) });
    else if (!k.isText && w !== null && w >= 200 && fills && k.style["position"] !== "absolute") media(k, q, { width: "100%" });
    if (k.tag !== "img" && k.tag !== "video") k.children.forEach((c) => visit(c, k));
  };
  e.children.forEach((c) => visit(c, e));
}

/**
 * Overlay / absolute containers become a stacked column, backdrop kept behind, at the bucket
 * where their text layers stop fitting side by side (phones at the latest).
 */
function stackOverlay(e: El, idx: ResponsiveIndex, topInset = 0, q: string = PHONE, force = false): void {
  if (!absoluteLike(e)) return;
  if (!force && keep(idx, e, q === PHONE ? "phone" : "tablet")) return;
  if (pictureLike(e)) return; // scales as one picture (scaleComposition), captions handled there
  const kids = e.children;
  const area = Math.max(1, e.box.w * e.box.h);
  const covering = (k: El) => (k.box.w * k.box.h) / area >= 0.85 && !hasText(k);
  const content = kids.filter((k) => k.role !== "backdrop" && hasText(k) && !restsOutside(k, e));
  if (!content.length && !force) return; // pure decoration: leave as designed (it scales with the box)
  const h = num(e.style["height"]) || num(e.style["min-height"]) || e.box.h;
  const pad = q === PHONE ? "16px" : "24px";
  media(e, q, { display: "flex", "flex-direction": "column", "align-items": "stretch", gap: "16px", height: "auto", "min-height": px(Math.min(h, 320)), padding: `${px(32 + topInset)} ${pad} 32px`, "aspect-ratio": "auto" });
  for (const k of kids) {
    if (restsOutside(k, e)) { media(k, q, { display: "none" }); continue; }
    if (k.role === "backdrop" || covering(k)) { media(k, q, { position: "absolute", inset: "0", width: "100%", height: "100%", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", "max-width": "none" }); continue; }
    const wide = k.box.w >= e.box.w * 0.85 && k.box.h <= 120 && k.hasAsset; // torn edges, dividers
    if (wide) continue;
    if (!hasText(k)) {
      // Small decorations (badges, arrows, glows) have no place in a stack; a picture that carries
      // a side of the layout (the hero illustration) joins it at its designed size.
      const share = (k.box.w * k.box.h) / area;
      if (share < 0.15 || (k.hasAsset && share < 0.25)) media(k, q, { display: "none" });
      else media(k, q, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", width: "100%", "max-width": `min(100%, ${px(Math.round(k.box.w))})`, height: "auto", "aspect-ratio": `${Math.round(k.box.w)} / ${Math.round(k.box.h)}`, margin: "0 auto", "align-self": "center" });
      continue;
    }
    media(k, q, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", width: "100%", "max-width": "100%", height: "auto", "min-height": "0", margin: "0", "z-index": k.style["z-index"] || "1" });
  }
}

/**
 * Display type set tighter than its glyphs (a 150px "2012" on a 70px line) or painted
 * through `background-clip: text` is cut to its line box once the trim is lifted: keep it trimmed.
 */
function tightLeading(e: El): boolean {
  if (e.style["background-clip"] === "text" || e.style["-webkit-background-clip"] === "text") return true;
  const lh = e.style["line-height"]; if (!lh) return false;
  if (/^[\d.]+$/.test(lh)) return parseFloat(lh) < 1;
  const l = num(lh), f = num(e.style["font-size"]);
  return l !== null && f !== null && l < f;
}

/** Fixed heights that hold text open up; nowrap text wraps; fixed images go fluid; controls stay tappable. */
function loosen(e: El, idx: ResponsiveIndex, W: number): void {
  if (keep(idx, e, "phone") || pictureKids.has(e) || pictureLike(e)) return;
  const h = num(e.style["height"]);
  if (h !== null && h > 48 && hasText(e) && e.role !== "backdrop") {
    // Below the design width content can only get taller (grids lose columns,
    // rows wrap). A designed height becomes a floor, never a ceiling, so an
    // overflow-hidden section stops cutting its own text off.
    media(e, mq(W - 1), { height: "auto", "min-height": px(h) });
    if (!absoluteLike(e)) {
      media(e, TABLET_SM, { height: "auto", "min-height": px(Math.min(h, 200)) });
      media(e, PHONE, { height: "auto", "min-height": "0" });
    }
  }
  if (e.isText && e.style["white-space"] === "nowrap" && e.box.w > 120) media(e, PHONE, { "white-space": "normal" });
  // Leading trim cuts a text box to cap height and baseline; the designer spaced the
  // desktop around that. Below the design width gaps shrink and blocks stack flush, so the
  // descenders of one line would touch (or be clipped against) the next block: give the
  // lines their half-leading back. Compositions keep it (their layers are placed by the trimmed box).
  if (e.isText && e.style["text-box-trim"] && !compositionText.has(e) && !tightLeading(e)) media(e, TABLET, { "text-box-trim": "none" });
  // A text that overhangs its column by design (negative margins) has nowhere to hang
  // once the column is narrower than a phone: it spans the column instead.
  if (e.isText && ((e.style["margin-left"] || "").startsWith("-") || (e.style["margin-right"] || "").startsWith("-"))) media(e, TABLET, { width: "100%", "max-width": "100%", "margin-left": "0", "margin-right": "0" });
  if ((e.style["width"] || "").startsWith("calc(100% +")) media(e, mq(W - 1), { width: "100%" });
  if (e.isText && e.style["white-space"] === "nowrap" && e.box.w > 240) media(e, TABLET, { "white-space": "normal" }); // a long single line (copyright, tagline) wraps rather than clips
  const w = num(e.style["width"]);
  // Nothing designed at a fixed width may be wider than the box it is in once the boxes shrink.
  const pxMax = /^[\d.]+px$/.test(e.style["max-width"] || "");
  if (w !== null && w >= 120 && (e.style["max-width"] === undefined || pxMax) && e.style["position"] !== "absolute") {
    const picture = e.tag === "svg" || e.tag === "img" || e.tag === "video";
    media(e, mq(W - 1), { "max-width": "100%", ...(picture && e.style["height"] ? { height: "auto", "aspect-ratio": `${Math.round(e.box.w)} / ${Math.round(Math.max(1, e.box.h))}` } : {}) });
  }
  // A hug container wider than a phone (its children carry the width) must be allowed to shrink.
  if (!e.isText && e.tag !== "img" && w === null && e.box.w >= 360 && e.style["position"] !== "absolute" && e.style["display"] === "flex") media(e, PHONE, { width: "100%", "max-width": "100%" });
  if ((e.tag === "img" || e.tag === "video") && w !== null && w >= 280 && e.style["position"] !== "absolute") {
    const hh = num(e.style["height"]);
    media(e, PHONE, { width: "100%", height: "auto", ...(hh ? { "aspect-ratio": `${Math.round(w)} / ${Math.round(hh)}` } : {}) });
  }
  if (!e.isText && e.tag !== "img" && w !== null && w >= 360 && e.style["position"] !== "absolute") media(e, PHONE, { width: "100%" });
  // Touch: a button-like control shorter than 44px grows to the recommended tap height on phones.
  const control = e.tag === "button" || (e.tag === "a" && !!(e.style["background-color"] || e.style["border"] || e.style["background-image"]) && !e.hasAsset);
  if (control && e.box.h < 40 && e.box.h >= 16 && hasText(e) && e.style["position"] !== "absolute") media(e, PHONE, { "min-height": "44px", "align-items": "center", ...(e.style["display"] === "flex" ? {} : { display: "inline-flex", "justify-content": "center" }) });
}

/** Direct children of a picture-like composition: their fixed heights are % of the picture, never loosened. */
const pictureKids = new WeakSet<El>();
function textLeafArea(e: El): number { return e.isText ? e.box.w * e.box.h : e.children.reduce((n, k) => n + textLeafArea(k), 0); }
/**
 * A collage: an overlay whose picture is its own background image (or one
 * covering image child) with a few small captions placed over it. It scales as
 * one picture; the captions are too small to justify stacking it.
 */
export function pictureLike(e: El): boolean {
  if (e.layoutKind !== "overlay" && e.layoutKind !== "absolute") return false;
  const W = e.box.w, H = e.box.h;
  if (W < 300 || H < 120) return false;
  const bg = /url\(/.test(e.style["background-image"] || "");
  const cover = e.children.some((k) => (k.tag === "img" || k.tag === "video") && !hasText(k) && (k.box.w * k.box.h) / (W * H) >= 0.6);
  if (!bg && !cover) return false;
  const kids = e.children.filter((k) => k.style["position"] === "absolute");
  if (!kids.length || !kids.some(hasText)) return false;
  return textLeafArea(e) / (W * H) <= 0.12;
}

/** Horizontal padding in px from a padding shorthand; fluid tokens `min(Apx, Bvw)` count as A. */
export function sidePadding(padding: string | undefined): number {
  if (!padding) return 0;
  const tokens = padding.match(/min\([^)]*\)|[-\d.]+px|0/g) || [];
  const pxOf = (t: string) => { const m = t.match(/([\d.]+)px/); return m ? parseFloat(m[1]) : 0; };
  const v = tokens.map(pxOf);
  if (v.length === 1) return v[0] * 2;
  if (v.length === 2 || v.length === 3) return v[1] * 2;
  if (v.length >= 4) return v[1] + v[3];
  return 0;
}
/** `cqw` is a share of the query container's CONTENT box: the design width minus its side padding. */
const cqBase = (e: El, W: number): number => Math.max(1, W - sidePadding(e.style["padding"]));

/** Text inside a self-scaling composition: fluidType leaves it alone (its size follows the composition). */
const compositionText = new WeakSet<El>();

/**
 * A small composition that holds text (a headline drawn as separate lines plus a highlight
 * block, a badge with a caption): its text, offsets and sizes are a share of its own width
 * (container-query units), so the layers stay aligned whatever the viewport does to the box.
 * Full-width compositions are excluded: they restack on phones instead of shrinking their type.
 */
function scaleTextComposition(e: El, frameW: number): void {
  const W = num(e.style["width"]);
  if (W === null || W < 120 || W > frameW * 0.6 || !hasText(e)) return;
  e.style["container-type"] = "inline-size";
  const base = cqBase(e, W);
  const cq = (v: number) => `${Math.round((v / base) * 10000) / 100}cqw`;
  // Only layers placed by coordinates scale with the box; flowing columns (a footer's link lists)
  // keep their type and reflow like any flow content.
  const visitLeaf = (k: El, depth: number, positioned = false) => {
    const st = k.style;
    positioned = positioned || (depth > 0 && st["position"] === "absolute");
    if (!positioned) { k.children.forEach((c) => visitLeaf(c, depth + 1, false)); return; }
    if (st["position"] === "absolute") for (const prop of ["left", "top", "right", "bottom"] as const) { const v = num(st[prop]); if (v !== null && v !== 0) st[prop] = cq(v); }
    for (const prop of ["width", "height", "min-height"] as const) { const v = num(st[prop]); if (v !== null && v > 0) st[prop] = cq(v); }
    if (k.isText) {
      const fs = num(st["font-size"]); if (fs !== null) st["font-size"] = `clamp(12px, ${cq(fs)}, ${px(fs)})`;
      const lh = num(st["line-height"]); if (lh !== null) st["line-height"] = `clamp(14px, ${cq(lh)}, ${px(lh)})`;
      const ls = num(st["letter-spacing"]); if (ls !== null && ls !== 0) st["letter-spacing"] = cq(ls);
      compositionText.add(k);
    }
    k.children.forEach((c) => visitLeaf(c, depth + 1, true));
  };
  visitLeaf(e, 0);
}

/**
 * A text-less absolute composition (photo + plate + badge, map with pins,
 * polaroid stack) scales as ONE picture: percentage offsets inside a box that
 * keeps the design's aspect ratio. Exact at the design width, fluid below it.
 */
function scaleComposition(e: El, frameW = Infinity): void {
  if (e.layoutKind !== "absolute" && e.layoutKind !== "overlay") return; // the plan's compositions only: a positioned frame keeps its px layers
  const picture = pictureLike(e);
  if (hasText(e) && !picture) { scaleTextComposition(e, frameW); return; }
  const W = e.box.w, H = e.box.h;
  if (W < 120 || H < 60 || !e.children.length) return;
  const kids = e.children.filter((k) => k.style["position"] === "absolute");
  if (kids.length < 1) return;
  for (const k of kids) pictureKids.add(k);
  for (const k of kids) {
    if (k.style["inset"] === "0" || (k.style["top"] === "0" && k.style["bottom"] === "0" && k.style["left"] === "0")) continue;
    const pct = (v: number, of: number) => `${Math.round((v / of) * 10000) / 100}%`;
    const st = k.style;
    const l = num(st["left"]), r = num(st["right"]), t = num(st["top"]), b = num(st["bottom"]), w = num(st["width"]), h = num(st["height"]);
    if (l === null && r === null) continue;
    if (l !== null) st["left"] = pct(l, W);
    if (r !== null) st["right"] = pct(r, W);
    if (t !== null) st["top"] = pct(t, H);
    if (b !== null) st["bottom"] = pct(b, H);
    if (w !== null) st["width"] = pct(w, W);
    if (h !== null) st["height"] = pct(h, H);
    delete st["max-width"];
    if (k.rotation || st["transform"]) { /* rotation keeps its transform; the box still scales */ }
  }
  const es = e.style;
  const designW = num(es["width"]) ?? W;
  // Design width capped by the container. Not `width: 100%`: inside a hug (shrink-to-fit) parent a
  // percentage resolves to auto and an aspect-ratio box then collapses to its captions' width.
  if (e.attrs["data-bleed"]) { es["height"] = "auto"; es["aspect-ratio"] = `${Math.round(W)} / ${Math.round(H)}`; delete es["min-height"]; }
  else { es["width"] = px(designW); es["max-width"] = "100%"; es["height"] = "auto"; es["aspect-ratio"] = `${Math.round(W)} / ${Math.round(H)}`; delete es["min-height"]; } // a bleed layer keeps left:0/right:0
  if (!picture) return;
  // Tablets: the captions shrink with the picture. Container-query units make a
  // caption's type and fixed widths a share of the picture's width; exact at the design width.
  es["container-type"] = "inline-size";
  const cqb = cqBase(e, W);
  const cq = (v: number) => `${Math.round((v / cqb) * 10000) / 100}cqw`;
  const scaleLeaf = (k: El) => {
    const st: Record<string, string> = {}, reset: Record<string, string> = {};
    const fs = num(k.style["font-size"]);
    if (k.isText && fs !== null) { st["font-size"] = `clamp(12px, ${cq(fs)}, ${px(fs)})`; reset["font-size"] = k.style["font-size"]; }
    const lh = num(k.style["line-height"]);
    if (k.isText && lh !== null) { st["line-height"] = `clamp(14px, ${cq(lh)}, ${px(lh)})`; reset["line-height"] = k.style["line-height"]; }
    const w = num(k.style["width"]), h = num(k.style["height"]);
    if (w !== null && k.style["position"] !== "absolute") { st["width"] = `min(${px(w)}, ${cq(w)})`; reset["width"] = k.style["width"]; if (h !== null && (k.tag === "img" || k.tag === "svg" || k.hasAsset)) { st["height"] = "auto"; st["aspect-ratio"] = `${Math.round(w)} / ${Math.round(h)}`; reset["height"] = k.style["height"]; reset["aspect-ratio"] = "auto"; } }
    if (Object.keys(st).length) { Object.assign(k.style, st); media(k, PHONE, reset); }
    k.children.forEach(scaleLeaf);
  };
  for (const k of kids) k.children.forEach(scaleLeaf);
  // Phones: captions cannot shrink with the picture. The picture keeps its box (as
  // top padding when it is the background) and the captions follow it in flow.
  const bg = /url\(/.test(es["background-image"] || "");
  const st: Record<string, string> = { display: "flex", "flex-direction": "column", "align-items": "stretch", gap: "16px", height: "auto", "min-height": "0", "aspect-ratio": "auto", padding: bg ? `calc(100% * ${Math.round(H)} / ${Math.round(W)}) 0 0 0` : "0" };
  if (bg) { st["background-size"] = "100% auto"; st["background-position"] = "top center"; }
  media(e, PHONE, st);
  const inflow = { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", width: "100%", "max-width": "100%", height: "auto", "min-height": "0", margin: "0" };
  for (const k of kids) {
    const covering = k.hasAsset && !hasText(k) && (k.box.w * k.box.h) / (W * H) >= 0.6;
    if (covering) media(k, PHONE, { ...inflow, order: "-1", "aspect-ratio": `${Math.round(k.box.w)} / ${Math.round(k.box.h)}` });
    else if (!hasText(k)) media(k, PHONE, { display: "none" }); // a badge over the picture has no place under it
    else media(k, PHONE, { ...inflow, ...(k.style["background-color"] || k.style["background-image"] ? {} : { padding: "0" }) });
  }
}

/**
 * Absolutely placed children of a FLOW container (Figma "absolute position"
 * inside auto-layout: badges, pouch photos over cards, pinned buttons) have no
 * meaningful coordinates once the flow stacks on a phone:
 *  - full-bleed backgrounds and edge decorations stay pinned;
 *  - small decorations disappear;
 *  - logos come first, in flow;
 *  - anything with text or a large image joins the flow where the DOM has it.
 */
function absoluteInFlow(e: El): void {
  if (e.style["display"] !== "flex" || absoluteLike(e)) return;
  const area = Math.max(1, e.box.w * e.box.h);
  for (const k of e.children) {
    if (k.style["position"] !== "absolute") continue;
    // Horizontal placement follows the container's width (a plate over the
    // second card stays over the second card when the grid shrinks).
    const pct = (v: number) => `${Math.round((v / e.box.w) * 10000) / 100}%`;
    const l = num(k.style["left"]), r = num(k.style["right"]), w = num(k.style["width"]);
    if (l !== null && l > 0) k.style["left"] = pct(l);
    if (r !== null && r > 0) k.style["right"] = pct(r);
    if (w !== null && w >= 120 && l === null && r === null && k.style["left"] && !k.style["right"] && !(k.style["left"] || "").includes("50%")) {
      // Placed by a fluid offset (fluidAbsolute made it `min(px, vw)`): the box may not run past the right edge.
      k.style["max-width"] = `calc(100% - ${k.style["left"]})`;
    }
    if (w !== null && w >= 120 && (l !== null || r !== null)) {
      k.style["width"] = pct(w); delete k.style["max-width"];
      // A picture whose width now follows the container keeps its proportions.
      const h = num(k.style["height"]);
      if (h !== null && (k.tag === "img" || k.tag === "video" || (k.hasAsset && !hasText(k)))) { k.style["height"] = "auto"; k.style["aspect-ratio"] = `${Math.round(w)} / ${Math.round(h)}`; }
    }
    const share = (k.box.w * k.box.h) / area;
    const fullBleed = k.box.w >= e.box.w * 0.85 && (share >= 0.6 || k.box.h <= 120);
    if (fullBleed || k.role === "backdrop") continue;
    const inflow = { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", "max-width": "100%", margin: "0" } as Record<string, string>;
    if (!hasText(k)) {
      const logo = (k.hasAsset || k.tag === "svg" || k.tag === "img") && k.box.h >= 40 && k.box.y <= e.box.h * 0.2 && k.box.x <= e.box.w * 0.3;
      if (logo) media(k, PHONE, { ...inflow, order: "-1", width: "auto", "max-width": "60%", height: "auto", "align-self": "flex-start" });
      else if (share < 0.15 || k.box.h < 80) media(k, PHONE, { display: "none" });
      else media(k, PHONE, { ...inflow, width: "100%", height: "auto", "aspect-ratio": `${Math.round(k.box.w)} / ${Math.round(k.box.h)}` });
      continue;
    }
    const wide = k.box.w >= e.box.w * 0.6;
    if (wide) media(k, TABLET_SM, { ...inflow, width: "100%", height: "auto", "min-height": "0" });
    media(k, PHONE, { ...inflow, width: "100%", height: "auto", "min-height": "0", "margin-top": "16px" });
  }
}

/**
 * A full-width edge strip pinned by `top` in the lower fifth of its container (a ruler,
 * a torn edge, a fade) must follow the bottom edge when the container grows taller than
 * designed below the design width. Measured from the bottom it lands on the same pixel
 * at the design width.
 */
function anchorEdgeStrips(e: El): void {
  if (e.box.h <= 0) return;
  for (const k of e.children) {
    if (k.style["position"] !== "absolute" || hasText(k) || k.style["bottom"] !== undefined) continue;
    const t = num(k.style["top"]); if (t === null) continue;
    const fullBleed = k.box.w >= e.box.w * 0.85 && k.box.h <= Math.max(120, e.box.h * 0.25);
    if (!fullBleed || k.box.y + k.box.h < e.box.h * 0.8) continue;
    media(k, TABLET, { top: "auto", bottom: px(Math.max(0, Math.round(e.box.h - (k.box.y + k.box.h)))) });
  }
}

const INFLOW: Record<string, string> = { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", margin: "0" };

function applyDecisions(e: El, idx: ResponsiveIndex, topInset: number, hints: FrameHints | null): void {
  for (const d of idx.get(e.id) || []) {
    const q = atQuery(d.at);
    const positioned = e.style["position"] === "absolute";
    const isRow = e.style["display"] === "flex" && e.style["flex-direction"] === "row";
    const isGrid = e.style["display"] === "grid";
    const composition = e.layoutKind === "overlay" || e.layoutKind === "absolute";
    switch (d.action) {
      case "hide": media(e, q, { display: "none" }); break;
      case "full-width": {
        // On a positioned node "full width" means: join the flow and span it.
        // An image never grows past its designed size: "fit the container" is a cap, not an upscale.
        const designW = e.box.w;
        const cap: Record<string, string> = (e.hasAsset || e.tag === "img") && designW >= 40 ? { "max-width": `min(100%, ${px(Math.round(designW))})`, height: "auto" } : {};
        media(e, q, positioned ? { ...INFLOW, width: "100%", "max-width": "100%", height: "auto", "min-height": "0", ...cap } : { width: "100%", "max-width": "100%", "margin-left": "0", "margin-right": "0", ...cap });
        break;
      }
      case "columns": {
        const n = Math.max(1, d.columns || 2);
        if (isGrid) media(e, q, { "grid-template-columns": `repeat(${n}, minmax(0, 1fr))` });
        else if (isRow) {
          const gapExpr = gapExprOf(e, "16px");
          media(e, q, { "flex-direction": "row", "flex-wrap": "wrap", "row-gap": "16px", "justify-content": "center", "align-items": "flex-start" });
          const basis = `calc(${Math.round(10000 / n) / 100}% - ${gapExpr} * ${Math.round(((n - 1) / n) * 100) / 100})`;
          for (const k of e.children.filter((c) => c.style["position"] !== "absolute")) media(k, q, cellStyle(k, basis));
        }
        break;
      }
      case "center": {
        media(e, q, { "align-self": "center", "margin-left": "auto", "margin-right": "auto", "text-align": "center", "align-items": "center", "justify-content": "center" });
        // Text layers carry their own alignment (a right-aligned column mirrored across the axis);
        // "centre" means the copy too, not only the boxes.
        const centreText = (k: El) => { if (k.isText && k.style["text-align"] && k.style["text-align"] !== "center") media(k, q, { "text-align": "center" }); if (k.style["display"] === "flex") media(k, q, { "align-items": "center" }); k.children.forEach(centreText); };
        e.children.forEach(centreText);
        break;
      }
      case "stack":
        if (composition && pictureLike(e)) break; // a collage scales as one picture; its captions already stack on phones
        if (composition) stackOverlay(e, idx, topInset, q, true);
        else if (isRow) { /* applied in rows() so the shares stage sees it */ }
        else if (isGrid) media(e, q, { "grid-template-columns": "repeat(1, minmax(0, 1fr))" });
        if (positioned) media(e, q, { ...INFLOW, width: "100%", "max-width": "100%" });
        break;
      case "wrap": break; // applied in rows()
      case "row": if (e.style["display"] === "flex") media(e, q, { "flex-direction": "row" }); break;
      default: break;
    }
  }
  void hints;
}

/**
 * Hug-width containers take their width from their content, so a fixed-width
 * text inside one never shrinks with the column around it (flex items refuse
 * to go below their content: min-width:auto). Below the design width they may.
 */
function shrinkHug(e: El, W: number): void {
  if (e.style["display"] !== "flex") return;
  const row = e.style["flex-direction"] === "row";
  // A row that wraps somewhere must keep its items' minimums, or they shrink instead of wrapping.
  const wraps = !!e.style["flex-wrap"] || Object.values(e.media).some((m) => m["flex-wrap"] === "wrap");
  const allNowrap = (n: El): boolean => n.isText ? n.style["white-space"] === "nowrap" : n.children.length > 0 && n.children.every(allNowrap);
  for (const k of e.children) {
    if (k.isText || k.tag === "img" || k.tag === "svg" || k.tag === "video" || k.style["position"] === "absolute") continue;
    if (k.style["width"] !== undefined || k.style["flex"] !== undefined || !k.children.length) continue;
    media(k, mq(W - 1), row && !wraps && !allNowrap(k) ? { "min-width": "0", "max-width": "100%" } : { "max-width": "100%" });
  }
}

/**
 * A content panel that bleeds across a section (white plate with the copy on
 * it) is absolutely placed inside a fixed-height box. Once its content stacks
 * on a phone it must drive the height: bring it into the flow.
 */
function panelsInFlow(e: El, W: number): void {
  const panels = e.children.filter((c) => c.role === "panel");
  if (!panels.length) return;
  // Below the design width the panel's content reflows and may grow; the panel must drive the
  // section's height from there. At the design width the two heights are the same.
  const q = mq(W - 1);
  media(e, q, { height: "auto", "min-height": "0" });
  // The inner held the designed height for the absolute layout; the panel drives it now.
  for (const c of e.children) if (c.role === "inner" && !hasText(c)) media(c, q, { height: "auto", "min-height": "0", "aspect-ratio": "auto" });
  for (const p of panels) {
    const top = num(p.style["top"]) || 0;
    media(p, q, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", "margin-top": px(Math.max(0, top)), height: "auto", "min-height": "0" });
  }
}

/**
 * A frame only serves viewports in its breakpoint range. Transforms written
 * for widths it never displays at (a phone rule on a desktop frame that hands
 * over to a mobile frame at 768) are dropped, and a frame never gets
 * max-width transforms at or above its own design width — the designer drew that.
 * Min-width rules (stretching) are kept only when the range reaches above them.
 */
export function pruneMedia(sections: Section[], W: number, range: { min: number; max: number | null }): void {
  const applies = (q: string): boolean => {
    const mx = q.match(/max-width:\s*(\d+)px/), mn = q.match(/min-width:\s*(\d+)px/);
    if (mn) { const minW = parseInt(mn[1], 10); return range.max === null || minW <= range.max; }
    if (!mx) return true;
    const maxW = parseInt(mx[1], 10);
    if (maxW >= W) return false;                       // at/above the design width
    if (maxW < range.min) return false;                // below this frame's range
    return true;
  };
  const visit = (e: El) => { for (const q of Object.keys(e.media)) if (!applies(q)) delete e.media[q]; e.children.forEach(visit); };
  for (const s of sections) visit(s.el);
}

/**
 * Overlay/absolute containers on tablets: the big text-bearing layers keep
 * their horizontal placement but join the flow vertically, so the box grows
 * with them instead of clipping (an absolutely placed child cannot grow its
 * parent). Backdrops stay pinned and stretch.
 */
function overlayGrow(e: El, idx: ResponsiveIndex, W: number): void {
  if (!absoluteLike(e)) return;
  if (keep(idx, e, "tablet") || pictureLike(e)) return;
  for (const k of e.children) if (restsOutside(k, e)) media(k, TABLET, { display: "none" });
  const big = e.children
    .filter((k) => k.style["position"] === "absolute" && k.role !== "backdrop" && hasText(k) && k.box.w >= e.box.w * 0.5 && !restsOutside(k, e))
    .sort((a, b) => a.box.y - b.box.y);
  if (!big.length) { overlayRow(e); return; }
  const h = num(e.style["height"]) || num(e.style["min-height"]) || e.box.h;
  // Layers that follow one another vertically can join the flow as soon as the box shrinks (the
  // result is the design at the design width); layers that overlap wait for the tablet bucket.
  const sequential = big.every((k, i) => i === 0 || k.box.y >= big[i - 1].box.y + big[i - 1].box.h - 2);
  const q = sequential ? mq(W - 1) : TABLET;
  media(e, q, { height: "auto", "min-height": px(h) });
  let prevBottom = 0;
  for (const k of big) {
    const st: Record<string, string> = { position: "relative", top: "auto", bottom: "auto", right: "auto", "margin-top": px(Math.max(0, k.box.y - prevBottom)), "max-width": "100%" };
    if ((k.style["left"] || "").includes("50%")) { st["left"] = "auto"; st["transform"] = "none"; st["margin-left"] = "auto"; st["margin-right"] = "auto"; }
    else { const l = k.style["left"] || "0"; st["margin-left"] = l; st["left"] = "auto"; if (l !== "0" && l !== "0px") st["max-width"] = `calc(100% - ${l})`; }
    media(k, q, st);
    prevBottom = k.box.y + k.box.h;
  }
  // Whatever sits below the last grown layer keeps its distance from the bottom.
  const tail = e.children.filter((k) => k.style["position"] === "absolute" && !big.includes(k) && k.role !== "backdrop" && k.box.y >= prevBottom - 1 && hasText(k) && !restsOutside(k, e));
  for (const k of tail) media(k, q, { top: "auto", bottom: px(Math.max(0, e.box.h - (k.box.y + k.box.h))) });
}

/**
 * An absolute container holding a few small text layers side by side (three cards on a band, two
 * quotes on a photo) becomes a flex row on tablets: the layers keep their order and share the width,
 * and the box grows with them instead of clipping. Phones stack the row (stackOverlay).
 */
function overlayRow(e: El): void {
  const layers = e.children.filter((k) => k.style["position"] === "absolute" && k.role !== "backdrop" && hasText(k) && !restsOutside(k, e));
  if (layers.length < 2 || layers.length > 4) return;
  const sorted = [...layers].sort((a, b) => a.box.x - b.box.x);
  // Side by side: each next layer starts past the previous one and shares its vertical band.
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const overlapY = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
    if (b.box.x < a.box.x + a.box.w - 4 || overlapY < Math.min(a.box.h, b.box.h) * 0.5) return;
  }
  const others = e.children.filter((k) => !layers.includes(k) && k.role !== "backdrop" && k.style["position"] === "absolute");
  if (others.some((k) => hasText(k))) return;
  const padT = Math.max(0, Math.round(Math.min(...layers.map((k) => k.box.y))));
  const padB = Math.max(0, Math.round(e.box.h - Math.max(...layers.map((k) => k.box.y + k.box.h))));
  const padL = Math.max(0, Math.round(sorted[0].box.x)), padR = Math.max(0, Math.round(e.box.w - (sorted[sorted.length - 1].box.x + sorted[sorted.length - 1].box.w)));
  const gap = Math.max(16, Math.round(Math.min(...sorted.slice(1).map((b, i) => b.box.x - (sorted[i].box.x + sorted[i].box.w)))));
  media(e, TABLET, { display: "flex", "flex-direction": "row", "align-items": "flex-start", gap: px(gap), height: "auto", "min-height": "0", padding: `${px(padT)} ${px(Math.min(padR, 48))} ${px(padB)} ${px(Math.min(padL, 48))}`, "aspect-ratio": "auto" });
  sorted.forEach((k, i) => media(k, TABLET, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", flex: `${Math.max(1, Math.round(k.box.w))} 1 0%`, width: "auto", "min-width": "0", "max-width": "100%", height: "auto", "min-height": "0", margin: "0", order: String(i) }));
  for (const k of others) if (k.box.w * k.box.h < e.box.w * e.box.h * 0.15 || k.hasAsset) media(k, TABLET, { display: "none" });
  for (const k of e.children) if (k.role === "backdrop") media(k, TABLET, { position: "absolute", inset: "0", width: "100%", height: "100%", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", "max-width": "none" });
}

/**
 * An overlay whose text layers sit side by side (copy left, card right) stacks at the bucket
 * where they stop fitting, which may be a tablet; one whose layers already sit one under the
 * other stacks on phones only.
 */
function overlayStackQuery(e: El, W: number): string {
  if (!absoluteLike(e)) return PHONE;
  const layers = e.children.filter((k) => k.style["position"] === "absolute" && k.role !== "backdrop" && hasText(k) && !restsOutside(k, e));
  if (layers.length < 2) return PHONE;
  const sorted = [...layers].sort((a, b) => a.box.x - b.box.x);
  let sideBySide = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const overlapY = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
    if (overlapY > Math.min(a.box.h, b.box.h) * 0.3 && b.box.x >= a.box.x + a.box.w * 0.6) sideBySide = Math.max(sideBySide, minWidth(a) + minWidth(b) + 24);
  }
  if (!sideBySide) return PHONE;
  return widerQ(PHONE, bucketAtOrAbove(breakWidth(e.box.w, sideBySide, W), W));
}

/* ------------------------------------------------------------ stretch */

/**
 * A frame shown ABOVE its design width (a 390 phone frame serving up to 767): its centred
 * inner boxes, spanning fixed-width blocks and pictures follow the viewport instead of the
 * design width. Type and small elements keep their size: it stays a phone layout, wider.
 */
export function stretchFrame(sections: Section[], W: number, range: { min: number; max: number | null }): void {
  if (range.max !== null && range.max <= W) return;
  if (W >= 1024) return; // a desktop frame centres and bleeds; it does not scale up
  const q = `(min-width: ${W + 1}px)`;
  const visit = (e: El, contentW: number) => {
    const w = num(e.style["width"]);
    const spans = e.box.w >= contentW * 0.9;
    if (e.role === "inner") media(e, q, { "max-width": "none" });
    // A picture capped at its designed size inside a box that now grows would float in empty space.
    if ((e.style["max-width"] || "").startsWith("min(100%,") && (e.tag === "img" || e.tag === "video" || e.hasAsset)) media(e, q, { "max-width": "100%" });
    if (e.role === "inner") { /* handled */ }
    else if (e.style["position"] !== "absolute" && spans && !e.isText) {
      if (e.tag === "img" || e.tag === "video") {
        const h = num(e.style["height"]);
        media(e, q, { width: "100%", "max-width": "100%", height: "auto", ...(h && w ? { "aspect-ratio": `${Math.round(w)} / ${Math.round(h)}` } : {}) });
      } else if (w !== null || e.style["max-width"] !== undefined) media(e, q, { width: "100%", "max-width": "100%" });
    } else if (e.isText && spans && (w !== null || e.style["max-width"])) media(e, q, { width: "100%", "max-width": "100%" });
    const inner = Math.max(1, e.box.w - sidePadding(e.style["padding"]));
    e.children.forEach((c) => visit(c, inner));
  };
  for (const s of sections) visit(s.el, s.box.w);
}

/* --------------------------------------------------------------- main */

export function applyResponsive(sections: Section[], W: number, idx: ResponsiveIndex = new Map(), hints: FrameHints | null = null): void {
  const visit = (e: El, depth: number, topInset: number, parent: El | null) => {
    fluidPadding(e, W); fluidGap(e, W); fluidAbsolute(e, W, parent); fluidType(e, W);
    collapseGrid(e, idx, W); rows(e, idx, W, hints); overlayGrow(e, idx, W);
    if (!(idx.get(e.id) || []).some((d) => d.action === "stack")) stackOverlay(e, idx, topInset, overlayStackQuery(e, W));
    loosen(e, idx, W); shrinkHug(e, W);
    if (!keep(idx, e, "phone")) { scaleComposition(e, W); anchorEdgeStrips(e); absoluteInFlow(e); panelsInFlow(e, W); }
    applyDecisions(e, idx, topInset, hints);
    e.children.forEach((c) => visit(c, depth + 1, c.role === "inner" ? topInset : 0, e));
  };
  sections.forEach((s, i) => {
    // A section the previous one overlaps (a header on a hero) must start its stack below it.
    const prev = sections[i - 1];
    const overlap = prev ? Math.max(0, prev.box.y + prev.box.h - s.box.y) : 0;
    visit(s.el, 0, overlap > 0 && overlap < 200 ? overlap : 0, null);
  });
}
