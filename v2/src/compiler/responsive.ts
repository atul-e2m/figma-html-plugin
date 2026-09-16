/**
 * Responsive behaviour for a frame that was designed at ONE width.
 *
 * Two layers:
 *  1. Fluid baseline — at the design width nothing changes; below it values
 *     scale instead of overflowing (padding, gaps, offsets, type).
 *  2. Breakpoint transforms — at tablet (≤1023) and phone (≤767) the layout
 *     kinds that cannot shrink are restructured the way a designer would:
 *     overlays stack over their backdrop, rows become columns or wrap, grids
 *     lose columns, fixed heights that hold text open up, images go fluid.
 *
 * The plan can override any transform per node (`responsive` entries); the
 * heuristics here are what runs when it says nothing.
 */
import type { El, Section } from "./resolve.ts";
import { hasText } from "./resolve.ts";
import { px } from "./style.ts";

export const TABLET = "(max-width: 1024px)";
/** Portrait tablets: two wide columns no longer fit side by side. */
export const TABLET_SM = "(max-width: 900px)";
export const PHONE = "(max-width: 767px)";

export type ResponsiveAction = "stack" | "wrap" | "hide" | "columns" | "full-width" | "center" | "keep" | "row";
export interface ResponsiveDecision { at: "tablet" | "phone"; action: ResponsiveAction; columns?: number }
export type ResponsiveIndex = Map<string, ResponsiveDecision[]>;

const vw = (v: number, W: number) => `min(${px(v)}, ${Math.round((v / W) * 10000) / 100}vw)`;
const num = (v: string | undefined): number | null => { if (!v) return null; if (v === "0") return 0; const m = v.match(/^(-?[\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
/** Column-gap expression of a flex container: the last token, or the whole value when it is a math function (`min(77px, 5.35vw)`). */
const gapExprOf = (e: El, fallback = "0px"): string => { const g = e.style["gap"]; if (!g) return fallback; return g.includes("(") ? g : g.split(/\s+/).pop() || fallback; };
const media = (e: El, q: string, st: Record<string, string>) => { e.media[q] = { ...(e.media[q] || {}), ...st }; };
const decided = (idx: ResponsiveIndex, e: El, at: "tablet" | "phone"): ResponsiveDecision[] => (idx.get(e.id) || []).filter((d) => d.at === at);
const keep = (idx: ResponsiveIndex, e: El, at: "tablet" | "phone") => decided(idx, e, at).some((d) => d.action === "keep");

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

function fluidAbsolute(e: El, W: number): void {
  if (e.style["position"] !== "absolute") return;
  const left = num(e.style["left"]), right = num(e.style["right"]);
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
  const fs = num(e.style["font-size"]);
  if (fs === null || fs < 28) return;
  const min = Math.round(fs * 0.6);
  e.style["font-size"] = `clamp(${px(min)}, ${Math.round((fs / W) * 10000) / 100}vw, ${px(fs)})`;
  const lh = num(e.style["line-height"]);
  if (lh !== null) e.style["line-height"] = String(Math.round((lh / fs) * 100) / 100);
}

/* ------------------------------------------------------ transforms */

function collapseGrid(e: El, idx: ResponsiveIndex): void {
  const m = e.style["grid-template-columns"]?.match(/^repeat\((\d+), /);
  if (!m) return;
  const cols = parseInt(m[1], 10);
  if (cols <= 1) return;
  const tCols = decided(idx, e, "tablet").find((d) => d.action === "columns")?.columns;
  const pCols = decided(idx, e, "phone").find((d) => d.action === "columns")?.columns;
  const itemW = e.box.w / cols;
  if (!keep(idx, e, "tablet")) {
    if (tCols) media(e, TABLET, { "grid-template-columns": `repeat(${tCols}, minmax(0, 1fr))` });
    else if (cols >= 4) media(e, TABLET, { "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
    else if (cols === 3 && itemW > 420) media(e, TABLET_SM, { "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
    // three narrow columns (feature icons, small cards) stay three across on tablets: no orphan row
  }
  if (!keep(idx, e, "phone")) media(e, PHONE, { "grid-template-columns": `repeat(${pCols || 1}, minmax(0, 1fr))` });
}

/** Text-ish rows (nav links, tags, meta) wrap; content rows stack. */
function rows(e: El, depth: number, idx: ResponsiveIndex): void {
  if (e.style["display"] !== "flex" || e.style["flex-direction"] !== "row") return;
  const kids = e.children.filter((c) => c.style["position"] !== "absolute");
  if (kids.length < 2) return;
  const gap = num(e.style["gap"]?.split(/\s+/).pop()) || 0;
  const total = kids.reduce((n, k) => n + k.box.w, 0) + gap * (kids.length - 1);
  const forced = decided(idx, e, "phone").find((d) => d.action === "stack" || d.action === "wrap" || d.action === "row");
  const tall = Math.max(...kids.map((k) => k.box.h));
  const textish = e.tag === "nav" || e.tag === "ul" || e.tag === "ol" || kids.every((k) => k.isText || k.tag === "a" || k.tag === "button" || (k.box.h <= 56 && k.box.w <= 260));
  let action: ResponsiveAction | null = forced ? forced.action : null;
  if (!action && !keep(idx, e, "phone")) {
    if (total <= 340 && tall <= 80) action = null;                 // fits a phone as it is
    else if (textish) action = "wrap";
    else action = "stack";
  }
  const stackAt = (q: string) => stackRow(e, q);
  if (action === "wrap") media(e, PHONE, { "flex-wrap": "wrap", "row-gap": "12px" });
  else if (action === "stack") {
    stackAt(PHONE);
    // Two or three wide columns cannot share a portrait tablet either.
    if (!textish && kids.length <= 3 && total > 1000 && !keep(idx, e, "tablet")) stackAt(TABLET_SM);
  }
  // Tablets: text rows wrap; a 2-3 column content row shares the width instead
  // of squeezing whichever child has no fixed size.
  const navKid = kids.find((k) => k.tag === "nav");
  if (navKid && kids.length >= 3 && total > 700 && !keep(idx, e, "tablet")) {
    // Header (logo | links | actions): the link list drops to its own centred line.
    media(e, TABLET_SM, { "flex-wrap": "wrap", "row-gap": "16px" });
    media(navKid, TABLET_SM, { order: "3", flex: "1 0 100%", "justify-content": "center", "flex-wrap": "wrap" });
  } else if (!keep(idx, e, "tablet") && total > 800 && !e.style["flex-wrap"]) {
    if (textish || kids.length >= 4) {
      media(e, TABLET, { "flex-wrap": "wrap", "row-gap": "16px" });
      // Four/six small equal items (counters, stats) wrap to a balanced 2-up, not 3 + 1.
      if (!textish && kids.length % 2 === 0 && kids.every((k) => k.box.h <= 160 && !k.hasAsset)) {
        const gapExpr = gapExprOf(e);
        media(e, TABLET_SM, { "justify-content": "center" });
        for (const k of kids) media(k, TABLET_SM, { flex: `0 0 calc(50% - ${gapExpr} / 2)`, "max-width": "100%" });
      }
    } else {
      const weights = kids.map((k) => Math.max(1, Math.round(k.box.w)));
      kids.forEach((k, i) => {
        media(k, TABLET, { flex: `${weights[i]} 1 0%`, "min-width": "0", width: "auto", "max-width": "100%" });
        if (k.style["display"] === "flex" && k.style["flex-direction"] === "row" && !k.style["flex-wrap"]) media(k, TABLET, { "flex-wrap": "wrap", "row-gap": "8px" });
      });
      fluidImages(e);
    }
  }
}

/** A flex row becomes a column at `q`; children take the full width (small assets keep theirs). */
function stackRow(e: El, q: string): void {
  const kids = e.children.filter((c) => c.style["position"] !== "absolute");
  media(e, q, { "flex-direction": "column", "align-items": "stretch" });
  for (const k of kids) {
    const small = (k.hasAsset || k.tag === "svg" || k.tag === "img") && k.box.w < 300;
    const picture = !small && (k.tag === "img" || k.tag === "video" || (!!k.style["aspect-ratio"] && !hasText(k)));
    const st: Record<string, string> = small
      ? { flex: "0 0 auto", "align-self": "flex-start", "margin-left": "0", "margin-right": "0" }
      : picture
        ? { width: "100%", "max-width": `min(100%, ${px(Math.round(k.box.w))})`, flex: "0 0 auto", "align-self": "center", "margin-left": "0", "margin-right": "0" }
        : { width: "100%", "max-width": "100%", flex: "0 0 auto", "margin-left": "0", "margin-right": "0" };
    if (k.isText) st["text-align"] = k.style["text-align"] || "left";
    media(k, q, st);
  }
}

/** Images inside a shared row keep their ratio and fill their column. */
function fluidImages(e: El): void {
  const visit = (k: El, parent: El) => {
    const w = num(k.style["width"]), h = num(k.style["height"]);
    // Only a picture that carries its column goes fluid; an avatar or icon beside text keeps its size.
    const fills = k.box.w >= parent.box.w * 0.5;
    if ((k.tag === "img" || k.tag === "video") && w !== null && fills && k.style["position"] !== "absolute") media(k, TABLET, { width: "100%", "max-width": px(Math.round(k.box.w)), height: "auto", ...(h ? { "aspect-ratio": `${Math.round(w)} / ${Math.round(h)}` } : {}) });
    else if (!k.isText && w !== null && w >= 200 && fills && k.style["position"] !== "absolute") media(k, TABLET, { width: "100%" });
    if (k.tag !== "img" && k.tag !== "video") k.children.forEach((c) => visit(c, k));
  };
  e.children.forEach((c) => visit(c, e));
}

/** Overlay / absolute containers become a stacked column on phones, backdrop kept behind. */
function stackOverlay(e: El, idx: ResponsiveIndex, topInset = 0, q: string = PHONE, force = false): void {
  if (e.layoutKind !== "overlay" && e.layoutKind !== "absolute") return;
  if (!force && keep(idx, e, q === PHONE ? "phone" : "tablet")) return;
  if (pictureLike(e)) return; // scales as one picture (scaleComposition), captions handled there
  const kids = e.children;
  const area = Math.max(1, e.box.w * e.box.h);
  const covering = (k: El) => (k.box.w * k.box.h) / area >= 0.85 && !hasText(k);
  const content = kids.filter((k) => k.role !== "backdrop" && hasText(k));
  if (!content.length && !force) return; // pure decoration: leave as designed (it scales with the box)
  const h = num(e.style["height"]) || num(e.style["min-height"]) || e.box.h;
  const pad = q === PHONE ? "16px" : "24px";
  media(e, q, { display: "flex", "flex-direction": "column", "align-items": "stretch", gap: "16px", height: "auto", "min-height": px(Math.min(h, 320)), padding: `${px(32 + topInset)} ${pad} 32px`, "aspect-ratio": "auto" });
  for (const k of kids) {
    if (k.role === "backdrop" || covering(k)) { media(k, q, { position: "absolute", inset: "0", width: "100%", height: "100%", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", "max-width": "none" }); continue; }
    const wide = k.box.w >= e.box.w * 0.85 && k.box.h <= 120 && k.hasAsset; // torn edges, dividers
    if (wide) continue;
    if (!hasText(k)) {
      // Small decorations (badges, arrows, glows) have no place in a stack.
      if (k.box.w * k.box.h < e.box.w * e.box.h * 0.15 || k.hasAsset) media(k, q, { display: "none" });
      else media(k, q, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", width: "100%", "max-width": `min(100%, ${px(Math.round(k.box.w))})`, height: "auto", "aspect-ratio": `${Math.round(k.box.w)} / ${Math.round(k.box.h)}`, margin: "0" });
      continue;
    }
    media(k, q, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", width: "100%", "max-width": "100%", height: "auto", "min-height": "0", margin: "0", "z-index": k.style["z-index"] || "1" });
  }
}

/** Fixed heights that hold text open up on phones; nowrap text wraps; fixed images go fluid. */
function loosen(e: El, idx: ResponsiveIndex): void {
  if (keep(idx, e, "phone") || pictureKids.has(e) || pictureLike(e)) return;
  const h = num(e.style["height"]);
  if (h !== null && h > 48 && hasText(e) && e.role !== "backdrop") {
    // Below the design width content can only get taller (grids lose columns,
    // rows wrap). A designed height becomes a floor, never a ceiling, so an
    // overflow-hidden section stops cutting its own text off.
    media(e, TABLET, { height: "auto", "min-height": px(h) });
    if (e.layoutKind !== "overlay" && e.layoutKind !== "absolute") {
      media(e, TABLET_SM, { height: "auto", "min-height": px(Math.min(h, 200)) });
      media(e, PHONE, { height: "auto", "min-height": "0" });
    }
  }
  if (e.isText && e.style["white-space"] === "nowrap" && e.box.w > 120) media(e, PHONE, { "white-space": "normal" });
  if (e.isText && e.style["white-space"] === "nowrap" && e.box.w > 240) media(e, TABLET, { "white-space": "normal" }); // a long single line (copyright, tagline) wraps rather than clips
  const w = num(e.style["width"]);
  // A hug container wider than a phone (its children carry the width) must be allowed to shrink.
  if (!e.isText && e.tag !== "img" && w === null && e.box.w >= 360 && e.style["position"] !== "absolute" && e.style["display"] === "flex") media(e, PHONE, { width: "100%", "max-width": "100%" });
  if ((e.tag === "img" || e.tag === "video") && w !== null && w >= 280 && e.style["position"] !== "absolute") {
    const hh = num(e.style["height"]);
    media(e, PHONE, { width: "100%", height: "auto", ...(hh ? { "aspect-ratio": `${Math.round(w)} / ${Math.round(hh)}` } : {}) });
  }
  if (!e.isText && e.tag !== "img" && w !== null && w >= 360 && e.style["position"] !== "absolute") media(e, PHONE, { width: "100%" });
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
  const cover = e.children.some((k) => k.hasAsset && !hasText(k) && (k.box.w * k.box.h) / (W * H) >= 0.6);
  if (!bg && !cover) return false;
  const kids = e.children.filter((k) => k.style["position"] === "absolute");
  if (!kids.length || !kids.some(hasText)) return false;
  return textLeafArea(e) / (W * H) <= 0.12;
}

/**
 * A text-less absolute composition (photo + plate + badge, map with pins,
 * polaroid stack) scales as ONE picture: percentage offsets inside a box that
 * keeps the design's aspect ratio. Exact at the design width, fluid below it.
 */
function scaleComposition(e: El): void {
  if (e.layoutKind !== "absolute" && e.layoutKind !== "overlay") return;
  const picture = pictureLike(e);
  if (hasText(e) && !picture) return;
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
  es["width"] = px(designW); es["max-width"] = "100%"; es["height"] = "auto"; es["aspect-ratio"] = `${Math.round(W)} / ${Math.round(H)}`;
  delete es["min-height"];
  if (!picture) return;
  // Tablets: the captions shrink with the picture. Container-query units make a
  // caption's type and fixed widths a share of the picture's width; exact at the design width.
  es["container-type"] = "inline-size";
  const cq = (v: number) => `${Math.round((v / W) * 10000) / 100}cqw`;
  const scaleLeaf = (k: El) => {
    const st: Record<string, string> = {}, reset: Record<string, string> = {};
    const fs = num(k.style["font-size"]);
    if (k.isText && fs !== null) { st["font-size"] = `clamp(9px, ${cq(fs)}, ${px(fs)})`; reset["font-size"] = k.style["font-size"]; }
    const lh = num(k.style["line-height"]);
    if (k.isText && lh !== null) { st["line-height"] = `clamp(11px, ${cq(lh)}, ${px(lh)})`; reset["line-height"] = k.style["line-height"]; }
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
  if (e.style["display"] !== "flex" || e.layoutKind === "overlay" || e.layoutKind === "absolute") return;
  const area = Math.max(1, e.box.w * e.box.h);
  for (const k of e.children) {
    if (k.style["position"] !== "absolute") continue;
    // Horizontal placement follows the container's width (a plate over the
    // second card stays over the second card when the grid shrinks).
    const pct = (v: number) => `${Math.round((v / e.box.w) * 10000) / 100}%`;
    const l = num(k.style["left"]), r = num(k.style["right"]), w = num(k.style["width"]);
    if (l !== null && l > 0) k.style["left"] = pct(l);
    if (r !== null && r > 0) k.style["right"] = pct(r);
    if (w !== null && w >= 120 && (l !== null || r !== null)) { k.style["width"] = pct(w); delete k.style["max-width"]; }
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

const INFLOW: Record<string, string> = { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none", margin: "0" };

function applyDecisions(e: El, idx: ResponsiveIndex, topInset: number): void {
  for (const d of idx.get(e.id) || []) {
    const q = d.at === "phone" ? PHONE : TABLET;
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
          for (const k of e.children.filter((c) => c.style["position"] !== "absolute")) media(k, q, { flex: `0 0 calc(${Math.round(10000 / n) / 100}% - ${gapExpr} * ${Math.round(((n - 1) / n) * 100) / 100})`, width: "auto", "max-width": "100%" });
        }
        break;
      }
      case "center": media(e, q, { "align-self": "center", "margin-left": "auto", "margin-right": "auto", "text-align": "center", "align-items": "center", "justify-content": "center" }); break;
      case "stack":
        if (composition && pictureLike(e)) break; // a collage scales as one picture; its captions already stack on phones
        if (composition) stackOverlay(e, idx, topInset, q, true);
        else if (isRow) stackRow(e, q);
        else if (isGrid) media(e, q, { "grid-template-columns": "repeat(1, minmax(0, 1fr))" });
        if (positioned) media(e, q, { ...INFLOW, width: "100%", "max-width": "100%" });
        break;
      case "wrap": if (isRow) media(e, q, { "flex-wrap": "wrap", "row-gap": "12px" }); break;
      case "row": if (e.style["display"] === "flex") media(e, q, { "flex-direction": "row" }); break;
      default: break;
    }
  }
}

/**
 * Hug-width containers take their width from their content, so a fixed-width
 * text inside one never shrinks with the column around it (flex items refuse
 * to go below their content: min-width:auto). Below the design width they may.
 */
function shrinkHug(e: El): void {
  if (e.style["display"] !== "flex") return;
  const row = e.style["flex-direction"] === "row";
  for (const k of e.children) {
    if (k.isText || k.tag === "img" || k.tag === "svg" || k.tag === "video" || k.style["position"] === "absolute") continue;
    if (k.style["width"] !== undefined || k.style["flex"] !== undefined || !k.children.length) continue;
    media(k, TABLET, row ? { "min-width": "0", "max-width": "100%" } : { "max-width": "100%" });
  }
}

/**
 * A content panel that bleeds across a section (white plate with the copy on
 * it) is absolutely placed inside a fixed-height box. Once its content stacks
 * on a phone it must drive the height: bring it into the flow.
 */
function panelsInFlow(e: El): void {
  const panels = e.children.filter((c) => c.role === "panel");
  if (!panels.length) return;
  media(e, PHONE, { height: "auto", "min-height": "0" });
  // The inner held the designed height for the absolute layout; the panel drives it now.
  for (const c of e.children) if (c.role === "inner" && !hasText(c)) media(c, PHONE, { height: "auto", "min-height": "0" });
  for (const p of panels) {
    const top = num(p.style["top"]) || 0;
    media(p, PHONE, { position: "relative", inset: "auto", left: "auto", right: "auto", top: "auto", bottom: "auto", "margin-top": px(Math.max(0, top)), height: "auto", "min-height": "0" });
  }
}

/**
 * A frame only serves viewports in its breakpoint range. Transforms written
 * for widths it never displays at (a phone rule on a desktop frame that hands
 * over to a mobile frame at 768) are dropped, and a frame never gets
 * transforms at or above its own design width — the designer drew that.
 */
export function pruneMedia(sections: Section[], W: number, range: { min: number; max: number | null }): void {
  const applies = (q: string): boolean => {
    const m = q.match(/max-width:\s*(\d+)px/); if (!m) return true;
    const maxW = parseInt(m[1], 10);
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
function overlayGrow(e: El, idx: ResponsiveIndex): void {
  if (e.layoutKind !== "overlay" && e.layoutKind !== "absolute") return;
  if (keep(idx, e, "tablet") || pictureLike(e)) return;
  const big = e.children
    .filter((k) => k.style["position"] === "absolute" && k.role !== "backdrop" && hasText(k) && k.box.w >= e.box.w * 0.5)
    .sort((a, b) => a.box.y - b.box.y);
  if (!big.length) return;
  const h = num(e.style["height"]) || num(e.style["min-height"]) || e.box.h;
  media(e, TABLET, { height: "auto", "min-height": px(h) });
  let prevBottom = 0;
  for (const k of big) {
    const st: Record<string, string> = { position: "relative", top: "auto", bottom: "auto", right: "auto", "margin-top": px(Math.max(0, k.box.y - prevBottom)) };
    if ((k.style["left"] || "").includes("50%")) { st["left"] = "auto"; st["transform"] = "none"; st["margin-left"] = "auto"; st["margin-right"] = "auto"; }
    else { st["margin-left"] = k.style["left"] || "0"; st["left"] = "auto"; }
    media(k, TABLET, st);
    prevBottom = k.box.y + k.box.h;
  }
  // Whatever sits below the last grown layer keeps its distance from the bottom.
  const tail = e.children.filter((k) => k.style["position"] === "absolute" && !big.includes(k) && k.role !== "backdrop" && k.box.y >= prevBottom - 1 && hasText(k));
  for (const k of tail) media(k, TABLET, { top: "auto", bottom: px(Math.max(0, e.box.h - (k.box.y + k.box.h))) });
}

export function applyResponsive(sections: Section[], W: number, idx: ResponsiveIndex = new Map()): void {
  const visit = (e: El, depth: number, topInset: number) => {
    fluidPadding(e, W); fluidGap(e, W); fluidAbsolute(e, W); fluidType(e, W);
    collapseGrid(e, idx); rows(e, depth, idx); overlayGrow(e, idx); stackOverlay(e, idx, topInset); loosen(e, idx); shrinkHug(e);
    if (!keep(idx, e, "phone")) { scaleComposition(e); absoluteInFlow(e); panelsInFlow(e); }
    applyDecisions(e, idx, topInset);
    e.children.forEach((c) => visit(c, depth + 1, c.role === "inner" ? topInset : 0));
  };
  sections.forEach((s, i) => {
    // A section the previous one overlaps (a header on a hero) must start its stack below it.
    const prev = sections[i - 1];
    const overlap = prev ? Math.max(0, prev.box.y + prev.box.h - s.box.y) : 0;
    visit(s.el, 0, overlap > 0 && overlap < 200 ? overlap : 0);
  });
}
