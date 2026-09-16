/**
 * Figma node tree -> figma-ir/1. Facts only.
 *
 * The only judgement calls here are WHICH nodes get bytes exported, because
 * the compiler cannot come back to Figma later:
 *   - vectors, lines, boolean ops       -> SVG
 *   - leaves with an image/video fill   -> PNG@2x / poster
 *   - containers with an image fill     -> fill-only PNG (children stripped)
 *   - masked / rotated groups           -> PNG@2x of the composite
 *   - small all-vector groups (icons)   -> SVG of the group
 *   - ids listed in `rasterIds`         -> PNG@2x (a previous plan asked)
 */
import type {
  IRNode, IRNodeType, IRLayout, IRFill, IRStroke, IREffect, IRText, IRTextSegment,
  IRInteraction, Box, SizingMode, Constraint,
} from "../ir/schema.ts";
import { rgbaToCss, round2, type RGBA } from "../ir/color.ts";
import { exportNode, exportFill, type AssetStore } from "./assets.ts";

export interface ExtractCtx {
  frameAbs: { x: number; y: number };
  assets: AssetStore;
  rasterIds: Set<string>;
  progress: (msg: string) => void;
  count: number;
  exported: number;
  /** family -> styles seen; filled while walking text. */
  fonts: Map<string, Set<string>>;
  missingFonts: Set<string>;
}

const TYPE_MAP: Record<string, IRNodeType> = {
  FRAME: "frame", GROUP: "group", COMPONENT: "component", COMPONENT_SET: "component-set", INSTANCE: "instance",
  SECTION: "section", TEXT: "text", VECTOR: "vector", RECTANGLE: "rect", ELLIPSE: "ellipse", LINE: "line",
  POLYGON: "polygon", STAR: "star", BOOLEAN_OPERATION: "boolean", SLICE: "slice",
};

const r2 = round2;

function absBox(node: SceneNode, origin: { x: number; y: number }): Box {
  const b = (node as unknown as { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox;
  if (b) return { x: r2(b.x - origin.x), y: r2(b.y - origin.y), w: r2(b.width), h: r2(b.height) };
  return { x: r2(node.x), y: r2(node.y), w: r2(node.width), h: r2(node.height) };
}
function renderBox(node: SceneNode, origin: { x: number; y: number }): Box {
  const b = (node as unknown as { absoluteRenderBounds?: Rect | null }).absoluteRenderBounds;
  if (b) return { x: r2(b.x - origin.x), y: r2(b.y - origin.y), w: r2(b.width), h: r2(b.height) };
  return absBox(node, origin);
}

/* ------------------------------------------------------------ paint */

function gradientAngle(m: Transform): number {
  // gradientTransform maps node space -> gradient space; read the rotation
  // from the transposed cell and convert to CSS's clockwise-from-top angle.
  return Math.round((Math.atan2(m[0][1], m[0][0]) * 180) / Math.PI + 90);
}

/** Invert Figma's gradientTransform (node space -> gradient space) to place a radial gradient. */
function radialGeometry(m: Transform): { center: [number, number]; radii: [number, number] } | null {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return null;
  const inv = (x: number, y: number): [number, number] => [(e * (x - c) - b * (y - f)) / det, (-d * (x - c) + a * (y - f)) / det];
  const ctr = inv(0.5, 0.5), ex = inv(1, 0.5), ey = inv(0.5, 1);
  const rx = Math.hypot(ex[0] - ctr[0], ex[1] - ctr[1]), ry = Math.hypot(ey[0] - ctr[0], ey[1] - ctr[1]);
  return { center: [r2(ctr[0]), r2(ctr[1])], radii: [r2(rx), r2(ry)] };
}

/** Linear gradient line (0% and 100% points) in node space. */
function linearGeometry(m: Transform): { start: [number, number]; end: [number, number] } | null {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return null;
  const inv = (x: number, y: number): [number, number] => [r2((e * (x - c) - b * (y - f)) / det), r2((-d * (x - c) + a * (y - f)) / det)];
  return { start: inv(0, 0.5), end: inv(1, 0.5) };
}

const PAINT_BLENDS = new Set(["multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]);
function paintBlend(p: Paint): IRFill extends { blend?: infer B } ? B : never {
  const b = String((p as unknown as { blendMode?: string }).blendMode || "NORMAL").toLowerCase().replace(/_/g, "-");
  return (PAINT_BLENDS.has(b) ? b : "normal") as never;
}

function fillsOf(node: SceneNode): IRFill[] {
  const fills = (node as unknown as { fills?: readonly Paint[] | symbol }).fills;
  if (typeof fills === "symbol" || !Array.isArray(fills)) return [];
  const out: IRFill[] = [];
  for (const p of fills) {
    if (p.visible === false) continue;
    const op = p.opacity ?? 1;
    const blend = paintBlend(p);
    if (p.type === "SOLID") out.push({ type: "solid", color: rgbaToCss(p.color as RGBA), opacity: r2(op), ...(blend !== "normal" ? { blend } : {}) });
    else if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_ANGULAR" || p.type === "GRADIENT_DIAMOND") {
      const g = p as GradientPaint;
      const geo = p.type === "GRADIENT_LINEAR" ? null : radialGeometry(g.gradientTransform);
      const lin = p.type === "GRADIENT_LINEAR" ? linearGeometry(g.gradientTransform) : null;
      out.push({
        type: "gradient",
        kind: p.type === "GRADIENT_LINEAR" ? "linear" : p.type === "GRADIENT_RADIAL" ? "radial" : p.type === "GRADIENT_ANGULAR" ? "angular" : "diamond",
        angle: gradientAngle(g.gradientTransform),
        stops: g.gradientStops.map((s) => ({ color: rgbaToCss(s.color as RGBA), position: r2(s.position) })),
        opacity: r2(op),
        ...(geo ? { center: geo.center, radii: geo.radii } : {}),
        ...(lin ? { start: lin.start, end: lin.end } : {}),
        ...(blend !== "normal" ? { blend } : {}),
      });
    } else if (p.type === "IMAGE") {
      const ip = p as ImagePaint;
      out.push({ type: "image", scaleMode: (ip.scaleMode || "FILL").toLowerCase() as "fill" | "fit" | "tile" | "crop", opacity: r2(op), imageHash: ip.imageHash || null, ...(blend !== "normal" ? { blend } : {}) });
    } else if ((p.type as string) === "VIDEO") out.push({ type: "video", opacity: r2(op) });
  }
  return out;
}

function strokeOf(node: SceneNode): IRStroke | null {
  const n = node as unknown as {
    strokes?: readonly Paint[]; strokeWeight?: number | symbol; strokeAlign?: string; dashPattern?: readonly number[];
    strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number;
  };
  if (!Array.isArray(n.strokes) || !n.strokes.length) return null;
  const solid = n.strokes.find((p) => p.visible !== false && p.type === "SOLID") as SolidPaint | undefined;
  if (!solid) return null;
  let weight = typeof n.strokeWeight === "number" ? n.strokeWeight : 0;
  let weights: IRStroke["weights"] = null;
  if (typeof n.strokeTopWeight === "number") {
    const w = [n.strokeTopWeight, n.strokeRightWeight || 0, n.strokeBottomWeight || 0, n.strokeLeftWeight || 0].map(r2) as [number, number, number, number];
    if (new Set(w).size > 1) { weights = w; weight = Math.max(...w); }
    else weight = w[0];
  }
  if (weight <= 0) return null;
  return {
    color: rgbaToCss(solid.color as RGBA, solid.opacity ?? 1), weight: r2(weight), weights,
    align: ((n.strokeAlign || "INSIDE").toLowerCase()) as IRStroke["align"],
    dash: Array.isArray(n.dashPattern) ? n.dashPattern.map(r2) : [],
  };
}

function radiusOf(node: SceneNode): IRNode["radius"] {
  const n = node as unknown as { cornerRadius?: number | symbol; topLeftRadius?: number; topRightRadius?: number; bottomRightRadius?: number; bottomLeftRadius?: number };
  if (typeof n.cornerRadius === "number") return n.cornerRadius > 0 ? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius].map(r2) as [number, number, number, number] : null;
  const v = [n.topLeftRadius ?? 0, n.topRightRadius ?? 0, n.bottomRightRadius ?? 0, n.bottomLeftRadius ?? 0].map(r2) as [number, number, number, number];
  return v.some((x) => x > 0) ? v : null;
}

function effectsOf(node: SceneNode): IREffect[] {
  const effects = (node as unknown as { effects?: readonly Effect[] | symbol }).effects;
  if (typeof effects === "symbol" || !Array.isArray(effects)) return [];
  const out: IREffect[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const s = e as DropShadowEffect;
      out.push({ type: e.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow", x: r2(s.offset.x), y: r2(s.offset.y), blur: r2(s.radius), spread: r2(s.spread ?? 0), color: rgbaToCss(s.color as RGBA) });
    } else if (e.type === "LAYER_BLUR") out.push({ type: "blur", radius: r2((e as BlurEffect).radius) });
    else if (e.type === "BACKGROUND_BLUR") out.push({ type: "backdrop-blur", radius: r2((e as BlurEffect).radius) });
  }
  return out;
}

/* ------------------------------------------------------------ layout */

const JUSTIFY: Record<string, IRLayout["justify"]> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" };
const ALIGN: Record<string, IRLayout["align"]> = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" };

function layoutOf(node: SceneNode): IRLayout | null {
  if (!("layoutMode" in node)) return null;
  const f = node as FrameNode;
  if (!f.layoutMode || f.layoutMode === "NONE") return null;
  const wrap = f.layoutWrap === "WRAP";
  const ac = (f as unknown as { counterAxisAlignContent?: string }).counterAxisAlignContent;
  return {
    direction: f.layoutMode === "VERTICAL" ? "column" : "row",
    wrap,
    gap: r2(f.itemSpacing || 0),
    counterGap: r2((f as unknown as { counterAxisSpacing?: number | null }).counterAxisSpacing || 0),
    padding: [f.paddingTop || 0, f.paddingRight || 0, f.paddingBottom || 0, f.paddingLeft || 0].map(r2) as [number, number, number, number],
    justify: JUSTIFY[f.primaryAxisAlignItems] || "start",
    align: ALIGN[f.counterAxisAlignItems] || "start",
    alignContent: wrap ? (ac === "SPACE_BETWEEN" ? "space-between" : "start") : null,
    // Negative spacing + reverse z-index = earlier children paint on top.
    reverse: !!(f as unknown as { itemReverseZIndex?: boolean }).itemReverseZIndex,
    strokesIncluded: !!(f as unknown as { strokesIncludedInLayout?: boolean }).strokesIncludedInLayout,
  };
}

function sizingOf(node: SceneNode): IRNode["sizing"] {
  const n = node as unknown as { layoutSizingHorizontal?: string; layoutSizingVertical?: string; minWidth?: number | null; maxWidth?: number | null; minHeight?: number | null; maxHeight?: number | null };
  const m = (v?: string): SizingMode => (v === "FILL" ? "fill" : v === "HUG" ? "hug" : "fixed");
  return {
    w: m(n.layoutSizingHorizontal), h: m(n.layoutSizingVertical),
    minW: n.minWidth ?? null, maxW: n.maxWidth ?? null, minH: n.minHeight ?? null, maxH: n.maxHeight ?? null,
  };
}

function constraintsOf(node: SceneNode): IRNode["constraints"] {
  const c = (node as unknown as { constraints?: Constraints }).constraints;
  const m = (v?: string): Constraint => (v === "MAX" ? "max" : v === "CENTER" ? "center" : v === "STRETCH" ? "stretch" : v === "SCALE" ? "scale" : "min");
  return { h: m(c?.horizontal), v: m(c?.vertical) };
}

/* -------------------------------------------------------------- text */

const LH = (lh: LineHeight | symbol | undefined): IRTextSegment["lineHeight"] => {
  if (!lh || typeof lh === "symbol") return { unit: "auto", value: 0 };
  if (lh.unit === "PIXELS") return { unit: "px", value: r2(lh.value) };
  if (lh.unit === "PERCENT") return { unit: "percent", value: r2(lh.value) };
  return { unit: "auto", value: 0 };
};
const LS = (ls: LetterSpacing | symbol | undefined): IRTextSegment["letterSpacing"] => {
  if (!ls || typeof ls === "symbol") return { unit: "px", value: 0 };
  return { unit: ls.unit === "PERCENT" ? "percent" : "px", value: r2(ls.value) };
};
function weightFromStyle(style: string): number {
  const s = style.toLowerCase();
  if (s.includes("thin") || s.includes("hairline")) return 100;
  if (s.includes("extralight") || s.includes("extra light") || s.includes("ultralight")) return 200;
  if (s.includes("semibold") || s.includes("semi bold") || s.includes("demibold") || s.includes("demi bold")) return 600;
  if (s.includes("extrabold") || s.includes("extra bold") || s.includes("ultrabold")) return 800;
  if (s.includes("black") || s.includes("heavy")) return 900;
  if (s.includes("light")) return 300;
  if (s.includes("medium")) return 500;
  if (s.includes("bold")) return 700;
  return 400;
}

function textOf(node: TextNode, ctx: ExtractCtx): IRText {
  const segs = node.getStyledTextSegments([
    "fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fills", "textDecoration", "textCase", "hyperlink", "listOptions",
  ]);
  if (node.hasMissingFont) ctx.missingFonts.add(typeof node.fontName === "symbol" ? "(mixed)" : node.fontName.family);
  const segments: IRTextSegment[] = segs.map((s) => {
    const solid = Array.isArray(s.fills) ? (s.fills.find((p) => p.visible !== false && p.type === "SOLID") as SolidPaint | undefined) : undefined;
    const style = s.fontName.style || "Regular";
    if (!ctx.fonts.has(s.fontName.family)) ctx.fonts.set(s.fontName.family, new Set());
    ctx.fonts.get(s.fontName.family)!.add(style);
    return {
      start: s.start, end: s.end,
      fontFamily: s.fontName.family, fontStyle: style,
      fontWeight: typeof s.fontWeight === "number" ? s.fontWeight : weightFromStyle(style),
      italic: /italic|oblique/i.test(style),
      fontSize: r2(s.fontSize),
      lineHeight: LH(s.lineHeight), letterSpacing: LS(s.letterSpacing),
      color: solid ? rgbaToCss(solid.color as RGBA, solid.opacity ?? 1) : null,
      decoration: s.textDecoration === "UNDERLINE" ? "underline" : s.textDecoration === "STRIKETHROUGH" ? "strikethrough" : "none",
      textCase: s.textCase === "UPPER" ? "upper" : s.textCase === "LOWER" ? "lower" : s.textCase === "TITLE" ? "title" : "original",
      href: s.hyperlink && s.hyperlink.type === "URL" ? s.hyperlink.value : null,
      list: s.listOptions?.type === "ORDERED" ? "ordered" : s.listOptions?.type === "UNORDERED" ? "unordered" : "none",
    };
  });
  const first = segments[0];
  let lines = node.characters.split("\n").length;
  if (first && first.lineHeight.unit === "px" && first.lineHeight.value > 0) lines = Math.max(lines, Math.round(node.height / first.lineHeight.value));
  else if (first && first.fontSize > 0) lines = Math.max(lines, Math.round(node.height / (first.fontSize * 1.2)));
  const ar = node.textAutoResize;
  return {
    characters: node.characters,
    segments,
    align: node.textAlignHorizontal === "CENTER" ? "center" : node.textAlignHorizontal === "RIGHT" ? "right" : node.textAlignHorizontal === "JUSTIFIED" ? "justify" : "left",
    valign: node.textAlignVertical === "CENTER" ? "center" : node.textAlignVertical === "BOTTOM" ? "bottom" : "top",
    autoResize: ar === "HEIGHT" ? "height" : ar === "WIDTH_AND_HEIGHT" ? "width-height" : ar === "TRUNCATE" ? "truncate" : "none",
    maxLines: (node as unknown as { maxLines?: number | null }).maxLines ?? null,
    paragraphSpacing: typeof node.paragraphSpacing === "number" ? r2(node.paragraphSpacing) : 0,
    lines,
    leadingTrim: (node as unknown as { leadingTrim?: string }).leadingTrim === "CAP_HEIGHT" ? "cap-height" : "none",
  };
}

/* ------------------------------------------------------ interactions */

async function interactionsOf(node: SceneNode): Promise<IRInteraction[]> {
  const out: IRInteraction[] = [];
  const reactions = (node as unknown as { reactions?: readonly Reaction[] }).reactions;
  if (!Array.isArray(reactions) || !reactions.length) return out;
  let hover: IRInteraction["hover"] = null;
  if (node.type === "INSTANCE") {
    try {
      const main = await (node as InstanceNode).getMainComponentAsync();
      const set = main?.parent;
      if (set && set.type === "COMPONENT_SET") {
        const hv = set.children.find((c) => /hover/i.test(c.name)) as ComponentNode | undefined;
        if (hv) {
          const f = fillsOf(hv).find((x) => x.type === "solid") as Extract<IRFill, { type: "solid" }> | undefined;
          hover = {};
          if (f) hover.backgroundColor = f.color;
          if (typeof hv.opacity === "number" && hv.opacity < 1) hover.opacity = r2(hv.opacity);
          if (!Object.keys(hover).length) hover = null;
        }
      }
    } catch { /* dynamic-page restrictions */ }
  }
  for (const r of reactions) {
    const t = r.trigger; if (!t) continue;
    const trigger: IRInteraction["trigger"] | null = t.type === "ON_HOVER" ? "hover" : t.type === "ON_PRESS" ? "press" : t.type === "ON_CLICK" ? "click" : null;
    if (!trigger) continue;
    const actions = (r as unknown as { actions?: readonly Action[] }).actions || ((r as unknown as { action?: Action }).action ? [(r as unknown as { action: Action }).action] : []);
    for (const a of actions) {
      if (!a) continue;
      if (a.type === "URL") out.push({ trigger, action: "navigate", url: (a as { url: string }).url, durationMs: 0, easing: "ease", hover: null });
      else if (a.type === "NODE") {
        const na = a as unknown as { destinationId?: string | null; navigation?: string; transition?: { type?: string; duration?: number; easing?: { type?: string } } | null };
        const dur = na.transition?.duration ? Math.round(na.transition.duration * 1000) : 200;
        const et = na.transition?.easing?.type;
        const easing = et === "EASE_IN" ? "ease-in" : et === "EASE_OUT" ? "ease-out" : et === "EASE_IN_AND_OUT" ? "ease-in-out" : et === "LINEAR" ? "linear" : "ease";
        const action: IRInteraction["action"] = na.navigation === "OVERLAY" ? "overlay" : na.navigation === "NAVIGATE" ? "navigate" : "style";
        out.push({ trigger, action, url: null, durationMs: dur, easing, hover, destinationId: na.destinationId || null, transitionType: na.transition?.type || null });
      } else out.push({ trigger, action: "unknown", url: null, durationMs: 0, easing: "ease", hover: null });
    }
  }
  return out;
}

/* ----------------------------------------------------- export policy */

const VECTORISH = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const hasChildren = (n: SceneNode): n is SceneNode & ChildrenMixin => "children" in n && (n as ChildrenMixin).children.length > 0;
const hasFillType = (n: SceneNode, t: string) => {
  const f = (n as unknown as { fills?: readonly Paint[] | symbol }).fills;
  return Array.isArray(f) && f.some((p) => p.visible !== false && (p.type as string) === t);
};
function rotationOf(n: SceneNode): number {
  const r = (n as unknown as { rotation?: number }).rotation;
  return typeof r === "number" && Math.abs(r) > 0.5 ? r2(r) : 0;
}
/** A small group made only of vectors/shapes (an icon drawn from paths). */
function isIconGroup(n: SceneNode): boolean {
  if (!hasChildren(n)) return false;
  if (n.width > 320 || n.height > 320) return false;
  let count = 0, ok = true;
  const visit = (k: SceneNode) => {
    if (!ok || k.visible === false) return;
    count++;
    if (count > 60) { ok = false; return; }
    if (k.type === "TEXT" || hasFillType(k, "IMAGE") || hasFillType(k, "VIDEO")) { ok = false; return; }
    if (hasChildren(k)) { if (k.type === "INSTANCE" || k.type === "COMPONENT") { /* nested icon instance fine */ } k.children.forEach(visit); return; }
    if (!VECTORISH.has(k.type) && k.type !== "ELLIPSE" && k.type !== "RECTANGLE") ok = false;
  };
  n.children.forEach(visit);
  // At least one real vector path, otherwise it is just a box.
  const anyVector = (k: SceneNode): boolean => VECTORISH.has(k.type) || (hasChildren(k) && k.children.some(anyVector));
  return ok && count >= 1 && n.children.some(anyVector);
}
function hasTextureEffect(n: SceneNode): boolean {
  const effects = (n as unknown as { effects?: readonly Effect[] | symbol }).effects;
  return Array.isArray(effects) && effects.some((e) => e.visible !== false && ((e.type as string) === "NOISE" || (e.type as string) === "TEXTURE"));
}
/** Many same-sized plain shapes (stripes, dot grids): one image is lighter and exact. */
function isPatternGroup(n: SceneNode): boolean {
  if (!hasChildren(n)) return false;
  const kids = n.children.filter((k) => k.visible !== false);
  if (kids.length < 24) return false;
  const ws: number[] = [], hs: number[] = [];
  for (const k of kids) {
    if (hasChildren(k) || k.type === "TEXT" || hasFillType(k, "IMAGE") || hasFillType(k, "VIDEO")) return false;
    if (!(k.type === "RECTANGLE" || k.type === "ELLIPSE" || VECTORISH.has(k.type))) return false;
    ws.push(k.width); hs.push(k.height);
  }
  // Same size within a couple of pixels (dots drawn by hand differ by a fraction).
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mw = med(ws), mh = med(hs);
  const same = kids.filter((_, i) => Math.abs(ws[i] - mw) <= 2 && Math.abs(hs[i] - mh) <= 2).length;
  return same / kids.length >= 0.8;
}

/** Row-major reading order of already-extracted children (indices). */
function readingOrderOf(children: IRNode[]): number[] | null {
  if (children.length < 2) return null;
  const idx = children.map((_, i) => i);
  idx.sort((a, b) => {
    const A = children[a].box, B = children[b].box;
    const tol = Math.max(8, Math.min(A.h, B.h) * 0.3);
    return Math.abs(A.y - B.y) < tol ? A.x - B.x : A.y - B.y;
  });
  return idx.some((v, i) => v !== i) ? idx : null;
}

function needsRaster(n: SceneNode): boolean {
  if (!hasChildren(n)) return false;
  if (n.children.some((k) => (k as unknown as { isMask?: boolean }).isMask)) return true;
  if (rotationOf(n) !== 0) return true;
  return false;
}

/* -------------------------------------------------------------- main */

export async function extractNode(node: SceneNode, ctx: ExtractCtx, depth: number): Promise<IRNode | null> {
  if (node.visible === false) return null;
  ctx.count++;
  if (ctx.count % 40 === 0) ctx.progress(`Reading layers… ${ctx.count}`);

  const type = TYPE_MAP[node.type] || "other";
  const box = absBox(node, ctx.frameAbs);
  const rbox = renderBox(node, ctx.frameAbs);
  const op = (node as unknown as { opacity?: number }).opacity;
  const ir: IRNode = {
    id: node.id, name: node.name, type,
    visible: true,
    opacity: typeof op === "number" ? r2(op) : 1,
    blendMode: String((node as unknown as { blendMode?: string }).blendMode || "PASS_THROUGH").toLowerCase().replace(/_/g, "-"),
    box, renderBox: rbox,
    size: { w: r2(node.width), h: r2(node.height) },
    rotation: rotationOf(node),
    layout: layoutOf(node),
    sizing: sizingOf(node),
    positioning: (node as unknown as { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE" ? "absolute" : "auto",
    constraints: constraintsOf(node),
    grow: r2((node as unknown as { layoutGrow?: number }).layoutGrow || 0),
    alignSelf: (node as unknown as { layoutAlign?: string }).layoutAlign === "STRETCH" ? "stretch" : "auto",
    fills: fillsOf(node),
    stroke: strokeOf(node),
    radius: radiusOf(node),
    effects: effectsOf(node),
    clips: !!(node as unknown as { clipsContent?: boolean }).clipsContent,
    isMask: !!(node as unknown as { isMask?: boolean }).isMask,
    text: null, asset: null, fillAsset: null, component: null, interactions: [], readingOrder: null, children: [],
  };

  if (node.type === "TEXT") ir.text = textOf(node, ctx);

  if (node.type === "INSTANCE") {
    try {
      const main = await node.getMainComponentAsync();
      const props: Record<string, string> = {};
      try { for (const [k, v] of Object.entries(node.componentProperties || {})) props[k.replace(/#.*$/, "")] = String((v as { value: unknown }).value); } catch { /* none */ }
      ir.component = { name: main?.name || node.name, setName: main?.parent?.type === "COMPONENT_SET" ? main.parent.name : null, props };
    } catch { ir.component = { name: node.name, setName: null, props: {} }; }
  }

  try { ir.interactions = await interactionsOf(node); } catch { /* skip */ }

  // Prototype states: a "Change to" reaction names the exact variant the node
  // becomes on hover/press. Extract that variant like any node; the compiler
  // diffs the two trees into :hover / :active rules. Only variants of the same
  // component set (a swap to something else entirely is a navigation).
  if (node.type === "INSTANCE" && ir.interactions.some((i) => i.destinationId && i.action === "style")) {
    try {
      const main = await node.getMainComponentAsync();
      const setId = main?.parent?.type === "COMPONENT_SET" ? main.parent.id : null;
      for (const i of ir.interactions) {
        if (!i.destinationId || i.action !== "style" || (i.trigger !== "hover" && i.trigger !== "press")) continue;
        const dest = await figma.getNodeByIdAsync(i.destinationId);
        if (!dest || dest.type !== "COMPONENT" || !setId || dest.parent?.id !== setId) continue;
        if (ir.states?.[i.trigger]) continue;
        const sub = await extractNode(dest as SceneNode, { ...ctx, rasterIds: new Set(), progress: () => {} }, depth + 1);
        if (sub) { ir.states = ir.states || {}; ir.states[i.trigger] = sub; }
      }
    } catch (e) { console.warn("state extraction failed for", node.name, e); }
  }

  // ---- what gets bytes ---------------------------------------------------
  const kids = hasChildren(node) ? node.children.filter((c) => c.visible !== false) : [];
  const forced = ctx.rasterIds.has(node.id);
  const imageFill = hasFillType(node, "IMAGE");
  const videoFill = hasFillType(node, "VIDEO");
  let flatten = false; // do not descend

  if (forced) {
    const rec = await exportNode(node, ctx.assets, "image");
    if (rec) { ir.asset = rec.id; flatten = true; ctx.exported++; }
  } else if (VECTORISH.has(node.type) || (node.type === "ELLIPSE" && !imageFill)) {
    // Noise / texture effects export as multi-megabyte SVG paths that browsers
    // truncate; those vectors are better served as PNG.
    let rec = hasTextureEffect(node) ? null : await exportNode(node, ctx.assets, "svg");
    if (rec && rec.bytes.length > 200_000) { ctx.assets.delete(rec.id); rec = null; }
    if (!rec) rec = await exportNode(node, ctx.assets, "image");
    if (rec) { ir.asset = rec.id; ctx.exported++; }
    flatten = true;
  } else if (videoFill && !kids.length) {
    const rec = await exportNode(node, ctx.assets, "video-poster");
    if (rec) { ir.asset = rec.id; ctx.exported++; }
  } else if (imageFill && !kids.length) {
    const rec = await exportNode(node, ctx.assets, "image");
    if (rec) { ir.asset = rec.id; ctx.exported++; }
  } else if ((imageFill || videoFill) && kids.length) {
    const rec = await exportFill(node, ctx.assets);
    if (rec) { ir.fillAsset = rec.id; ctx.exported++; }
  } else if (kids.length && needsRaster(node)) {
    const rec = await exportNode(node, ctx.assets, "image");
    if (rec) { ir.asset = rec.id; ctx.exported++; }
    // keep children so the planner can still see what is inside
  } else if (kids.length && isIconGroup(node)) {
    const rec = (await exportNode(node, ctx.assets, "svg")) || (await exportNode(node, ctx.assets, "image"));
    if (rec) { ir.asset = rec.id; ctx.exported++; }
  } else if (kids.length && isPatternGroup(node)) {
    const rec = await exportNode(node, ctx.assets, "image");
    if (rec) { ir.asset = rec.id; ctx.exported++; }
    // children stay in the IR: the compiler may rebuild regular stripes as a gradient
  }

  if (!flatten) {
    for (const k of kids) {
      const c = await extractNode(k, ctx, depth + 1);
      if (c) ir.children.push(c);
    }
    if (!ir.layout) ir.readingOrder = readingOrderOf(ir.children);
  }
  return ir;
}
