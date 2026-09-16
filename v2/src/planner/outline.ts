/**
 * Compact, model-readable outline of an IR frame: one line per node with the
 * facts a STRUCTURE decision needs (id, name, type, box, layout, sizing,
 * content hints). No colours or radii — the compiler reads those itself.
 */
import type { IRFrame, IRNode } from "../ir/schema.ts";

export interface OutlineResult { text: string; ids: Set<string>; nodeCount: number; truncated: boolean }

const r = (n: number) => Math.round(n);
const trunc = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function describe(n: IRNode): string {
  const p: string[] = [`[${n.id}] "${trunc(n.name, 40)}" ${n.type} @${r(n.box.x)},${r(n.box.y)} ${r(n.box.w)}x${r(n.box.h)}`];
  if (n.layout) {
    let l = `layout=${n.layout.direction === "column" ? "col" : "row"}`;
    if (n.layout.wrap) l += "+wrap";
    if (n.layout.gap) l += ` gap=${r(n.layout.gap)}`;
    if (n.layout.justify !== "start") l += ` main=${n.layout.justify}`;
    if (n.layout.align !== "start") l += ` cross=${n.layout.align}`;
    if (n.layout.padding.some((v) => v)) l += ` pad=${n.layout.padding.map(r).join("/")}`;
    p.push(l);
  } else if (n.children.length) p.push("layout=none");
  if (n.clips) p.push("clip");
  p.push(`size=${n.sizing.w[0].toUpperCase()}/${n.sizing.h[0].toUpperCase()}`);
  if (n.positioning === "absolute") p.push("abs-in-autolayout");
  if (n.children.length) p.push(`kids=${n.children.length}`);
  if (n.text) {
    const s = n.text.segments[0];
    p.push(`text${s ? `(${r(s.fontSize)}px${n.text.lines > 1 ? `,${n.text.lines}ln` : ""})` : ""}="${trunc(n.text.characters, 48)}"`);
  }
  if (n.fills.some((f) => f.type === "image")) p.push("img-fill");
  if (n.fills.some((f) => f.type === "video")) p.push("video-fill");
  if (n.asset) p.push(n.children.length ? "exported-composite" : "asset");
  if (n.isMask) p.push("MASK");
  if (n.rotation) p.push(`rot=${r(n.rotation)}`);
  if (n.opacity < 1) p.push(`op=${n.opacity}`);
  if (n.type === "instance" && n.component) p.push(`instance(${trunc(n.component.setName || n.component.name, 24)})`);
  if (n.interactions.length) p.push(`reactions=${n.interactions.map((i) => i.trigger).join("+")}`);
  return p.join(" ");
}

export function buildOutline(frame: IRFrame, maxDepth = 7, maxLines = 1400): OutlineResult {
  const lines: string[] = []; const ids = new Set<string>(); let truncated = false, nodeCount = 0;
  const reg = (n: IRNode) => { ids.add(n.id); n.children.forEach(reg); };
  const visit = (n: IRNode, depth: number) => {
    nodeCount++; ids.add(n.id);
    if (lines.length < maxLines) lines.push("  ".repeat(depth) + describe(n)); else truncated = true;
    const kids = n.children;
    if (!kids.length) return;
    if (depth >= maxDepth) { if (lines.length < maxLines) lines.push("  ".repeat(depth + 1) + `… ${kids.length} deeper children omitted`); kids.forEach(reg); return; }
    const cap = depth <= 1 ? Infinity : depth <= 3 ? 12 : 8;
    kids.forEach((k, i) => { if (i < cap) visit(k, depth + 1); else reg(k); });
    if (kids.length > cap && lines.length < maxLines) {
      lines.push("  ".repeat(depth + 1) + `… +${kids.length - cap} more: ${trunc(kids.slice(cap).map((k) => `[${k.id}] "${trunc(k.name, 24)}"`).join(", "), 300)}`);
    }
  };
  visit(frame.root, 0);
  return { text: lines.join("\n"), ids, nodeCount, truncated };
}

export function outlineHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
