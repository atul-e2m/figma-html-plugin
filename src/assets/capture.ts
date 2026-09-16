import { AssetMap, AssetRecord } from "../core/types";

/** FNV-1a over bytes — stable dedup key, no crypto dependency. */
function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const safe = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "asset";

export interface CaptureResult extends AssetRecord { svg?: string }

/**
 * Export a node's bytes. Images/videos at 2x for retina; vectors as inline SVG.
 * Identical bytes are stored once and reused (hash dedup).
 */
export async function captureAsset(
  node: SceneNode,
  assets: AssetMap,
  kind: "image" | "video" | "svg"
): Promise<CaptureResult | null> {
  try {
    if (kind === "svg") {
      const bytes = await (node as ExportMixin).exportAsync({ format: "SVG" });
      const svg = String.fromCharCode(...Array.from(bytes));
      const hash = hashBytes(bytes);
      const existing = findByHash(assets, hash);
      if (existing) return { ...existing, svg };
      const filename = `${safe(node.name)}-${hash}.svg`;
      const rec: AssetRecord = {
        key: node.id, filename, kind: "svg", bytes, hash, nodeName: node.name,
        width: "width" in node ? Math.round(node.width) : undefined,
        height: "height" in node ? Math.round(node.height) : undefined,
      };
      assets.set(node.id, rec);
      return { ...rec, svg };
    }

    if (kind === "video") {
      // Figma cannot export video bytes via the plugin API. Record the
      // reference + a poster frame so nothing is silently lost.
      const poster = await (node as ExportMixin).exportAsync({
        format: "PNG", constraint: { type: "SCALE", value: 2 },
      });
      const hash = hashBytes(poster);
      const filename = `${safe(node.name)}-${hash}-poster.png`;
      const rec: AssetRecord = {
        key: node.id, filename, kind: "video", bytes: poster, hash, nodeName: node.name,
        width: "width" in node ? Math.round(node.width) : undefined,
        height: "height" in node ? Math.round(node.height) : undefined,
      };
      assets.set(node.id, rec);
      return rec;
    }

    const bytes = await (node as ExportMixin).exportAsync({
      format: "PNG", constraint: { type: "SCALE", value: 2 },
    });
    const hash = hashBytes(bytes);
    const existing = findByHash(assets, hash);
    if (existing) return existing;
    const filename = `${safe(node.name)}-${hash}.png`;
    const rec: AssetRecord = {
      key: node.id, filename, kind: "image", bytes, hash, nodeName: node.name,
      width: "width" in node ? Math.round(node.width) : undefined,
      height: "height" in node ? Math.round(node.height) : undefined,
    };
    assets.set(node.id, rec);
    return rec;
  } catch (e) {
    console.warn(`asset export failed for "${node.name}":`, e);
    return null;
  }
}

/**
 * Export ONLY a frame's background fill, exactly as Figma crops it. Exporting
 * the frame itself bakes its children (text, buttons) into the PNG — the hero
 * background came out as black with white text. Clone, strip children, export,
 * delete. If the render is empty (a video fill exports black), fall back to the
 * raw image bytes so the reference is never silently lost.
 */
export async function captureFillImage(node: SceneNode, assets: AssetMap): Promise<AssetRecord | null> {
  const n = node as FrameNode;
  const existing = assets.get(`${node.id}:fill`);
  if (existing) return existing;
  let bytes: Uint8Array | null = null;
  let clone: SceneNode | null = null;
  try {
    clone = n.clone();
    const c = clone as FrameNode;
    if ("children" in c) [...c.children].forEach((ch) => ch.remove());
    c.effects = [];
    // Strokes/shadows are emitted as CSS; the PNG should be the fill alone.
    c.strokes = [];
    bytes = await c.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  } catch (e) {
    console.warn("fill export failed for", node.name, e);
  } finally {
    try { if (clone) clone.remove(); } catch (e) { /* already gone */ }
  }
  const area = ("width" in node ? (node as LayoutMixin).width : 0) * ("height" in node ? (node as LayoutMixin).height : 0) * 4;
  // A flat black/transparent render compresses to almost nothing.
  const fills = (node as unknown as { fills?: readonly Paint[] }).fills;
  const hasVideo = Array.isArray(fills) && fills.some((p) => p.visible !== false && (p.type as string) === "VIDEO");
  // A flat black render (video fills export black) compresses to almost nothing.
  const looksEmpty = !bytes || bytes.length < Math.max(2000, area / 200) || hasVideo;
  if (looksEmpty) {
    const img = Array.isArray(fills) ? fills.find((p) => p.visible !== false && p.type === "IMAGE") as ImagePaint | undefined : undefined;
    if (img && img.imageHash) {
      try {
        const raw = figma.getImageByHash(img.imageHash);
        if (raw) bytes = await raw.getBytesAsync();
      } catch (e) { console.warn("raw image fetch failed for", node.name, e); }
    }
  }
  if (!bytes) return null;
  const hash = hashBytes(bytes);
  const dup = findByHash(assets, hash);
  if (dup) return dup;
  const filename = `${safe(node.name)}-bg-${hash}.png`;
  const rec: AssetRecord = {
    key: `${node.id}:fill`, filename, kind: "image", bytes, hash, nodeName: node.name,
    width: "width" in node ? Math.round((node as LayoutMixin).width) : undefined,
    height: "height" in node ? Math.round((node as LayoutMixin).height) : undefined,
  };
  assets.set(rec.key, rec);
  return rec;
}

function findByHash(assets: AssetMap, hash: string): AssetRecord | null {
  for (const rec of assets.values()) if (rec.hash === hash) return rec;
  return null;
}
