/**
 * Cross-frame matching for a page exported at several widths.
 *
 *  - `pairSections`: the same logical section on two frames (hero ↔ hero), by slug, then by role
 *    and shared copy, then by order. Written to `plans/responsive.plan.json` as `sectionPairs`.
 *  - `frameHints`: what the narrower frame (the designer's own phone layout) says about the wider
 *    frame's nodes — the reading order of its content, the alignment of its text, what was left
 *    out — so the wide frame's restructuring in the widths no frame was drawn for follows the
 *    designer's decisions instead of guessing.
 *
 * Matching is by copy: two text layers with the same characters are the same content. Pictures
 * match by asset file. Containers inherit from their text.
 */
import type { IRDocument, IRFrame, IRNode } from "../ir/schema.ts";
import { walk } from "../ir/schema.ts";
import type { Plan, ResponsivePlan } from "../ir/plan.ts";
import type { FrameHints } from "./responsive.ts";

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[‘’“”'"]/g, "").trim();
const key = (s: string): string => norm(s).slice(0, 40);

function textsUnder(n: IRNode): string[] {
  const out: string[] = [];
  walk(n, (k) => { if (k.text && k.text.characters.trim() && k.visible !== false) out.push(norm(k.text.characters)); });
  return out;
}
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** Pair the sections of frame `a` with those of frame `b` (both plans required). */
export function pairSections(fa: IRFrame, pa: Plan, fb: IRFrame, pb: Plan): Array<{ a: string; b: string; note: string }> {
  const byIdA = new Map<string, IRNode>(), byIdB = new Map<string, IRNode>();
  walk(fa.root, (n) => { byIdA.set(n.id, n); }); walk(fb.root, (n) => { byIdB.set(n.id, n); });
  const out: Array<{ a: string; b: string; note: string }> = [];
  const usedB = new Set<string>();
  const textsA = new Map(pa.sections.map((s) => [s.id, byIdA.has(s.id) ? textsUnder(byIdA.get(s.id)!) : []]));
  const textsB = new Map(pb.sections.map((s) => [s.id, byIdB.has(s.id) ? textsUnder(byIdB.get(s.id)!) : []]));
  // 1. same slug
  for (const sa of pa.sections) {
    const sb = pb.sections.find((s) => s.slug === sa.slug && !usedB.has(s.id));
    if (sb) { out.push({ a: sa.id, b: sb.id, note: "slug" }); usedB.add(sb.id); }
  }
  // 2. shared copy (best Jaccard over the unpaired), role as a tie-break
  for (const sa of pa.sections) {
    if (out.some((p) => p.a === sa.id)) continue;
    let best: { id: string; score: number } | null = null;
    for (const sb of pb.sections) {
      if (usedB.has(sb.id)) continue;
      let score = jaccard(textsA.get(sa.id) || [], textsB.get(sb.id) || []);
      if (sa.role && sa.role === sb.role) score += 0.25;
      if (score > 0.3 && (!best || score > best.score)) best = { id: sb.id, score };
    }
    if (best) { out.push({ a: sa.id, b: best.id, note: `copy ${Math.round(best.score * 100) / 100}` }); usedB.add(best.id); }
  }
  // Keep the wide frame's order.
  const orderA = new Map(pa.sections.map((s, i) => [s.id, i]));
  out.sort((x, y) => (orderA.get(x.a) ?? 0) - (orderA.get(y.a) ?? 0));
  return out;
}

/** Section pairs for every frame pair of the document (wider frame as `a`). */
export function pairAllSections(doc: IRDocument, plans: Map<string, Plan>): ResponsivePlan["sectionPairs"] {
  const frames = [...doc.frames].sort((x, y) => y.width - x.width);
  const out: ResponsivePlan["sectionPairs"] = [];
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
    const pa = plans.get(frames[i].id), pb = plans.get(frames[j].id);
    if (!pa || !pb || frames[i].width === frames[j].width) continue;
    out.push(...pairSections(frames[i], pa, frames[j], pb));
  }
  return out;
}

/**
 * Hints for `wide` from `narrow`. Text nodes match by characters (exact, then by the first 40
 * characters); pictures by asset file. A wide node's rank is the reading order (y, then x) of its
 * match in the narrow frame, relative to the paired section. Containers get no rank of their own:
 * the compiler takes the earliest rank among their text.
 */
export function frameHints(wide: IRFrame, wPlan: Plan, narrow: IRFrame, nPlan: Plan, pairs: ResponsivePlan["sectionPairs"]): FrameHints {
  const hints: FrameHints = { order: new Map(), align: new Map(), dropped: new Set() };
  const byIdW = new Map<string, IRNode>(), byIdN = new Map<string, IRNode>();
  walk(wide.root, (n) => { byIdW.set(n.id, n); }); walk(narrow.root, (n) => { byIdN.set(n.id, n); });
  const relevant = pairs.length ? pairs : pairSections(wide, wPlan, narrow, nPlan);
  for (const p of relevant) {
    const sw = byIdW.get(p.a), sn = byIdN.get(p.b);
    if (!sw || !sn) continue;
    // Narrow frame: content leaves in reading order.
    const leavesN: Array<{ n: IRNode; k: string; y: number; x: number }> = [];
    walk(sn, (n) => {
      if (n.visible === false) return;
      if (n.text && n.text.characters.trim()) leavesN.push({ n, k: `t:${key(n.text.characters)}`, y: n.box.y, x: n.box.x });
      else if (n.asset) leavesN.push({ n, k: `a:${n.asset}`, y: n.box.y, x: n.box.x });
    });
    leavesN.sort((a, b) => a.y - b.y || a.x - b.x);
    const rankN = new Map<string, number>(); const nodeN = new Map<string, IRNode>();
    leavesN.forEach((l, i) => { if (!rankN.has(l.k)) { rankN.set(l.k, i); nodeN.set(l.k, l.n); } });
    // Wide frame: match each leaf; unmatched text-bearing nodes are "dropped" by the designer.
    walk(sw, (n) => {
      if (n.visible === false) return;
      let k: string | null = null;
      if (n.text && n.text.characters.trim()) k = `t:${key(n.text.characters)}`;
      else if (n.asset) k = `a:${n.asset}`;
      if (!k) return;
      const r = rankN.get(k);
      if (r === undefined) { if (k.startsWith("t:")) hints.dropped.add(n.id); return; }
      hints.order.set(n.id, r);
      const m = nodeN.get(k);
      if (n.text && m?.text && m.text.align !== n.text.align) hints.align.set(n.id, m.text.align);
    });
  }
  return hints;
}
