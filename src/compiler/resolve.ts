/**
 * IR + Plan -> element tree. This is where the layout rules live.
 *
 * Every structural decision (root, sections, flow/grid/overlay, tags,
 * decorations) comes from the plan; every measurement from the IR. The output
 * is a tree of `El` with plain CSS declarations, ready for the emitters.
 */
import {
  type IRDocument, type IRFrame, type IRNode, type IRIndex, type Box, type IRAsset, type IRTextSegment, type IREffect,
  indexFrame, isAncestor, slugify, walk,
  type IRText,
} from "../ir/schema.ts";
import { type Plan, type PlanIndex, type PlanContainer, indexPlan } from "../ir/plan.ts";
import {
  type Style, px, backgroundOf, applyBackground, applyStroke, applyEffects, radiusCss, segmentCss, withAlpha, gradientCss,
} from "./style.ts";

export interface El {
  id: string;
  name: string;
  tag: string;
  cls: string;
  attrs: Record<string, string>;
  style: Style;
  hover: Style | null;
  /** Descendant deltas in another state: `.root:hover [data-figma-id=childId] { style }`. */
  stateRules: Array<{ state: "hover" | "active"; childId: string | null; style: Style }>;
  /** Extra declarations under a media query, e.g. "(max-width: 767px)". */
  media: Record<string, Style>;
  children: El[];
  /** Plain text (single style) or rich runs. */
  text: string | null;
  runs: Array<{ text: string; style: Style; href: string | null }> | null;
  svg: string | null;
  src: string | null;          // img src
  assetUrl: string | null;     // any exported asset file behind this element
  poster: string | null;       // video poster
  box: Box;                    // relative to parent
  size: { w: number; h: number };
  rotation: number;
  isText: boolean;
  hasAsset: boolean;
  irType: string;
  /** How this container's children were laid out (set for containers). */
  layoutKind: "flow" | "grid" | "overlay" | "absolute" | null;
  /** Backdrop of an overlay, decoration, or the centred content box of a full-bleed section. */
  role: "backdrop" | "decoration" | "inner" | "panel" | null;
  /** Padding that was inferred from child offsets (not designed padding). */
  inferredPad: boolean;
}

export function hasText(e: El): boolean {
  if (e.isText) return true;
  return e.children.some(hasText);
}

export interface Section { el: El; slug: string; box: Box; id: string; name: string }

export interface ResolvedFrame {
  frame: IRFrame;
  plan: Plan;
  sections: Section[];
  /** Styles for the frame wrapper itself: background, top offset of the first section, bottom slack. */
  rootStyle: Style;
  generated: Map<string, string>;
  warnings: string[];
  fonts: Map<string, Set<string>>; // family -> weights (as "wght" or "ital,wght")
}

export interface ResolveOptions {
  /** Prefix for asset urls relative to the html file, e.g. "assets/". */
  assetPrefix: string;
  inlineSvg: boolean;
}

interface Ctx {
  /** Files the compiler synthesises (composite SVGs), path -> text. */
  generated: Map<string, string>;
  navDepth: number;   // >0 while inside a nav-role container
  headingDepth: number; // >0 while inside an h1-h6 container: descendants must stay phrasing content
  doc: IRDocument;
  frame: IRFrame;
  idx: IRIndex;
  plan: PlanIndex;
  opts: ResolveOptions;
  warnings: string[];
  fonts: Map<string, Set<string>>;
  canvasWidth: number;
  /** Variant ids that several instances with different pictures hover into (a component's master variant). */
  sharedVariants: Set<string>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------ helpers */

function rel(n: IRNode, parent: IRNode | null, rendered = false): Box {
  const b = rendered ? n.renderBox : n.box;
  if (!parent) return { ...b };
  return { x: r2(b.x - parent.box.x), y: r2(b.y - parent.box.y), w: b.w, h: b.h };
}

function childrenOverlap(kids: IRNode[], parent: IRNode): boolean {
  const boxes = kids.map((k) => k.box).filter((b) => b.w > 0 && b.h > 0);
  if (boxes.length < 2) return false;
  const parentArea = Math.max(1, parent.box.w * parent.box.h);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox <= 1 || oy <= 1) continue;
    const area = ox * oy, smaller = Math.min(a.w * a.h, b.w * b.h), bigger = Math.max(a.w * a.h, b.w * b.h);
    if (area / smaller <= 0.15) continue;
    if (bigger / parentArea >= 0.5) return true;
  }
  return false;
}

function inferFlow(kids: El[], force?: "row" | "column"): { direction: "row" | "column"; gap: number } | null {
  const boxes = kids.filter((k) => k.box.w > 0 && k.box.h > 0);
  if (boxes.length < 2) return force ? { direction: force, gap: 0 } : null;
  const sY = [...boxes].sort((a, b) => a.box.y - b.box.y), sX = [...boxes].sort((a, b) => a.box.x - b.box.x);
  const vG: number[] = [], hG: number[] = []; let vC = true, hC = true;
  for (let i = 1; i < sY.length; i++) { const g = sY[i].box.y - (sY[i - 1].box.y + sY[i - 1].box.h); if (g < -2) vC = false; vG.push(Math.max(0, g)); }
  for (let i = 1; i < sX.length; i++) { const g = sX[i].box.x - (sX[i - 1].box.x + sX[i - 1].box.w); if (g < -2) hC = false; hG.push(Math.max(0, g)); }
  const avg = (g: number[]) => g.reduce((a, b) => a + b, 0) / Math.max(1, g.length);
  const consistent = (g: number[]) => g.length > 0 && g.every((x) => Math.abs(x - avg(g)) <= Math.max(4, avg(g) * 0.25));
  if (force === "row") return { direction: "row", gap: Math.round(Math.max(0, avg(hG))) };
  if (force === "column") return { direction: "column", gap: Math.round(Math.max(0, avg(vG))) };
  if (hC && consistent(hG)) return { direction: "row", gap: Math.round(avg(hG)) };
  if (vC && consistent(vG)) return { direction: "column", gap: Math.round(avg(vG)) };
  return null;
}
function inferColumns(kids: El[]): number {
  const boxes = kids.filter((k) => k.box.w > 0 && k.box.h > 0);
  if (!boxes.length) return 1;
  const minY = Math.min(...boxes.map((b) => b.box.y));
  return Math.max(1, boxes.filter((b) => Math.abs(b.box.y - minY) < Math.max(8, b.box.h * 0.3)).length);
}
function inferGridGaps(kids: El[], columns: number): { row: number; col: number } {
  const b = [...kids].filter((k) => k.box.w > 0).sort((a, c) => a.box.y - c.box.y || a.box.x - c.box.x);
  let col = 0, row = 0;
  if (b.length >= 2 && columns >= 2) col = Math.max(0, Math.round(b[1].box.x - (b[0].box.x + b[0].box.w)));
  if (b.length > columns) row = Math.max(0, Math.round(b[columns].box.y - (b[0].box.y + b[0].box.h)));
  return { row, col };
}

function roleFromName(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(h1|title|headline)([^a-z]|$)/.test(n)) return "heading";
  if (/(^|[^a-z])(h2|subtitle|subheading)([^a-z]|$)/.test(n)) return "subheading";
  if (/\b(btn|button|cta)\b/.test(n)) return "cta";
  if (/\b(nav|menu)\b/.test(n)) return "nav";
  if (/\b(logo|brand)\b/.test(n)) return "logo";
  if (/\b(icon)\b/.test(n)) return "icon";
  if (/\b(card|item|tile)\b/.test(n)) return "card";
  if (/\b(header|masthead)\b/.test(n)) return "header";
  if (/\b(footer)\b/.test(n)) return "footer";
  if (/\b(hero|banner)\b/.test(n)) return "hero";
  return undefined;
}
function headingTag(size: number): string {
  if (size >= 44) return "h1"; if (size >= 34) return "h2"; if (size >= 26) return "h3"; if (size >= 21) return "h4"; return "h5";
}
function tagForText(n: IRNode, role?: string): string {
  const t = n.text!; const seg = t.segments[0];
  const size = seg ? seg.fontSize : 16, weight = seg ? seg.fontWeight : 400;
  const chars = t.characters.trim();
  const short = chars.length <= 60 && !chars.includes("\n");
  if (role === "heading") return size >= 40 ? "h1" : headingTag(size);
  if (role === "subheading") return size >= 30 ? "h2" : headingTag(size);
  if (role === "cta") return "span";
  if (short && (size >= 21 || (weight >= 500 && size >= 18))) return headingTag(size);
  return "p";
}
function tagForContainer(role: string | undefined, depth: number, box: Box): string {
  if (role === "header") return "header";
  if (role === "footer") return "footer";
  if (role === "nav") return "nav";
  if (role === "cta" && box.h <= 120 && box.w <= 640) return "button";
  if (depth === 0) return "section";
  return "div";
}

function newEl(n: IRNode, box: Box, tag = "div"): El {
  return {
    id: n.id, name: n.name, tag, cls: slugify(n.name, "el"), attrs: {}, style: {}, hover: null, stateRules: [], media: {}, children: [],
    text: null, runs: null, svg: null, src: null, assetUrl: null, poster: null, box, size: { ...n.size }, rotation: n.rotation,
    isText: n.type === "text", hasAsset: false, irType: n.type, layoutKind: null, role: null, inferredPad: false,
  };
}

/* ------------------------------------------------------------- sizing */

function applySizing(el: El, n: IRNode, parent: IRNode | null, ctx: Ctx): void {
  const s = el.style;
  const W = ctx.canvasWidth;
  const pl = parent?.layout || null;
  const w = n.size.w, h = n.size.h;

  // width
  if (n.sizing.w === "fill") {
    if (pl && pl.direction === "row") { s["flex"] = "1 1 0%"; s["min-width"] = "0"; }
    else s["width"] = "100%";
    // In a HUG parent the fill child follows its siblings' width in Figma; the
    // browser would let it grow to its own content instead.
    if (parent && parent.sizing.w === "hug" && w > 0) s["max-width"] = px(w);
  } else if (n.sizing.w === "fixed" || !pl) {
    // A fixed child wider than its parent's content box (a full-bleed heading
    // inside a padded column) hangs out by design: keep the overhang as
    // negative margins so it survives at other widths too.
    const padL = pl ? pl.padding[3] : 0, padR = pl ? pl.padding[1] : 0;
    const contentW = parent ? parent.box.w - padL - padR : Infinity;
    const overL = parent ? (parent.box.x + padL) - n.box.x : 0, overR = parent ? (n.box.x + w) - (parent.box.x + parent.box.w - padR) : 0;
    if (pl && pl.direction === "column" && n.positioning === "auto" && w > contentW + 1 && overL >= -1 && overR >= -1) {
      s["width"] = `calc(100% + ${px(Math.max(0, overL) + Math.max(0, overR))})`;
      s["margin-left"] = px(-Math.max(0, overL)); s["margin-right"] = px(-Math.max(0, overR));
      s["max-width"] = "none";
    } else if (n.sizing.w === "fixed" || n.type !== "text") {
      if (w >= W * 0.6) { s["width"] = "100%"; s["max-width"] = px(w); }
      else { s["width"] = px(w); s["max-width"] = "100%"; }
    }
  }
  // height
  if (n.sizing.h === "fill") {
    if (pl && pl.direction === "column") {
      const parentFixed = parent!.sizing.h === "fixed";
      if (parentFixed) { s["flex"] = "1 1 0%"; s["min-height"] = "0"; } else s["align-self"] = "stretch";
    } else s["align-self"] = "stretch";
  } else if (n.sizing.h === "fixed" || (!pl && n.type !== "text")) {
    const paints = n.fills.some((f) => f.type === "image" || f.type === "solid" || f.type === "gradient") || !!n.fillAsset;
    const reflowable = n.children.some((k) => k.type === "text" && k.text && (k.text.autoResize === "height" || k.text.characters.trim().length > 24));
    const policy = ctx.plan.text.get(n.id);
    if ((reflowable && !paints && policy !== "fixed") || policy === "reflow") s["min-height"] = px(h);
    else s["height"] = px(h);
  }
  if (n.sizing.minW) s["min-width"] = px(n.sizing.minW);
  if (n.sizing.maxW) s["max-width"] = px(n.sizing.maxW);
  if (n.sizing.minH) s["min-height"] = px(n.sizing.minH);
  if (n.sizing.maxH) s["max-height"] = px(n.sizing.maxH);
  if (n.grow > 0 && !s["flex"]) s["flex-grow"] = String(n.grow);
  if (n.alignSelf === "stretch" && !s["align-self"]) s["align-self"] = "stretch";
}

function measuredGap(n: IRNode): number {
  const kids = n.children.filter((k) => k.positioning !== "absolute" && k.opacity > 0).map((k) => k.box);
  if (kids.length < 2) return 0;
  const row = n.layout!.direction === "row";
  const sorted = [...kids].sort((a, b) => (row ? a.x - b.x : a.y - b.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(row ? sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) : sorted[i].y - (sorted[i - 1].y + sorted[i - 1].h));
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avg < 2 || gaps.some((g) => Math.abs(g - avg) > Math.max(3, avg * 0.25))) return 0;
  return Math.round(avg * 100) / 100;
}

/**
 * Figma's stored direction can contradict the geometry (a "row" whose children
 * each span the width and sit one under another: the designer stacked them by
 * hand). The measured arrangement is the truth.
 */
function measuredDirection(n: IRNode): "row" | "column" | null {
  const kids = n.children.filter((k) => k.positioning !== "absolute" && k.box.w > 0 && k.box.h > 0);
  if (kids.length < 2) return null;
  const sortedY = [...kids].sort((a, b) => a.box.y - b.box.y), sortedX = [...kids].sort((a, b) => a.box.x - b.box.x);
  const stackedY = sortedY.every((k, i) => i === 0 || k.box.y >= sortedY[i - 1].box.y + sortedY[i - 1].box.h - 2);
  const stackedX = sortedX.every((k, i) => i === 0 || k.box.x >= sortedX[i - 1].box.x + sortedX[i - 1].box.w - 2);
  if (stackedY && !stackedX) return "column";
  if (stackedX && !stackedY) return "row";
  return null;
}

function applyAutoLayout(el: El, n: IRNode, forced?: "row" | "column" | ""): void {
  const l = n.layout!; const s = el.style;
  s["display"] = "flex";
  const measured = measuredDirection(n);
  const direction = forced || (measured && measured !== l.direction && !l.wrap ? measured : l.direction);
  s["flex-direction"] = direction;
  // Imported designs often report gap 0 while the children measurably sit apart.
  const gap = l.gap || (l.justify !== "space-between" && !l.wrap ? measuredGap(n) : 0);
  if (gap > 0 && l.justify !== "space-between") s["gap"] = l.wrap && l.counterGap ? `${px(l.counterGap)} ${px(gap)}` : px(gap);
  else if (gap < 0) el.attrs["data-neg-gap"] = String(gap); // applied to the children once they exist
  if (l.wrap) { s["flex-wrap"] = "wrap"; if (l.alignContent === "space-between") s["align-content"] = "space-between"; }
  const J: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" };
  const A: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", baseline: "baseline" };
  s["justify-content"] = J[l.justify];
  s["align-items"] = A[l.align];
  // A fixed-height column pinned to the top leaves a hole when its text wraps
  // to one more line in the browser; let the slack fall between the groups.
  if (direction === "column" && l.justify === "start" && n.sizing.h === "fixed") {
    const flow = n.children.filter((c) => c.positioning === "auto" && c.box.h > 0);
    if (flow.length > 1) {
      // Only when the designed children span the frame: a start-pinned column
      // with slack at the bottom must keep that slack.
      const last = flow.reduce((m, c) => (c.box.y + c.box.h > m.box.y + m.box.h ? c : m), flow[0]);
      const innerBottom = n.box.y + n.box.h - l.padding[2];
      if (Math.abs(innerBottom - (last.box.y + last.box.h)) <= 8) s["justify-content"] = "space-between";
    }
  }
  const [t, r, b, lft] = l.padding;
  if (t || r || b || lft) s["padding"] = `${px(t)} ${px(r)} ${px(b)} ${px(lft)}`;
}

/* ---------------------------------------------------------- placement */

function placeAbsolute(c: El, x: number, y: number): void {
  c.style["position"] = "absolute";
  if (c.rotation && c.size) {
    c.style["left"] = px(x + (c.box.w - c.size.w) / 2);
    c.style["top"] = px(y + (c.box.h - c.size.h) / 2);
  } else { c.style["left"] = px(x); c.style["top"] = px(y); }
}

/** Absolute placement that honours Figma constraints so it survives resizing. */
function placeConstrained(c: El, n: IRNode, parent: IRNode): void {
  const pw = parent.box.w, ph = parent.box.h;
  const b = c.box;
  const s = c.style;
  s["position"] = "absolute";
  // A fluid cap (width:100% + max-width) means "no wider than designed" in
  // flow; when positioned, the designed width IS the width, else centring
  // and right-anchoring measure against the whole parent.
  if (s["width"] === "100%" && s["max-width"] && s["max-width"] !== "100%") s["width"] = s["max-width"];
  delete s["max-width"];
  // A layer that hangs outside its (clipping) parent must keep its size: the
  // parent shows a window onto it. Only layers that fit get the fluid cap.
  const fits = c.box.x >= -1 && c.box.x + c.box.w <= parent.box.w + 1;
  if (s["width"] && s["width"] !== "100%" && fits) s["max-width"] = "100%";
  const cx = c.rotation ? b.x + (b.w - c.size.w) / 2 : b.x;
  const cy = c.rotation ? b.y + (b.h - c.size.h) / 2 : b.y;
  const w = c.rotation ? c.size.w : b.w, h = c.rotation ? c.size.h : b.h;
  const rightInset = pw - (cx + w);
  const centredWide = n.constraints.h === "min" && w >= pw * 0.5 && Math.abs(rightInset - cx) <= 2 && cx >= 0;
  switch (centredWide ? "stretch" : n.constraints.h) {
    case "max": s["right"] = px(pw - (cx + w)); break;
    case "center": {
      const off = cx + w / 2 - pw / 2;
      s["left"] = Math.abs(off) < 0.5 ? "50%" : `calc(50% + ${Math.round((off / pw) * 10000) / 100}%)`;
      s["transform"] = `translateX(-50%)${s["transform"] ? " " + s["transform"] : ""}`;
      break;
    }
    case "stretch":
      // Equal insets around a box narrower than the frame: a centred content row. Fixed insets would
      // squeeze it on screens between its width and the design width; centre it and cap at 100%.
      if (Math.abs(rightInset - cx) <= 2 && w < pw * 0.95) { s["left"] = "50%"; s["transform"] = `translateX(-50%)${s["transform"] ? " " + s["transform"] : ""}`; s["width"] = px(w); s["max-width"] = "100%"; delete s["right"]; }
      else { s["left"] = px(cx); s["right"] = px(pw - (cx + w)); delete s["width"]; }
      break;
    case "scale": s["left"] = `${r2((cx / pw) * 100)}%`; s["width"] = `${r2((w / pw) * 100)}%`; break;
    default: s["left"] = px(cx);
  }
  switch (n.constraints.v) {
    case "max": s["bottom"] = px(ph - (cy + h)); break;
    case "stretch": s["top"] = px(cy); s["bottom"] = px(ph - (cy + h)); delete s["height"]; break;
    default: s["top"] = px(cy);
  }
}

/* -------------------------------------------------------- text runs */

function dominantSegment(segs: IRTextSegment[]): IRTextSegment {
  let best = segs[0];
  for (const s of segs) if (s.end - s.start > best.end - best.start) best = s;
  return best;
}
function noteFont(ctx: Ctx, seg: IRTextSegment) {
  if (!ctx.fonts.has(seg.fontFamily)) ctx.fonts.set(seg.fontFamily, new Set());
  ctx.fonts.get(seg.fontFamily)!.add(`${seg.italic ? 1 : 0},${seg.fontWeight}`);
}

function buildText(el: El, n: IRNode, ctx: Ctx): void {
  const t = n.text!;
  const s = el.style;
  if (!t.segments.length) { el.text = t.characters; return; }
  const base = dominantSegment(t.segments);
  Object.assign(s, segmentCss(base));
  // Figma "auto" line height is the font's own; browsers pick a different
  // "normal". The measured box gives the value: height / rendered lines.
  if (base.lineHeight.unit === "auto" && t.lines >= 1 && n.box.h > 0 && t.segments.length === 1) {
    const perLine = n.box.h / t.lines;
    if (perLine >= base.fontSize * 0.9 && perLine <= base.fontSize * 1.8) s["line-height"] = px(Math.round(perLine * 100) / 100);
  }
  // Fixed-width text Figma wrapped at N lines: the browser's version of the
  // font can run a few percent wider and add a line. Give the box that slack
  // as a soft cap (max-width) so the line count survives; single lines stay.
  // Only display type: a lost line there is a whole 60px; body copy re-wraps harmlessly.
  if (n.sizing.w === "fixed" && t.autoResize === "height" && t.lines >= 2 && n.box.w >= 200 && n.positioning === "auto" && base.fontSize >= 28) el.attrs["data-text-slack"] = "1";
  for (const seg of t.segments) noteFont(ctx, seg);
  if (t.align !== "left") s["text-align"] = t.align;
  // Leading trim: Figma cuts the box to cap height and baseline. Older bundles
  // do not record the flag, but a box shorter than its line boxes means the same.
  const lhPx = base.lineHeight.unit === "px" ? base.lineHeight.value : base.lineHeight.unit === "percent" ? base.fontSize * base.lineHeight.value / 100 : base.fontSize * 1.2;
  const k = n.box.h / lhPx;
  // Only with an explicit line height: an "auto" line box is font-metric dependent and cannot be tested.
  const removed = Math.ceil(k) * lhPx - n.box.h;
  const inferredTrim = base.lineHeight.unit !== "auto" && lhPx > 0 && n.box.h > 0
    && Math.abs(n.box.h - Math.round(k) * lhPx) > 1.5 && removed > lhPx * 0.15 && removed < lhPx * 0.85 && n.box.h >= base.fontSize * 0.5;
  const trimmed = t.leadingTrim === "cap-height" || inferredTrim;
  if (trimmed) { s["text-box-trim"] = "trim-both"; s["text-box-edge"] = "cap alphabetic"; }
  // Gradient-filled text: paint the gradient through the glyphs.
  if (!base.color) {
    const g = n.fills.find((f) => f.type === "gradient");
    if (g && g.type === "gradient") { s["background-image"] = gradientCss(g); s["-webkit-background-clip"] = "text"; s["background-clip"] = "text"; s["color"] = "transparent"; s["-webkit-text-fill-color"] = "transparent"; }
  }
  // Hug-both text never soft-wraps in Figma. Keep hard breaks, but let a line
  // that is wider in the browser's font wrap instead of spilling out of its box.
  if (t.autoResize === "width-height") s["white-space"] = t.characters.includes("\n") ? "pre-wrap" : "nowrap";
  else if (t.autoResize === "height" && hardWrapped(t, n.box.w)) s["white-space"] = "nowrap"; // imported copy: every line already ends in a break
  if (t.autoResize === "truncate") {
    s["overflow"] = "hidden"; s["text-overflow"] = "ellipsis";
    if (t.maxLines && t.maxLines > 1) { s["display"] = "-webkit-box"; s["-webkit-line-clamp"] = String(t.maxLines); s["-webkit-box-orient"] = "vertical"; }
    else s["white-space"] = "nowrap";
  }
  if (t.valign !== "top" && n.sizing.h === "fixed") { s["display"] = "flex"; s["flex-direction"] = "column"; s["justify-content"] = t.valign === "center" ? "center" : "flex-end"; }
  if (t.paragraphSpacing && t.characters.includes("\n")) el.attrs["data-paragraph-spacing"] = String(t.paragraphSpacing);

  const uniform = t.segments.length === 1 || t.segments.every((x) => Object.keys(segmentCss(x, base)).length === 0 && !x.href);
  if (uniform) { el.text = t.characters; return; }
  el.runs = t.segments.map((seg) => ({
    text: t.characters.slice(seg.start, seg.end),
    style: segmentCss(seg, base),
    href: seg.href,
  }));
}

/* -------------------------------------------------------------- walk */

/** Two same-sized copies of one icon, offset diagonally so one sits outside the clip: a swap rig. */
function sameNameSwap(n: IRNode): boolean {
  const [a, b] = n.children;
  if (!a || !b || Math.abs(a.box.w - b.box.w) > 0.5 || Math.abs(a.box.h - b.box.h) > 0.5) return false;
  const inside = (c: IRNode) => c.box.x >= n.box.x - 0.5 && c.box.y >= n.box.y - 0.5 && c.box.x + c.box.w <= n.box.x + n.box.w + 0.5 && c.box.y + c.box.h <= n.box.y + n.box.h + 0.5;
  return inside(a) !== inside(b);
}

function assetOf(ctx: Ctx, id: string | null): IRAsset | undefined {
  if (!id) return undefined;
  const a = ctx.doc.assets[id];
  if (!a) ctx.warnings.push(`asset ${id} referenced but missing from bundle`);
  return a;
}

function useAsset(el: El, a: IRAsset, ctx: Ctx, bbox: Box): void {
  el.hasAsset = true;
  el.assetUrl = `${ctx.opts.assetPrefix}${a.file}`;
  // Inline small vectors (they inherit colour and scale crisply); very large
  // ones (Figma bakes noise/texture into thousands of path segments) stay files.
  if (a.kind === "svg" && a.svg && ctx.opts.inlineSvg && a.svg.length <= 60_000) { el.tag = "svg"; el.svg = a.svg; }
  else if (a.kind === "video-poster") { el.tag = "video"; el.poster = `${ctx.opts.assetPrefix}${a.file}`; }
  else { el.tag = "img"; el.src = `${ctx.opts.assetPrefix}${a.file}`; el.attrs["alt"] = el.name; }
  if (!el.style["width"]) el.style["width"] = px(bbox.w);
  if (!el.style["height"]) el.style["height"] = px(bbox.h);
  if (el.tag === "img" || el.tag === "video") el.style["object-fit"] = "cover";
}

function resolveNode(n: IRNode, parent: IRNode | null, depth: number, ctx: Ctx): El | null {
  const plan = ctx.plan;
  if (plan.ignore.has(n.id)) return null;
  if (n.opacity === 0) {
    // Figma still reserves the space of a fully transparent child in a flow.
    if (parent && n.positioning === "auto" && n.size.w > 0 && n.size.h > 0) {
      const spacer = newEl(n, rel(n, parent));
      spacer.style["width"] = px(n.size.w); spacer.style["height"] = px(n.size.h); spacer.style["visibility"] = "hidden"; spacer.style["flex-shrink"] = "0";
      spacer.attrs["data-figma-id"] = n.id; spacer.attrs["aria-hidden"] = "true";
      return spacer;
    }
    return null;
  }
  const deco = plan.decorations.get(n.id);
  if (deco === "ignore") return null;
  const role = roleFromName(n.name);

  // A LINE is a stroke with no area. CSS draws it crisper than a 1px SVG:
  // a box the stroke's weight thick, the stroke's colour, along its axis.
  if (n.type === "line" && n.stroke && n.stroke.dash.length === 0) {
    const bbox = rel(n, parent);
    const el = newEl(n, bbox);
    const vertical = bbox.w < bbox.h;
    const w = n.stroke.weight;
    el.style["width"] = vertical ? px(w) : px(bbox.w || w);
    el.style["height"] = vertical ? px(bbox.h || w) : px(w);
    el.style["background-color"] = n.stroke.color;
    if (vertical) { el.style["flex-shrink"] = "0"; if (n.sizing.h === "fill") { el.style["align-self"] = "stretch"; delete el.style["height"]; } }
    else if (n.sizing.w === "fill") { el.style["width"] = "100%"; }
    el.rotation = 0;
    finishCommon(el, n, ctx, true);
    return el;
  }

  // A group made of many small vectors (a dotted map, a particle field) is one
  // picture: compose the exported SVGs into a single file instead of hundreds
  // of inline elements.
  const composite = compositeSvg(n, ctx);
  if (composite) {
    const bbox = rel(n, parent);
    const el = newEl(n, bbox);
    el.tag = "img"; el.src = composite; el.hasAsset = true; el.assetUrl = composite; el.attrs["alt"] = n.name;
    el.style["width"] = px(bbox.w); el.style["height"] = px(bbox.h); el.style["max-width"] = "100%";
    applySizing(el, n, parent, ctx);
    if (n.sizing.w !== "fill") el.style["width"] = px(bbox.w);
    finishCommon(el, n, ctx, true);
    return el;
  }

  // Regular stripes (many same-size rects, constant period, cycling colours)
  // are one repeating gradient: exact, weightless, and it scales.
  const stripes = stripePattern(n);
  if (stripes) {
    const bbox = rel(n, parent);
    const el = newEl(n, bbox);
    el.style["background-image"] = stripes;
    el.style["background-repeat"] = "repeat";
    applySizing(el, n, parent, ctx);
    if (!el.style["width"]) el.style["width"] = px(bbox.w);
    if (!el.style["height"] && !el.style["min-height"]) el.style["height"] = px(bbox.h);
    finishCommon(el, n, ctx, false);
    return el;
  }

  // Flattened subtree: an exported composite (mask/rotated group, icon group,
  // or a plan-requested raster) stands in for its children.
  let own = assetOf(ctx, n.asset);
  const isLeafish = !n.children.length;
  // A clipping frame holding two copies of the same icon, each with its own export, inside a hover
  // component is a swap rig (one arrow flies out while the other flies in). Flattening it to one
  // picture would freeze the animation: keep the children as elements and let the frame clip them.
  if (own && n.clips && n.children.length >= 2 && n.children.every((c) => c.asset) && new Set(n.children.map((c) => c.name)).size === 1) {
    let cur: IRNode | null = n, inState = false;
    while (cur) { if (cur.states && Object.keys(cur.states).length) { inState = true; break; } cur = ctx.idx.parent.get(cur.id) || null; }
    if (inState || sameNameSwap(n)) own = undefined;
  }
  if (deco === "rasterize" && !own) {
    let hasAssets = false; walk(n, (k) => { if (k.asset) hasAssets = true; });
    if (!hasAssets) ctx.warnings.push(`plan asked to rasterize ${n.id} "${n.name}" but no asset was exported; re-extract with this id in the rasterize list`);
  }
  if (own && (isLeafish || deco === "rasterize" || n.children.length)) {
    // Exports cover the render bounds: shadows and rotation included, and
    // CLIPPED by a clipping parent. An SVG's viewBox says which box it matches.
    let useRender = true;
    if (own.kind === "svg" && own.svg) {
      const vb = own.svg.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/);
      if (vb) {
        const vw = parseFloat(vb[1]), vh = parseFloat(vb[2]);
        const dBox = Math.abs(vw - n.box.w) + Math.abs(vh - n.box.h), dRender = Math.abs(vw - n.renderBox.w) + Math.abs(vh - n.renderBox.h);
        useRender = dRender <= dBox;
      }
    }
    const bbox = rel(n, parent, useRender);
    const el = newEl(n, bbox);
    el.rotation = 0; // the exported bytes are already rotated; bbox is the render box
    useAsset(el, own, ctx, bbox);
    if (n.type === "text") { /* never */ }
    applySizing(el, n, parent, ctx);
    if (own.kind === "svg") { el.style["width"] = px(Math.max(1, bbox.w)); el.style["height"] = px(Math.max(1, bbox.h)); delete el.style["max-width"]; }
    else if (n.sizing.w !== "fill") { el.style["width"] = px(bbox.w); }
    if (n.sizing.h !== "fill") el.style["height"] = px(bbox.h);
    // Shadows/glows outside the layer are in the exported bytes but take no
    // layout space in Figma. In flow, pull that overflow back with margins.
    if (n.positioning === "auto" && parent && parent.layout) {
      const b = n.box, r = n.renderBox;
      const t = b.y - r.y, l = b.x - r.x, rt = (r.x + r.w) - (b.x + b.w), bt = (r.y + r.h) - (b.y + b.h);
      if ([t, l, rt, bt].some((v) => v > 0.5)) {
        el.style["margin"] = `${px(-Math.max(0, t))} ${px(-Math.max(0, rt))} ${px(-Math.max(0, bt))} ${px(-Math.max(0, l))}`;
        el.box = { x: b.x - parent.box.x, y: b.y - parent.box.y, w: b.w, h: b.h };
      }
    }
    finishCommon(el, n, ctx, true);
    return el;
  }

  const bbox = rel(n, parent);
  const el = newEl(n, bbox);

  if (n.type === "text" && n.text) {
    el.tag = tagForText(n, role);
    if (ctx.headingDepth > 0) el.tag = "span"; // a heading inside a heading closes the parent in the HTML parser
    // Short text directly inside a nav/menu is a link unless the plan says otherwise.
    if (ctx.navDepth > 0 && n.text.characters.trim().length <= 40 && !n.text.characters.includes("\n")) { el.tag = "a"; el.attrs["href"] = "#"; }
    buildText(el, n, ctx);
    applySizing(el, n, parent, ctx);
    if (n.sizing.w === "hug" || (n.text.autoResize === "width-height")) { delete el.style["width"]; delete el.style["max-width"]; }
    if (n.text.autoResize === "height" || n.text.autoResize === "width-height") { delete el.style["height"]; delete el.style["min-height"]; }
    const overhangs = (el.style["margin-right"] || "").startsWith("-") || (el.style["margin-left"] || "").startsWith("-");
    if (n.sizing.w === "fixed" && n.text.autoResize !== "width-height" && !overhangs) {
      el.style["width"] = px(n.size.w); el.style["max-width"] = "100%";
      if (el.attrs["data-text-slack"]) {
        delete el.attrs["data-text-slack"];
        // Width slack absorbs font drift; the designed height stays as a floor
        // so a line that no longer wraps does not shrink the block around it.
        el.style["width"] = `min(100%, ${px(Math.round(n.size.w * 1.03))})`;
        el.style["min-height"] = px(n.size.h);
      }
    }
    if (el.style["height"] && n.text.autoResize !== "truncate") { el.style["min-height"] = el.style["height"]; delete el.style["height"]; }
    finishCommon(el, n, ctx, false);
    return el;
  }

  // ---- container / shape ---------------------------------------------
  el.tag = tagForContainer(role, depth, bbox);
  if (ctx.headingDepth > 0) el.tag = "span";
  const kids = n.children;
  // Decided now, before the children resolve: a heading container (a multi-line headline drawn as
  // separate layers plus a highlight block) may only hold phrasing content.
  const HEADING = /^h[1-6]$/;
  const thisHeading = HEADING.test(plan.tags.get(n.id) || el.tag);
  const pc: PlanContainer | undefined = plan.containers.get(n.id);
  const hasAuto = !!n.layout;
  const flowKids = kids.filter((k) => k.positioning !== "absolute");

  let mode: PlanContainer["layout"];
  if (pc) mode = pc.layout;
  else if (hasAuto) mode = n.layout!.wrap && flowKids.length > 2 ? "grid" : "flow";
  else mode = childrenOverlap(flowKids, n) ? "overlay" : "flow";
  // A grid means equal cells that fill the row. A single auto-layout row is
  // not one when its items are unequal (a logo strip) or when they do not span
  // the row (three fixed cards centred in a full-width frame): equal columns
  // would resize the items. Keep the row Figma already laid out.
  if (mode === "grid" && hasAuto && !n.layout!.wrap && flowKids.length >= 2) {
    const ws = flowKids.map((k) => k.box.w).filter((w) => w > 0);
    const oneRow = new Set(flowKids.map((k) => Math.round(k.box.y / 8))).size === 1;
    const l = n.layout!;
    const spanned = ws.reduce((a, b) => a + b, 0) + l.gap * (flowKids.length - 1) + l.padding[1] + l.padding[3];
    const fillsRow = spanned >= n.box.w * 0.9;
    const fixedItems = flowKids.every((k) => k.sizing.w !== "fill");
    if (oneRow && (Math.max(...ws) / Math.max(1, Math.min(...ws)) > 1.5 || (!fillsRow && fixedItems))) {
      mode = "flow";
      if (pc) ctx.warnings.push(`plan grid on ${n.id} "${n.name}" overridden: one row that does not fill its frame, kept as a flex row`);
    }
  }

  const auto = mode === "flow" && hasAuto;
  el.layoutKind = mode;
  // The plan's direction wins over Figma's stored one when they disagree.
  if (auto) applyAutoLayout(el, n, pc && pc.direction ? pc.direction : "");
  else if (n.layout) { const [t, r, b, l] = n.layout.padding; if (t || r || b || l) el.style["padding"] = `${px(t)} ${px(r)} ${px(b)} ${px(l)}`; }
  applySizing(el, n, parent, ctx);

  // paint
  const bg = backgroundOf(n.fills, { w: n.size.w, h: n.size.h });
  const fillAsset = assetOf(ctx, n.fillAsset);
  applyBackground(el.style, bg, fillAsset ? `${ctx.opts.assetPrefix}${fillAsset.file}` : null);
  if (bg.hasVideo && !fillAsset) ctx.warnings.push(`video fill on ${n.id} "${n.name}" has no poster`);
  if (n.clips) el.style["overflow"] = "hidden";
  else if (kids.some((k) => k.positioning === "absolute" && (k.box.x < n.box.x - 1 || k.box.x + k.box.w > n.box.x + n.box.w + 1 || k.box.y < n.box.y - 1 || k.box.y + k.box.h > n.box.y + n.box.h + 1))) el.style["overflow"] = "visible";

  // Children keep Figma's order. A child Figma positions absolutely inside an
  // auto-layout frame (backgrounds, torn edges, badges) leaves the flow; its
  // stacking follows the layer order, so every sibling gets z-index = index.
  const ordered: Array<{ el: El; ir: IRNode; abs: boolean }> = [];
  const isNav = role === "nav" || el.tag === "nav";
  if (isNav) ctx.navDepth++;
  if (thisHeading) ctx.headingDepth++;
  // Imported designs record auto-layout the boxes contradict: a child drawn
  // before the previous one ends is not in the sequence (position it), and a
  // child sitting at the far or middle of the cross axis is aligned there.
  const dirNow = el.style["flex-direction"] === "row" ? "row" : "column";
  const trustBoxes = auto && !!n.layout && !n.layout.wrap && !n.layout.reverse && n.layout.gap >= 0 && n.layout.justify !== "space-between";
  let prevEnd = -Infinity;
  for (const k of kids) {
    const c = resolveNode(k, n, depth + 1, ctx);
    if (!c) continue;
    let abs = k.positioning === "absolute" && (auto || mode === "grid");
    if (trustBoxes && !abs && k.box.w > 0 && k.box.h > 0) {
      const mainStart = dirNow === "row" ? k.box.x : k.box.y, mainEnd = dirNow === "row" ? k.box.x + k.box.w : k.box.y + k.box.h;
      if (prevEnd !== -Infinity && mainStart < prevEnd - 2) {
        abs = true; ctx.warnings.push(`${k.id} "${k.name}" is drawn outside its auto-layout sequence; positioned`);
        // The layer still took part in the frame's hug size: keep that size so the siblings' alignment holds.
        if (!el.style["height"]) el.style["min-height"] = px(n.box.h);
      }
      else prevEnd = Math.max(prevEnd, mainEnd);
      if (!abs && n.layout!.align === "start" && k.alignSelf === "auto" && c.style["align-self"] !== "stretch") {
        const pad = n.layout!.padding;
        const cs = dirNow === "row" ? k.box.y - (n.box.y + pad[0]) : k.box.x - (n.box.x + pad[3]);
        const ce = dirNow === "row" ? (n.box.y + n.box.h - pad[2]) - (k.box.y + k.box.h) : (n.box.x + n.box.w - pad[1]) - (k.box.x + k.box.w);
        if (cs > 2 && Math.abs(ce) <= 2) c.style["align-self"] = "flex-end";
        else if (cs > 2 && Math.abs(cs - ce) <= 2) c.style["align-self"] = "center";
      }
    }
    if (abs) placeConstrained(c, k, n);
    ordered.push({ el: c, ir: k, abs });
  }
  if (isNav) ctx.navDepth--;
  if (thisHeading) ctx.headingDepth--;
  const absKids = ordered.filter((o) => o.abs).map((o) => o.el);
  const flowEls = ordered.filter((o) => !o.abs).map((o) => o.el);
  if (absKids.length) el.style["position"] = el.style["position"] || "relative";

  let visualOrder = false;
  // Without auto-layout, siblings that overlap (an icon drawn as several
  // vectors, a photo with its plate) are one visual unit; flowing them apart
  // destroys it. Group each overlapping cluster into one positioned box.
  if (!hasAuto && (mode === "flow" || mode === "grid") && flowEls.length > 1) {
    // Every child in one overlapping cluster that fills the frame (a section built from a backdrop,
    // wave dividers and a content row): the frame IS the composition. A wrapper group here would be
    // a fixed-width box that neither centres on wide screens nor lets its layers bleed to the edges.
    if (singleClusterFills(flowEls, bbox)) mode = "absolute";
    else {
      const grouped = clusterOverlaps(flowEls, kids);
      if (grouped !== flowEls) { flowEls.length = 0; flowEls.push(...grouped); }
    }
  }
  // A grid drawn as a column of row wrappers (two 3-up rows of cards): the
  // cells are the grandchildren; the wrappers carry nothing of their own.
  let flattenedRows = false;
  let gridPc = pc;
  if (mode === "grid" && hasAuto && n.layout!.direction === "column" && flowEls.length >= 2) {
    const rows = ordered.filter((o) => !o.abs);
    const wrapper = (o: { el: El; ir: IRNode }) => !!o.ir.layout && o.ir.layout.direction === "row" && !o.ir.fills.length && !o.ir.stroke && !o.ir.effects.length
      && !o.el.hasAsset && o.el.children.length >= 2 && o.el.children.every((c) => c.style["position"] !== "absolute");
    if (rows.every(wrapper)) {
      const counts = rows.map((o) => o.el.children.length);
      const cols = (pc && pc.columns) || Math.max(...counts);
      const cells = rows.flatMap((o) => o.el.children);
      flowEls.length = 0; flowEls.push(...cells);
      flattenedRows = true;
      gridPc = { ...(pc || { id: n.id, layout: "grid", direction: "", base: "", note: "" }), columns: cols } as PlanContainer;
      // Row gap is the column's gap; column gap is the wrapper's gap.
      el.attrs["data-grid-gaps"] = `${px(n.layout!.gap)} ${px(rows[0].ir.layout!.gap)}`;
    }
  }
  if (flowEls.length) {
    const kidIr = new Map(kids.map((k) => [k.id, k] as const));
    if (mode === "grid") {
      if (!hasAuto) { if (!sortByReadingOrder(flowEls, n.readingOrder, kids)) sortRowMajor(flowEls); visualOrder = true; }
      applyGrid(el, flowEls, n, hasAuto, gridPc);
      if (el.attrs["data-grid-gaps"]) { el.style["gap"] = el.attrs["data-grid-gaps"]; delete el.attrs["data-grid-gaps"]; }
    }
    else if (mode === "overlay") applyOverlay(el, flowEls, bbox, pc, kidIr, n);
    else if (mode === "absolute") applyAbsolute(el, flowEls, bbox, kidIr, n);
    else if (!auto) visualOrder = applyInferredFlow(el, flowEls, bbox, pc, kidIr, n);
  }
  if (auto && n.layout) {
    // A negative gap (Figma lets items overlap) becomes a negative margin on every item after the first.
    const neg = el.attrs["data-neg-gap"] ? parseFloat(el.attrs["data-neg-gap"]) : 0;
    if (neg < 0) {
      delete el.attrs["data-neg-gap"];
      const flow = ordered.filter((o) => !o.abs);
      flow.forEach((o, i) => { if (i > 0) o.el.style[n.layout!.direction === "column" ? "margin-top" : "margin-left"] = px(neg); });
    }
    proportionalFill(ordered.filter((o) => !o.abs), n.layout.direction);
    // Auto-layout content wider than its fixed frame overflows in Figma (a map
    // pin whose label hangs out to the left). Flex would shrink the items
    // instead; pin their sizes so the overflow happens the same way.
    const flow = ordered.filter((o) => !o.abs);
    const row = n.layout.direction === "row";
    const main = flow.reduce((t, o) => t + (row ? o.ir.box.w : o.ir.box.h), 0) + n.layout.gap * Math.max(0, flow.length - 1)
      + (row ? n.layout.padding[1] + n.layout.padding[3] : n.layout.padding[0] + n.layout.padding[2]);
    const frame = row ? n.box.w : n.box.h;
    if ((row ? n.sizing.w : n.sizing.h) === "fixed" && main > frame + 1) {
      for (const o of flow) { o.el.style["flex-shrink"] = "0"; if (o.el.style["max-width"] === "100%") delete o.el.style["max-width"]; }
      if (!n.clips) el.style["overflow"] = "visible";
    }
    // CSS pins a stretched item that has a max-width to the START edge; Figma
    // centres it when the frame's counter-axis alignment is centre (or end).
    const cross = n.layout.align === "center" ? "center" : n.layout.align === "end" ? "flex-end" : null;
    if (cross) for (const o of ordered) {
      if (o.abs) continue;
      const st = o.el.style;
      if (st["align-self"] === "stretch" && st["max-width"] && st["max-width"] !== "100%") st["align-self"] = cross;
    }
  }
  if (absKids.length || (n.layout && n.layout.reverse)) {
    const rev = !!(n.layout && n.layout.reverse);
    ordered.forEach((o, i) => {
      if (o.el.style["z-index"] === undefined) o.el.style["z-index"] = String(rev ? ordered.length - i : i);
      if (!o.abs && !o.el.style["position"]) o.el.style["position"] = "relative";
    });
  }
  // Without auto-layout, Figma's children array is z-order, not reading order.
  // Flow/grid children were sorted visually; z-index above keeps the paint order.
  el.children = visualOrder || flattenedRows || mode === "overlay" || mode === "absolute" ? [...flowEls, ...absKids] : ordered.map((o) => o.el);

  // A fixed-height frame directly holding a reflow paragraph must be able to grow.
  if (el.style["height"] && el.children.some((c) => c.isText && plan.text.get(c.id) === "reflow")) { el.style["min-height"] = el.style["height"]; delete el.style["height"]; }

  finishCommon(el, n, ctx, false);
  applyStates(el, n, parent, depth, ctx);
  return el;
}

/* ------------------------------------------------------------ states */

const STATE_PROPS = new Set(["background-color", "background-image", "background-blend-mode", "color", "border", "border-color", "border-width", "border-style",
  "box-shadow", "opacity", "border-radius", "filter", "backdrop-filter", "-webkit-backdrop-filter", "text-decoration", "letter-spacing", "font-weight",
  "padding", "gap", "width", "height", "min-height", "transform"]);

/**
 * A prototype state (the variant a hover/press reaction changes to) resolved
 * with the same rules, then diffed against the default tree pair by pair.
 * Root deltas become `.cls:hover`; descendant deltas target the default
 * tree's node ids; children that moved get a translate.
 */
function applyStates(el: El, n: IRNode, parent: IRNode | null, depth: number, ctx: Ctx): void {
  if (!n.states) return;
  for (const [state, sub] of Object.entries(n.states) as Array<["hover" | "press", IRNode]>) {
    const pseudo = state === "press" ? "active" : "hover";
    const stateEl = resolveNode(sub, parent, depth, { ...ctx, warnings: [] });
    if (!stateEl) continue;
    const rootDelta = styleDelta(el.style, stateEl.style);
    // The variant's own box is the same size as the instance: a size delta here is a layout artefact, not a hover effect.
    if (Math.abs(n.size.w - sub.size.w) < 0.5) delete rootDelta["width"];
    if (Math.abs(n.size.h - sub.size.h) < 0.5) { delete rootDelta["height"]; delete rootDelta["min-height"]; }
    // Several instances hover into the same component variant while each shows its own picture: the
    // variant's picture is the master's, not a hover effect. Keep the instance's image.
    const sharedVariant = ctx.sharedVariants.has(sub.id);
    if (sharedVariant) for (const k of ["background-image", "background-size", "background-position", "background-repeat", "background-blend-mode"]) delete rootDelta[k];
    const inter = n.interactions.find((x) => x.trigger === state);
    const transition = `all ${inter?.durationMs || 200}ms ${inter?.easing || "ease"}`;
    if (Object.keys(rootDelta).length) {
      if (pseudo === "hover") el.hover = { ...(el.hover || {}), ...rootDelta };
      else el.stateRules.push({ state: pseudo, childId: null, style: rootDelta });
    }
    // Variants reorder layers freely (a slid-up bar moves to the front), so pair children by name, then by order.
    const pair = (a: El, b: El): Array<[number, number]> => {
      const used = new Set<number>(); const out: Array<[number, number]> = [];
      a.children.forEach((ca, i) => {
        const j = b.children.findIndex((cb, k) => !used.has(k) && cb.name === ca.name && cb.isText === ca.isText);
        if (j >= 0) { used.add(j); out.push([i, j]); }
      });
      a.children.forEach((_, i) => {
        if (out.some(([x]) => x === i)) return;
        const j = b.children.findIndex((_, k) => !used.has(k));
        if (j >= 0) { used.add(j); out.push([i, j]); }
        else out.push([i, -1]); // a layer the variant removes: hidden in that state
      });
      return out;
    };
    const walk = (a: El, b: El, ai: IRNode, bi: IRNode) => {
      const pairs = pair(a, b);
      for (const [i, j] of pairs) {
        const ca = a.children[i];
        if (j < 0) { el.stateRules.push({ state: pseudo, childId: ca.id, style: { opacity: "0" } }); continue; }
        const cb = b.children[j];
        const ia = ai.children.find((c) => c.id === ca.id) || ai.children[i], ib = bi.children.find((c) => c.id === cb.id) || bi.children[j];
        const delta = styleDelta(ca.style, cb.style);
        if (ia && ib) {
          // Offset inside the PARENT, not the root: a parent that slides carries its children with it,
          // so a child only gets its own translate when its place within the parent changed.
          const dx = (ib.box.x - bi.box.x) - (ia.box.x - ai.box.x), dy = (ib.box.y - bi.box.y) - (ia.box.y - ai.box.y);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            // Keep the resting transform (e.g. the translateX(-50%) that centres a backdrop) and add the slide.
            const base = ca.style["transform"] ? ca.style["transform"] + " " : "";
            delta["transform"] = `${base}translate(${px(dx)}, ${px(dy)})`;
          } else if (delta["transform"] !== undefined && delta["transform"] === cb.style["transform"] && ca.style["transform"] && ca.style["transform"] !== cb.style["transform"]) {
            delete delta["transform"]; // both states centre the same way; the variant's own transform is not an effect
          }
        }
        // The variant paints a different picture (a darker overlay baked into the export): swap the image.
        if (!sharedVariant && ca.tag === "img" && cb.tag === "img" && ca.src && cb.src && ca.src !== cb.src) delta["content"] = `url("${cb.src}")`;
        if (sharedVariant) for (const k of ["background-image", "background-size", "background-position", "content"]) delete delta[k];
        // Children keep their box unless Figma really resized them (a bar that grows to reveal copy).
        // A growing box gets an explicit resting height too, so the growth animates instead of jumping.
        delete delta["width"]; delete delta["height"]; delete delta["min-height"];
        if (ia && ib && !ca.isText) {
          if (Math.abs(ib.box.h - ia.box.h) > 0.5 && !ca.style["min-height"]) { ca.style["height"] = ca.style["height"] || px(ia.box.h); delta["height"] = px(ib.box.h); }
          if (Math.abs(ib.box.h - ia.box.h) > 0.5 && ca.style["min-height"]) delta["min-height"] = px(ib.box.h);
          if (Math.abs(ib.box.w - ia.box.w) > 0.5 && ca.style["width"] && /px$/.test(ca.style["width"])) delta["width"] = px(ib.box.w);
        }
        if (Object.keys(delta).length) { el.stateRules.push({ state: pseudo, childId: ca.id, style: delta }); ca.style["transition"] = ca.style["transition"] || transition; }
        // Descend only where both states have element children: a flattened icon paired with the
        // variant's un-exported vector group has nothing to diff.
        if (ia && ib && ca.children.length && cb.children.length) walk(ca, cb, ia, ib);
      }
      if (a.hasAsset || a.isText || !a.children.length) return;
      // Layers that exist only in the variant (copy revealed on hover): rendered in the default tree at
      // the place the variant gives them, positioned so the resting layout is untouched, faded in on
      // hover. The parent, which grows with them in Figma, got its hover height above.
      const paired = new Set(pairs.map(([, j]) => j));
      b.children.forEach((cb, j) => {
        if (paired.has(j)) return;
        const ib = bi.children.find((c) => c.id === cb.id) || bi.children[j];
        if (ib) {
          cb.style["position"] = "absolute"; cb.style["left"] = px(ib.box.x - bi.box.x); cb.style["top"] = px(ib.box.y - bi.box.y);
          if (!cb.style["width"] || !/px$/.test(cb.style["width"])) cb.style["width"] = px(ib.box.w);
          delete cb.style["right"]; delete cb.style["bottom"]; delete cb.style["margin"]; delete cb.style["max-width"];
        }
        cb.style["opacity"] = "0"; cb.style["pointer-events"] = "none"; cb.style["transition"] = cb.style["transition"] || transition;
        a.style["position"] = a.style["position"] || "relative";
        if (!a.style["overflow"]) a.style["overflow"] = "hidden";
        a.children.splice(Math.min(j, a.children.length), 0, cb);
        el.stateRules.push({ state: pseudo, childId: cb.id, style: { opacity: "1" } });
      });
      if (a.children.length !== b.children.length) ctx.warnings.push(`${state} state of ${n.id} "${n.name}" changes structure under "${a.name}"; unmatched layers hidden or revealed`);
    };
    walk(el, stateEl, n, sub);
    if (!el.style["transition"]) el.style["transition"] = transition;
    el.style["cursor"] = el.style["cursor"] || "pointer";
  }
}

/**
 * Text whose characters carry a line break at the end of nearly every line
 * (HTML-imported copy): the breaks ARE the wrapping. A browser font a few
 * percent wider would wrap each line once more; forbid soft wraps instead.
 */
function hardWrapped(t: IRText, boxW: number): boolean {
  const lines = t.characters.split("\n");
  if (lines.length < 3) return false;
  const fs = t.segments[0]?.fontSize || 16;
  const est = (l: string): number => l.length * fs * 0.5;
  const body = lines.slice(0, -1); // the last line may be short
  return body.every((l: string) => est(l) >= boxW * 0.55 && est(l) <= boxW * 1.15);
}

function styleDelta(a: Style, b: Style): Style {
  const out: Style = {};
  for (const k of STATE_PROPS) {
    const va = a[k], vb = b[k];
    if (vb !== undefined && vb !== va) out[k] = vb;
    else if (va !== undefined && vb === undefined && (k === "box-shadow" || k === "border" || k === "background-image" || k === "filter")) out[k] = "none";
  }
  return out;
}

function finishCommon(el: El, n: IRNode, ctx: Ctx, flattened: boolean): void {
  const s = el.style;
  const plan = ctx.plan;
  const lineLike = n.type === "line" || (n.size.h <= 1 && !!n.stroke);
  if (!flattened) {
    if (lineLike && n.stroke) { s["height"] = px(n.stroke.weight); s["background-color"] = n.stroke.color; delete s["min-height"]; }
    else applyStroke(s, n.stroke, false, !!(n.layout && n.layout.strokesIncluded));
    const rad = radiusCss(n.radius); if (rad) s["border-radius"] = rad;
    if (n.type === "ellipse" && !n.radius) s["border-radius"] = "50%";
    const paints = !!(s["background-color"] || s["background-image"] || s["border"] || s["border-width"] || s["box-shadow"]);
    type Shadow = IREffect & { x: number; y: number; blur: number; spread: number; color: string };
    const drops = n.effects.filter((e): e is Shadow => e.type === "drop-shadow");
    if (el.isText && drops.length) {
      // Figma shadows text glyphs; CSS box-shadow would draw a box around them.
      s["text-shadow"] = drops.map((e) => `${px(e.x)} ${px(e.y)} ${px(e.blur)} ${e.color}`).join(", ");
      applyEffects(s, n.effects.filter((e) => e.type !== "drop-shadow"));
    } else if (!paints && drops.length && !el.hasAsset) {
      // A shadow on a frame with no fill follows the shapes inside it.
      s["filter"] = drops.map((e) => `drop-shadow(${px(e.x)} ${px(e.y)} ${px(e.blur / 2)} ${e.color})`).join(" ");
      applyEffects(s, n.effects.filter((e) => e.type !== "drop-shadow"));
    } else applyEffects(s, n.effects);
  }
  // exportAsync bakes the layer's own opacity into the bytes; do not apply it twice.
  if (n.opacity < 1 && !(flattened && el.hasAsset)) s["opacity"] = String(n.opacity);
  if (n.blendMode && n.blendMode !== "pass-through" && n.blendMode !== "normal") s["mix-blend-mode"] = n.blendMode;
  if (n.rotation && el.rotation !== 0 && !el.hasAsset && !el.children.length) {
    s["width"] = px(n.size.w); s["height"] = px(n.size.h); delete s["max-width"];
    s["transform"] = `rotate(${r2(-n.rotation)}deg)${s["transform"] ? " " + s["transform"] : ""}`;
  }
  // interactions -> transition + :hover
  const inter = n.interactions;
  if (inter.length) {
    const dur = inter.find((i) => i.durationMs)?.durationMs || 200;
    s["transition"] = `all ${dur}ms ${inter[0].easing || "ease"}`;
    const hv = inter.find((i) => i.hover)?.hover;
    if (hv) { el.hover = {}; if (hv.backgroundColor) el.hover["background-color"] = hv.backgroundColor; if (hv.opacity !== undefined) el.hover["opacity"] = String(hv.opacity); if (hv.color) el.hover["color"] = hv.color; }
    const nav = inter.find((i) => i.action === "navigate" && i.url);
    if (nav && nav.url && !plan.links.has(n.id)) { el.tag = el.tag === "button" || el.isText ? "a" : el.tag; el.attrs["href"] = nav.url; }
    if (!plan.tags.has(n.id) && !el.hasAsset && !el.isText && (el.tag === "div") && inter.some((i) => i.trigger === "click" || i.trigger === "press")) el.tag = "button";
  }
  // plan overrides
  const tag = plan.tags.get(n.id);
  const PHRASING = new Set(["a", "span", "strong", "em", "b", "i", "small", "mark", "sub", "sup", "button", "img", "svg"]);
  if (tag && !el.hasAsset) el.tag = ctx.headingDepth > 0 && !PHRASING.has(tag) ? "span" : tag;
  const href = plan.links.get(n.id);
  if (href) { if (!el.hasAsset) el.tag = "a"; el.attrs["href"] = href; }
  if (el.tag === "button") { s["cursor"] = "pointer"; s["border"] = s["border"] || "0"; s["font"] = "inherit"; s["color"] = s["color"] || "inherit"; if (!s["background-color"] && !s["background-image"]) s["background"] = "transparent"; }
  if (el.tag === "a") { s["text-decoration"] = s["text-decoration"] || "none"; s["color"] = s["color"] || "inherit"; }
  if (el.tag === "svg" && el.box.h < 1) s["height"] = "1px";
  if (el.tag === "svg" && el.box.w < 1) s["width"] = "1px";
  el.attrs["data-figma-id"] = n.id;
}

/**
 * Two FILL siblings in a row split the free space equally in CSS, but Figma's
 * measured boxes can be unequal (imported designs, min sizes). Weight flex-grow
 * by the measured size so the design-width render matches and still flexes.
 */
function proportionalFill(items: Array<{ el: El; ir: IRNode }>, direction: "row" | "column"): void {
  const fills = items.filter((o) => (direction === "row" ? o.ir.sizing.w : o.ir.sizing.h) === "fill");
  if (fills.length < 2) return;
  const sizes = fills.map((o) => (direction === "row" ? o.ir.box.w : o.ir.box.h));
  const min = Math.min(...sizes), max = Math.max(...sizes);
  if (max <= 0 || (max - min) / max < 0.03) return;
  fills.forEach((o, i) => {
    const key = direction === "row" ? "flex" : "flex";
    if (o.el.style[key] === "1 1 0%") o.el.style[key] = `${Math.round(sizes[i])} 1 0%`;
  });
}

/* ------------------------------------------------------------ layouts */

function applyGrid(el: El, children: El[], n: IRNode, hasAuto: boolean, pc?: PlanContainer): void {
  const s = el.style;
  const columns = (pc && pc.columns) || inferColumns(children);
  s["display"] = "grid";
  s["grid-template-columns"] = `repeat(${columns}, minmax(0, 1fr))`;
  let rowGap = 0, colGap = 0;
  // Stored gaps win when present; a gap of 0 with children that measurably
  // sit apart (imported designs) means the measured gap is the real one.
  const measured = inferGridGaps(children, columns);
  if (hasAuto && n.layout && n.layout.justify !== "space-between" && (n.layout.gap || n.layout.counterGap)) {
    const l = n.layout;
    // A wrapping row stores the gap between items; the gap between lines is
    // separate and often unset, in which case the measured one is the truth.
    colGap = l.direction === "row" ? l.gap : (l.counterGap || measured.col);
    rowGap = l.direction === "row" ? (l.counterGap || measured.row) : l.gap;
  } else { rowGap = measured.row; colGap = measured.col; }
  s["gap"] = `${px(rowGap)} ${px(colGap)}`;
  delete s["flex-direction"]; delete s["flex-wrap"]; delete s["justify-content"];
  // Cards of one row that Figma drew at different heights are hug-sized; stretching them
  // to the tallest repaints every shorter card. Equal heights stretch (they already match).
  const byRow = new Map<number, number[]>();
  for (const c of children) { const key = Math.round(c.box.y / 8); byRow.set(key, [...(byRow.get(key) || []), c.box.h]); }
  const unequal = [...byRow.values()].some((hs) => hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 4);
  s["align-items"] = unequal ? "start" : "stretch";
  const widths = children.map((c) => c.box.w).filter((w) => w > 0).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] || 0;
  for (const c of children) {
    c.style["width"] = "100%"; delete c.style["max-width"]; delete c.style["flex"];
    if (c.style["position"] === "absolute") { delete c.style["position"]; delete c.style["left"]; delete c.style["top"]; }
    // An item much wider than the others (a centred last row) spans the grid.
    if (columns > 1 && median > 0 && c.box.w >= median * 1.5) { c.style["grid-column"] = "1 / -1"; c.style["justify-self"] = "center"; c.style["width"] = px(c.box.w); c.style["max-width"] = "100%"; }
  }
  if (s["height"]) { s["min-height"] = s["height"]; delete s["height"]; }
}

function applyOverlay(el: El, children: El[], bbox: Box, pc: PlanContainer | undefined, kidIr: Map<string, IRNode>, parent: IRNode): void {
  const s = el.style;
  s["position"] = "relative";
  delete s["display"]; delete s["flex-direction"]; delete s["gap"]; delete s["align-items"]; delete s["justify-content"];
  const parentArea = Math.max(1, bbox.w * bbox.h);
  let base = -1;
  let stretchBase = false;
  if (pc && pc.base) base = children.findIndex((c) => c.id === pc.base);
  if (base < 0 && !s["background-image"]) {
    // The backdrop is real media (photo/video, not a gradient scrim) that
    // covers the frame AND sits at the bottom of the stack. A scrim above the
    // photo must stay above it.
    const isMedia = (c: El): boolean => c.hasAsset || /url\(/.test(c.style["background-image"] || "") ||
      (!hasText(c) && c.children.length > 0 && c.children.some((k) => isMedia(k) && (k.box.w * k.box.h) / Math.max(1, c.box.w * c.box.h) >= 0.9));
    const first = children[0];
    if (first && isMedia(first) && (first.box.w * first.box.h) / parentArea >= 0.9) { base = 0; stretchBase = true; }
  }
  if (base >= 0 && pc && pc.base) stretchBase = (children[base].box.w * children[base].box.h) / parentArea >= 0.9;
  s["height"] = s["height"] || s["min-height"] || px(bbox.h);
  delete s["min-height"];
  if (!s["width"] && !s["flex"]) { s["width"] = px(bbox.w); s["max-width"] = "100%"; }
  s["overflow"] = s["overflow"] || "hidden";
  children.forEach((c, i) => {
    if (i === base) return;
    c.style["z-index"] = String(10 + i);
    const ir = kidIr.get(c.id);
    if (ir) placeConstrained(c, ir, parent); else placeAbsolute(c, c.box.x, c.box.y);
  });
  const b = base >= 0 ? children[base] : undefined;
  if (b) b.role = "backdrop";
  // z-index is explicit now, so the DOM may follow reading order (what a
  // stacked phone layout and a screen reader need).
  children.sort((x, y) => (x === b ? -1 : y === b ? 1 : Math.abs(x.box.y - y.box.y) < 8 ? x.box.x - y.box.x : x.box.y - y.box.y));
  if (b && stretchBase) {
    Object.assign(b.style, { position: "absolute", top: "0", left: "0", right: "0", bottom: "0", "z-index": "0", width: "100%", height: "100%" });
    delete b.style["max-width"];
  } else if (b) {
    placeAbsolute(b, b.box.x, b.box.y);
    b.style["width"] = px(b.box.w); b.style["height"] = px(b.box.h); b.style["z-index"] = "0";
    delete b.style["max-width"]; delete b.style["right"];
  }
}

function applyAbsolute(el: El, children: El[], bbox: Box, kidIr: Map<string, IRNode>, parent: IRNode): void {
  const s = el.style;
  s["position"] = s["position"] || "relative";
  delete s["display"]; delete s["flex-direction"]; delete s["gap"];
  if (!s["min-height"] && !s["height"]) s["height"] = px(bbox.h);
  // Positioned children give a hug box no size of its own.
  if (!s["width"] && !s["flex"]) { s["width"] = px(bbox.w); s["max-width"] = "100%"; }
  children.forEach((c, i) => { if (c.style["z-index"] === undefined) c.style["z-index"] = String(i + 1); });
  for (const c of children) { const ir = kidIr.get(c.id); if (ir) placeConstrained(c, ir, parent); else placeAbsolute(c, c.box.x, c.box.y); }
  // A child covering the box is its backdrop.
  const area = Math.max(1, bbox.w * bbox.h);
  const back = children.find((c) => (c.box.w * c.box.h) / area >= 0.9 && (c.hasAsset || c.style["background-image"] || c.style["background-color"]));
  if (back) back.role = "backdrop";
  children.sort((x, y) => (x === back ? -1 : y === back ? 1 : Math.abs(x.box.y - y.box.y) < 8 ? x.box.x - y.box.x : x.box.y - y.box.y));
}

function overlapRatio(a: Box, b: Box): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  return (ox * oy) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** True when all siblings form one overlap cluster whose union covers (almost) the whole box. */
function singleClusterFills(els: El[], bbox: Box): boolean {
  const n = els.length;
  const parentOf = els.map((_, i) => i);
  const find = (i: number): number => (parentOf[i] === i ? i : (parentOf[i] = find(parentOf[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (overlapRatio(els[i].box, els[j].box) >= 0.3) parentOf[find(i)] = find(j);
  const root = find(0);
  if (!els.every((_, i) => find(i) === root)) return false;
  const x = Math.min(...els.map((e) => e.box.x)), y = Math.min(...els.map((e) => e.box.y));
  const x2 = Math.max(...els.map((e) => e.box.x + e.box.w)), y2 = Math.max(...els.map((e) => e.box.y + e.box.h));
  return x2 - x >= bbox.w * 0.95 && y2 - y >= bbox.h * 0.95;
}

/** Union overlapping siblings (≥ 30% of the smaller box) into synthetic groups. */
function clusterOverlaps(els: El[], kids: IRNode[]): El[] {
  const n = els.length;
  const parentOf = els.map((_, i) => i);
  const find = (i: number): number => (parentOf[i] === i ? i : (parentOf[i] = find(parentOf[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (overlapRatio(els[i].box, els[j].box) >= 0.3) parentOf[find(i)] = find(j);
  const groups = new Map<number, El[]>();
  els.forEach((e, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(e); });
  if ([...groups.values()].every((g) => g.length === 1)) return els;
  const out: El[] = [];
  const done = new Set<number>();
  els.forEach((_, i) => {
    const r = find(i); if (done.has(r)) return; done.add(r);
    const g = groups.get(r)!;
    if (g.length === 1) { out.push(g[0]); return; }
    const x = Math.min(...g.map((e) => e.box.x)), y = Math.min(...g.map((e) => e.box.y));
    const x2 = Math.max(...g.map((e) => e.box.x + e.box.w)), y2 = Math.max(...g.map((e) => e.box.y + e.box.h));
    const first = g[0];
    const wrap: El = {
      id: `${first.id}~group`, name: `${first.name} group`, tag: "div", cls: slugify(`${first.name}-group`, "group"), attrs: {},
      style: { position: "relative", width: px(x2 - x), height: px(y2 - y), "flex-shrink": "0" }, hover: null, stateRules: [], media: {}, children: [],
      text: null, runs: null, svg: null, src: null, assetUrl: null, poster: null, box: { x, y, w: x2 - x, h: y2 - y }, size: { w: x2 - x, h: y2 - y },
      rotation: 0, isText: false, hasAsset: false, irType: "group", layoutKind: "absolute", role: null, inferredPad: false,
    };
    // Keep Figma paint order inside the group; place each member at its offset.
    const order = new Map(kids.map((k, i) => [k.id, i] as const));
    g.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const m of g) {
      const lx = m.box.x - x, rx = (x2 - x) - (lx + m.box.w);
      m.style["position"] = "absolute"; m.style["top"] = px(m.box.y - y);
      delete m.style["margin"]; delete m.style["max-width"];
      // A flow-time fluid cap (width:100% + max-width) means nothing once the member is placed by
      // coordinates: the designed box is its size. A member centred in the group stays centred and
      // never wider than the group (a 1271 content row inside a 1923 section on a 1440 screen).
      if (!m.style["width"] || m.style["width"] === "100%") m.style["width"] = px(m.box.w);
      if (lx > 2 && Math.abs(lx - rx) <= 2) { m.style["left"] = "50%"; m.style["transform"] = `translateX(-50%)${m.style["transform"] ? " " + m.style["transform"] : ""}`; m.style["max-width"] = "100%"; }
      else m.style["left"] = px(lx);
      m.box = { x: m.box.x - x, y: m.box.y - y, w: m.box.w, h: m.box.h };
      wrap.children.push(m);
    }
    out.push(wrap);
  });
  return out;
}

/**
 * ≥ 24 leaf vectors with exported SVGs, nothing else inside: nest each SVG at its
 * offset inside one root SVG and register it as a generated asset file.
 */
function compositeSvg(n: IRNode, ctx: Ctx): string | null {
  if (!n.children.length || n.asset) return null;
  const leaves: IRNode[] = [];
  let ok = true;
  const visit = (k: IRNode) => {
    if (!ok) return;
    if (k.children.length) { if (k.text || k.fills.some((f) => f.type === "image")) { ok = false; return; } k.children.forEach(visit); return; }
    if (k.text || !k.asset || ctx.doc.assets[k.asset]?.kind !== "svg") { ok = false; return; }
    leaves.push(k);
  };
  visit(n);
  if (!ok || leaves.length < 24) return null;
  // One root <svg>, each leaf as a <g transform> — never nested <svg> elements.
  // Dev servers (Live Server) inject a <script> before the FIRST "</svg>" they
  // see; nested roots put that inside a child and the file stops parsing.
  const parts: string[] = [];
  leaves.forEach((k, i) => {
    const a = ctx.doc.assets[k.asset!]; if (!a || !a.svg) return;
    const m = a.svg.replace(/^\s*<\?xml[^>]*>\s*/i, "").match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>\s*$/i);
    if (!m) return;
    const attrs = m[1]; let inner = m[2];
    const vb = attrs.match(/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)"/);
    const vx = vb ? parseFloat(vb[1]) : 0, vy = vb ? parseFloat(vb[2]) : 0, vw = vb ? parseFloat(vb[3]) : k.renderBox.w, vh = vb ? parseFloat(vb[4]) : k.renderBox.h;
    const b = k.renderBox;
    const sx = vw > 0 ? b.w / vw : 1, sy = vh > 0 ? b.h / vh : 1;
    // Ids must stay unique across leaves (gradients, clip paths).
    inner = inner.replace(/\bid="([^"]+)"/g, `id="l${i}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#l${i}-$1)`).replace(/href="#([^"]+)"/g, `href="#l${i}-$1"`);
    const fill = /\bfill="/.test(attrs) ? ` fill="${(attrs.match(/\bfill="([^"]*)"/) || [])[1]}"` : "";
    parts.push(`<g transform="translate(${r2(b.x - n.box.x)} ${r2(b.y - n.box.y)}) scale(${r2(sx)} ${r2(sy)}) translate(${r2(-vx)} ${r2(-vy)})"${fill}>${inner.trim()}</g>`);
  });
  if (!parts.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${r2(n.box.w)} ${r2(n.box.h)}" width="${r2(n.box.w)}" height="${r2(n.box.h)}">\n${parts.join("\n")}\n</svg>\n`;
  // Content hash in the name: a browser cache can never hold a stale version.
  let h = 0x811c9dc5;
  for (let i = 0; i < svg.length; i++) { h ^= svg.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  const file = `${slugify(n.name, "group")}-${h.toString(16).padStart(8, "0")}.svg`;
  ctx.generated.set(`assets/${file}`, svg);
  return `${ctx.opts.assetPrefix}${file}`;
}

/** repeating-linear-gradient for a frame made of ≥ 12 equal stripes with a constant period. */
function stripePattern(n: IRNode): string | null {
  const kids = n.children;
  if (kids.length < 12 || n.layout) return null;
  const first = kids[0];
  const solid = (k: IRNode) => (k.fills.length === 1 && k.fills[0].type === "solid" && k.opacity === 1 ? withAlpha(k.fills[0].color, k.fills[0].opacity) : null);
  for (const k of kids) {
    if (k.type !== "rect" || k.children.length || !solid(k) || k.rotation || k.radius) return null;
    if (Math.abs(k.box.w - first.box.w) > 0.5 || Math.abs(k.box.h - first.box.h) > 0.5) return null;
  }
  const vertical = kids.every((k) => Math.abs(k.box.y - first.box.y) <= 0.5);
  const horizontal = !vertical && kids.every((k) => Math.abs(k.box.x - first.box.x) <= 0.5);
  if (!vertical && !horizontal) return null;
  const sorted = [...kids].sort((a, b) => (vertical ? a.box.x - b.box.x : a.box.y - b.box.y));
  const pos = (k: IRNode) => (vertical ? k.box.x : k.box.y), size = vertical ? first.box.w : first.box.h;
  const step = pos(sorted[1]) - pos(sorted[0]);
  if (step < size - 0.5) return null;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(pos(sorted[i]) - pos(sorted[i - 1]) - step) > 0.6) return null;
  // Colour cycle length (1..4), or bail.
  const colours = sorted.map((k) => solid(k)!);
  let cycle = 0;
  for (let c = 1; c <= 4; c++) { if (colours.every((col, i) => col === colours[i % c])) { cycle = c; break; } }
  if (!cycle) return null;
  const gap = step - size;
  const stops: string[] = [];
  let at = 0;
  for (let c = 0; c < cycle; c++) {
    stops.push(`${colours[c]} ${px(at)} ${px(at + size)}`);
    at += size;
    if (gap > 0.5) { stops.push(`transparent ${px(at)} ${px(at + gap)}`); at += gap; }
  }
  return `repeating-linear-gradient(${vertical ? "90deg" : "180deg"}, ${stops.join(", ")})`;
}

function sortByReadingOrder(children: El[], order: number[] | null | undefined, kids: IRNode[]): boolean {
  if (!order || !order.length) return false;
  const rank = new Map<string, number>();
  order.forEach((ci, i) => { const k = kids[ci]; if (k) rank.set(k.id, i); });
  if (children.some((c) => !rank.has(c.id))) return false;
  children.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return true;
}

function sortRowMajor(children: El[]): void {
  children.sort((a, b) => {
    const tol = Math.max(8, Math.min(a.box.h, b.box.h) * 0.3);
    return Math.abs(a.box.y - b.box.y) < tol ? a.box.x - b.box.x : a.box.y - b.box.y;
  });
}

function applyInferredFlow(el: El, children: El[], bbox: Box, pc: PlanContainer | undefined, kidIr: Map<string, IRNode>, parent: IRNode): boolean {
  const s = el.style;
  if (children.length === 1 && !(pc && pc.direction)) {
    // One child at an offset: a padded block, not an absolutely placed one.
    const c = children[0];
    // A child that starts before the frame's edge or is bigger than the frame (a 124px logo image
    // centred on a 54px pill) cannot be padding: it sits at its own coordinates.
    if (c.box.x < -0.5 || c.box.y < -0.5 || c.box.w > bbox.w + 1 || c.box.h > bbox.h + 1) {
      s["position"] = s["position"] || "relative";
      if (!s["height"] && !s["min-height"]) s["height"] = px(bbox.h);
      if (!s["width"] && !s["flex"]) { s["width"] = px(bbox.w); s["max-width"] = "100%"; }
      if (!s["overflow"]) s["overflow"] = "visible";
      placeAbsolute(c, c.box.x, c.box.y);
      if (!c.style["width"]) c.style["width"] = px(c.box.w);
      if (!c.style["height"] && !c.isText) c.style["height"] = px(c.box.h);
      delete c.style["max-width"];
      el.layoutKind = "absolute";
      return false;
    }
    s["display"] = "flex"; s["flex-direction"] = "column"; s["align-items"] = "flex-start";
    // Equal room on both sides: the child is centred (a 1240 header bar in a 1920 strip), not padded.
    const centred = c.box.x > 2 && Math.abs(c.box.x - (bbox.w - (c.box.x + c.box.w))) <= 2;
    if (centred) {
      s["align-items"] = "center";
      // A stretched child with a max-width pins to the start edge in CSS; centre it explicitly.
      if (c.style["align-self"] === "stretch" || c.style["width"] === "100%") c.style["align-self"] = "center";
      if (c.box.y > 0.5) { s["padding"] = `${px(c.box.y)} 0 0 0`; el.inferredPad = true; }
    }
    else if (c.box.y > 0.5 || c.box.x > 0.5) { s["padding"] = `${px(Math.max(0, c.box.y))} 0 0 ${px(Math.max(0, c.box.x))}`; el.inferredPad = true; }
    if (!s["min-height"] && !s["height"]) s["min-height"] = px(bbox.h);
    return false;
  }
  // A decoration hugging an edge (palm frond, blob) that overlaps a bigger
  // sibling along the flow axis cannot be flowed without pushing that sibling
  // aside: pin it where Figma has it and flow the rest.
  const pinned: El[] = [];
  if (children.length >= 2) {
    const areaOf = (c: El) => c.box.w * c.box.h;
    for (const c of children) {
      if (hasText(c)) continue;
      const atEdge = c.box.x <= bbox.w * 0.05 || c.box.x + c.box.w >= bbox.w * 0.95 || c.box.y <= bbox.h * 0.05 || c.box.y + c.box.h >= bbox.h * 0.95;
      // Overlaps a much bigger sibling along the vertical axis (the flow axis of a section).
      const overlapsBigger = children.some((o) => o !== c && areaOf(o) > areaOf(c) * 2 && c.box.y < o.box.y + o.box.h - 2 && c.box.y + c.box.h > o.box.y + 2);
      if (atEdge && overlapsBigger && areaOf(c) < bbox.w * bbox.h * 0.15) pinned.push(c);
    }
    if (pinned.length && pinned.length < children.length) {
      for (const c of pinned) {
        const st = c.style;
        st["position"] = "absolute"; st["left"] = px(c.box.x); st["top"] = px(c.box.y);
        if (st["width"] === undefined) st["width"] = px(c.box.w);
        delete st["align-self"]; delete st["max-width"];
        st["z-index"] = st["z-index"] || "1";
      }
      s["position"] = s["position"] || "relative";
      const rest = children.filter((c) => !pinned.includes(c));
      children.length = 0; children.push(...rest);
    } else pinned.length = 0;
  }
  const flow = inferFlow(children, pc && pc.direction ? pc.direction : undefined);
  if (!flow) { el.layoutKind = "absolute"; children.push(...pinned); applyAbsolute(el, children, bbox, kidIr, parent); return false; }
  children.sort((a, b) => (flow.direction === "row" ? a.box.x - b.box.x : a.box.y - b.box.y));
  children.push(...pinned); // stay in the DOM after the flowed siblings; their position is absolute
  s["display"] = "flex"; s["flex-direction"] = flow.direction;
  const span = flow.direction === "row" ? bbox.w : bbox.h;
  if (flow.gap > 0 && flow.gap >= span * 0.3 && children.length <= 3) s["justify-content"] = "space-between";
  else if (flow.gap > 0) s["gap"] = px(flow.gap);
  s["align-items"] = "flex-start";
  // Cross-axis placement per child: centred / end-aligned / offset from the start.
  const row = flow.direction === "row";
  const P = row ? bbox.h : bbox.w;
  const start = (c: El) => (row ? c.box.y : c.box.x), size = (c: El) => (row ? c.box.h : c.box.w);
  const kind = (c: El): "center" | "end" | "start" => {
    const st = start(c), en = P - (st + size(c));
    if (Math.abs(st - en) <= 2 && st > 2) return "center";
    if (en <= 2 && st > 2) return "end";
    return "start";
  };
  const kinds = children.map(kind);
  const starts = children.filter((_, i) => kinds[i] === "start");
  const crossPad = starts.length ? Math.max(0, Math.min(...starts.map(start))) : 0;
  // A child that happens to be centred in the frame but shares the start edge with its
  // siblings is start-aligned like them; centring it inside the padded box would double the offset.
  if (starts.length) children.forEach((c, i) => { if (kinds[i] !== "start" && Math.abs(start(c) - crossPad) <= 2) kinds[i] = "start"; });
  if (!starts.length && kinds.every((k) => k === "center")) s["align-items"] = "center";
  else if (!starts.length && kinds.every((k) => k === "end")) s["align-items"] = "flex-end";
  children.forEach((c, i) => {
    // Explicit per child: a FILL child carries align-self:stretch, which would
    // pin a centred, max-width box to the start edge.
    if (kinds[i] === "center") c.style["align-self"] = "center";
    else if (kinds[i] === "end") c.style["align-self"] = "flex-end";
    else if (kinds[i] === "start") {
      const off = start(c) - crossPad;
      if (off > 2) c.style[row ? "margin-top" : "margin-left"] = px(off);
    }
  });
  if (flow.direction === "row") {
    // Items on several lines in the design: this row wraps (a pill list). Reading order is
    // line by line, not left to right across lines.
    const cols = inferColumns(children);
    if (cols < children.length) {
      const g = inferGridGaps(children, cols);
      s["flex-wrap"] = "wrap";
      s["gap"] = `${px(g.row)} ${px(g.col)}`;
      const pinnedTail = children.filter((c) => c.style["position"] === "absolute");
      const flowing = children.filter((c) => c.style["position"] !== "absolute");
      sortRowMajor(flowing); children.length = 0; children.push(...flowing, ...pinnedTail);
    } else {
      // Figma lets the children run past a fixed frame; flex would shrink them instead.
      const main = children.filter((c) => c.style["position"] !== "absolute").reduce((t, c) => t + c.box.w, 0) + flow.gap * Math.max(0, children.length - 1);
      const mainPad0 = Math.max(0, Math.min(...children.map((c) => c.box.x)));
      if (main + mainPad0 > bbox.w + 1) {
        for (const c of children) if (c.style["position"] !== "absolute") { c.style["flex-shrink"] = "0"; if (c.style["max-width"] === "100%") delete c.style["max-width"]; }
        if (!s["overflow"]) s["overflow"] = "visible";
      }
    }
  }
  const mainPad = Math.max(0, Math.min(...children.map((c) => (row ? c.box.x : c.box.y))));
  const padTop = row ? crossPad : mainPad, padLeft = row ? mainPad : crossPad;
  if ((padTop > 0.5 || padLeft > 0.5) && !s["padding"]) { s["padding"] = `${px(padTop)} 0 0 ${px(padLeft)}`; el.inferredPad = true; }
  if (!s["min-height"] && !s["height"]) s["min-height"] = px(bbox.h);
  return true;
}

/* --------------------------------------------------------- compaction */

function isContentless(e: El): boolean {
  if (e.children.length || e.text !== null || e.runs || e.hasAsset) return false;
  const st = e.style;
  if (st["background-color"] || st["background-image"] || st["background"] || st["border"] || st["border-width"] || st["box-shadow"] || st["visibility"]) return false;
  // An empty, sized box inside a flow is a spacer: Figma gives it room, so must we.
  const sized = !!(st["height"] || st["min-height"]) && e.box.h >= 8;
  return !(sized && st["position"] !== "absolute");
}
export function compact(e: El): El {
  e.children = e.children.map(compact).filter((c) => !isContentless(c));
  const st = e.style;
  const realGap = !!st["gap"] && e.children.length > 1;
  const carriesSpacing = !!(st["padding"] || realGap);
  const realWidth = !!st["width"] && st["width"] !== "100%";
  const constrainsSize = !!(realWidth || st["height"] || st["min-height"] || st["max-width"]);
  const positions = st["position"] === "absolute" || st["position"] === "relative";
  if (
    e.children.length === 1 && e.text === null && !e.runs && !e.hasAsset && e.tag === "div" && !e.hover &&
    !st["background-color"] && !st["background-image"] && !st["border"] && !st["box-shadow"] && !st["opacity"] && !st["transform"] &&
    !carriesSpacing && !constrainsSize && !positions && st["display"] !== "grid" && !e.attrs["href"]
  ) {
    const child = e.children[0];
    const inherited: Style = { ...e.style };
    // The wrapper's box is not the child's box.
    for (const k of ["width", "max-width", "min-width", "height", "min-height", "align-self", "flex", "flex-grow", "flex-shrink", "flex-wrap"]) delete inherited[k];
    const wrapperCol = st["display"] === "flex" && st["flex-direction"] !== "row";
    const wrapperAlign = wrapperCol ? st["align-items"] : st["justify-content"];
    const wrapperCross = wrapperCol ? st["justify-content"] : st["align-items"];
    if (child.style["display"] || true) for (const k of ["display", "flex-direction", "gap", "align-items", "justify-content", "align-content"]) delete inherited[k];
    // A wrapper that centred its only child: keep that placement on the child.
    const fullWidth = child.style["width"] === "100%" || child.style["flex"];
    if (!fullWidth && (wrapperAlign === "center" || wrapperAlign === "flex-end")) child.style["align-self"] = wrapperAlign;
    if (!wrapperCol && wrapperCross === "center" && !child.style["align-self"]) child.style["align-self"] = "center";
    child.style = { ...inherited, ...child.style };
    // The wrapper spanned its parent; a hug child that is now centred/ended must not.
    if (child.style["align-self"] === "center" || child.style["align-self"] === "flex-end") delete child.style["align-self-stretch"];
    return child;
  }
  return e;
}

/* --------------------------------------------------------------- page */

export function resolveFrame(doc: IRDocument, frame: IRFrame, plan: Plan, opts: ResolveOptions): ResolvedFrame {
  const idx = indexFrame(frame);
  const pidx = indexPlan(plan);
  // Instances that share a hover variant but show different pictures: the variant's picture is the
  // component master's, so it must not replace the instance's own image on hover.
  const variantPictures = new Map<string, Set<string>>();
  walk(frame.root, (k) => {
    for (const v of Object.values(k.states || {})) {
      if (!variantPictures.has(v.id)) variantPictures.set(v.id, new Set());
      variantPictures.get(v.id)!.add(k.fillAsset || "");
    }
  });
  const sharedVariants = new Set([...variantPictures].filter(([, pics]) => pics.size > 1).map(([id]) => id));
  const ctx: Ctx = { generated: new Map(), navDepth: 0, headingDepth: 0, doc, frame, idx, plan: pidx, opts, warnings: [], fonts: new Map(), canvasWidth: frame.width, sharedVariants };

  const root = idx.byId.get(plan.pageRoot) || frame.root;
  const secNodes: Array<{ node: IRNode; ps: Plan["sections"][number] }> = [];
  for (const ps of plan.sections) {
    const n = idx.byId.get(ps.id);
    if (n) secNodes.push({ node: n, ps });
  }
  if (!secNodes.length) {
    ctx.warnings.push("plan has no resolvable sections; using the frame root as one section");
    secNodes.push({ node: frame.root, ps: { id: frame.root.id, slug: frame.slug, tag: "section", role: "", attach: [], confidence: 0, note: "fallback" } });
  }
  secNodes.sort((a, b) => a.node.box.y - b.node.box.y);

  // Loose layers: children of the frame / page root that are not a section,
  // not inside one, not attached, not ignored -> attach to the section they overlap most.
  const sectionSet = new Set(secNodes.map((s) => s.node.id));
  const candidates: IRNode[] = [...frame.root.children];
  if (root.id !== frame.root.id) candidates.push(...root.children);
  const loose: IRNode[] = [];
  for (const c of candidates) {
    if (sectionSet.has(c.id) || pidx.attached.has(c.id) || pidx.ignore.has(c.id) || c.id === root.id) continue;
    if (secNodes.some((s) => isAncestor(idx, c.id, s.node.id) || isAncestor(idx, s.node.id, c.id))) continue;
    loose.push(c);
  }
  const overlapY = (a: Box, b: Box) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const extra = new Map<string, IRNode[]>();
  for (const l of loose) {
    let best: string | null = null, bestOv = 0;
    for (const s of secNodes) { const ov = overlapY(l.box, s.node.box); if (ov > bestOv) { bestOv = ov; best = s.node.id; } }
    if (best && bestOv > 0) { if (!extra.has(best)) extra.set(best, []); extra.get(best)!.push(l); }
    else ctx.warnings.push(`loose layer ${l.id} "${l.name}" overlaps no section; dropped`);
  }

  // Figma's paint order along the layer path (later siblings paint on top; a container with
  // "reverse z-index" paints its first child on top). Used for section stacking and for deciding
  // whether an attached layer sits behind or in front of its section's content.
  const paintKey = (id: string): number[] => {
    const key: number[] = [];
    for (let cur = idx.byId.get(id) || null; cur; ) {
      const p = idx.parent.get(cur.id) || null;
      if (!p) break;
      const i = p.children.findIndex((c) => c.id === cur!.id);
      key.unshift(p.layout?.reverse ? p.children.length - 1 - i : i);
      if (p.id === root.id || p.id === frame.root.id) break;
      cur = p;
    }
    return key;
  };
  const cmpKeys = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; } return 0; };

  // Attachments per section: what the plan says, loose layers by overlap, and a decoration that
  // spans several sections (a dotted pattern behind a whole dark band) goes to each one it covers.
  const attachMap = new Map<string, IRNode[]>();
  for (const { node, ps } of secNodes) {
    const list: IRNode[] = [];
    for (const id of ps.attach) {
      const a = idx.byId.get(id); if (!a) continue;
      if (a.id === node.id || isAncestor(idx, node.id, a.id)) { ctx.warnings.push(`plan attaches ${a.id} "${a.name}" to ${ps.slug} but it is already inside it; ignored`); continue; }
      list.push(a);
    }
    for (const a of extra.get(node.id) || []) list.push(a);
    attachMap.set(node.id, list);
  }
  for (const { node } of secNodes) {
    for (const a of attachMap.get(node.id) || []) {
      for (const other of secNodes) {
        if (other.node.id === node.id || isAncestor(idx, other.node.id, a.id)) continue;
        const ov = overlapY(a.box, other.node.box);
        if (ov < 40 || ov < Math.min(a.box.h, other.node.box.h) * 0.1) continue;
        const l = attachMap.get(other.node.id)!;
        if (!l.includes(a)) l.push(a);
      }
    }
  }

  const sections: Section[] = [];
  for (const { node, ps } of secNodes) {
    const el = resolveNode(node, idx.parent.get(node.id) || null, 0, ctx);
    if (!el) continue;
    // A section that resolved to an asset (a flattened composite) keeps its img tag.
    if (!el.hasAsset) {
      el.tag = ps.tag && ps.tag !== "div" ? ps.tag : (el.tag === "div" ? "section" : el.tag);
      if (pidx.tags.has(node.id)) el.tag = pidx.tags.get(node.id)!;
    }
    el.cls = ps.slug;
    el.attrs["data-section"] = ps.slug;
    // A section with no paint of its own that sits inside a painted wrapper (two sections grouped
    // in one dark band) shows the wrapper's fill in Figma; the wrapper itself is never rendered.
    if (!el.hasAsset && !el.style["background-color"] && !el.style["background-image"] && !el.style["background"]) {
      for (let anc = idx.parent.get(node.id); anc && anc.id !== root.id && anc.id !== frame.root.id; anc = idx.parent.get(anc.id)) {
        if (sectionSet.has(anc.id)) break;
        const covers = anc.box.x <= node.box.x + 1 && anc.box.x + anc.box.w >= node.box.x + node.box.w - 1;
        if (!covers) continue;
        const probe: Style = {};
        const fa = anc.fillAsset ? ctx.doc.assets[anc.fillAsset] : null;
        applyBackground(probe, backgroundOf(anc.fills, { w: anc.box.w, h: anc.box.h }), fa ? `${ctx.opts.assetPrefix}${fa.file}` : null);
        if (Object.keys(probe).length) { Object.assign(el.style, probe); break; }
      }
    }
    const toAttach = attachMap.get(node.id) || [];
    const secKey = paintKey(node.id);
    for (const a of toAttach) {
      const child = resolveNode(a, idx.parent.get(a.id) || null, 1, ctx);
      if (!child) continue;
      // The same layer attached to several sections must be several elements: class allocation and
      // the Elementor element id are keyed by element id.
      const copies = [...attachMap.values()].filter((l) => l.includes(a)).length;
      const ab = child.hasAsset ? a.renderBox : a.box;
      if (copies > 1) {
        child.id = `${a.id}~@${ps.slug}`;
        // Each copy shows only its own section's slice: a later section paints over an earlier one,
        // so an unclipped copy would cover the previous section's content.
        const cut = (v: number) => Math.max(0, Math.round(v * 100) / 100);
        child.style["clip-path"] = `inset(${px(cut(node.box.y - ab.y))} ${px(cut(ab.x + ab.w - (node.box.x + node.box.w)))} ${px(cut(ab.y + ab.h - (node.box.y + node.box.h)))} ${px(cut(node.box.x - ab.x))})`;
      }
      placeAbsolute(child, ab.x - node.box.x, ab.y - node.box.y);
      // A layer Figma paints before the section is a backdrop (pattern behind the content); one it
      // paints after is a foreground decoration (badge over the content).
      const behind = cmpKeys(paintKey(a.id), secKey) < 0;
      child.style["z-index"] = behind ? "0" : "30";
      if (behind) child.attrs["data-behind"] = "1";
      if (!child.style["width"]) child.style["width"] = px(ab.w);
      delete child.style["right"]; delete child.style["max-width"];
      el.children.push(child);
    }
    if (toAttach.length) el.style["position"] = el.style["position"] || "relative";
    // Sections normally span the frame; a narrower one keeps its width and its
    // horizontal position (centred when Figma centred it).
    const fw = frame.width;
    if (node.box.w >= fw - 4) { el.style["width"] = "100%"; delete el.style["max-width"]; splitBleed(el, fw); }
    else {
      // Insets scale with the viewport; the box is whatever is left between them.
      const right = fw - (node.box.x + node.box.w);
      const ins = (v: number) => (v >= 40 ? `min(${px(v)}, ${Math.round((v / fw) * 10000) / 100}vw)` : px(v));
      el.style["width"] = "auto"; el.style["max-width"] = px(node.box.w);
      el.style["margin-left"] = ins(node.box.x); el.style["margin-right"] = ins(right);
      // Near-equal margins (62 / 59) are a centred card section: centre it on wide screens too.
      if (Math.abs(right - node.box.x) <= Math.max(8, node.box.w * 0.01)) { el.style["margin-left"] = "auto"; el.style["margin-right"] = "auto"; el.style["width"] = `calc(100% - 2 * ${ins(node.box.x)})`; }
    }
    sections.push({ el: compact(el), slug: ps.slug, box: { ...node.box }, id: node.id, name: node.name });
  }
  singleH1(sections, pidx);
  // Sections overlap on purpose (torn edges, bleeding photos). Figma's
  // "reverse z-index" on the page column means earlier sections stay on top.
  const rootLayout = root.layout || frame.root.layout;
  const overlaps = sections.some((sec, i) => i > 0 && sec.box.y < sections[i - 1].box.y + sections[i - 1].box.h - 0.5);
  if (rootLayout && rootLayout.reverse) {
    sections.forEach((s, i) => { s.el.style["position"] = s.el.style["position"] || "relative"; s.el.style["z-index"] = String(sections.length - i); });
  } else if (!overlaps) {
    // Figma paints later sections over earlier ones; a positioned child that
    // hangs out of its section must not show through the next one.
    sections.forEach((s, i) => { s.el.style["position"] = s.el.style["position"] || "relative"; s.el.style["z-index"] = String(i + 1); });
  } else {
    // No auto-layout: the paint order is Figma's layer order — the path of sibling indices from the
    // root, compared lexicographically, so two sections inside one wrapper (a CTA card over the footer,
    // both children of a Footer instance) still stack the way Figma paints them.
    const ranked = [...sections].sort((x, y) => cmpKeys(paintKey(x.id), paintKey(y.id)));
    sections.forEach((s) => { s.el.style["position"] = s.el.style["position"] || "relative"; s.el.style["z-index"] = String(ranked.indexOf(s) + 1); });
  }
  // The frame's own paint shows wherever sections leave a gap (top inset, bottom slack).
  const rootStyle: Style = {};
  const rootBg = backgroundOf(frame.root.fills);
  applyBackground(rootStyle, rootBg, null);
  if (sections.length) {
    const first = sections[0], last = sections[sections.length - 1];
    if (first.box.y > 0.5) rootStyle["padding-top"] = px(first.box.y);
    const slack = frame.height - (last.box.y + last.box.h);
    if (slack > 0.5) rootStyle["padding-bottom"] = px(slack);
  }
  return { frame, plan, sections, warnings: ctx.warnings, fonts: ctx.fonts, rootStyle, generated: ctx.generated };
}

/**
 * A full-width asset inside a bleeding layer must follow the viewport too.
 * A periodic strip (ruler ticks, dot rows) repeats; anything else stretches.
 */
function stretchSpanningAssets(layer: El, sectionW: number): void {
  const visit = (e: El) => {
    if (e.hasAsset && e.box.w >= sectionW * 0.95) {
      const periodic = !!e.svg && (e.svg.match(/<(path|rect|line|circle)\b/g) || []).length >= 40 && e.box.w / Math.max(1, e.box.h) > 6;
      if (periodic && e.assetUrl) {
        // Tile the strip across the viewport instead of distorting the pattern.
        const h = e.style["height"] || px(e.box.h);
        e.tag = "div"; e.svg = null;
        e.style["background-image"] = `url("${e.assetUrl}")`; e.style["background-repeat"] = "repeat-x"; e.style["background-position"] = "center top"; e.style["background-size"] = `auto ${h}`;
        e.style["width"] = "100%"; e.style["height"] = h; delete e.style["max-width"];
        e.attrs["role"] = "presentation";
      } else {
        e.style["width"] = "100%"; delete e.style["max-width"];
        if (e.svg) e.attrs["data-stretch"] = "1";
      }
    }
    e.children.forEach(visit);
  };
  visit(layer);
  // Wrappers between the layer and a stretched asset must be full width.
  const widen = (e: El): boolean => {
    let any = false;
    for (const c of e.children) if (widen(c)) any = true;
    if (any || (e.hasAsset && e.style["width"] === "100%" && e.box.w >= sectionW * 0.95)) { if (e !== layer) { e.style["width"] = "100%"; delete e.style["max-width"]; } return true; }
    return false;
  };
  widen(layer);
}

/**
 * Screens wider than the design: the section's paint (background, backdrop
 * photo, torn edges, stripes) bleeds to the viewport edges while everything
 * else sits in a centred box of the design width. Below the design width the
 * inner box is 100%, so nothing changes there.
 */
function splitBleed(sec: El, fw: number, depth = 0): void {
  const area = Math.max(1, sec.box.w * sec.box.h);
  const spans = (c: El) => c.box.w >= sec.box.w * 0.95;
  const flowKids = sec.children.filter((c) => c.style["position"] !== "absolute");
  const paints = (c: El) => !!(c.style["background-color"] || c.style["background-image"] || c.hasAsset);

  // Banded section (header = stripes + navbar, footer = bar + legal row): every
  // flow child spans the width. Each band bleeds on its own; no shared inner.
  if (depth === 0 && flowKids.length >= 1 && flowKids.every(spans) && flowKids.some(paints) && sec.layoutKind === "flow" && sec.style["flex-direction"] !== "row") {
    for (const band of flowKids) {
      delete band.style["max-width"]; band.style["width"] = "100%";
      if (band.children.length && (hasText(band) || band.children.some((k) => k.children.length))) splitBleed(band, fw, depth + 1);
    }
    for (const c of sec.children) if (c.style["position"] === "absolute" && spans(c)) { c.style["left"] = "0"; c.style["right"] = "0"; delete c.style["width"]; delete c.style["max-width"]; delete c.style["transform"]; }
    return;
  }

  const isBleed = (c: El): boolean => {
    if (c.role === "backdrop") return true;
    if (c.style["position"] !== "absolute") return false;
    const covers = (c.box.w * c.box.h) / area >= 0.9 && !hasText(c);
    return covers || spans(c);
  };
  const bleed = sec.children.filter(isBleed);
  const content = sec.children.filter((c) => !isBleed(c));
  // The inner is the layout box: it carries the designed height too, so
  // bottom-anchored children (a card pinned to the hero's floor) keep working.
  const LAYOUT = ["display", "flex-direction", "flex-wrap", "gap", "row-gap", "column-gap", "justify-content", "align-items", "align-content", "padding", "grid-template-columns", "height", "min-height"];
  const PAINT = ["background-color", "background-image", "background-size", "background-position", "background-repeat"];
  if (!sec.style["background-color"] && !sec.style["background-image"]) {
    const skin = content.find((c) => spans(c) && c.style["position"] !== "absolute" && (c.style["background-color"] || c.style["background-image"]) && c.box.h >= sec.box.h * 0.9);
    if (skin) for (const k of PAINT) if (skin.style[k] !== undefined) sec.style[k] = skin.style[k];
  }
  const inflowContent = content.some((c) => c.style["position"] !== "absolute");
  if (content.length) {
    const inner: El = {
      id: `${sec.id}~inner`, name: `${sec.name} inner`, tag: "div", cls: depth ? `${sec.cls}-content` : `${sec.cls}-inner`, attrs: {},
      style: { width: "100%", "max-width": px(fw), margin: "0 auto", position: "relative" },
      hover: null, stateRules: [], media: {}, children: content, text: null, runs: null, svg: null, src: null, assetUrl: null, poster: null,
      box: { x: 0, y: 0, w: sec.box.w, h: sec.box.h }, size: { w: sec.box.w, h: sec.box.h }, rotation: 0,
      isText: false, hasAsset: false, irType: "frame", layoutKind: sec.layoutKind, role: "inner", inferredPad: sec.inferredPad,
    };
    for (const k of LAYOUT) if (sec.style[k] !== undefined) { inner.style[k] = sec.style[k]; delete sec.style[k]; }
    if (!inner.style["height"] && !inner.style["min-height"] && !inflowContent) inner.style["min-height"] = px(sec.box.h);
    sec.layoutKind = null; sec.inferredPad = false;
    sec.children = [...bleed, inner];
  } else if (sec.style["height"] === undefined && sec.style["min-height"] === undefined) sec.style["min-height"] = px(sec.box.h);
  sec.style["position"] = sec.style["position"] || "relative";
  for (const b of bleed) {
    const st = b.style;
    b.attrs["data-bleed"] = "1";
    if (!spans(b)) {
      // A big decoration that does not reach the edges (a dotted pattern behind the content) is
      // designed against the centred content, not the viewport's left edge: anchor it to the centre.
      if (st["position"] === "absolute" && st["left"] !== undefined && !st["right"]) {
        const centreOff = (b.box.x + b.box.w / 2) - sec.box.w / 2;
        st["width"] = st["width"] || px(b.box.w);
        st["left"] = Math.abs(centreOff) < 0.5 ? "50%" : `calc(50% + ${px(centreOff)})`;
        st["transform"] = st["transform"] ? `${st["transform"].replace(/translateX\([^)]*\)\s*/g, "")} translateX(-50%)`.trim() : "translateX(-50%)";
        delete st["max-width"];
      }
      continue;
    }
    const overhang = b.box.w > sec.box.w + 2;
    // An overhanging composition keeps its designed size (below); only layers that
    // end at the design edges follow the viewport.
    if (!overhang) stretchSpanningAssets(b, sec.box.w);
    if (overhang && b.children.length && (hasText(b) || b.layoutKind === "absolute" || b.layoutKind === "overlay")) {
      // A composition wider than the frame (a map cropped by the section's
      // edges): it keeps its designed size and its centre; the section clips it.
      const centreOff = (b.box.x + b.box.w / 2) - sec.box.w / 2;
      st["width"] = px(b.box.w); if (!st["height"] && !st["aspect-ratio"]) st["height"] = px(b.box.h);
      st["left"] = Math.abs(centreOff) < 0.5 ? "50%" : `calc(50% + ${px(centreOff)})`; delete st["right"]; delete st["max-width"];
      st["transform"] = "translateX(-50%)";
      continue;
    }
    st["left"] = "0"; st["right"] = "0"; delete st["width"]; delete st["max-width"]; delete st["transform"]; delete st["margin-left"]; delete st["margin-right"];
    if (b.tag === "img" || b.tag === "video" || b.tag === "svg") st["width"] = "100%";
    // A spanning panel that holds content: centre it one level down, and
    // remember it is a panel so the phone stack can let it drive the height.
    if (hasText(b) && depth < 2 && b.children.length) { b.role = "panel"; splitBleed(b, fw, depth + 1); }
  }
}

/** One h1 per page: the first heuristic h1 in reading order stays, the rest become h2. */
function singleH1(sections: Section[], plan: PlanIndex): void {
  let seen = false;
  const visit = (e: El) => {
    if (e.tag === "h1") {
      if (plan.tags.get(e.id) === "h1") seen = true;
      else if (seen) e.tag = "h2";
      else seen = true;
    }
    e.children.forEach(visit);
  };
  for (const s of sections) visit(s.el);
}
