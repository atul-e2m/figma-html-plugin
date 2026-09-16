/** IR facts -> CSS declarations. Pure functions, no layout decisions. */
import type { IRNode, IRFill, IRStroke, IREffect, IRTextSegment, IRAsset } from "../ir/schema.ts";

export type Style = Record<string, string>;
export const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** Multiply a css colour's alpha ("#rrggbb" | "rgba(...)") by `mult`. */
export function withAlpha(color: string, mult: number): string {
  if (mult >= 0.999) return color;
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Math.round(mult * 1000) / 1000})`;
  }
  const r = color.match(/^rgba?\(([^)]+)\)$/);
  if (r) {
    const p = r[1].split(",").map((s) => parseFloat(s.trim()));
    const a = (p[3] ?? 1) * mult;
    return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${Math.round(a * 1000) / 1000})`;
  }
  return color;
}

/**
 * A CSS linear gradient always spans the whole box along its angle. Figma's
 * gradient line can start and end anywhere, so the stop positions are remapped
 * onto the CSS line (box aspect matters; the caller passes it when known).
 */
export function gradientCss(f: Extract<IRFill, { type: "gradient" }>, box?: { w: number; h: number }): string {
  let positions = f.stops.map((s) => s.position);
  if (f.kind === "linear" && f.start && f.end && box && box.w > 0 && box.h > 0) {
    const [sx, sy] = [f.start[0] * box.w, f.start[1] * box.h], [ex, ey] = [f.end[0] * box.w, f.end[1] * box.h];
    const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
    if (len > 0.5) {
      // Unit direction of Figma's line; the CSS line through the box centre with
      // the same direction has length |w·ux| + |h·uy| and starts at the corner side.
      const ux = dx / len, uy = dy / len;
      const L = Math.abs(box.w * ux) + Math.abs(box.h * uy);
      const cx = box.w / 2, cy = box.h / 2;
      const proj = (x: number, y: number) => (x - cx) * ux + (y - cy) * uy + L / 2; // 0..L along the CSS line
      const p0 = proj(sx, sy), p1 = proj(ex, ey);
      positions = f.stops.map((s) => (p0 + s.position * (p1 - p0)) / L);
      // Clamp with the outer colours held (CSS extends the end stops anyway).
      positions = positions.map((p) => Math.max(-1, Math.min(2, p)));
    }
  }
  const stops = f.stops.map((s, i) => `${withAlpha(s.color, f.opacity)} ${Math.round(positions[i] * 1000) / 10}%`).join(", ");
  const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
  if (f.kind === "radial" || f.kind === "diamond") {
    if (f.center && f.radii) return `radial-gradient(ellipse ${pct(f.radii[0])} ${pct(f.radii[1])} at ${pct(f.center[0])} ${pct(f.center[1])}, ${stops})`;
    return `radial-gradient(circle, ${stops})`;
  }
  if (f.kind === "angular") return `conic-gradient(from ${f.angle}deg${f.center ? ` at ${pct(f.center[0])} ${pct(f.center[1])}` : ""}, ${stops})`;
  return `linear-gradient(${f.angle}deg, ${stops})`;
}

export interface Background {
  color?: string;
  /** Top-first CSS layers; "IMAGE" marks where the exported image goes. */
  layers: string[];
  /** Blend mode per layer, same order as `layers`. */
  blends: string[];
  hasImage: boolean;
  hasVideo: boolean;
  imageMode: "cover" | "contain" | "tile";
}

/**
 * Figma paints fills bottom-to-top. CSS background-color is always below every
 * background-image, so only the lowest solid may become background-color; every
 * fill above it becomes an image layer (solids as flat gradients).
 */
export function backgroundOf(fills: IRFill[], box?: { w: number; h: number }): Background {
  const out: Background = { layers: [], blends: [], hasImage: false, hasVideo: false, imageMode: "cover" };
  const bottomUp: string[] = []; const blendsUp: string[] = [];
  fills.forEach((f, i) => {
    const blend = (f as { blend?: string }).blend || "normal";
    if (f.type === "solid") {
      const c = withAlpha(f.color, f.opacity);
      if (i === 0 && blend === "normal") out.color = c; else { bottomUp.push(`linear-gradient(${c}, ${c})`); blendsUp.push(blend); }
    } else if (f.type === "gradient") { bottomUp.push(gradientCss(f, box)); blendsUp.push(blend); }
    else if (f.type === "image") { out.hasImage = true; bottomUp.push("IMAGE"); blendsUp.push(blend); out.imageMode = f.scaleMode === "fit" ? "contain" : f.scaleMode === "tile" ? "tile" : "cover"; }
    else if (f.type === "video") out.hasVideo = true;
  });
  out.layers = bottomUp.reverse(); out.blends = blendsUp.reverse();
  return out;
}

export function applyBackground(s: Style, bg: Background, imageUrl: string | null): void {
  if (bg.color) s["background-color"] = bg.color;
  let layers = bg.layers, blends = bg.blends.length === bg.layers.length ? bg.blends : bg.layers.map(() => "normal");
  if (imageUrl && !layers.includes("IMAGE")) { layers = [...layers, "IMAGE"]; blends = [...blends, "normal"]; }
  if (!imageUrl) { blends = blends.filter((_, i) => layers[i] !== "IMAGE"); layers = layers.filter((l) => l !== "IMAGE"); }
  if (!layers.length) return;
  s["background-image"] = layers.map((l) => (l === "IMAGE" ? `url("${imageUrl}")` : l)).join(", ");
  if (blends.some((b) => b !== "normal")) s["background-blend-mode"] = blends.join(", ");
  if (imageUrl) {
    s["background-size"] = layers.map((l) => (l === "IMAGE" ? (bg.imageMode === "tile" ? "auto" : bg.imageMode) : "auto")).join(", ");
    s["background-position"] = "center";
    s["background-repeat"] = bg.imageMode === "tile" ? "repeat" : "no-repeat";
  }
}

export function applyStroke(s: Style, st: IRStroke | null, isLineLike: boolean, strokesInLayout = false): void {
  if (!st) return;
  const style = st.dash.length ? "dashed" : "solid";
  if (isLineLike) return; // handled by the caller (height = weight, background = colour)
  if (st.align === "inside") {
    // An inside stroke paints over the padding and takes no layout space in
    // Figma (unless strokesIncludedInLayout). A CSS border would grow a hug box
    // and push the content inward, so paint it as an inset shadow instead.
    if (st.dash.length || strokesInLayout) {
      if (st.weights) {
        const [t, r, b, l] = st.weights;
        s["border-style"] = style; s["border-color"] = st.color;
        s["border-width"] = `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
      } else s["border"] = `${px(st.weight)} ${style} ${st.color}`;
    } else if (st.weights) {
      const [t, r, b, l] = st.weights;
      const parts: string[] = [];
      if (t) parts.push(`inset 0 ${px(t)} 0 0 ${st.color}`);
      if (r) parts.push(`inset ${px(-r)} 0 0 0 ${st.color}`);
      if (b) parts.push(`inset 0 ${px(-b)} 0 0 ${st.color}`);
      if (l) parts.push(`inset ${px(l)} 0 0 0 ${st.color}`);
      s["box-shadow"] = parts.join(", ");
    } else s["box-shadow"] = `inset 0 0 0 ${px(st.weight)} ${st.color}`;
  } else if (st.align === "outside") {
    s["box-shadow"] = `0 0 0 ${px(st.weight)} ${st.color}`;
  } else {
    const half = st.weight / 2;
    s["box-shadow"] = `0 0 0 ${px(half)} ${st.color}, inset 0 0 0 ${px(half)} ${st.color}`;
  }
}

export function applyEffects(s: Style, effects: IREffect[]): void {
  const shadows: string[] = [];
  for (const e of effects) {
    if (e.type === "drop-shadow" || e.type === "inner-shadow") {
      shadows.push(`${e.type === "inner-shadow" ? "inset " : ""}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${e.color}`);
    } else if (e.type === "blur") s["filter"] = `blur(${px(e.radius)})`;
    else if (e.type === "backdrop-blur") { s["backdrop-filter"] = `blur(${px(e.radius)})`; s["-webkit-backdrop-filter"] = `blur(${px(e.radius)})`; }
  }
  if (shadows.length) s["box-shadow"] = s["box-shadow"] ? `${s["box-shadow"]}, ${shadows.join(", ")}` : shadows.join(", ");
}

export function radiusCss(r: IRNode["radius"]): string | undefined {
  if (!r) return undefined;
  const [tl, tr, br, bl] = r;
  if (tl === tr && tr === br && br === bl) return px(tl);
  return `${px(tl)} ${px(tr)} ${px(br)} ${px(bl)}`;
}

/** CSS for one text segment. `base` = the element's own segment (deltas only when given). */
export function segmentCss(seg: IRTextSegment, base?: IRTextSegment): Style {
  const s: Style = {};
  const set = (k: string, v: string | undefined, bv?: string | undefined) => { if (v !== undefined && (!base || v !== bv)) s[k] = v; };
  const fam = (x: IRTextSegment) => `"${x.fontFamily}", ${genericFor(x.fontFamily)}`;
  set("font-family", fam(seg), base && fam(base));
  set("font-weight", String(seg.fontWeight), base && String(base.fontWeight));
  set("font-style", seg.italic ? "italic" : "normal", base && (base.italic ? "italic" : "normal"));
  set("font-size", px(seg.fontSize), base && px(base.fontSize));
  const lh = (x: IRTextSegment) => x.lineHeight.unit === "px" ? px(x.lineHeight.value) : x.lineHeight.unit === "percent" ? String(Math.round(x.lineHeight.value) / 100) : "normal";
  set("line-height", lh(seg), base && lh(base));
  const ls = (x: IRTextSegment) => x.letterSpacing.value === 0 ? "normal" : x.letterSpacing.unit === "px" ? px(x.letterSpacing.value) : `${Math.round(x.letterSpacing.value * 1000) / 100000}em`;
  set("letter-spacing", ls(seg), base && ls(base));
  set("color", seg.color || undefined, base ? base.color || undefined : undefined);
  const tt = (x: IRTextSegment) => x.textCase === "upper" ? "uppercase" : x.textCase === "lower" ? "lowercase" : x.textCase === "title" ? "capitalize" : "none";
  set("text-transform", tt(seg), base && tt(base));
  const td = (x: IRTextSegment) => x.decoration === "underline" ? "underline" : x.decoration === "strikethrough" ? "line-through" : "none";
  set("text-decoration", td(seg), base && td(base));
  if (!base) {
    // Defaults the element does not need to state explicitly.
    if (s["font-style"] === "normal") delete s["font-style"];
    if (s["letter-spacing"] === "normal") delete s["letter-spacing"];
    if (s["text-transform"] === "none") delete s["text-transform"];
    if (s["text-decoration"] === "none") delete s["text-decoration"];
    if (s["line-height"] === "normal") delete s["line-height"];
  }
  return s;
}

const SERIF = /(serif|garamond|georgia|times|playfair|merriweather|lora|baskerville|cormorant|libre caslon|crimson)/i;
const MONO = /(mono|code|courier|consolas|menlo)/i;
export function genericFor(family: string): string {
  if (MONO.test(family)) return "monospace";
  if (SERIF.test(family) && !/sans/i.test(family)) return "serif";
  return "sans-serif";
}

export function assetUrl(a: IRAsset | undefined, prefix: string): string | null {
  return a ? `${prefix}${a.file}` : null;
}
