import { IRNode, IRTag, IRStyle, IRSection, IRPage, AssetMap } from "./types";
import {
  px, autoLayoutToFlex, sizingToCss, cornerToCss, strokeToCss,
  textToCss, backgroundFromFills, effectsToCss,
} from "./style";
import { captureAsset, captureFillImage } from "../assets/capture";
import { extractInteractions } from "./interactions";
import { Plan, PlanIndex, PlanContainer, indexPlan } from "../ai/plan";

/**
 * The walker turns Figma nodes into the IR. Every STRUCTURAL decision (page
 * root, sections, flow/grid/overlay, tags, decorations) comes from a Plan —
 * produced by the AI planner, or by `defaultPlan` when AI is unavailable.
 * Every MEASUREMENT (padding, gap, size, colour) is read from Figma here.
 */
export interface WalkCtx {
  assets: AssetMap;
  canvasWidth: number;
  plan: PlanIndex | null;
}

type Box = { x: number; y: number; width: number; height: number };

/** Absolute box in canvas space; falls back to relative x/y for odd nodes. */
function absBox(node: SceneNode): Box | null {
  const b = (node as unknown as { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox;
  if (b) return { x: b.x, y: b.y, width: b.width, height: b.height };
  if ("x" in node) {
    const n = node as LayoutMixin;
    return { x: n.x, y: n.y, width: n.width, height: n.height };
  }
  return null;
}

/** What exportAsync actually renders: the node plus its shadows/rotation.
 *  A rotated polaroid with a 50px shadow exports ~100px larger than its box. */
function renderBox(node: SceneNode): Box | null {
  const r = (node as unknown as { absoluteRenderBounds?: Rect | null }).absoluteRenderBounds;
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : absBox(node);
}

/** Box of `node` relative to `parent`'s top-left, using absolute bounds so
 *  Groups (which have no coordinate space of their own) come out right.
 *  `rendered` = use the render bounds (for exported images / vectors). */
function relBox(node: SceneNode, parent: SceneNode | null, rendered = false): Box {
  const a = rendered ? renderBox(node) : absBox(node);
  const p = parent ? absBox(parent) : null;
  if (a && p) return { x: a.x - p.x, y: a.y - p.y, width: a.width, height: a.height };
  if (a) return { ...a, x: "x" in node ? (node as LayoutMixin).x : 0, y: "y" in node ? (node as LayoutMixin).y : 0 };
  return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Do the children genuinely STACK (one over another) rather than flow?
 * Requires a meaningful intersection, and — when a plan is present — one of
 * the pair to be large relative to the parent, so a badge nudging a card
 * corner no longer downgrades a whole auto-layout frame to absolute mode.
 */
function childrenOverlap(kids: readonly SceneNode[], parent: SceneNode, strict: boolean): boolean {
  const pb = absBox(parent);
  const boxes = kids.filter((k) => k.visible !== false).map((k) => absBox(k))
    .filter((b): b is Box => !!b && b.width > 0 && b.height > 0);
  if (boxes.length < 2) return false;
  const parentArea = pb ? pb.width * pb.height : Infinity;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ox <= 1 || oy <= 1) continue;
      const area = ox * oy;
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      if (area / smaller <= 0.15) continue;
      if (!strict) return true;
      const bigger = Math.max(a.width * a.height, b.width * b.height);
      if (bigger / parentArea >= 0.5) return true;
    }
  }
  return false;
}

/** Infer rows/columns from raw coordinates for frames with NO auto-layout. */
function inferFlow(kids: IRNode[], force?: "row" | "column"): { direction: "row" | "column"; gap: number } | null {
  const boxes = kids.filter((k) => k.bbox.width > 0 && k.bbox.height > 0);
  if (boxes.length < 2) return force ? { direction: force, gap: 0 } : null;

  const sortedY = [...boxes].sort((a, b) => a.bbox.y - b.bbox.y);
  const sortedX = [...boxes].sort((a, b) => a.bbox.x - b.bbox.x);
  const vGaps: number[] = [], hGaps: number[] = [];
  let vClean = true, hClean = true;
  for (let i = 1; i < sortedY.length; i++) {
    const g = sortedY[i].bbox.y - (sortedY[i - 1].bbox.y + sortedY[i - 1].bbox.height);
    if (g < -2) vClean = false;
    vGaps.push(Math.max(0, g));
  }
  for (let i = 1; i < sortedX.length; i++) {
    const g = sortedX[i].bbox.x - (sortedX[i - 1].bbox.x + sortedX[i - 1].bbox.width);
    if (g < -2) hClean = false;
    hGaps.push(Math.max(0, g));
  }
  const avg = (gs: number[]) => gs.reduce((a, b) => a + b, 0) / Math.max(1, gs.length);
  const consistent = (gs: number[]) => gs.length > 0 && gs.every((g) => Math.abs(g - avg(gs)) <= Math.max(4, avg(gs) * 0.25));

  if (force === "row") return { direction: "row", gap: Math.round(Math.max(0, avg(hGaps))) };
  if (force === "column") return { direction: "column", gap: Math.round(Math.max(0, avg(vGaps))) };
  if (hClean && consistent(hGaps)) return { direction: "row", gap: Math.round(avg(hGaps)) };
  if (vClean && consistent(vGaps)) return { direction: "column", gap: Math.round(avg(vGaps)) };
  return null;
}

/** Column count = distinct x positions in the first visual row. */
function inferColumns(kids: IRNode[]): number {
  const boxes = kids.filter((k) => k.bbox.width > 0 && k.bbox.height > 0);
  if (!boxes.length) return 1;
  const minY = Math.min(...boxes.map((b) => b.bbox.y));
  const firstRow = boxes.filter((b) => Math.abs(b.bbox.y - minY) < Math.max(8, b.bbox.height * 0.3));
  return Math.max(1, firstRow.length);
}

/** Row / column gaps for a grid inferred from coordinates. */
function inferGridGaps(kids: IRNode[], columns: number): { row: number; col: number } {
  const boxes = [...kids].filter((k) => k.bbox.width > 0).sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  let col = 0, row = 0;
  if (boxes.length >= 2 && columns >= 2) {
    const a = boxes[0], b = boxes[1];
    col = Math.max(0, Math.round(b.bbox.x - (a.bbox.x + a.bbox.width)));
  }
  if (boxes.length > columns) {
    const a = boxes[0], b = boxes[columns];
    row = Math.max(0, Math.round(b.bbox.y - (a.bbox.y + a.bbox.height)));
  }
  return { row, col };
}

let uid = 0;
const slug = (s: string) => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `n${uid++}`;
  // ".64-21-024" is not a valid CSS selector — every rule for it is dropped.
  return /^[0-9]/.test(base) ? `n-${base}` : base;
};

/** Layer-name conventions designers actually use, mapped to semantics. */
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

function headingTag(fontSize: number): IRTag {
  if (fontSize >= 44) return "h1";
  if (fontSize >= 34) return "h2";
  if (fontSize >= 26) return "h3";
  if (fontSize >= 21) return "h4";
  return "h5";
}

function tagForText(node: TextNode, role?: string): IRTag {
  const size = typeof node.fontSize === "number" ? node.fontSize : 16;
  const weight = typeof node.fontName !== "symbol" ? node.fontName.style.toLowerCase() : "regular";
  const chars = node.characters.trim();
  const short = chars.length <= 60 && !chars.includes("\n");
  // "Title" is what designers name EVERY card heading. Only a big title is h1.
  if (role === "heading") return size >= 40 ? "h1" : headingTag(size);
  if (role === "subheading") return size >= 30 ? "h2" : headingTag(size);
  if (role === "cta") return "span";
  const bold = /bold|black|heavy|semibold|medium/.test(weight);
  if (short && (size >= 21 || (bold && size >= 18))) return headingTag(size);
  return "p";
}

function tagForContainer(role: string | undefined, depth: number, box: Box): IRTag {
  if (role === "header") return "header";
  if (role === "footer") return "footer";
  if (role === "nav") return "nav";
  // "CTA Section" is a section that CONTAINS a button, not a 1900px button.
  if (role === "cta" && box.height <= 120 && box.width <= 640) return "button";
  if (depth === 0) return "section";
  return "div";
}

const VALID_TAGS = new Set<string>(["section", "div", "header", "footer", "nav", "main", "article",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "ul", "li", "img", "video", "svg"]);

function rotationOf(node: SceneNode): number {
  const r = (node as unknown as { rotation?: number }).rotation;
  return typeof r === "number" && Math.abs(r) > 0.5 ? r : 0;
}
/** A group/frame whose children include a mask, or that is rotated as a whole,
 *  cannot be rebuilt from CSS boxes — Figma composites it. Rasterise it. */
function needsRaster(node: SceneNode): boolean {
  if (!("children" in node)) return false;
  const kids = (node as ChildrenMixin).children;
  if (kids.some((k) => (k as unknown as { isMask?: boolean }).isMask)) return true;
  if (rotationOf(node) !== 0 && kids.length > 0) return true;
  return false;
}

function isVectorish(node: SceneNode): boolean {
  return node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION"
    || node.type === "STAR" || node.type === "POLYGON" || node.type === "LINE";
}
function hasFill(node: SceneNode, type: string): boolean {
  const n = node as unknown as { fills?: readonly Paint[] };
  return Array.isArray(n.fills) && n.fills.some((p) => p.visible !== false && (p.type as string) === type);
}

/** Rasterise a subtree as one PNG placed exactly where it was. */
async function rasterize(node: SceneNode, ctx: WalkCtx, bbox: Box, role?: string): Promise<IRNode> {
  const rec = await captureAsset(node, ctx.assets, "image");
  const style: IRStyle = { width: px(bbox.width), height: px(bbox.height), maxWidth: "100%", objectFit: "contain" };
  return {
    id: node.id, name: node.name, tag: rec ? "img" : "div", className: slug(node.name), role,
    style, assetRef: rec ? rec.key : undefined, assetKind: rec ? "image" : undefined,
    children: [], figmaType: node.type, spacingSource: "auto-layout", bbox,
  };
}

/** Rotated leaves keep their own (unrotated) size and are turned with CSS. */
function applyRotation(node: SceneNode, ir: IRNode) {
  const rot = rotationOf(node);
  if (!rot || !("width" in node)) return;
  // An exported image/SVG already shows the rotation; rotating again doubles it.
  if (ir.assetRef) return;
  const w = (node as LayoutMixin).width, h = (node as LayoutMixin).height;
  ir.rotation = rot;
  ir.size = { width: w, height: h };
  ir.style.width = px(w); ir.style.height = px(h);
  delete ir.style.maxWidth;
  // Figma rotates counter-clockwise for positive angles; CSS clockwise.
  ir.style.transform = `rotate(${Math.round(-rot * 100) / 100}deg)`;
}

/** Absolute placement that honours rotation: position the unrotated box at the
 *  centre of the rotated bounds Figma reports. */
function placeAbsolute(c: IRNode, x: number, y: number) {
  c.style.position = "absolute";
  if (c.rotation && c.size) {
    c.style.left = px(x + (c.bbox.width - c.size.width) / 2);
    c.style.top = px(y + (c.bbox.height - c.size.height) / 2);
  } else {
    c.style.left = px(x);
    c.style.top = px(y);
  }
}

export async function walkNode(
  node: SceneNode, ctx: WalkCtx, depth: number, parentAutoLayout: boolean, parent: SceneNode | null
): Promise<IRNode | null> {
  if (node.visible === false) return null;
  const op = (node as unknown as { opacity?: number }).opacity;
  if (typeof op === "number" && op === 0) return null;

  const plan = ctx.plan;
  if (plan && plan.ignore.has(node.id)) return null;
  const deco = plan ? plan.decorations.get(node.id) : undefined;
  if (deco && deco.treatment === "ignore") return null;

  const role = roleFromName(node.name);
  const bbox = relBox(node, parent);
  if ((deco && deco.treatment === "rasterize") || (!deco && needsRaster(node))) {
    return rasterize(node, ctx, relBox(node, parent, true), role);
  }

  const style: IRStyle = {};
  let tag: IRTag = "div";
  let text: string | undefined;
  let assetRef: string | undefined;
  let assetKind: IRNode["assetKind"];
  let svgMarkup: string | undefined;
  const children: IRNode[] = [];
  let spacingSource: IRNode["spacingSource"] = "auto-layout";
  const canvasWidth = ctx.canvasWidth;

  // ---- TEXT -------------------------------------------------------------
  if (node.type === "TEXT") {
    tag = tagForText(node, role);
    text = node.characters;
    Object.assign(style, textToCss(node));
    // Auto-width text is one line in Figma; let it stay one line ("NEWS & BLOG").
    if (node.textAutoResize === "WIDTH_AND_HEIGHT" && !text.includes("\n")) style.whiteSpace = "nowrap";
    const sizing = sizingToCss(node, canvasWidth);
    if (sizing.width) style.width = sizing.width;
    if (sizing.flexGrow) style.flexGrow = sizing.flexGrow;
  }
  // ---- VECTOR / ICON ----------------------------------------------------
  else if (isVectorish(node) || role === "icon") {
    Object.assign(bbox, relBox(node, parent, true));
    const rec = await captureAsset(node, ctx.assets, "svg");
    if (rec) { assetRef = rec.key; assetKind = "svg"; svgMarkup = rec.svg; tag = "svg"; }
    else {
      // SVG export can fail on boolean ops with effects (torn edges vanished).
      const png = await captureAsset(node, ctx.assets, "image");
      if (png) { assetRef = png.key; assetKind = "image"; tag = "img"; }
    }
    Object.assign(style, sizingToCss(node, canvasWidth));
    if (!style.width) style.width = px(bbox.width);
    if (!style.height) style.height = px(bbox.height);
  }
  // ---- VIDEO ------------------------------------------------------------
  else if (hasFill(node, "VIDEO")) {
    const rec = await captureAsset(node, ctx.assets, "video");
    if (rec) { assetRef = rec.key; assetKind = "video"; tag = "video"; }
    Object.assign(style, sizingToCss(node, canvasWidth));
    style.objectFit = "cover";
    if (!style.width) style.width = px(bbox.width);
    if (!style.height) style.height = px(bbox.height);
  }
  // ---- IMAGE ------------------------------------------------------------
  else if (hasFill(node, "IMAGE") && !("children" in node && node.children.length)) {
    // The PNG is the rendered node (crop, stroke, shadow, rotation) — size it so.
    Object.assign(bbox, relBox(node, parent, true));
    const rec = await captureAsset(node, ctx.assets, "image");
    if (rec) { assetRef = rec.key; assetKind = "image"; tag = "img"; }
    Object.assign(style, sizingToCss(node, canvasWidth));
    style.objectFit = "cover";
    if (!style.width) style.width = px(bbox.width);
    if (!style.height) style.height = px(bbox.height);
  }
  // ---- CONTAINER --------------------------------------------------------
  else {
    tag = tagForContainer(role, depth, bbox);
    const isFrame = node.type === "FRAME" || node.type === "COMPONENT"
      || node.type === "INSTANCE" || node.type === "COMPONENT_SET";
    const f = node as FrameNode;
    const hasAuto = isFrame && f.layoutMode !== "NONE";
    const kids = "children" in node ? (node as ChildrenMixin).children.filter((c) => c.visible !== false) : [];
    const pc: PlanContainer | undefined = plan ? plan.containers.get(node.id) : undefined;

    // Decide the layout KIND. Plan wins; otherwise Figma's auto-layout is the
    // truth (only overridden by overlap when there is no plan at all).
    // Children Figma positions absolutely (torn edges, carousel arrows) sit on
    // top of everything by design; they must not make a flowing frame look
    // like an overlay. Only in-flow children are tested, and only a LARGE
    // stacked child (a backdrop) counts.
    const flowKids = kids.filter((k) => (k as unknown as { layoutPositioning?: string }).layoutPositioning !== "ABSOLUTE");
    let mode: PlanContainer["layout"];
    if (pc) mode = pc.layout;
    else if (hasAuto) mode = plan ? "flow" : (childrenOverlap(flowKids, node, true) ? "overlay" : "flow");
    else if (f.layoutWrap === "WRAP" && hasAuto) mode = "grid";
    else mode = childrenOverlap(flowKids, node, true) ? "overlay" : "flow";
    // A wrapping auto-layout list is a grid (cards in rows), plan or not.
    if (!pc && hasAuto && f.layoutWrap === "WRAP" && flowKids.length > 2) mode = "grid";

    const auto = mode === "flow" && hasAuto;
    if (auto) Object.assign(style, autoLayoutToFlex(f));
    else if (isFrame) {
      spacingSource = "absolute-coordinates";
      if (f.paddingTop) style.paddingTop = px(f.paddingTop);
      if (f.paddingRight) style.paddingRight = px(f.paddingRight);
      if (f.paddingBottom) style.paddingBottom = px(f.paddingBottom);
      if (f.paddingLeft) style.paddingLeft = px(f.paddingLeft);
    }
    Object.assign(style, { ...sizingToCss(node, canvasWidth), ...style });

    // Paint (frames AND plain shapes — a Rectangle overlay must keep its fill)
    const fills = (node as unknown as { fills?: readonly Paint[] | symbol }).fills;
    if (fills !== undefined) {
      const bg = backgroundFromFills(fills);
      if (bg.backgroundColor) style.backgroundColor = bg.backgroundColor;
      if (bg.backgroundImage) style.backgroundImage = bg.backgroundImage;
      if (bg.hasImage || bg.hasVideo) {
        // Children present: export the fill alone so text/buttons are not baked
        // into the background. Leaf shapes export as-is (exact Figma crop).
        const rec = kids.length || bg.hasVideo
          ? await captureFillImage(node, ctx.assets)
          : await captureAsset(node, ctx.assets, "image");
        if (rec) {
          assetRef = rec.key; assetKind = "image";
          const url = `url("../assets/images/${rec.filename}")`;
          const layers = bg.layers.includes("IMAGE") ? bg.layers : [...bg.layers, "IMAGE"];
          style.backgroundImage = layers.map((l) => (l === "IMAGE" ? url : l)).join(", ");
          style.backgroundSize = layers.map((l) => (l === "IMAGE" ? "cover" : "auto")).join(", ");
          style.backgroundPosition = "center";
          style.backgroundRepeat = "no-repeat";
        }
      }
    }
    if (isFrame && f.clipsContent) style.overflow = "hidden";

    // Figma lets a child of an auto-layout frame opt out of the flow
    // ("absolute position" — torn edges, badges, decorative vectors). Such a
    // child must not become a flex item, or it pushes real content around.
    const absKids: IRNode[] = [];
    for (const child of kids) {
      const c = await walkNode(child, ctx, depth + 1, auto, node);
      if (!c) continue;
      if ((child as unknown as { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE" && auto) {
        placeAbsolute(c, c.bbox.x, c.bbox.y);
        c.style.zIndex = c.style.zIndex || "5";
        absKids.push(c);
      } else children.push(c);
    }
    if (absKids.length) style.position = style.position || "relative";

    if (children.length) {
      if (mode === "grid") applyGrid(style, children, f, hasAuto, pc);
      else if (mode === "overlay") applyOverlay(style, children, bbox, pc);
      else if (mode === "absolute") applyAbsolute(style, children, bbox);
      else if (!auto) applyInferredFlow(style, children, bbox, pc);
    }

    children.push(...absKids);

    // Text reflow policy: a fixed-height frame that directly holds a paragraph
    // the plan marked "reflow" must be allowed to grow.
    if (plan && style.height) {
      const reflow = children.some((c) => c.text !== undefined && plan.text.get(c.id)?.policy === "reflow");
      if (reflow) { style.minHeight = style.height; delete style.height; }
    }
  }

  if (tag === "svg" && bbox.height < 1) style.height = "1px";
  if (tag === "svg" && bbox.width < 1) style.width = "1px";

  // Figma LINE/zero-height nodes carry their visual weight in the STROKE.
  if (bbox.height <= 1 && style.border) {
    const w = style.border.split(" ")[0];
    const color = style.border.split(" ").slice(2).join(" ");
    delete style.border;
    style.height = w;
    style.backgroundColor = color || style.backgroundColor;
  }

  const radius = cornerToCss(node);
  if (radius) style.borderRadius = radius;
  const stroke = strokeToCss(node);
  if (stroke) style.border = stroke;
  if ("effects" in node) Object.assign(style, effectsToCss((node as BlendMixin).effects));
  if (typeof op === "number" && op < 1) style.opacity = String(Math.round(op * 100) / 100);

  let interactions: Awaited<ReturnType<typeof extractInteractions>> = [];
  try { interactions = await extractInteractions(node); }
  catch (e) { console.warn("interactions skipped for", node.name, e); }
  if (interactions.length) {
    const dur = interactions[0].durationMs;
    style.transition = `all ${dur ? dur : 200}ms ${interactions[0].easing || "ease"}`;
  }

  // Plan tag override (validated against what the emitters understand).
  if (plan) {
    const t = plan.tags.get(node.id);
    if (t && VALID_TAGS.has(t) && t !== "img" && t !== "video" && t !== "svg") tag = t as IRTag;
  }

  const ir: IRNode = {
    id: node.id, name: node.name, tag, className: slug(node.name), role, text, style,
    assetRef, assetKind, svgMarkup,
    interactions: interactions.length ? interactions : undefined,
    children, figmaType: node.type, spacingSource, bbox,
  };
  if (!children.length) applyRotation(node, ir);
  return ir;
}

/* ---------------------------------------------------------------- layouts */

function applyGrid(style: IRStyle, children: IRNode[], f: FrameNode, hasAuto: boolean, pc?: PlanContainer) {
  const columns = (pc && pc.columns) || inferColumns(children);
  style.display = "grid";
  style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  let rowGap = 0, colGap = 0;
  if (hasAuto) {
    colGap = f.layoutMode === "HORIZONTAL" ? (f.itemSpacing || 0) : ((f as unknown as { counterAxisSpacing?: number }).counterAxisSpacing || f.itemSpacing || 0);
    rowGap = f.layoutMode === "HORIZONTAL" ? ((f as unknown as { counterAxisSpacing?: number }).counterAxisSpacing || f.itemSpacing || 0) : (f.itemSpacing || 0);
  } else {
    const g = inferGridGaps(children, columns);
    rowGap = g.row; colGap = g.col;
  }
  style.gap = `${px(rowGap)} ${px(colGap)}`;
  delete style.flexDirection; delete style.flexWrap; delete style.justifyContent;
  style.alignItems = "stretch";
  // Cells size the cards; a Figma px width would fight the column.
  for (const c of children) {
    c.style.width = "100%";
    delete c.style.maxWidth;
    delete c.style.position; delete c.style.left; delete c.style.top;
  }
  // A grid's height follows its rows.
  if (style.height) { style.minHeight = style.height; delete style.height; }
}

function applyOverlay(style: IRStyle, children: IRNode[], bbox: Box, pc?: PlanContainer) {
  style.position = "relative";
  delete style.display; delete style.flexDirection; delete style.gap;
  delete style.alignItems; delete style.justifyContent;
  let biggest = -1;
  let stretchBase = false;
  if (pc && pc.base) biggest = children.findIndex((c) => c.id === pc.base);
  const parentArea = Math.max(1, bbox.width * bbox.height);
  if (biggest < 0 && !style.backgroundImage) {
    // The backdrop is the photo/video that covers (nearly) the whole frame —
    // not whatever happens to be largest. A frame with its own background
    // image needs no base at all; a partial photo keeps its own box.
    const media = children
      .map((c, i) => ({ i, a: c.bbox.width * c.bbox.height / parentArea, m: c.assetKind === "image" || c.assetKind === "video" || !!c.style.backgroundImage }))
      .filter((x) => x.m && x.a >= 0.9)
      .sort((x, y) => y.a - x.a);
    if (media.length) { biggest = media[0].i; stretchBase = true; }
  }
  if (biggest >= 0 && pc && pc.base) {
    const b = children[biggest];
    stretchBase = (b.bbox.width * b.bbox.height) / parentArea >= 0.9;
  }
  // The frame is the source of truth for its own height; taller children are
  // clipped, exactly as Figma composites them.
  style.height = style.height || px(bbox.height);
  style.overflow = style.overflow || "hidden";
  children.forEach((c, i) => {
    if (i === biggest) return;
    c.style.zIndex = String(10 + i);
    if (c.rotation) { placeAbsolute(c, c.bbox.x, c.bbox.y); return; }
    c.style.position = "absolute";
    c.style.top = px(c.bbox.y);
    const rightInset = bbox.width - (c.bbox.x + c.bbox.width);
    if (c.bbox.x >= 0 && rightInset >= 0) {
      c.style.left = px(c.bbox.x);
      c.style.right = px(rightInset);
      delete c.style.width;
    } else {
      c.style.left = px(c.bbox.x);
      c.style.maxWidth = `calc(100% - ${px(c.bbox.x)})`;
    }
  });
  const base = biggest >= 0 ? children[biggest] : undefined;
  if (base && stretchBase && !base.assetRef) {
    // A plain colour/gradient backdrop may fill the frame.
    base.style.position = "absolute";
    base.style.top = "0"; base.style.left = "0"; base.style.right = "0"; base.style.bottom = "0";
    base.style.zIndex = "0";
    base.style.width = "100%"; base.style.height = "100%";
    delete base.style.maxWidth;
  } else if (base) {
    // Partial backdrop (a footer photo over the top 2/3): keep its own box.
    placeAbsolute(base, base.bbox.x, base.bbox.y);
    base.style.width = px(base.bbox.width); base.style.height = px(base.bbox.height);
    delete base.style.maxWidth; delete base.style.right;
    base.style.zIndex = "0";
  }
}

function applyAbsolute(style: IRStyle, children: IRNode[], bbox: Box) {
  style.position = style.position || "relative";
  delete style.display; delete style.flexDirection; delete style.gap;
  if (!style.minHeight && !style.height) style.height = px(bbox.height);
  for (const c of children) placeAbsolute(c, c.bbox.x, c.bbox.y);
}

function applyInferredFlow(style: IRStyle, children: IRNode[], bbox: Box, pc?: PlanContainer) {
  const flow = inferFlow(children, pc && pc.direction ? pc.direction : undefined);
  if (flow) {
    style.display = "flex";
    style.flexDirection = flow.direction;
    if (flow.gap > 0) style.gap = px(flow.gap);
    style.alignItems = "flex-start";
    const minX = Math.min(...children.map((c) => c.bbox.x));
    const minY = Math.min(...children.map((c) => c.bbox.y));
    if (minX > 0 && !style.paddingLeft) style.paddingLeft = px(minX);
    if (minY > 0 && !style.paddingTop) style.paddingTop = px(minY);
    if (!style.minHeight && !style.height) style.minHeight = px(bbox.height);
  } else {
    applyAbsolute(style, children, bbox);
  }
}

/* ------------------------------------------------------------ compaction */

function isContentless(n: IRNode): boolean {
  if (n.children.length) return false;
  if (n.text !== undefined && n.text.trim()) return false;
  if (n.assetRef || n.svgMarkup) return false;
  const st = n.style;
  const paints = !!(st.backgroundColor || st.backgroundImage || st.border || st.boxShadow || st.borderRadius);
  return !paints;
}

export function compactTree(n: IRNode): IRNode {
  n.children = n.children.map(compactTree).filter((c) => !isContentless(c));
  const st = n.style;
  const realGap = !!st.gap && n.children.length > 1;
  const carriesSpacing = !!(st.paddingTop || st.paddingRight || st.paddingBottom || st.paddingLeft || realGap);
  const realWidth = !!st.width && st.width !== "100%";
  const constrainsSize = !!(realWidth || st.height || st.minHeight || st.maxWidth);
  const positions = !!(st.position === "absolute" || st.position === "relative");
  if (
    n.children.length === 1 && !n.text && !n.assetRef && n.tag === "div" &&
    !st.backgroundColor && !st.backgroundImage && !st.border && !st.boxShadow && !n.interactions &&
    !carriesSpacing && !constrainsSize && !positions && st.display !== "grid"
  ) {
    const child = n.children[0];
    const inherited = { ...n.style };
    if (child.style.display) {
      delete inherited.display; delete inherited.flexDirection;
      delete inherited.gap; delete inherited.alignItems; delete inherited.justifyContent;
    }
    child.style = { ...inherited, ...child.style };
    return child;
  }
  return n;
}

/* ------------------------------------------------------------------ page */

/**
 * Behaviour when no AI plan is available. Designers wrap the real page in a
 * frame and leave stray layers (a footer, decorative photos) beside it, so:
 *  1. descend through single-child wrappers;
 *  2. if one child covers most of the frame and holds several children, THAT
 *     child is the page and its children are the sections;
 *  3. siblings that sit fully below/above the page child (a separate footer)
 *     become sections too; everything else is left for the overlap-attach pass.
 */
export function defaultPlan(frame: FrameNode): Plan {
  let root: FrameNode = frame;
  for (let guard = 0; guard < 4; guard++) {
    const vis = root.children.filter((c) => c.visible !== false);
    if (vis.length === 1 && "children" in vis[0] && (vis[0] as FrameNode).children.length > 1) root = vis[0] as FrameNode;
    else break;
  }
  const kids = root.children.filter((c) => c.visible !== false);
  const rootArea = Math.max(1, root.width * root.height);
  const page = kids.find((c) => "children" in c && (c as FrameNode).children.length >= 3 &&
    ("width" in c ? (c as LayoutMixin).width * (c as LayoutMixin).height / rootArea : 0) >= 0.6) as FrameNode | undefined;

  let sectionNodes: SceneNode[];
  if (page) {
    const pageBox = absBox(page)!;
    sectionNodes = page.children.filter((c) => c.visible !== false);
    for (const sib of kids) {
      if (sib.id === page.id) continue;
      const b = absBox(sib); if (!b) continue;
      const outside = b.y >= pageBox.y + pageBox.height - 2 || b.y + b.height <= pageBox.y + 2;
      const wide = b.width >= pageBox.width * 0.6;
      if (outside && wide) sectionNodes.push(sib);
    }
    root = page;
  } else {
    sectionNodes = kids.length > 1 ? kids : [root];
  }
  // Tiny loose scraps are not sections.
  sectionNodes = sectionNodes.filter((c) => {
    const b = absBox(c); return !b || (b.width >= 200 && b.height >= 40);
  });
  return {
    planVersion: 1, pageRoot: root.id,
    sections: sectionNodes.map((c) => ({
      id: c.id, slug: slug(c.name), tag: "section" as const, role: roleFromName(c.name) || "",
      attach: [], confidence: 0.5, note: "heuristic",
    })),
    containers: [], tagOverrides: [], decorations: [], textPolicy: [], ignore: [], notes: "no AI plan",
  };
}

function isAncestor(a: BaseNode, n: BaseNode): boolean {
  let p = n.parent;
  while (p) { if (p.id === a.id) return true; p = p.parent; }
  return false;
}

export async function walkPage(frame: FrameNode, assets: AssetMap, planIn: Plan | null): Promise<IRPage> {
  const plan = planIn || defaultPlan(frame);
  const idx = indexPlan(plan);
  const ctx: WalkCtx = { assets, canvasWidth: Math.round(frame.width), plan: planIn ? idx : null };
  const frameAbs = absBox(frame) || { x: 0, y: 0, width: frame.width, height: frame.height };

  const rootNode = (await figma.getNodeByIdAsync(plan.pageRoot)) as SceneNode | null;
  const pageRoot: SceneNode = rootNode && isAncestor(frame, rootNode) ? rootNode : frame;

  // Resolve section nodes; sort by absolute y — visual order is the truth.
  const secNodes: Array<{ node: SceneNode; ps: Plan["sections"][number] }> = [];
  for (const ps of plan.sections) {
    const n = (await figma.getNodeByIdAsync(ps.id)) as SceneNode | null;
    if (n && n.visible !== false && (n.id === frame.id || isAncestor(frame, n))) secNodes.push({ node: n, ps });
  }
  if (!secNodes.length) {
    for (const ps of defaultPlan(frame).sections) {
      const n = (await figma.getNodeByIdAsync(ps.id)) as SceneNode | null;
      if (n) secNodes.push({ node: n, ps });
    }
  }
  secNodes.sort((a, b) => (absBox(a.node)?.y ?? 0) - (absBox(b.node)?.y ?? 0));

  // Loose layers: children of the frame or of the page root that are neither a
  // section, nor inside one, nor already attached / ignored. Code attaches them
  // to the section they overlap most, so nothing the model missed is dropped.
  const sectionSet = new Set(secNodes.map((s) => s.node.id));
  const loose: SceneNode[] = [];
  const candidates: SceneNode[] = [];
  for (const c of frame.children) candidates.push(c);
  if (pageRoot.id !== frame.id && "children" in pageRoot) for (const c of (pageRoot as ChildrenMixin).children) candidates.push(c);
  for (const c of candidates) {
    if (c.visible === false || sectionSet.has(c.id) || idx.attached.has(c.id) || idx.ignore.has(c.id)) continue;
    if (c.id === pageRoot.id) continue;
    if (secNodes.some((s) => isAncestor(c, s.node) || isAncestor(s.node, c))) continue;
    loose.push(c);
  }
  const overlapY = (a: Box, b: Box) => Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const extraAttach = new Map<string, SceneNode[]>();
  for (const l of loose) {
    const lb = absBox(l); if (!lb) continue;
    let best: string | null = null, bestOv = 0;
    for (const s of secNodes) {
      const sb = absBox(s.node); if (!sb) continue;
      const ov = overlapY(lb, sb);
      if (ov > bestOv) { bestOv = ov; best = s.node.id; }
    }
    if (best && bestOv > 0) {
      if (!extraAttach.has(best)) extraAttach.set(best, []);
      extraAttach.get(best)!.push(l);
    }
  }

  const sections: IRSection[] = [];
  for (const { node, ps } of secNodes) {
    const root = await walkNode(node, ctx, 0, false, node.parent as SceneNode | null);
    if (!root) continue;
    if (ps.tag && ps.tag !== "div") root.tag = ps.tag as IRTag;
    else if (root.tag === "div") root.tag = "section";
    if (ps.role) root.role = ps.role;
    root.className = ps.slug;

    // Attach loose layers (from the plan, then code's own overlap pass) as
    // positioned children of this section, at their exact visual offset.
    const secAbs = absBox(node);
    const toAttach: SceneNode[] = [];
    for (const id of ps.attach) {
      const a = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
      if (a && a.visible !== false) toAttach.push(a);
    }
    for (const a of extraAttach.get(node.id) || []) toAttach.push(a);
    for (const a of toAttach) {
      const child = await walkNode(a, ctx, 1, false, a.parent as SceneNode | null);
      const ab = absBox(a);
      if (!child || !ab || !secAbs) continue;
      placeAbsolute(child, ab.x - secAbs.x, ab.y - secAbs.y);
      child.style.zIndex = "30";
      if (!child.style.width) child.style.width = px(ab.width);
      delete child.style.right; delete child.style.maxWidth;
      root.children.push(child);
    }
    if (toAttach.length) {
      root.style.position = root.style.position || "relative";
      root.spacingSource = root.spacingSource;
    }

    const sb = absBox(node) || { x: 0, y: 0, width: 0, height: 0 };
    sections.push({
      id: node.id, name: node.name, slug: ps.slug,
      root: compactTree(root),
      bbox: { x: sb.x - frameAbs.x, y: sb.y - frameAbs.y, width: sb.width, height: sb.height },
      confidence: ps.confidence, note: ps.note,
    });
  }

  return {
    name: frame.name,
    slug: slug(frame.name),
    canvasWidth: Math.round(frame.width),
    canvasHeight: Math.round(frame.height),
    sections,
  };
}
