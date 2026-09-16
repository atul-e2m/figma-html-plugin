import type { IRAsset } from "../ir/schema.ts";

export interface AssetRecord extends IRAsset { bytes: Uint8Array }
export type AssetStore = Map<string, AssetRecord>;

/** FNV-1a — stable dedup key without crypto. */
export function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "asset";
const byHash = new Map<string, AssetRecord>();

function sizeOf(node: SceneNode): { w: number; h: number } {
  const r = (node as unknown as { absoluteRenderBounds?: Rect | null }).absoluteRenderBounds;
  if (r) return { w: Math.round(r.width), h: Math.round(r.height) };
  return { w: "width" in node ? Math.round(node.width) : 0, h: "height" in node ? Math.round(node.height) : 0 };
}

function bytesToString(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

/** True when an ancestor clips the node down to (almost) nothing: Figma then renders it as an empty export. */
function isClippedAway(node: SceneNode): boolean {
  const own = ("width" in node ? node.width : 0) * ("height" in node ? node.height : 0);
  if (own <= 0) return false;
  let clipper = false;
  for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    if ((p as unknown as { clipsContent?: boolean }).clipsContent) { clipper = true; break; }
  }
  if (!clipper) return false;
  const rb = (node as unknown as { absoluteRenderBounds?: Rect | null }).absoluteRenderBounds;
  if (!rb) return true;
  return rb.width * rb.height < own * 0.5;
}

/**
 * Copy of `node` placed directly on the page (so no ancestor clips it). Nodes inside an
 * instance cannot be cloned alone: clone the outermost instance, detach it, and walk the
 * same child-index path down to the matching layer.
 */
async function unclippedCopy(node: SceneNode): Promise<{ target: SceneNode; dispose: () => void } | null> {
  const path: number[] = [];
  let top: SceneNode = node;
  const chain: SceneNode[] = [node];
  let outermost: SceneNode | null = null;
  for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    chain.push(p as SceneNode);
    if (p.type === "INSTANCE") outermost = p as SceneNode;
  }
  if (outermost) {
    for (let k = chain.indexOf(outermost); k > 0; k--) path.push((chain[k] as SceneNode & ChildrenMixin).children.indexOf(chain[k - 1]));
    top = outermost;
  }
  // `top` is the outermost instance containing the node, or the node itself when it sits in plain frames.
  const trash: SceneNode[] = [];
  try {
    let clone: SceneNode = (top as SceneNode & { clone(): SceneNode }).clone();
    trash.push(clone);
    figma.currentPage.appendChild(clone);
    if (clone.type === "INSTANCE") { const det = (clone as InstanceNode).detachInstance(); trash[0] = det; clone = det; }
    let target: SceneNode = clone;
    for (const i of path) {
      const kids: readonly SceneNode[] | undefined = (target as SceneNode & Partial<ChildrenMixin>).children;
      if (!kids || !kids[i]) throw new Error("path mismatch");
      target = kids[i];
    }
    if (target !== clone) { figma.currentPage.appendChild(target); trash.push(target); }
    (target as LayoutMixin).x = -100000; (target as LayoutMixin).y = -100000;
    return { target, dispose: () => { for (const t of trash) { try { t.remove(); } catch { /* gone */ } } } };
  } catch (e) {
    console.warn("unclipped copy failed for", node.name, e);
    for (const t of trash) { try { t.remove(); } catch { /* gone */ } }
    return null;
  }
}

/** Export a node as SVG (with inline markup) or PNG@2x. Deduped by content hash. */
export async function exportNode(node: SceneNode, store: AssetStore, kind: "svg" | "image" | "video-poster"): Promise<AssetRecord | null> {
  const key = `${node.id}:${kind}`;
  const existing = store.get(key);
  if (existing) return existing;
  try {
    let bytes: Uint8Array;
    let svg: string | undefined;
    let scale = 2;
    const run = async (target: SceneNode) => {
      const ex = target as ExportMixin;
      if (kind === "svg") {
        bytes = await ex.exportAsync({ format: "SVG", svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true });
        svg = bytesToString(bytes);
        scale = 1;
      } else {
        bytes = await ex.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
      }
    };
    let size = sizeOf(node);
    if (isClippedAway(node)) {
      // A layer hidden outside its clipping parent (a hover-reveal button) exports as an empty image
      // in place; export an unclipped copy instead.
      const copy = await unclippedCopy(node);
      if (copy) {
        try { await run(copy.target); size = { w: Math.round((copy.target as LayoutMixin).width), h: Math.round((copy.target as LayoutMixin).height) }; }
        finally { copy.dispose(); }
      } else await run(node);
    } else await run(node);
    bytes = bytes!;
    const hash = hashBytes(bytes);
    const dup = byHash.get(hash);
    if (dup) { store.set(key, dup); return dup; }
    const { w, h } = size;
    const rec: AssetRecord = {
      id: key, file: `${safe(node.name)}-${hash}.${kind === "svg" ? "svg" : "png"}`, kind, hash,
      width: w, height: h, scale, svg, nodeName: node.name, bytes,
    };
    store.set(key, rec); byHash.set(hash, rec);
    return rec;
  } catch (e) {
    console.warn(`export failed for "${node.name}" (${kind}):`, e);
    return null;
  }
}

/**
 * Export ONLY a frame's fill (children stripped) so text is not baked into the
 * background. Clone, strip, export, delete. A black/empty render (video fill)
 * falls back to the raw image bytes.
 */
export async function exportFill(node: SceneNode, store: AssetStore): Promise<AssetRecord | null> {
  const key = `${node.id}:fill`;
  const existing = store.get(key);
  if (existing) return existing;
  let bytes: Uint8Array | null = null;
  // A same-size rectangle carrying the node's image/video paints renders the
  // fill exactly as cropped (imageTransform is relative to the node size), and
  // works for instances, whose children cannot be removed from a clone.
  let temp: RectangleNode | null = null;
  try {
    const n = node as GeometryMixin & LayoutMixin;
    const paints = (Array.isArray(n.fills) ? n.fills : []).filter((p) => p.visible !== false && (p.type === "IMAGE" || (p.type as string) === "VIDEO"));
    if (paints.length) {
      temp = figma.createRectangle();
      temp.resize(Math.max(1, n.width), Math.max(1, n.height));
      temp.x = -100000; temp.y = -100000;
      temp.fills = paints;
      const cr = (node as unknown as { cornerRadius?: number | symbol }).cornerRadius;
      if (typeof cr === "number") temp.cornerRadius = 0;
      bytes = await temp.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    }
  } catch (e) { console.warn("fill export failed for", node.name, e); }
  finally { try { if (temp) temp.remove(); } catch { /* gone */ } }

  const fills = (node as unknown as { fills?: readonly Paint[] }).fills;
  const hasVideo = Array.isArray(fills) && fills.some((p) => p.visible !== false && (p.type as string) === "VIDEO");
  const area = ("width" in node ? node.width : 0) * ("height" in node ? node.height : 0) * 4;
  const looksEmpty = !bytes || bytes.length < Math.max(2000, area / 200) || hasVideo;
  if (looksEmpty && Array.isArray(fills)) {
    const img = fills.find((p) => p.visible !== false && p.type === "IMAGE") as ImagePaint | undefined;
    if (img && img.imageHash) {
      try { const raw = figma.getImageByHash(img.imageHash); if (raw) bytes = await raw.getBytesAsync(); }
      catch (e) { console.warn("raw image fetch failed for", node.name, e); }
    }
  }
  if (!bytes) return null;
  const hash = hashBytes(bytes);
  const dup = byHash.get(hash);
  if (dup) { store.set(key, dup); return dup; }
  const rec: AssetRecord = {
    id: key, file: `${safe(node.name)}-bg-${hash}.png`, kind: "image", hash,
    width: "width" in node ? Math.round(node.width) : 0, height: "height" in node ? Math.round(node.height) : 0,
    scale: 2, nodeName: node.name, bytes,
  };
  store.set(key, rec); byHash.set(hash, rec);
  return rec;
}
