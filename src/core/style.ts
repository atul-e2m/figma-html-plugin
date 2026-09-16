import { IRStyle, RGBA } from "./types";

export const px = (n: number): string =>
  `${Math.round(n * 100) / 100}px`;

export function rgbaToCss(c: RGBA, opacity = 1): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = (c.a ?? 1) * opacity;
  if (a >= 0.999) {
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

function gradientToCss(paint: GradientPaint): string {
  // The paint's own opacity multiplies every stop (a 30% black overlay).
  const op = paint.opacity ?? 1;
  const stops = paint.gradientStops
    .map((s) => `${rgbaToCss(s.color as RGBA, op)} ${Math.round(s.position * 1000) / 10}%`)
    .join(", ");
  // Derive angle from the gradient transform matrix.
  const m = paint.gradientTransform;
  // gradientTransform maps node space -> gradient space (the inverse of the
  // drawing direction), so read the rotation from the transposed cell.
  const angle = Math.round((Math.atan2(m[0][1], m[0][0]) * 180) / Math.PI + 90);
  if (paint.type === "GRADIENT_RADIAL") return `radial-gradient(circle, ${stops})`;
  if (paint.type === "GRADIENT_ANGULAR") return `conic-gradient(from ${angle}deg, ${stops})`;
  return `linear-gradient(${angle}deg, ${stops})`;
}

/** Solid fill -> color. Returns null when the fill is not a usable solid. */
export function solidFill(fills: readonly Paint[] | symbol): string | null {
  if (typeof fills === "symbol" || !Array.isArray(fills)) return null;
  for (const p of fills) {
    if (p.visible === false) continue;
    if (p.type === "SOLID") return rgbaToCss(p.color as RGBA, p.opacity ?? 1);
  }
  return null;
}

/** Background from fills: solid color, gradient, or image marker. */
/**
 * Figma paints fills bottom-to-top in array order: an image with a 60% dark
 * solid ABOVE it is the classic hero. CSS `background-color` always paints
 * below `background-image`, so every fill above the lowest one becomes an
 * image layer (solids as flat gradients). `layers` is top-first, CSS order;
 * the token "IMAGE" marks where the exported image url goes.
 */
export function backgroundFromFills(
  fills: readonly Paint[] | symbol
): { backgroundColor?: string; backgroundImage?: string; layers: string[]; hasImage: boolean; hasVideo: boolean } {
  const out: { backgroundColor?: string; backgroundImage?: string; layers: string[]; hasImage: boolean; hasVideo: boolean } =
    { layers: [], hasImage: false, hasVideo: false };
  if (typeof fills === "symbol" || !Array.isArray(fills)) return out;
  const vis = fills.filter((p) => p.visible !== false);
  const bottomUp: string[] = [];
  vis.forEach((p, i) => {
    if (p.type === "SOLID") {
      const c = rgbaToCss(p.color as RGBA, p.opacity ?? 1);
      if (i === 0) out.backgroundColor = c; else bottomUp.push(`linear-gradient(${c}, ${c})`);
    } else if (p.type.startsWith("GRADIENT")) bottomUp.push(gradientToCss(p as GradientPaint));
    else if (p.type === "IMAGE") { out.hasImage = true; bottomUp.push("IMAGE"); }
    else if ((p.type as string) === "VIDEO") { out.hasVideo = true; }
  });
  out.layers = bottomUp.reverse();
  const nonImage = out.layers.filter((l) => l !== "IMAGE");
  if (nonImage.length && !out.hasImage) out.backgroundImage = nonImage.join(", ");
  return out;
}

export function effectsToCss(effects: readonly Effect[] | symbol): {
  boxShadow?: string; filter?: string; backdropFilter?: string;
} {
  const out: { boxShadow?: string; filter?: string; backdropFilter?: string } = {};
  if (typeof effects === "symbol" || !Array.isArray(effects)) return out;
  const shadows: string[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const s = e as DropShadowEffect;
      const inset = e.type === "INNER_SHADOW" ? "inset " : "";
      shadows.push(
        `${inset}${px(s.offset.x)} ${px(s.offset.y)} ${px(s.radius)} ${px(s.spread ?? 0)} ${rgbaToCss(s.color as RGBA)}`
      );
    } else if (e.type === "LAYER_BLUR") {
      out.filter = `blur(${px((e as BlurEffect).radius)})`;
    } else if (e.type === "BACKGROUND_BLUR") {
      out.backdropFilter = `blur(${px((e as BlurEffect).radius)})`;
    }
  }
  if (shadows.length) out.boxShadow = shadows.join(", ");
  return out;
}

const ALIGN: Record<string, string> = {
  MIN: "flex-start", CENTER: "center", MAX: "flex-end",
  SPACE_BETWEEN: "space-between", BASELINE: "baseline",
};

/**
 * Auto-layout -> flexbox. These values are EXACT, read from Figma's resolved
 * layout engine — not inferred from coordinates.
 */
export function autoLayoutToFlex(node: FrameNode | ComponentNode | InstanceNode): IRStyle {
  const s: IRStyle = {};
  if (node.layoutMode === "NONE") return s;
  s.display = "flex";
  s.flexDirection = node.layoutMode === "VERTICAL" ? "column" : "row";
  // Figma ignores itemSpacing when the primary axis is SPACE_BETWEEN; a gap
  // here forced the header row to overflow and wrap.
  if (node.itemSpacing && node.primaryAxisAlignItems !== "SPACE_BETWEEN") s.gap = px(node.itemSpacing);
  if (node.layoutWrap === "WRAP") s.flexWrap = "wrap";

  const counter = ALIGN[node.counterAxisAlignItems] || "flex-start";
  const primary = ALIGN[node.primaryAxisAlignItems] || "flex-start";
  s.alignItems = counter;
  s.justifyContent = primary;

  // Figma lays text out at ONE width; the browser re-wraps it. A fixed-height
  // column pinned to flex-start leaves a hole when its title wraps to two
  // lines (the card footer stays put instead of hugging the bottom). Let the
  // extra height fall between the groups instead of piling up at the end.
  if (
    node.layoutMode === "VERTICAL" &&
    primary === "flex-start" &&
    node.layoutSizingVertical === "FIXED" &&
    node.children.filter((c) => c.visible !== false).length > 1
  ) {
    s.justifyContent = "space-between";
  }

  if (node.paddingTop) s.paddingTop = px(node.paddingTop);
  if (node.paddingRight) s.paddingRight = px(node.paddingRight);
  if (node.paddingBottom) s.paddingBottom = px(node.paddingBottom);
  if (node.paddingLeft) s.paddingLeft = px(node.paddingLeft);
  return s;
}

/** Sizing from layout sizing modes (HUG / FILL / FIXED). */
export function sizingToCss(node: SceneNode, canvasWidth?: number): IRStyle {
  const s: IRStyle = {};
  const n = node as LayoutMixin & { layoutSizingHorizontal?: string; layoutSizingVertical?: string; layoutGrow?: number };
  const h = n.layoutSizingHorizontal;
  const v = n.layoutSizingVertical;
  const w = "width" in node ? (node as LayoutMixin).width : 0;

  if (h === "FILL") {
    s.width = "100%";
    // NOTE: no flex-grow here. FILL is a WIDTH instruction in Figma; emitting
    // flex-grow made the node grow along its parent's MAIN axis, which in a
    // column is the height — inflating every card row. Vertical FILL is
    // handled by layoutSizingVertical below.
  } else if (h === "FIXED" && w) {
    // Figma widths are absolute; CSS widths live inside a padded parent. A
    // literal px width therefore overflows as soon as the viewport is narrower
    // than the canvas (54 elements did exactly this). Emit a fluid width with
    // the Figma value as the CAP, so layout holds at every width.
    if (canvasWidth && w >= canvasWidth - 1) {
      s.width = "100%";
      s.maxWidth = px(w);
    } else if (canvasWidth && w >= canvasWidth * 0.6) {
      // Wide content blocks: fluid, capped at the design width.
      s.width = "100%";
      s.maxWidth = px(w);
    } else {
      // Small fixed things (buttons, badges, avatars) keep their size but may
      // never exceed the space available to them.
      s.width = px(w);
      s.maxWidth = "100%";
    }
  }
  // HUG -> intrinsic; emit nothing.

  if (v === "FIXED" && "height" in node) {
    const hh = (node as LayoutMixin).height;
    const n2 = node as unknown as { fills?: readonly Paint[] };
    const kids = "children" in node ? (node as ChildrenMixin).children : [];

    // A box that PAINTS (image or colour fill) is a media/decoration box: its
    // height is the design, and it must not grow — a card photo holding a
    // small "ACTIVE" badge counted as text and grew past its 320px, adding
    // ~105px to every card.
    const paints = Array.isArray(n2.fills) && n2.fills.some(
      (f) => f.visible !== false && (f.type === "IMAGE" || f.type === "SOLID" ||
             String(f.type).startsWith("GRADIENT")));

    // Only text that can actually REFLOW justifies growing: a long string, or
    // a node Figma set to auto-height.
    const reflowable = kids.some((k) => {
      if (k.type !== "TEXT") return false;
      const t = k as TextNode;
      const chars = typeof t.characters === "string" ? t.characters : "";
      return t.textAutoResize === "HEIGHT" || chars.trim().length > 24;
    });

    if (reflowable && !paints) s.minHeight = px(hh);
    else s.height = px(hh);
  } else if (v === "FILL") {
    // FILL along the parent's CROSS axis is "match my siblings" —
    // align-self:stretch. FILL along the MAIN axis is "take the slack" —
    // flex-grow. Emitting flex-grow unconditionally made every card row in a
    // column grow vertically with nothing to constrain it (+541px on one
    // section). Only the main axis gets flex-grow.
    const parent = (node as BaseNode).parent as FrameNode | null;
    const parentIsColumn = !!parent && "layoutMode" in parent &&
      (parent as FrameNode).layoutMode === "VERTICAL";
    if (parentIsColumn) {
      // Main axis is vertical: growing is meaningful only if the parent has a
      // height to distribute. A HUG parent has none, so growing is unbounded.
      const parentFixedHeight = !!parent &&
        (parent as unknown as { layoutSizingVertical?: string }).layoutSizingVertical === "FIXED";
      if (parentFixedHeight) s.flexGrow = "1";
      else s.alignSelf = "stretch";
    } else {
      s.alignSelf = "stretch";
    }
  }
  return s;
}

export function cornerToCss(node: SceneNode): string | undefined {
  const n = node as unknown as {
    cornerRadius?: number | symbol;
    topLeftRadius?: number; topRightRadius?: number;
    bottomRightRadius?: number; bottomLeftRadius?: number;
  };
  if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) return px(n.cornerRadius);
  const tl = n.topLeftRadius ?? 0, tr = n.topRightRadius ?? 0;
  const br = n.bottomRightRadius ?? 0, bl = n.bottomLeftRadius ?? 0;
  if (tl || tr || br || bl) return `${px(tl)} ${px(tr)} ${px(br)} ${px(bl)}`;
  return undefined;
}

export function strokeToCss(node: SceneNode): string | undefined {
  const n = node as unknown as {
    strokes?: readonly Paint[]; strokeWeight?: number | symbol; dashPattern?: readonly number[];
  };
  if (!n.strokes || !Array.isArray(n.strokes) || !n.strokes.length) return undefined;
  const color = solidFill(n.strokes);
  if (!color) return undefined;
  const w = typeof n.strokeWeight === "number" ? n.strokeWeight : 1;
  if (w <= 0) return undefined;
  const style = n.dashPattern && n.dashPattern.length ? "dashed" : "solid";
  return `${px(w)} ${style} ${color}`;
}

/** Text styling — uses Figma's RESOLVED values, including wrapped height. */
export function textToCss(node: TextNode): IRStyle {
  const s: IRStyle = {};
  const fname = node.fontName;
  if (typeof fname !== "symbol") {
    s.fontFamily = `"${fname.family}", sans-serif`;
    const st = fname.style.toLowerCase();
    s.fontWeight = String(weightFromStyle(st));
    if (st.includes("italic")) s.fontStyle = "italic";
  }
  if (typeof node.fontSize === "number") s.fontSize = px(node.fontSize);

  const lh = node.lineHeight;
  if (typeof lh !== "symbol" && lh) {
    if (lh.unit === "PIXELS") s.lineHeight = px(lh.value);
    else if (lh.unit === "PERCENT") s.lineHeight = String(Math.round(lh.value) / 100);
  }
  const ls = node.letterSpacing;
  if (typeof ls !== "symbol" && ls && ls.value !== 0) {
    s.letterSpacing = ls.unit === "PIXELS" ? px(ls.value) : `${ls.value / 100}em`;
  }
  const color = solidFill(node.fills);
  if (color) s.color = color;

  const alignMap: Record<string, string> = {
    LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify",
  };
  if (node.textAlignHorizontal && node.textAlignHorizontal !== "LEFT") {
    s.textAlign = alignMap[node.textAlignHorizontal];
  }
  const tcase = node.textCase;
  if (typeof tcase !== "symbol" && tcase && tcase !== "ORIGINAL") {
    s.textTransform = tcase === "UPPER" ? "uppercase"
      : tcase === "LOWER" ? "lowercase" : "capitalize";
  }
  const tdec = node.textDecoration;
  if (typeof tdec !== "symbol" && tdec && tdec !== "NONE") {
    s.textDecoration = tdec === "UNDERLINE" ? "underline" : "line-through";
  }
  return s;
}

function weightFromStyle(style: string): number {
  if (style.includes("thin")) return 100;
  if (style.includes("extralight") || style.includes("ultralight")) return 200;
  if (style.includes("semibold") || style.includes("demibold")) return 600;
  if (style.includes("extrabold") || style.includes("ultrabold")) return 800;
  if (style.includes("black") || style.includes("heavy")) return 900;
  if (style.includes("light")) return 300;
  if (style.includes("medium")) return 500;
  if (style.includes("bold")) return 700;
  return 400;
}

export function styleToCssText(s: IRStyle, indent = "  "): string {
  const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  return Object.keys(s)
    .filter((k) => (s as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${indent}${kebab(k)}: ${(s as Record<string, string>)[k]};`)
    .join("\n");
}
