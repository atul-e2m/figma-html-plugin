/**
 * Compact, model-readable outline of a Figma subtree.
 *
 * One line per node, indented by depth. Only what a layout decision needs:
 * id, name, type, box, auto-layout facts, sizing, child count, content hints.
 * Exact CSS values (colours, radii, shadows) are NOT included — the code reads
 * those itself, the model does not need them to decide structure.
 */

export interface OutlineResult {
  text: string;
  ids: Set<string>;
  nodeCount: number;
  truncated: boolean;
}

const r = (n: number) => Math.round(n);

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function describe(node: SceneNode, rootAbs: { x: number; y: number }): string {
  const parts: string[] = [];
  const abs = (node as LayoutMixin & { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox;
  const box = abs
    ? `@${r(abs.x - rootAbs.x)},${r(abs.y - rootAbs.y)} ${r(abs.width)}x${r(abs.height)}`
    : ("width" in node ? `${r((node as LayoutMixin).width)}x${r((node as LayoutMixin).height)}` : "");
  parts.push(`[${node.id}] "${trunc(node.name, 40)}" ${node.type} ${box}`);

  const f = node as unknown as FrameNode;
  if ("layoutMode" in node) {
    if (f.layoutMode && f.layoutMode !== "NONE") {
      let l = `layout=${f.layoutMode === "VERTICAL" ? "col" : "row"}`;
      if (f.layoutWrap === "WRAP") l += "+wrap";
      if (f.itemSpacing) l += ` gap=${r(f.itemSpacing)}`;
      if (f.primaryAxisAlignItems && f.primaryAxisAlignItems !== "MIN") l += ` main=${f.primaryAxisAlignItems.toLowerCase()}`;
      if (f.counterAxisAlignItems && f.counterAxisAlignItems !== "MIN") l += ` cross=${f.counterAxisAlignItems.toLowerCase()}`;
      const p = [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft].map((v) => r(v || 0));
      if (p.some((v) => v)) l += ` pad=${p.join("/")}`;
      parts.push(l);
    } else {
      parts.push("layout=none");
    }
    if (f.clipsContent) parts.push("clip");
  }
  const sz = node as unknown as { layoutSizingHorizontal?: string; layoutSizingVertical?: string; layoutPositioning?: string };
  if (sz.layoutSizingHorizontal || sz.layoutSizingVertical) {
    parts.push(`size=${(sz.layoutSizingHorizontal || "?")[0]}/${(sz.layoutSizingVertical || "?")[0]}`);
  }
  if (sz.layoutPositioning === "ABSOLUTE") parts.push("abs-in-autolayout");

  if ("children" in node) parts.push(`kids=${(node as ChildrenMixin).children.length}`);

  if (node.type === "TEXT") {
    const t = node as TextNode;
    const fs = typeof t.fontSize === "number" ? r(t.fontSize) : 0;
    const lines = t.characters.split("\n").length;
    parts.push(`text${fs ? `(${fs}px${lines > 1 ? `,${lines}ln` : ""})` : ""}="${trunc(t.characters, 48)}"`);
  }
  const fills = (node as unknown as { fills?: readonly Paint[] | symbol }).fills;
  if (Array.isArray(fills)) {
    if (fills.some((p) => p.visible !== false && p.type === "IMAGE")) parts.push("img-fill");
    if (fills.some((p) => p.visible !== false && (p.type as string) === "VIDEO")) parts.push("video-fill");
  }
  if ((node as unknown as { isMask?: boolean }).isMask) parts.push("MASK");
  const rot = (node as unknown as { rotation?: number }).rotation;
  if (typeof rot === "number" && Math.abs(rot) > 0.5) parts.push(`rot=${r(rot)}`);
  const op = (node as unknown as { opacity?: number }).opacity;
  if (typeof op === "number" && op < 1) parts.push(`op=${Math.round(op * 100) / 100}`);
  if (node.visible === false) parts.push("HIDDEN");
  if (node.type === "INSTANCE") parts.push("instance");
  return parts.join(" ");
}

/**
 * Build the outline. Depth and per-parent child caps keep it within a
 * sensible token budget while never hiding the top of the tree, which is
 * where every section-level decision is made.
 */
export function buildOutline(root: SceneNode, maxDepth = 7, maxLines = 1400): OutlineResult {
  const lines: string[] = [];
  const ids = new Set<string>();
  let truncated = false;
  let nodeCount = 0;
  const abs = (root as unknown as { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox;
  const rootAbs = abs ? { x: abs.x, y: abs.y } : { x: 0, y: 0 };

  const visit = (node: SceneNode, depth: number) => {
    if (node.visible === false) return;          // hidden layers do not render
    nodeCount++;
    ids.add(node.id);
    if (lines.length < maxLines) lines.push("  ".repeat(depth) + describe(node, rootAbs));
    else truncated = true;
    if (!("children" in node)) return;
    const kids = (node as ChildrenMixin).children.filter((c) => c.visible !== false);
    if (depth >= maxDepth) {
      if (kids.length && lines.length < maxLines) lines.push("  ".repeat(depth + 1) + `… ${kids.length} deeper children omitted`);
      // Still register ids so plan references to them validate.
      const reg = (n: SceneNode) => { ids.add(n.id); if ("children" in n) (n as ChildrenMixin).children.forEach(reg); };
      kids.forEach(reg);
      return;
    }
    // Repeated siblings (card grids, nav items): show the first few fully,
    // then summarise. Top two levels are never summarised.
    const cap = depth <= 1 ? Infinity : depth <= 3 ? 12 : 8;
    kids.forEach((k, i) => {
      if (i < cap) visit(k, depth + 1);
      else { ids.add(k.id); const reg = (n: SceneNode) => { ids.add(n.id); if ("children" in n) (n as ChildrenMixin).children.forEach(reg); }; reg(k); }
    });
    if (kids.length > cap && lines.length < maxLines) {
      const rest = kids.slice(cap).map((k) => `[${k.id}] "${trunc(k.name, 24)}"`).join(", ");
      lines.push("  ".repeat(depth + 1) + `… +${kids.length - cap} more: ${trunc(rest, 300)}`);
    }
  };
  visit(root, 0);
  return { text: lines.join("\n"), ids, nodeCount, truncated };
}

/** FNV-1a over the outline text: a stable cache key that changes when the design changes. */
export function outlineHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
