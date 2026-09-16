/**
 * figma-ir/1 — the Intermediate Representation.
 *
 * Written by the plugin (extract), read by the planner and the compiler.
 * It records FACTS only: what Figma resolved for every layer. No HTML, no
 * CSS strings, no structural decisions. Those live in the plan (plan.ts).
 *
 * Units: design pixels. Boxes are absolute to the frame's top-left.
 * Colours: "#rrggbb" or "rgba(r, g, b, a)".
 */

export const IR_SCHEMA = "figma-ir/1" as const;

export interface IRDocument {
  schema: typeof IR_SCHEMA;
  meta: {
    fileName: string;
    fileKey: string;
    exportedAt: string;
    pluginVersion: string;
    /** Node ids the plugin was asked to flatten (from a previous plan). */
    rasterized: string[];
    /** Every font family the frames use, and whether this machine had it. */
    fonts: Array<{ family: string; styles: string[]; available: boolean; missing: boolean }>;
  };
  /** One entry per selected top-level frame (e.g. desktop + mobile). */
  frames: IRFrame[];
  /** assetId -> record. Files live in assets/<file> next to ir.json. */
  assets: Record<string, IRAsset>;
}

export interface IRFrame {
  id: string;
  name: string;
  slug: string;
  width: number;
  height: number;
  /** Full-frame PNG at `screenshotScale`, path relative to the bundle root. */
  screenshot: string | null;
  screenshotScale: number;
  /** Frame-space box the screenshot covers (the frame box when it was clipped for export). */
  screenshotBox: Box | null;
  root: IRNode;
}

export interface IRAsset {
  id: string;
  file: string;
  kind: "image" | "svg" | "video-poster";
  hash: string;
  /** Design-pixel size of the exported region. */
  width: number;
  height: number;
  /** Export scale (2 = retina PNG). */
  scale: number;
  /** Inline markup for svg assets (so the compiler can inline them). */
  svg?: string;
  nodeName: string;
}

export type IRNodeType =
  | "frame" | "group" | "component" | "component-set" | "instance" | "section"
  | "text" | "vector" | "rect" | "ellipse" | "line" | "polygon" | "star" | "boolean"
  | "slice" | "other";

export interface Box { x: number; y: number; w: number; h: number }

export type SizingMode = "fixed" | "hug" | "fill";
export type Constraint = "min" | "max" | "center" | "stretch" | "scale";

export interface IRLayout {
  direction: "row" | "column";
  wrap: boolean;
  gap: number;
  /** Gap between wrapped lines (WRAP only). */
  counterGap: number;
  padding: [number, number, number, number]; // top right bottom left
  justify: "start" | "center" | "end" | "space-between";
  align: "start" | "center" | "end" | "baseline";
  /** Counter-axis alignment of wrapped lines (WRAP only). */
  alignContent: "start" | "center" | "end" | "space-between" | null;
  reverse: boolean;
  strokesIncluded: boolean;
}

/** Per-paint blend mode (Figma blends each fill against the fills below it). */
export type PaintBlend = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
export type IRFill =
  | { type: "solid"; color: string; opacity: number; blend?: PaintBlend }
  | { type: "gradient"; kind: "linear" | "radial" | "angular" | "diamond"; angle: number;
      stops: Array<{ color: string; position: number }>; opacity: number;
      /** Radial/angular/diamond: centre and radii as fractions of the node box (from gradientTransform). */
      center?: [number, number]; radii?: [number, number];
      /** Linear: where the 0% and 100% stops sit, as fractions of the node box. */
      start?: [number, number]; end?: [number, number]; blend?: PaintBlend }
  | { type: "image"; scaleMode: "fill" | "fit" | "tile" | "crop"; opacity: number; imageHash: string | null; blend?: PaintBlend }
  | { type: "video"; opacity: number };

export interface IRStroke {
  color: string;
  weight: number;
  /** Per-side weights when they differ (frames/rects only). */
  weights: [number, number, number, number] | null;
  align: "inside" | "center" | "outside";
  dash: number[];
}

export type IREffect =
  | { type: "drop-shadow" | "inner-shadow"; x: number; y: number; blur: number; spread: number; color: string }
  | { type: "blur" | "backdrop-blur"; radius: number };

export interface IRTextSegment {
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: { unit: "px" | "percent" | "auto"; value: number };
  letterSpacing: { unit: "px" | "percent"; value: number };
  color: string | null;
  decoration: "none" | "underline" | "strikethrough";
  textCase: "original" | "upper" | "lower" | "title";
  href: string | null;
  list: "none" | "ordered" | "unordered";
}

export interface IRText {
  characters: string;
  segments: IRTextSegment[];
  align: "left" | "center" | "right" | "justify";
  valign: "top" | "center" | "bottom";
  autoResize: "none" | "height" | "width-height" | "truncate";
  maxLines: number | null;
  paragraphSpacing: number;
  /** Number of rendered lines Figma produced at this width (approximate). */
  lines: number;
  /** Figma "leading trim": the box is cut to cap height / baseline instead of the line box. */
  leadingTrim: "none" | "cap-height";
}

export interface IRInteraction {
  trigger: "hover" | "press" | "click";
  action: "navigate" | "style" | "overlay" | "unknown";
  url: string | null;
  durationMs: number;
  easing: string;
  /** Style deltas read from a Hover variant, when one exists (legacy; see IRNode.states). */
  hover: { backgroundColor?: string; opacity?: number; color?: string } | null;
  /** Figma node the reaction changes to / navigates to. */
  destinationId?: string | null;
  /** SMART_ANIMATE, DISSOLVE, MOVE_IN … from the prototype transition. */
  transitionType?: string | null;
}

export interface IRNode {
  id: string;
  name: string;
  type: IRNodeType;
  visible: boolean;
  opacity: number;
  blendMode: string;
  /** Axis-aligned bounding box in frame space (post-rotation). */
  box: Box;
  /** What exportAsync renders: box + shadows/strokes outside. */
  renderBox: Box;
  /** The node's own unrotated size. */
  size: { w: number; h: number };
  /** Rotation in degrees, Figma convention (CCW positive). */
  rotation: number;
  /** Auto-layout facts when this frame has auto-layout, else null. */
  layout: IRLayout | null;
  sizing: { w: SizingMode; h: SizingMode; minW: number | null; maxW: number | null; minH: number | null; maxH: number | null };
  /** "absolute" = child opted out of the parent's auto-layout flow. */
  positioning: "auto" | "absolute";
  constraints: { h: Constraint; v: Constraint };
  grow: number;
  alignSelf: "auto" | "stretch";
  fills: IRFill[];
  stroke: IRStroke | null;
  radius: [number, number, number, number] | null;
  effects: IREffect[];
  clips: boolean;
  isMask: boolean;
  text: IRText | null;
  /** Exported bytes for this node itself (vector svg, image leaf, raster). */
  asset: string | null;
  /** Exported bytes of this node's image/video FILL alone (children stripped). */
  fillAsset: string | null;
  component: { name: string; setName: string | null; props: Record<string, string> } | null;
  interactions: IRInteraction[];
  /** Frames without auto-layout store children in paint order; this is the
   *  reading order (row-major by position) as indices into `children`. */
  readingOrder: number[] | null;
  /** The node as it looks in another prototype state (the reaction's destination
   *  variant, extracted like any node). The compiler diffs it against this one. */
  states?: { hover?: IRNode; press?: IRNode };
  children: IRNode[];
}

/* ------------------------------------------------------------ helpers */

export function walk(n: IRNode, fn: (n: IRNode, parent: IRNode | null, depth: number) => void | false,
                     parent: IRNode | null = null, depth = 0): void {
  if (fn(n, parent, depth) === false) return;
  for (const c of n.children) walk(c, fn, n, depth + 1);
}

export interface IRIndex {
  byId: Map<string, IRNode>;
  parent: Map<string, IRNode | null>;
  depth: Map<string, number>;
}

export function indexFrame(frame: IRFrame): IRIndex {
  const idx: IRIndex = { byId: new Map(), parent: new Map(), depth: new Map() };
  walk(frame.root, (n, p, d) => { idx.byId.set(n.id, n); idx.parent.set(n.id, p); idx.depth.set(n.id, d); });
  return idx;
}

export function isAncestor(idx: IRIndex, a: string, n: string): boolean {
  let p = idx.parent.get(n);
  while (p) { if (p.id === a) return true; p = idx.parent.get(p.id); }
  return false;
}

export const slugify = (s: string, fallback = "node"): string => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
  return /^[0-9]/.test(base) ? `n-${base}` : base;
};
