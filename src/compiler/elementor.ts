/**
 * Element tree -> Elementor Editor V4 (atomic elements) template JSON.
 *
 * Same input as the HTML emitter: the resolved `El` tree from resolve.ts with the
 * responsive baseline applied. Every El becomes one atomic element:
 *
 *   container            -> e-flexbox (display from the style) / e-grid
 *   h1..h6               -> widget e-heading
 *   p / span / a (text)  -> widget e-paragraph (+ link)
 *   a / button with box  -> widget e-button
 *   img                  -> widget e-image
 *   svg                  -> widget e-svg (file written next to the assets)
 *
 * Styles are V4 "local classes": one style definition per element with a desktop
 * variant, a hover variant and tablet / mobile variants (Elementor's default
 * breakpoints (laptop 1366, tablet_extra 1200, tablet 1024, mobile_extra 880, mobile 767) are the buckets responsive.ts
 * emits). Every CSS declaration the V4 style schema can express is written as a
 * typed prop value ($$type / value) so the client can edit it in the editor.
 * Declarations the schema has no control for (white-space, text-box-trim, the
 * design-width share query, descendant hover deltas, styled text runs...) go to a
 * companion stylesheet keyed by the element's `_cssid` attribute, which survives
 * the id regeneration Elementor does on import.
 *
 * Schema source of truth: elementor/modules/atomic-widgets (4.2.x) — prop-types/,
 * styles/style-schema.php, elements/*. Verified against 4.2.3.
 */
import type { El, ResolvedFrame, Section } from "./resolve.ts";
import type { Style } from "./style.ts";
import { fontFaces, stripNoiseFilters } from "./emit.ts";

/* ------------------------------------------------------------ prop values */

export interface PV { $$type: string; value: unknown }
interface SizeVal { size: number | string; unit: string }

const str = (v: string): PV => ({ $$type: "string", value: v });
const num = (v: number): PV => ({ $$type: "number", value: v });
const bool = (v: boolean): PV => ({ $$type: "boolean", value: v });
const color = (v: string): PV => ({ $$type: "color", value: v });
const urlPV = (v: string): PV => ({ $$type: "url", value: v });
const sizePV = (s: SizeVal): PV => ({ $$type: "size", value: s });
const obj = (type: string, value: Record<string, PV | null | undefined>): PV => {
  const out: Record<string, PV> = {};
  for (const [k, v] of Object.entries(value)) if (v) out[k] = v;
  return { $$type: type, value: out };
};

const LENGTH_RE = /^(-?\d*\.?\d+)(px|%|em|rem|vw|vh|ch|vmin|vmax|deg|rad|grad|turn|ms|s|fr)?$/;

/** CSS length -> Size prop. Anything the size control cannot hold (calc, min, clamp, keywords) rides in a `custom` unit. */
function parseSize(raw: string): SizeVal {
  const v = raw.trim();
  if (v === "auto") return { size: "", unit: "auto" };
  const m = v.match(LENGTH_RE);
  if (m) {
    const n = parseFloat(m[1]);
    if (m[2]) return { size: Math.round(n * 1000) / 1000, unit: m[2] };
    if (n === 0) return { size: 0, unit: "px" };
    return { size: v, unit: "custom" }; // unitless (line-height 1.2)
  }
  return { size: v, unit: "custom" };
}
const isLength = (t: string) => LENGTH_RE.test(t.trim()) || t.trim() === "0";

/** Split on `sep` outside parentheses and quotes. */
function splitTop(v: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, cur = "", q: string | null = null;
  for (const ch of v) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 1–4 value shorthand -> [top, right, bottom, left]. */
function fourSides(v: string): [string, string, string, string] | null {
  const p = splitTop(v, " ");
  if (p.length < 1 || p.length > 4) return null;
  const [a, b = a, c = a, d = b] = p;
  return [a, b, c, d];
}

/* -------------------------------------------------------------- enums */

const ENUM: Record<string, Set<string>> = {
  display: new Set(["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "flow-root", "none", "contents"]),
  "flex-direction": new Set(["row", "row-reverse", "column", "column-reverse"]),
  "flex-wrap": new Set(["wrap", "nowrap", "wrap-reverse"]),
  "justify-content": new Set(["center", "start", "end", "flex-start", "flex-end", "left", "right", "normal", "space-between", "space-around", "space-evenly", "stretch"]),
  "justify-items": new Set(["normal", "stretch", "center", "start", "end", "flex-start", "flex-end", "left", "right", "anchor-center"]),
  "align-content": new Set(["center", "start", "end", "space-between", "space-around", "space-evenly"]),
  "align-items": new Set(["normal", "stretch", "center", "start", "end", "flex-start", "flex-end", "self-start", "self-end", "anchor-center"]),
  "align-self": new Set(["auto", "normal", "center", "start", "end", "self-start", "self-end", "flex-start", "flex-end", "anchor-center", "baseline", "first baseline", "last baseline", "stretch"]),
  position: new Set(["static", "relative", "absolute", "fixed", "sticky"]),
  overflow: new Set(["visible", "hidden", "auto"]),
  "object-fit": new Set(["fill", "cover", "contain", "none", "scale-down"]),
  "font-style": new Set(["normal", "italic", "oblique"]),
  "text-transform": new Set(["none", "capitalize", "uppercase", "lowercase"]),
  "text-align": new Set(["start", "center", "end", "justify"]),
  "font-weight": new Set(["100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold", "bolder", "lighter"]),
  "mix-blend-mode": new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "saturation", "color", "difference", "exclusion", "hue", "luminosity", "soft-light", "hard-light", "color-burn"]),
  "border-style": new Set(["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]),
  "grid-auto-flow": new Set(["row", "column", "row dense", "column dense"]),
  direction: new Set(["ltr", "rtl"]),
  cursor: new Set(["pointer"]),
  appearance: new Set(["none", "auto"]),
};
const STRING_PROPS = new Set(["text-decoration", "aspect-ratio", "clip-path", "content", "grid-template-columns", "grid-template-rows"]);
const SIZE_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "font-size", "letter-spacing", "word-spacing", "line-height", "scroll-margin-top", "outline-width", "outline-offset"]);
const NUMBER_PROPS = new Set(["z-index", "order", "column-count"]);
const COLOR_PROPS = new Set(["color", "border-color", "outline-color"]);
const POSITION_KEYWORDS = new Set(["center center", "center left", "center right", "top center", "top left", "top right", "bottom center", "bottom left", "bottom right"]);

const SIDE = { top: "block-start", right: "inline-end", bottom: "block-end", left: "inline-start" } as const;

/* ------------------------------------------------------------ converters */

interface Converted { props: Record<string, PV>; rest: Style }

/** `linear-gradient(...)` -> gradient overlay, or null when the schema cannot hold it (radial with radii, conic). */
function parseGradient(v: string): PV | null {
  const m = v.match(/^linear-gradient\((.*)\)$/s);
  if (!m) return null;
  const parts = splitTop(m[1], ",");
  let angle = 180;
  const first = parts[0].trim();
  const dir = first.match(/^(-?\d*\.?\d+)deg$/) ? parseFloat(first) : first.startsWith("to ")
    ? ({ "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 } as Record<string, number>)[first] : NaN;
  if (!Number.isNaN(dir)) { angle = dir; parts.shift(); } else if (first.startsWith("to ")) return null;
  const stops: PV[] = [];
  parts.forEach((p, i) => {
    const toks = splitTop(p, " ");
    const pct = toks.length > 1 && /%$/.test(toks[toks.length - 1]) ? parseFloat(toks.pop()!) : (parts.length === 1 ? 0 : (i / (parts.length - 1)) * 100);
    stops.push(obj("color-stop", { color: color(toks.join(" ")), offset: num(Math.round(pct * 100) / 100) }));
  });
  if (!stops.length) return null;
  return obj("background-gradient-overlay", { type: str("linear"), angle: num(Math.round(angle)), stops: { $$type: "gradient-color-stop", value: stops } });
}

function parsePosition(v: string): PV | null {
  const t = splitTop(v, " ");
  const kw = (a: string) => ["top", "bottom", "left", "right", "center"].includes(a);
  if (t.length === 1) {
    if (t[0] === "center") return str("center center");
    if (t[0] === "top" || t[0] === "bottom") return str(`${t[0]} center`);
    if (t[0] === "left" || t[0] === "right") return str(`center ${t[0]}`);
    if (isLength(t[0])) return obj("background-image-position-offset", { x: sizePV(parseSize(t[0])), y: sizePV({ size: 50, unit: "%" }) });
    return null;
  }
  if (t.length === 2) {
    if (kw(t[0]) && kw(t[1])) {
      const vert = t.find((a) => a === "top" || a === "bottom"), horiz = t.find((a) => a === "left" || a === "right");
      const s = `${vert || "center"} ${horiz || "center"}`;
      return POSITION_KEYWORDS.has(s) ? str(s) : null;
    }
    if (isLength(t[0]) && isLength(t[1])) return obj("background-image-position-offset", { x: sizePV(parseSize(t[0])), y: sizePV(parseSize(t[1])) });
  }
  return null;
}
function parseBgSize(v: string): PV | null {
  const t = splitTop(v, " ");
  if (t.length === 1 && ["cover", "contain", "auto"].includes(t[0])) return str(t[0]);
  if (t.every((a) => a === "auto")) return str("auto");
  if (t.length <= 2 && t.every((a) => a === "auto" || isLength(a))) return obj("background-image-size-scale", { width: sizePV(parseSize(t[0])), height: sizePV(parseSize(t[1] || "auto")) });
  return null;
}

function parseShadow(v: string): PV | null {
  const toks = splitTop(v, " ");
  let inset = false; const lengths: string[] = []; let col = "";
  for (const t of toks) {
    if (t === "inset") inset = true;
    else if (isLength(t)) lengths.push(t);
    else col = col ? `${col} ${t}` : t;
  }
  if (lengths.length < 2) return null;
  const [h, vv, blur = "0", spread = "0"] = lengths;
  return obj("shadow", {
    hOffset: sizePV(parseSize(h)), vOffset: sizePV(parseSize(vv)), blur: sizePV(parseSize(blur)), spread: sizePV(parseSize(spread)),
    color: color(col || "rgba(0, 0, 0, 1)"), position: inset ? str("inset") : undefined,
  });
}

function parseTransform(v: string): PV | null {
  if (v === "none") return null;
  const fns: PV[] = [];
  const parsed = parseFunctions(v);
  if (!parsed.length) return null;
  for (const fn of parsed) {
    const name = fn.name, args = splitTop(fn.args, ",");
    const sz = (a: string) => sizePV(parseSize(a));
    switch (name) {
      case "translate": fns.push(obj("transform-move", { x: sz(args[0]), y: args[1] ? sz(args[1]) : undefined })); break;
      case "translateX": fns.push(obj("transform-move", { x: sz(args[0]) })); break;
      case "translateY": fns.push(obj("transform-move", { y: sz(args[0]) })); break;
      case "translate3d": fns.push(obj("transform-move", { x: sz(args[0]), y: sz(args[1]), z: sz(args[2]) })); break;
      case "rotate": fns.push(obj("transform-rotate", { z: sz(args[0]) })); break;
      case "rotateX": fns.push(obj("transform-rotate", { x: sz(args[0]) })); break;
      case "rotateY": fns.push(obj("transform-rotate", { y: sz(args[0]) })); break;
      case "scale": fns.push(obj("transform-scale", { x: num(parseFloat(args[0])), y: num(parseFloat(args[1] ?? args[0])) })); break;
      case "scaleX": fns.push(obj("transform-scale", { x: num(parseFloat(args[0])) })); break;
      case "scaleY": fns.push(obj("transform-scale", { y: num(parseFloat(args[0])) })); break;
      default: return null; // skew, matrix, perspective: companion CSS
    }
  }
  if (!fns.length) return null;
  return obj("transform", { "transform-functions": { $$type: "transform-functions", value: fns } });
}

/** `name(args)` list with balanced parentheses (nested functions such as `drop-shadow(… rgba(…))`). */
function parseFunctions(v: string): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  let i = 0;
  while (i < v.length) {
    const m = v.slice(i).match(/^\s*([a-zA-Z][a-zA-Z0-9-]*)\(/);
    if (!m) break;
    let j = i + m[0].length, depth = 1;
    const start = j;
    while (j < v.length && depth > 0) { if (v[j] === "(") depth++; else if (v[j] === ")") depth--; j++; }
    if (depth !== 0) break;
    out.push({ name: m[1], args: v.slice(start, j - 1).trim() });
    i = j;
  }
  return out;
}

/** `rgb()` / `rgba()` -> `#rrggbb[aa]`, so a colour never nests inside another CSS function.
 *  An unbalanced parenthesis in one declaration swallows the rest of Elementor's stylesheet. */
export function hexColor(c: string): string {
  const m = c.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i);
  if (!m) return c;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return `#${h(+m[1])}${h(+m[2])}${h(+m[3])}${a >= 0.999 ? "" : h(a * 255)}`;
}

function parseFilter(v: string, type: "filter" | "backdrop-filter"): PV | null {
  const items: PV[] = [];
  const fns = parseFunctions(v);
  if (!fns.length) return null;
  for (const { name, args } of fns) {
    if (name === "blur") items.push(obj("css-filter-func", { func: str("blur"), args: obj("blur", { size: sizePV(parseSize(args)) }) }));
    else if (name === "drop-shadow") {
      const toks = splitTop(args, " "); const lengths = toks.filter(isLength); const col = toks.filter((t) => !isLength(t)).join(" ");
      if (lengths.length < 2) return null;
      items.push(obj("css-filter-func", { func: str("drop-shadow"), args: obj("drop-shadow", { xAxis: sizePV(parseSize(lengths[0])), yAxis: sizePV(parseSize(lengths[1])), blur: sizePV(parseSize(lengths[2] || "0")), color: color(hexColor(col || "#000000")) }) }));
    } else return null; // brightness/contrast/...: their arg prop keys are not verified yet
  }
  if (!items.length) return null;
  return { $$type: type, value: items };
}

function parseTransition(v: string): PV | null {
  const items = splitTop(v, ",");
  let dur = "";
  for (const it of items) {
    const toks = splitTop(it, " ");
    if (toks[0] !== "all") return null; // V4 (free) only transitions `all`
    dur = toks.find((t) => /^\d*\.?\d+m?s$/.test(t)) || dur;
  }
  if (!dur) return null;
  return { $$type: "transition", value: [obj("selection-size", {
    selection: obj("key-value", { key: str("All properties"), value: str("all") }), size: sizePV(parseSize(dur)),
  })] };
}

interface BgLayer { kind: "image" | "gradient"; src?: string; grad?: PV; size?: string; position?: string; repeat?: string; attachment?: string }

/**
 * CSS declarations -> V4 style props. Whatever cannot be expressed stays in `rest`
 * for the companion stylesheet. `assetUrl` turns a relative asset path into the
 * public URL the import will download from.
 */
export function convertStyle(st: Style, assetUrl: (rel: string) => string): Converted {
  const props: Record<string, PV> = {}; const rest: Style = {};
  const dims: Record<"padding" | "margin", Partial<Record<string, string>>> = { padding: {}, margin: {} };
  const radius: Partial<Record<string, string>> = {}; const bwidth: Partial<Record<string, string>> = {};
  const gap: { row?: string; column?: string } = {}; const flex: { grow?: string; shrink?: string; basis?: string } = {};
  const inset: Partial<Record<string, string>> = {};
  const bg: { color?: string; layers: BgLayer[]; sizes?: string[]; positions?: string[]; repeats?: string[]; attachments?: string[]; clip?: string; failed?: boolean } = { layers: [] };
  let border: { width?: string; style?: string; color?: string } = {};

  // Shorthands first so longhands override them whatever the source order.
  const keys = Object.keys(st).filter((k) => st[k] !== undefined && st[k] !== "");
  const order = (k: string) => (/^(padding|margin|inset|border|border-radius|border-width|gap|flex|background|background-image|transition)$/.test(k) ? 0 : 1);
  keys.sort((a, b) => order(a) - order(b));

  for (const k of keys) {
    const v = String(st[k]).trim();
    const fail = () => { rest[k] = v; };
    if (k === "padding" || k === "margin") { const s = fourSides(v); if (!s) { fail(); continue; } dims[k] = { top: s[0], right: s[1], bottom: s[2], left: s[3] }; continue; }
    let m = k.match(/^(padding|margin)-(top|right|bottom|left)$/);
    if (m) { dims[m[1] as "padding"][m[2]] = v; continue; }
    if (k === "inset") { const s = fourSides(v); if (!s) { fail(); continue; } inset.top = s[0]; inset.right = s[1]; inset.bottom = s[2]; inset.left = s[3]; continue; }
    if (k === "top" || k === "right" || k === "bottom" || k === "left") { inset[k] = v; continue; }
    if (k === "border-radius") {
      if (v.includes("/")) { fail(); continue; }
      const s = fourSides(v); if (!s) { fail(); continue; }
      radius["start-start"] = s[0]; radius["start-end"] = s[1]; radius["end-end"] = s[2]; radius["end-start"] = s[3]; continue;
    }
    m = k.match(/^border-(top|bottom)-(left|right)-radius$/);
    if (m) { radius[`${m[1] === "top" ? "start" : "end"}-${m[2] === "left" ? "start" : "end"}`] = v; continue; }
    if (k === "border") {
      if (v === "0" || v === "none") { border = { width: "0", style: "none" }; continue; }
      const toks = splitTop(v, " "); const b: typeof border = {};
      for (const t of toks) { if (isLength(t)) b.width = t; else if (ENUM["border-style"].has(t)) b.style = t; else b.color = b.color ? `${b.color} ${t}` : t; }
      if (!b.width && !b.style) { fail(); continue; }
      border = { ...border, ...b }; continue;
    }
    if (k === "border-width") { const s = fourSides(v); if (!s) { fail(); continue; } bwidth.top = s[0]; bwidth.right = s[1]; bwidth.bottom = s[2]; bwidth.left = s[3]; continue; }
    m = k.match(/^border-(top|right|bottom|left)-width$/);
    if (m) { bwidth[m[1]] = v; continue; }
    if (k === "border-style") { if (ENUM["border-style"].has(v)) border.style = v; else fail(); continue; }
    if (k === "border-color") { border.color = v; continue; }
    if (k === "gap") { const p = splitTop(v, " "); if (p.length > 2) { fail(); continue; } gap.row = p[0]; gap.column = p[1] ?? p[0]; continue; }
    if (k === "row-gap") { gap.row = v; continue; }
    if (k === "column-gap") { gap.column = v; continue; }
    if (k === "flex") {
      if (v === "none") { flex.grow = "0"; flex.shrink = "0"; flex.basis = "auto"; continue; }
      if (v === "auto") { flex.grow = "1"; flex.shrink = "1"; flex.basis = "auto"; continue; }
      const p = splitTop(v, " ");
      if (p.length === 1) { if (/^\d*\.?\d+$/.test(p[0])) { flex.grow = p[0]; flex.shrink = "1"; flex.basis = "0%"; } else flex.basis = p[0]; continue; }
      if (p.length === 2) { flex.grow = p[0]; if (/^\d*\.?\d+$/.test(p[1])) flex.shrink = p[1]; else flex.basis = p[1]; continue; }
      flex.grow = p[0]; flex.shrink = p[1]; flex.basis = p[2]; continue;
    }
    if (k === "flex-grow") { flex.grow = v; continue; }
    if (k === "flex-shrink") { flex.shrink = v; continue; }
    if (k === "flex-basis") { flex.basis = v; continue; }
    if (k === "background") {
      if (v === "none" || v === "transparent") { bg.color = "transparent"; continue; }
      if (!/[( ]/.test(v)) { bg.color = v; continue; } // a plain colour
      bg.failed = true; rest[k] = v; continue;
    }
    if (k === "background-color") { bg.color = v; continue; }
    if (k === "background-image") {
      if (v === "none") continue;
      for (const layer of splitTop(v, ",")) {
        const u = layer.match(/^url\((["']?)(.*?)\1\)$/);
        if (u) { bg.layers.push({ kind: "image", src: u[2] }); continue; }
        const g = parseGradient(layer);
        if (g) { bg.layers.push({ kind: "gradient", grad: g }); continue; }
        bg.failed = true; break;
      }
      if (bg.failed) rest[k] = v;
      continue;
    }
    if (k === "background-size") { bg.sizes = splitTop(v, ","); continue; }
    if (k === "background-position") { bg.positions = splitTop(v, ","); continue; }
    if (k === "background-repeat") { bg.repeats = splitTop(v, ","); continue; }
    if (k === "background-attachment") { bg.attachments = splitTop(v, ","); continue; }
    if (k === "background-clip" || k === "-webkit-background-clip") { if (["border-box", "padding-box", "content-box", "text"].includes(v)) bg.clip = v; else fail(); continue; }
    if (k === "box-shadow") {
      if (v === "none") continue;
      const shadows = splitTop(v, ",").map(parseShadow);
      if (shadows.some((s) => !s)) { fail(); continue; }
      props["box-shadow"] = { $$type: "box-shadow", value: shadows as PV[] }; continue;
    }
    if (k === "transform") { const t = parseTransform(v); if (t) props.transform = t; else fail(); continue; }
    if (k === "filter" || k === "backdrop-filter") { const f = parseFilter(v, k); if (f) props[k] = f; else fail(); continue; }
    if (k === "-webkit-backdrop-filter") continue; // the unprefixed one carries it
    if (k === "transition") { const t = parseTransition(v); if (t) props.transition = t; else fail(); continue; }
    if (k === "opacity") { const n = parseFloat(v); if (Number.isNaN(n)) { fail(); continue; } props.opacity = sizePV({ size: Math.round(n * 1000) / 10, unit: "%" }); continue; }
    if (k === "font-family") { const fam = splitTop(v, ",")[0].replace(/^["']|["']$/g, ""); props["font-family"] = { $$type: "font-family", value: fam }; continue; }
    if (k === "text-align") { const t = v === "left" ? "start" : v === "right" ? "end" : v; if (ENUM["text-align"].has(t)) props[k] = str(t); else fail(); continue; }
    if (k === "overflow") { const t = v === "clip" ? "hidden" : v === "scroll" ? "auto" : v; if (ENUM.overflow.has(t)) props[k] = str(t); else fail(); continue; }
    if (k === "object-position") { const p = parsePosition(v); if (p) props[k] = p.$$type === "background-image-position-offset" ? { $$type: "object-position", value: p.value } : p; else fail(); continue; }
    if (ENUM[k]) { if (ENUM[k].has(v)) props[k] = str(v); else fail(); continue; }
    if (STRING_PROPS.has(k)) { props[k] = str(v); continue; }
    if (SIZE_PROPS.has(k)) { props[k] = sizePV(parseSize(v)); continue; }
    // Elementor's Styles_Renderer runs the resolved values through Collection::filter(), which drops
    // PHP-falsy values: a numeric 0 never reaches the stylesheet. `z-index: 0` still creates a stacking
    // context, so 0 goes to the companion css.
    if (NUMBER_PROPS.has(k)) { const n = parseFloat(v); if (Number.isNaN(n) || n === 0) fail(); else props[k] = num(n); continue; }
    if (COLOR_PROPS.has(k)) { props[k] = color(v); continue; }
    fail();
  }

  // Assemble the compound props.
  for (const key of ["padding", "margin"] as const) {
    const d = dims[key]; const sides = Object.keys(d);
    if (!sides.length) continue;
    const vals = sides.map((s) => d[s]!);
    if (sides.length === 4 && vals.every((x) => x === vals[0])) { props[key] = sizePV(parseSize(vals[0])); continue; }
    props[key] = obj("dimensions", Object.fromEntries(sides.map((s) => [SIDE[s as keyof typeof SIDE], sizePV(parseSize(d[s]!))])));
  }
  if (Object.keys(inset).length) for (const [s, v] of Object.entries(inset)) props[`inset-${SIDE[s as keyof typeof SIDE]}`] = sizePV(parseSize(v!));
  if (Object.keys(radius).length) {
    const vals = Object.values(radius) as string[];
    if (vals.length === 4 && vals.every((x) => x === vals[0])) props["border-radius"] = sizePV(parseSize(vals[0]));
    else props["border-radius"] = obj("border-radius-v2", Object.fromEntries(Object.entries(radius).map(([s, v]) => [s, sizePV(parseSize(v!))])));
  }
  if (border.width !== undefined) { bwidth.top = bwidth.top ?? border.width; bwidth.right = bwidth.right ?? border.width; bwidth.bottom = bwidth.bottom ?? border.width; bwidth.left = bwidth.left ?? border.width; }
  if (Object.keys(bwidth).length) {
    const vals = Object.values(bwidth) as string[];
    if (vals.length === 4 && vals.every((x) => x === vals[0])) props["border-width"] = sizePV(parseSize(vals[0]));
    else props["border-width"] = obj("border-width-v2", Object.fromEntries(Object.entries(bwidth).map(([s, v]) => [SIDE[s as keyof typeof SIDE], sizePV(parseSize(v!))])));
  }
  if (border.style) props["border-style"] = str(border.style);
  if (border.color) props["border-color"] = color(border.color);
  if (gap.row !== undefined || gap.column !== undefined) props.gap = obj("layout-direction", { row: gap.row !== undefined ? sizePV(parseSize(gap.row)) : undefined, column: gap.column !== undefined ? sizePV(parseSize(gap.column)) : undefined });
  if (flex.grow !== undefined || flex.shrink !== undefined || flex.basis !== undefined) {
    // Elementor's Flex_Transformer prints only the parts given (`flex-shrink: 0` -> `flex: 0 0`, whose
    // basis is 0%, not auto). Always send all three with the CSS initial values filled in.
    props.flex = obj("flex", {
      flexGrow: num(parseFloat(flex.grow ?? "0")),
      flexShrink: num(parseFloat(flex.shrink ?? "1")),
      flexBasis: sizePV(parseSize(flex.basis ?? "auto")),
    });
  }
  if (bg.failed) {
    // Keep the whole background in one place so layer order survives.
    for (const k of ["background", "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-attachment"]) if (st[k]) rest[k] = st[k];
  } else if (bg.color || bg.layers.length || bg.clip) {
    const pick = (list: string[] | undefined, i: number) => (list ? list[Math.min(i, list.length - 1)] : undefined);
    const overlays: PV[] = [];
    let ok = true;
    bg.layers.forEach((l, i) => {
      if (l.kind === "gradient") { overlays.push(l.grad!); return; }
      const size = pick(bg.sizes, i), pos = pick(bg.positions, i), rep = pick(bg.repeats, i), att = pick(bg.attachments, i);
      const sizePv = size ? parseBgSize(size) : undefined, posPv = pos ? parsePosition(pos) : undefined;
      if ((size && !sizePv) || (pos && !posPv) || (rep && !["repeat", "repeat-x", "repeat-y", "no-repeat"].includes(rep)) || (att && !["fixed", "scroll"].includes(att))) { ok = false; return; }
      overlays.push(obj("background-image-overlay", {
        image: obj("image", { src: obj("image-src", { id: null, url: urlPV(assetUrl(l.src!)) }), size: str("full") }),
        size: sizePv ?? undefined, position: posPv ?? undefined, repeat: rep ? str(rep) : undefined, attachment: att ? str(att) : undefined,
      }));
    });
    if (ok) {
      props.background = obj("background", {
        color: bg.color ? color(bg.color) : undefined,
        "background-overlay": overlays.length ? { $$type: "background-overlay", value: overlays } : undefined,
        clip: bg.clip ? str(bg.clip) : undefined,
      });
    } else for (const k of ["background", "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-attachment"]) if (st[k]) rest[k] = st[k];
  }
  return { props, rest };
}

/* --------------------------------------------------------------- output */

export interface StyleVariant { meta: { breakpoint: string; state: string | null }; props: Record<string, PV>; custom_css: null }
export interface StyleDef { id: string; type: "class"; label: string; variants: StyleVariant[] }
export interface ElementorElement {
  id: string; elType: string; widgetType?: string; isInner: boolean;
  settings: Record<string, PV>; styles: Record<string, StyleDef>; elements: ElementorElement[];
  editor_settings: { title: string }; version: string; interactions: never[];
}
export interface ElementorTemplate { content: ElementorElement[]; page_settings: Record<string, unknown>; version: string; title: string; type: "page" }

export interface ElementorOptions {
  /** Public URL of the deployed out/ folder; `assets/x.png` becomes `${publicBase}/assets/x.png`. */
  publicBase: string;
  title?: string;
  /** Families the extracting machine did not have (ir.meta.fonts): their @font-face gets local fallbacks. */
  fontsUnavailable?: string[];
}

/** Local fallbacks per generic family, tried after the (usually missing) licensed file. */
const LOCAL_FALLBACKS: Record<string, string[]> = {
  serif: ["Georgia", "Times New Roman"],
  monospace: ["Menlo", "Consolas", "Courier New"],
  "sans-serif": ["Helvetica Neue", "Arial", "Liberation Sans"],
};
export interface ElementorReport {
  frame: string; elements: Record<string, number>; nativeProps: Record<string, number>; companionProps: Record<string, number>;
  companionRules: number; warnings: string[];
}
export interface ElementorOutput {
  template: ElementorTemplate;
  /** Companion stylesheet: declarations V4 has no control for, keyed by `#f2h-<id>`. */
  css: string;
  /** Files the emitter synthesises (SVGs for inline vectors), path -> text. */
  generated: Map<string, string>;
  /** Asset paths (relative to out/) referenced by the template. */
  assets: Set<string>;
  report: ElementorReport;
}

/** responsive.ts buckets -> Elementor device names. laptop/tablet_extra/mobile_extra must be active in the Kit (tools/elementor_deploy.sh enables them). */
const MEDIA_BREAKPOINT: Record<string, string> = { "(max-width: 1366px)": "laptop", "(max-width: 1200px)": "tablet_extra", "(max-width: 1024px)": "tablet", "(max-width: 880px)": "mobile_extra", "(max-width: 767px)": "mobile" };
const CONTAINER_TAGS = new Set(["div", "header", "section", "article", "aside", "footer"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fnv(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const hex7 = (s: string) => fnv(s).toString(16).padStart(8, "0").slice(0, 7);

class Ctx {
  ids = new Map<string, string>(); used = new Set<string>();
  css: string[] = []; mediaCss = new Map<string, string[]>();
  generated = new Map<string, string>(); assets = new Set<string>(); warnings: string[] = [];
  counts: Record<string, number> = {}; native: Record<string, number> = {}; companion: Record<string, number> = {}; companionRules = 0;
  opts: ElementorOptions;
  constructor(opts: ElementorOptions) { this.opts = opts; }
  /** Stable 7-hex Elementor id per Figma node. */
  id(nodeId: string): string {
    let id = this.ids.get(nodeId); if (id) return id;
    let salt = 0; do { id = hex7(`${nodeId}#${salt++}`); } while (this.used.has(id));
    this.used.add(id); this.ids.set(nodeId, id); return id;
  }
  cssid(nodeId: string): string { return `f2h-${this.id(nodeId)}`; }
  assetUrl(rel: string): string {
    const clean = rel.replace(/^\.?\//, "");
    this.assets.add(clean);
    return `${this.opts.publicBase.replace(/\/$/, "")}/${clean.split("/").map(encodeURIComponent).join("/")}`;
  }
  rule(selector: string, st: Style, media?: string): void {
    // Companion declarations may still point at bundle assets (a background the schema could not
    // hold): register them for the copy step and address them at the public base.
    const abs = (v: string) => v.replace(/url\((["']?)(assets\/[^"')]+)\1\)/g, (_, q: string, rel: string) => `url("${this.assetUrl(rel)}")`);
    const body = Object.entries(st).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}: ${abs(String(v))};`).join(" ");
    if (!body) return;
    this.companionRules++;
    for (const k of Object.keys(st)) this.companion[k] = (this.companion[k] || 0) + 1;
    const line = `${selector} { ${body} }`;
    if (media) { if (!this.mediaCss.has(media)) this.mediaCss.set(media, []); this.mediaCss.get(media)!.push(line); } else this.css.push(line);
  }
  count(kind: string) { this.counts[kind] = (this.counts[kind] || 0) + 1; }
}

/** Where the text of an El goes: heading, button, or paragraph. */
function textKind(e: El): "e-heading" | "e-button" | "e-paragraph" {
  if (/^h[1-6]$/.test(e.tag)) return "e-heading";
  const boxed = !!(e.style["background-color"] || e.style["background"] || e.style["background-image"] || e.style["border"] || e.style["border-width"] || e.style["box-shadow"] || (e.style["padding"] && e.style["padding"] !== "0"));
  if ((e.tag === "a" || e.tag === "button") && boxed) return "e-button";
  return "e-paragraph";
}

function htmlV3(html: string): PV { return { $$type: "html-v3", value: { content: str(html), children: [] } }; }
function linkPV(href: string): PV { return obj("link", { destination: urlPV(href), isTargetBlank: bool(false) }); }
/** Custom HTML attributes (rendered verbatim by every atomic element): verify.py and the crops tool key on these. */
function attributesPV(attrs: Record<string, string>): PV {
  return { $$type: "attributes", value: Object.entries(attrs).map(([k, v]) => obj("key-value", { key: str(k), value: str(v) })) };
}

/** SVG markup -> a file whose root fills its box (Elementor inlines it at 100%/100%). */
function svgFile(e: El, ctx: Ctx): string {
  let svg = stripNoiseFilters(e.svg!.replace(/^\s*<\?xml[^>]*>\s*/i, ""));
  const vb = svg.match(/viewBox="([\d.\-\s]+)"/);
  let stretch = !!e.attrs["data-stretch"];
  if (vb && !stretch) { const p = vb[1].trim().split(/\s+/).map(Number); const va = p[2] / Math.max(1e-6, p[3]); const ba = e.box.w / Math.max(1e-6, e.box.h); stretch = Math.abs(va - ba) / Math.max(va, ba) > 0.03; }
  // Elementor rewrites the root's fill to `currentColor`; a shape without its own fill (a stroke-only
  // circle) would then be filled with the inherited text colour. Keep the root's fill on a wrapping group.
  const rootFill = svg.match(/^\s*<svg\b[^>]*\sfill="([^"]*)"/)?.[1] ?? "#000";
  svg = svg.replace(/^(\s*<svg\b[^>]*)>/, (m, open: string) => `${open.replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, "")}${stretch ? ' preserveAspectRatio="none"' : ""}><g fill="${rootFill}">`);
  svg = svg.replace(/<\/svg>\s*$/, "</g></svg>");
  const file = `assets/f2h-${ctx.id(e.id)}.svg`;
  ctx.generated.set(file, svg);
  return file;
}

function buildElement(e: El, ctx: Ctx, extraStyle: Style = {}): ElementorElement | null {
  const elId = ctx.id(e.id), cssid = ctx.cssid(e.id), styleId = `e-${elId}-${hex7(`${e.id}~style`)}`;
  const attrs: Record<string, string> = { "data-figma-id": e.attrs["data-figma-id"] || e.id };
  if (e.attrs["data-section"]) attrs["data-section"] = e.attrs["data-section"];
  const settings: Record<string, PV> = { classes: { $$type: "classes", value: [styleId] }, _cssid: str(cssid), attributes: attributesPV(attrs) };
  const style: Style = { ...e.style, ...extraStyle };
  let elType = "e-flexbox", widgetType: string | undefined; const children: ElementorElement[] = [];
  const isLeafText = (e.text !== null || e.runs) && !e.children.length;

  if (e.tag === "img" || (e.tag === "video" && e.poster)) {
    if (e.tag === "video") ctx.warnings.push(`${e.name}: video bytes are not exportable; poster emitted as an image`);
    const src = e.tag === "video" ? e.poster! : e.src || "";
    if (!src) return null;
    elType = "widget"; widgetType = "e-image";
    settings.image = obj("image", { src: obj("image-src", { id: null, url: urlPV(ctx.assetUrl(src)), alt: str(e.attrs["alt"] ?? e.name) }), size: str("full") });
  } else if (e.tag === "svg") {
    if (!e.svg && !e.assetUrl) return null;
    elType = "widget"; widgetType = "e-svg";
    const file = e.svg ? svgFile(e, ctx) : e.assetUrl!;
    settings.svg = obj("svg-src", { id: null, url: urlPV(ctx.assetUrl(file)) });
    // The base style is 65×65; the box always wins.
    style.width = style.width || `${e.box.w}px`; style.height = style.height || `${e.box.h}px`;
    style.display = style.display || "block";
  } else if (isLeafText) {
    elType = "widget"; widgetType = textKind(e);
    let html: string;
    if (e.runs) {
      html = e.runs.map((r, i) => {
        const t = esc(r.text).replace(/\n/g, "<br>");
        const rid = `${cssid}-r${i}`;
        const hasStyle = Object.keys(r.style).length > 0;
        if (hasStyle) ctx.rule(`#${rid}`, r.style);
        if (r.href) return `<a id="${rid}" href="${esc(r.href)}">${t}</a>`;
        return hasStyle ? `<span id="${rid}">${t}</span>` : t;
      }).join("");
    } else html = esc(e.text || "").replace(/\n/g, "<br>");
    // The site Kit styles h1..h6 / p globally (uppercase, letter-spacing, colour...). Every text
    // widget states its typography in full so the design wins over the Kit at equal specificity.
    for (const [k, v] of Object.entries({ "text-transform": "none", "font-style": "normal", "text-decoration": "none", "letter-spacing": "0px", "line-height": "normal" })) if (!style[k]) style[k] = v;
    if (widgetType === "e-heading") { settings.tag = str(e.tag); settings.title = htmlV3(html); }
    else if (widgetType === "e-button") {
      settings.text = htmlV3(html);
      // Base style: blue background, 12/24 padding, radius 2, centred text. Override every one of them.
      if (!style.background && !style["background-color"] && !style["background-image"]) style["background-color"] = "transparent";
      if (!style.padding && !Object.keys(style).some((k) => k.startsWith("padding-"))) style.padding = "0";
      if (!style["border-radius"]) style["border-radius"] = "0";
      if (!style["text-align"]) style["text-align"] = "start";
      if (!style.display) style.display = "block";
    } else { settings.tag = str(e.tag === "span" ? "span" : "p"); settings.paragraph = htmlV3(html); }
    if (e.attrs["href"] && !e.runs?.some((r) => r.href)) settings.link = linkPV(e.attrs["href"]);
  } else {
    if (e.text !== null && e.children.length) ctx.warnings.push(`${e.name}: text dropped because the node also has children`);
    elType = style.display === "grid" || e.layoutKind === "grid" ? "e-grid" : "e-flexbox";
    // Atomic containers still carry the legacy `.e-con` class, whose rule sets width:100%,
    // min-width:0 and position:relative, and the flexbox base style says display:flex and
    // padding:10px. State the CSS defaults the HTML build relied on wherever the design is silent.
    for (const [k, v] of Object.entries({ display: "block", width: "auto", "min-width": "auto", position: "static" })) if (!style[k]) style[k] = v;
    if (!style.padding && !Object.keys(style).some((k) => k.startsWith("padding-"))) style.padding = "0";
    if (elType === "e-grid") {
      // e-grid's base style is repeat(3,1fr) × repeat(2,1fr) with a 20px gap: an empty second row
      // as tall as the first unless the rows are stated.
      if (!style["grid-template-rows"]) style["grid-template-rows"] = "none";
      if (!style.gap && !style["row-gap"] && !style["column-gap"]) style.gap = "0px";
    }
    settings.tag = str(CONTAINER_TAGS.has(e.tag) ? e.tag : "div");
    if (e.attrs["href"]) settings.link = linkPV(e.attrs["href"]);
    for (const c of e.children) { const ce = buildElement(c, ctx); if (ce) children.push(ce); }
    if (elType === "e-grid" && !e.media["(max-width: 767px)"]?.["grid-template-columns"] && style["grid-template-columns"]) {
      // e-grid's base style collapses to 1fr on mobile; repeat the desktop tracks there unless the plan already decided.
      e = { ...e, media: { ...e.media, "(max-width: 767px)": { "grid-template-columns": style["grid-template-columns"], ...(e.media["(max-width: 767px)"] || {}) } } };
    }
  }
  ctx.count(widgetType || elType);

  // Styles: desktop, hover, tablet, mobile. Everything else -> companion css.
  const variants: StyleVariant[] = [];
  const push = (breakpoint: string, state: string | null, st: Style, selector: string, media?: string) => {
    const { props, rest } = convertStyle(st, (rel) => ctx.assetUrl(rel));
    for (const k of Object.keys(props)) ctx.native[k] = (ctx.native[k] || 0) + 1;
    if (Object.keys(props).length) variants.push({ meta: { breakpoint, state }, props, custom_css: null });
    if (Object.keys(rest).length) ctx.rule(selector, rest, media);
  };
  push("desktop", null, style, `#${cssid}`);
  if (e.hover) push("desktop", "hover", e.hover, `#${cssid}:hover`);
  for (const [q, st] of Object.entries(e.media)) {
    const bp = MEDIA_BREAKPOINT[q];
    if (bp) push(bp, null, st, `#${cssid}`, q);
    else ctx.rule(`#${cssid}`, st, q);
  }
  for (const r of e.stateRules) {
    const sel = r.childId ? `#${cssid}:${r.state} #${ctx.cssid(r.childId)}` : `#${cssid}:${r.state}`;
    ctx.rule(sel, r.style);
  }

  return {
    id: elId, elType, ...(widgetType ? { widgetType } : {}), isInner: false, settings,
    styles: { [styleId]: { id: styleId, type: "class", label: "local", variants } },
    elements: children, editor_settings: { title: e.name.slice(0, 80) }, version: "0.0", interactions: [],
  };
}

/** Same offsets as emit.ts sectionOffsets: section N starts exactly where Figma put it. */
function sectionMargins(sections: Section[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1], cur = sections[i];
    const delta = Math.round((cur.box.y - (prev.box.y + prev.box.h)) * 100) / 100;
    if (Math.abs(delta) > 0.5) out.set(cur.id, `${delta}px`);
  }
  return out;
}

export function emitElementor(frames: ResolvedFrame[], opts: ElementorOptions): ElementorOutput {
  const ctx = new Ctx(opts);
  // One frame per template. A multi-frame export (desktop + mobile) uses the widest; Elementor's
  // own breakpoints take over below it.
  const rf = [...frames].sort((a, b) => b.frame.width - a.frame.width)[0];
  if (frames.length > 1) ctx.warnings.push(`${frames.length} frames extracted; emitted the ${rf.frame.width}px frame only (${frames.filter((f) => f !== rf).map((f) => f.frame.slug).join(", ")} skipped)`);

  const margins = sectionMargins(rf.sections);
  const sections: ElementorElement[] = [];
  for (const s of rf.sections) {
    const extra: Style = {};
    const mt = margins.get(s.id);
    if (mt) extra["margin-top"] = mt;
    const el = buildElement(s.el, ctx, extra);
    if (el) sections.push(el);
  }

  // Page root: what `.page-root` did in the HTML (frame background, first-section offset, bottom slack).
  const rootId = ctx.id(`${rf.frame.id}~root`), rootCss = ctx.cssid(`${rf.frame.id}~root`), rootStyleId = `e-${rootId}-${hex7("root~style")}`;
  const rootStyle: Style = { display: "block", position: "relative", width: "100%", padding: "0", ...rf.rootStyle };
  const { props, rest } = convertStyle(rootStyle, (rel) => ctx.assetUrl(rel));
  ctx.rule(`#${rootCss}`, { "overflow-x": "clip", ...rest });
  const root: ElementorElement = {
    id: rootId, elType: "e-flexbox", isInner: false,
    settings: { classes: { $$type: "classes", value: [rootStyleId] }, _cssid: str(rootCss), tag: str("div"), attributes: attributesPV({ "data-bp": rf.frame.slug, "data-frame": rf.frame.id }) },
    styles: { [rootStyleId]: { id: rootStyleId, type: "class", label: "local", variants: [{ meta: { breakpoint: "desktop", state: null }, props, custom_css: null }] } },
    elements: sections, editor_settings: { title: `${rf.frame.name} (f2h root)` }, version: "0.0", interactions: [],
  };

  // Companion stylesheet: resets the HTML build relied on (scoped to the root), fonts, leftovers, media.
  let faces = fontFaces([rf]).css.replace(/url\("fonts\//g, `url("${opts.publicBase.replace(/\/$/, "")}/fonts/`);
  // A V4 font-family is one name, so a licensed font that is not installed would fall back to the
  // browser default (serif). The HTML build says `"Family", sans-serif`; give the @font-face the same
  // generic's local fonts after the file, so the native setting stays editable and the fallback matches.
  if (opts.fontsUnavailable?.length) {
    const generic = new Map<string, string>();
    const scan = (e: El) => {
      for (const st of [e.style, e.hover || {}, ...Object.values(e.media), ...(e.runs || []).map((r) => r.style)]) {
        const ff = st["font-family"]; if (!ff) continue;
        const parts = splitTop(ff, ",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
        if (parts.length > 1 && LOCAL_FALLBACKS[parts[parts.length - 1]]) generic.set(parts[0], parts[parts.length - 1]);
      }
      e.children.forEach(scan);
    };
    for (const s of rf.sections) scan(s.el);
    for (const fam of opts.fontsUnavailable) {
      const locals = (LOCAL_FALLBACKS[generic.get(fam) || "sans-serif"] || LOCAL_FALLBACKS["sans-serif"]).map((f) => `local("${f}")`).join(", ");
      faces = faces.replace(new RegExp(`(font-family: "${fam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";[^\\n]*format\\("woff2"\\))`, "g"), `$1, ${locals}`);
    }
  }
  const css: string[] = [
    "/* generated by figma-ir-pipeline (elementor v4 companion) */",
    `#${rootCss}, #${rootCss} * { box-sizing: border-box; }`,
    `#${rootCss} img, #${rootCss} svg, #${rootCss} video { display: block; flex-shrink: 0; }`,
    `#${rootCss} img { max-width: 100%; }`,
    `#${rootCss} :is(h1, h2, h3, h4, h5, h6, p, figure, blockquote, ul, ol) { margin: 0; }`,
    `#${rootCss} a { color: inherit; text-decoration: none; }`,
    `#${rootCss} button { font: inherit; }`,
    `#${rootCss} .e-svg svg, #${rootCss} [data-e-type="e-svg"] svg { display: block; }`,
    faces, "",
    ...ctx.css,
  ];
  const queries = [...ctx.mediaCss.keys()].sort((a, b) => (parseInt(b.match(/\d+/)?.[0] || "0", 10)) - (parseInt(a.match(/\d+/)?.[0] || "0", 10)));
  for (const q of queries) css.push("", `@media ${q} {`, ...ctx.mediaCss.get(q)!.map((l) => `  ${l}`), "}");

  for (const [p, text] of rf.generated) { ctx.generated.set(p, text); }
  return {
    template: { content: [root], page_settings: {}, version: "0.4", title: opts.title || rf.plan.page.title || rf.frame.name, type: "page" },
    css: css.join("\n") + "\n",
    generated: ctx.generated,
    assets: ctx.assets,
    report: { frame: rf.frame.slug, elements: ctx.counts, nativeProps: ctx.native, companionProps: ctx.companion, companionRules: ctx.companionRules, warnings: [...rf.warnings, ...ctx.warnings] },
  };
}
