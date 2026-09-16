/** A hand-built figma-ir/1 document: header, hero overlay, card grid, footer. */
import { PNG } from "pngjs";
import type { IRDocument, IRNode, IRFrame, IRTextSegment, IRAsset } from "../src/ir/schema.ts";

let seq = 1;
const id = () => `1:${seq++}`;

export function node(p: Partial<IRNode> & { name: string; x: number; y: number; w: number; h: number }): IRNode {
  const { x, y, w, h, ...rest } = p;
  return {
    id: id(), type: "frame", visible: true, opacity: 1, blendMode: "pass-through",
    box: { x, y, w, h }, renderBox: { x, y, w, h }, size: { w, h }, rotation: 0,
    layout: null, sizing: { w: "fixed", h: "fixed", minW: null, maxW: null, minH: null, maxH: null },
    positioning: "auto", constraints: { h: "min", v: "min" }, grow: 0, alignSelf: "auto",
    fills: [], stroke: null, radius: null, effects: [], clips: false, isMask: false,
    text: null, asset: null, fillAsset: null, component: null, interactions: [], readingOrder: null, children: [],
    ...rest,
  };
}
export function seg(p: Partial<IRTextSegment> & { end: number }): IRTextSegment {
  return {
    start: 0, fontFamily: "DM Sans", fontStyle: "Regular", fontWeight: 400, italic: false, fontSize: 16,
    lineHeight: { unit: "px", value: 24 }, letterSpacing: { unit: "px", value: 0 }, color: "#404040",
    decoration: "none", textCase: "original", href: null, list: "none", ...p,
  };
}
export function text(name: string, chars: string, x: number, y: number, w: number, h: number, s: Partial<IRTextSegment> = {}, extra: Partial<IRNode> = {}): IRNode {
  const lines = Math.max(1, Math.round(h / (s.lineHeight?.value || 24)));
  return node({
    name, type: "text", x, y, w, h,
    sizing: { w: "fixed", h: "hug", minW: null, maxW: null, minH: null, maxH: null },
    text: { characters: chars, segments: [seg({ end: chars.length, ...s })], align: "left", valign: "top", autoResize: "height", maxLines: null, paragraphSpacing: 0, lines, leadingTrim: "none" },
    ...extra,
  });
}
export function row(name: string, x: number, y: number, w: number, h: number, gap: number, pad: [number, number, number, number], children: IRNode[], extra: Partial<IRNode> = {}): IRNode {
  return node({ name, x, y, w, h, layout: { direction: "row", wrap: false, gap, counterGap: 0, padding: pad, justify: "start", align: "center", alignContent: null, reverse: false, strokesIncluded: false }, children, ...extra });
}
export function col(name: string, x: number, y: number, w: number, h: number, gap: number, pad: [number, number, number, number], children: IRNode[], extra: Partial<IRNode> = {}): IRNode {
  return node({ name, x, y, w, h, layout: { direction: "column", wrap: false, gap, counterGap: 0, padding: pad, justify: "start", align: "start", alignContent: null, reverse: false, strokesIncluded: false }, children, ...extra });
}

export function pngBytes(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { png.data[i * 4] = rgb[0]; png.data[i * 4 + 1] = rgb[1]; png.data[i * 4 + 2] = rgb[2]; png.data[i * 4 + 3] = 255; }
  return PNG.sync.write(png);
}

export function makeSample(): { doc: IRDocument; files: Map<string, Buffer | string> } {
  seq = 1;
  const W = 1440;
  const files = new Map<string, Buffer | string>();
  const assets: Record<string, IRAsset> = {};
  const asset = (name: string, kind: IRAsset["kind"], w: number, h: number, rgb: [number, number, number], svg?: string): string => {
    const aid = `${id()}:${kind === "svg" ? "svg" : "image"}`;
    const file = `${name}.${kind === "svg" ? "svg" : "png"}`;
    assets[aid] = { id: aid, file, kind, hash: name, width: w, height: h, scale: kind === "svg" ? 1 : 2, svg, nodeName: name };
    files.set(`assets/${file}`, svg ?? pngBytes(w, h, rgb));
    return aid;
  };
  const heroBg = asset("hero-bg", "image", W, 600, [20, 110, 130]);
  const cardImg = asset("card-photo", "image", 325, 160, [200, 200, 200]);
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40" viewBox="0 0 140 40"><rect width="140" height="40" rx="8" fill="#1FB1CC"/></svg>`;
  const logo = asset("logo", "svg", 140, 40, [0, 0, 0], logoSvg);

  // header
  const navItems = ["Home", "Tours", "About", "Contact"].map((t, i) => text(t, t, 900 + i * 110, 36, 80, 24, { fontWeight: 600, textCase: "upper" }, { sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null } }));
  navItems.forEach((n) => { n.text!.autoResize = "width-height"; });
  const nav = row("Nav", 900, 36, 420, 24, 32, [0, 0, 0, 0], navItems, { sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  const logoNode = node({ name: "Logo", type: "vector", x: 120, y: 28, w: 140, h: 40, asset: logo });
  const header = row("Header", 0, 0, W, 96, 0, [28, 120, 28, 120], [logoNode, nav], { fills: [{ type: "solid", color: "#FFFFFF", opacity: 1 }], sizing: { w: "fixed", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  header.layout!.justify = "space-between";

  // hero overlay: bg image + text block + button
  const h1 = text("Headline", "Discover the wild coast", 120, 210, 620, 128, { fontSize: 56, fontWeight: 700, lineHeight: { unit: "px", value: 64 }, color: "#FFFFFF" });
  const p = text("Sub", "Small-group tours led by locals who know every cove, cliff and café along the way.", 120, 354, 560, 60, { fontSize: 20, lineHeight: { unit: "px", value: 30 }, color: "#FFFFFF" });
  const btnText = text("Label", "Book a tour", 152, 446, 110, 24, { fontWeight: 600, color: "#0B3E47" }, { sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  btnText.text!.autoResize = "width-height";
  const btn = row("Button", 120, 430, 174, 56, 0, [16, 32, 16, 32], [btnText], { fills: [{ type: "solid", color: "#D3D508", opacity: 1 }], radius: [8, 8, 8, 8], sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null }, interactions: [{ trigger: "click", action: "navigate", url: "#book", durationMs: 0, easing: "ease", hover: null }] });
  const textBlock = col("Hero Copy", 120, 210, 620, 276, 16, [0, 0, 0, 0], [h1, p, btn], { sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  const heroImg = node({ name: "Hero Photo", type: "rect", x: 0, y: 96, w: W, h: 600, fills: [{ type: "image", scaleMode: "fill", opacity: 1, imageHash: "x" }, { type: "solid", color: "#000000", opacity: 0.35 }], asset: heroBg, constraints: { h: "stretch", v: "stretch" } });
  textBlock.box.y = 306; textBlock.children.forEach((c) => { c.box.y += 96; });
  const hero = node({ name: "Hero", x: 0, y: 96, w: W, h: 600, children: [heroImg, textBlock] });

  // cards grid: 2 rows x 3
  const cards: IRNode[] = [];
  for (let i = 0; i < 6; i++) {
    const cx = 120 + (i % 3) * (373 + 40), cy = 696 + 80 + 72 + Math.floor(i / 3) * (308 + 40);
    const img = node({ name: "Photo", type: "rect", x: cx + 24, y: cy + 24, w: 325, h: 160, fills: [{ type: "image", scaleMode: "fill", opacity: 1, imageHash: "y" }], asset: cardImg, radius: [8, 8, 8, 8] });
    const title = text("Title", `Tour ${i + 1}`, cx + 24, cy + 196, 325, 28, { fontSize: 22, fontWeight: 600, lineHeight: { unit: "px", value: 28 } });
    const desc = text("Desc", "Two days of sea caves, cliff paths and one very good fish supper.", cx + 24, cy + 232, 325, 48, {});
    cards.push(col(`Card ${i + 1}`, cx, cy, 373, 308, 12, [24, 24, 24, 24], [img, title, desc], { fills: [{ type: "solid", color: "#FFFFFF", opacity: 1 }], radius: [12, 12, 12, 12], effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 16, spread: 0, color: "rgba(0, 0, 0, 0.08)" }], stroke: { color: "#E5E5E5", weight: 1, weights: null, align: "inside", dash: [] } }));
  }
  const grid = node({ name: "Cards", x: 120, y: 848, w: 1200, h: 656, layout: { direction: "row", wrap: true, gap: 40, counterGap: 40, padding: [0, 0, 0, 0], justify: "start", align: "start", alignContent: "start", reverse: false, strokesIncluded: false }, children: cards, sizing: { w: "fill", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  const h2 = text("Section Title", "Our tours", 120, 776, 1200, 44, { fontSize: 40, fontWeight: 700, lineHeight: { unit: "px", value: 44 } });
  const tours = col("Tours Section", 0, 696, W, 888, 28, [80, 120, 80, 120], [h2, grid], { fills: [{ type: "solid", color: "#F0F9FA", opacity: 1 }], sizing: { w: "fixed", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });

  // footer
  const copy = text("Copyright", "© 2026 Wild Coast Tours", 120, 1624, 300, 24, { color: "#FFFFFF" });
  const footer = row("Footer", 0, 1584, W, 104, 0, [40, 120, 40, 120], [copy], { fills: [{ type: "solid", color: "#0B3E47", opacity: 1 }] });

  const page = col("Page", 0, 0, W, 1688, 0, [0, 0, 0, 0], [header, hero, tours, footer], { fills: [{ type: "solid", color: "#FFFFFF", opacity: 1 }] });
  const rootFrame = node({ name: "Desktop", x: 0, y: 0, w: W, h: 1688, children: [page] });

  const frame: IRFrame = { id: rootFrame.id, name: "Desktop", slug: "desktop", width: W, height: 1688, screenshot: null, screenshotScale: 1, screenshotBox: null, root: rootFrame };
  const doc: IRDocument = {
    schema: "figma-ir/1",
    meta: { fileName: "fixture", fileKey: "", exportedAt: "2026-09-15T00:00:00.000Z", pluginVersion: "test", rasterized: [], fonts: [{ family: "DM Sans", styles: ["Regular", "Bold"], available: true, missing: false }] },
    frames: [frame], assets,
  };
  return { doc, files };
}
