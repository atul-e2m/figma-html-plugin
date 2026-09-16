/**
 * Plugin entry: select one or more frames, press Extract, download the IR bundle.
 *
 * Bundle layout:
 *   ir.json                    figma-ir/1
 *   assets/<file>              exported bytes (png / svg)
 *   screenshots/<slug>.png     full-frame render, for the planner + verify
 */
import { IR_SCHEMA, slugify, type IRDocument, type IRFrame } from "../ir/schema.ts";
import { extractNode, type ExtractCtx } from "./extract.ts";
import { type AssetStore } from "./assets.ts";
import { Zip } from "./zip.ts";

const PLUGIN_VERSION = "0.1.0";
const VALID = new Set(["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET", "GROUP", "SECTION"]);

figma.showUI(__html__, { width: 440, height: 560, themeColors: true });

function selectedFrames(): SceneNode[] {
  return figma.currentPage.selection.filter((n) => VALID.has(n.type));
}
function postSelection() {
  const frames = selectedFrames();
  figma.ui.postMessage({
    type: "selection",
    frames: frames.map((f) => ({ id: f.id, name: f.name, width: Math.round(f.width), height: Math.round(f.height), type: f.type })),
    total: figma.currentPage.selection.length,
  });
}
postSelection();
figma.on("selectionchange", postSelection);

const progress = (message: string, pct: number) => figma.ui.postMessage({ type: "progress", message, pct });

/**
 * Full-frame render at exactly the frame's box. A frame that does not clip its
 * content exports with every overflowing child included (shadows, bleeding
 * photos), which shifts the origin; export a clipped clone in that case.
 */
async function screenshot(frame: SceneNode): Promise<{ bytes: Uint8Array; scale: number } | null> {
  const clips = !!(frame as unknown as { clipsContent?: boolean }).clipsContent;
  let target: SceneNode = frame;
  let clone: SceneNode | null = null;
  if (!clips && "clipsContent" in frame) {
    try { clone = (frame as FrameNode).clone(); (clone as FrameNode).clipsContent = true; target = clone; }
    catch (e) { console.warn("clip clone failed; exporting render bounds", e); clone = null; target = frame; }
  }
  try {
    const ex = target as ExportMixin;
    for (const scale of [1, 0.5, 0.25]) {
      try {
        const bytes = await ex.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
        return { bytes, scale };
      } catch (e) { console.warn(`screenshot at ${scale}x failed`, e); }
    }
    return null;
  } finally { try { if (clone) clone.remove(); } catch { /* gone */ } }
}

async function runExtract(rasterIds: string[]) {
  const frames = selectedFrames();
  if (!frames.length) { figma.ui.postMessage({ type: "error", message: "Select at least one Frame / Component / Group." }); return; }
  const t0 = Date.now();
  const assets: AssetStore = new Map();
  const zip = new Zip();
  const doc: IRDocument = {
    schema: IR_SCHEMA,
    meta: { fileName: figma.root.name, fileKey: figma.fileKey || "", exportedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION, rasterized: rasterIds, fonts: [] },
    frames: [],
    assets: {},
  };
  const usedSlugs = new Set<string>();
  let nodeCount = 0;
  const fonts = new Map<string, Set<string>>();
  const missingFonts = new Set<string>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const base = i / frames.length, span = 1 / frames.length;
    progress(`Frame ${i + 1}/${frames.length}: ${f.name}`, Math.round(base * 80));
    const abs = (f as unknown as { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox || { x: f.x, y: f.y };
    const ctx: ExtractCtx = {
      frameAbs: { x: abs.x, y: abs.y }, assets, rasterIds: new Set(rasterIds),
      progress: (m) => progress(`${f.name}: ${m}`, Math.round((base + span * 0.5) * 80)), count: 0, exported: 0,
      fonts, missingFonts,
    };
    const root = await extractNode(f, ctx, 0);
    if (!root) continue;
    nodeCount += ctx.count;
    let slug = slugify(f.name, "frame"); let k = 2; while (usedSlugs.has(slug)) slug = `${slugify(f.name, "frame")}-${k++}`; usedSlugs.add(slug);
    progress(`${f.name}: screenshot…`, Math.round((base + span * 0.85) * 80));
    const shot = await screenshot(f);
    let shotPath: string | null = null;
    if (shot) { shotPath = `screenshots/${slug}.png`; zip.add(shotPath, shot.bytes); }
    const frame: IRFrame = {
      id: f.id, name: f.name, slug, width: Math.round(f.width), height: Math.round(f.height),
      screenshot: shotPath, screenshotScale: shot ? shot.scale : 1,
      screenshotBox: shot ? { x: 0, y: 0, w: Math.round(f.width), h: Math.round(f.height) } : null,
      root,
    };
    doc.frames.push(frame);
  }
  progress("Checking fonts…", 82);
  try {
    const avail = new Set((await figma.listAvailableFontsAsync()).map((x) => x.fontName.family));
    doc.meta.fonts = [...fonts.entries()].map(([family, styles]) => ({ family, styles: [...styles], available: avail.has(family), missing: missingFonts.has(family) }));
  } catch (e) { console.warn("font listing failed", e); doc.meta.fonts = [...fonts.entries()].map(([family, styles]) => ({ family, styles: [...styles], available: true, missing: missingFonts.has(family) })); }
  progress("Writing assets…", 85);
  const seenFiles = new Set<string>();
  for (const [id, rec] of assets) {
    doc.assets[id] = { id: rec.id, file: rec.file, kind: rec.kind, hash: rec.hash, width: rec.width, height: rec.height, scale: rec.scale, svg: rec.svg, nodeName: rec.nodeName };
    if (!seenFiles.has(rec.file)) { seenFiles.add(rec.file); zip.add(`assets/${rec.file}`, rec.bytes); }
  }
  progress("Writing ir.json…", 95);
  const json = JSON.stringify(doc);
  zip.add("ir.json", json);
  const bytes = zip.finish();
  const name = doc.frames.length === 1 ? doc.frames[0].slug : slugify(figma.root.name, "design");
  figma.ui.postMessage({
    type: "result",
    filename: `${name}-ir.zip`,
    bytes,
    stats: { frames: doc.frames.length, nodes: nodeCount, assets: seenFiles.size, irBytes: json.length, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      fonts: doc.meta.fonts.filter((x) => !x.available || x.missing).map((x) => x.family) },
    preview: doc.frames.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height })),
  });
}

figma.ui.onmessage = async (msg: { type: string; rasterIds?: string[] }) => {
  if (msg.type === "extract") {
    try { await runExtract(msg.rasterIds || []); }
    catch (e) { console.error(e); figma.ui.postMessage({ type: "error", message: String((e as Error)?.message || e) }); }
  } else if (msg.type === "close") figma.closePlugin();
};
