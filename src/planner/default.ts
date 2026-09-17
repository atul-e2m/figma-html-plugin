/**
 * Heuristic plan — what the compiler runs on when no model is available.
 * Designers wrap the real page in a frame and leave stray layers beside it:
 *  1. descend through single-child wrappers;
 *  2. a child covering most of the frame with several children IS the page;
 *  3. wide siblings fully above/below it (a separate footer) are sections too.
 */
import { type IRDocument, type IRFrame, type IRNode, slugify, walk } from "../ir/schema.ts";
import { PLAN_SCHEMA_ID, type Plan, type ResponsivePlan } from "../ir/plan.ts";
import { pairAllSections } from "../compiler/pairs.ts";

function roleFromName(name: string): string {
  const n = name.toLowerCase();
  if (/\b(header|masthead|navbar|nav)\b/.test(n)) return "header";
  if (/\b(footer)\b/.test(n)) return "footer";
  if (/\b(hero|banner)\b/.test(n)) return "hero";
  if (/\b(testimonial|review)/.test(n)) return "testimonials";
  if (/\b(cta|call to action)\b/.test(n)) return "cta";
  if (/\b(gallery|instagram|photos)\b/.test(n)) return "gallery";
  if (/\b(news|blog|article)/.test(n)) return "news";
  if (/\b(about)\b/.test(n)) return "about";
  if (/\b(feature|why|benefit)/.test(n)) return "features";
  if (/\b(card|tour|product|service|pricing|plan)/.test(n)) return "cards";
  return "";
}

function pageTitle(frame: IRFrame): string {
  let best: IRNode | null = null, bestSize = 0;
  walk(frame.root, (n) => {
    if (n.text && n.text.segments[0] && n.text.characters.trim().length >= 3 && n.text.characters.trim().length <= 80) {
      const s = n.text.segments[0].fontSize;
      if (s > bestSize) { bestSize = s; best = n; }
    }
  });
  const b = best as IRNode | null;
  return b && b.text ? b.text.characters.replace(/\s+/g, " ").trim() : frame.name;
}

export function defaultPlan(frame: IRFrame): Plan {
  let root: IRNode = frame.root;
  for (let guard = 0; guard < 4; guard++) {
    if (root.children.length === 1 && root.children[0].children.length > 1) root = root.children[0]; else break;
  }
  const kids = root.children;
  const rootArea = Math.max(1, root.box.w * root.box.h);
  const page = kids.find((c) => c.children.length >= 3 && (c.box.w * c.box.h) / rootArea >= 0.6);
  let sectionNodes: IRNode[];
  if (page) {
    sectionNodes = [...page.children];
    for (const sib of kids) {
      if (sib.id === page.id) continue;
      const b = sib.box;
      const outside = b.y >= page.box.y + page.box.h - 2 || b.y + b.h <= page.box.y + 2;
      if (outside && b.w >= page.box.w * 0.6) sectionNodes.push(sib);
    }
    root = page;
  } else sectionNodes = kids.length > 1 ? kids : [root];
  sectionNodes = sectionNodes.filter((c) => c.box.w >= 200 && c.box.h >= 40);
  sectionNodes.sort((a, b) => a.box.y - b.box.y);
  const used = new Set<string>();
  const sections = sectionNodes.map((c) => {
    let slug = slugify(c.name, "section"), i = 2; while (used.has(slug)) slug = `${slugify(c.name, "section")}-${i++}`; used.add(slug);
    const role = roleFromName(c.name);
    const tag = role === "header" ? "header" as const : role === "footer" ? "footer" as const : "section" as const;
    return { id: c.id, slug, tag, role, attach: [], confidence: 0.5, note: "heuristic" };
  });

  // Text policy: multi-line paragraphs may reflow; single-line labels are fixed.
  const textPolicy: Plan["textPolicy"] = [];
  walk(frame.root, (n) => {
    if (!n.text) return;
    const chars = n.text.characters.trim();
    if (n.text.lines > 1 || chars.length > 80) textPolicy.push({ id: n.id, policy: "reflow" });
  });

  return {
    schema: PLAN_SCHEMA_ID, frameId: frame.id, source: "heuristic", model: "",
    pageRoot: root.id,
    page: { title: pageTitle(frame), lang: "en" },
    sections, containers: [], tags: [], links: [], decorations: [], textPolicy, repeaters: [], ignore: [], responsive: [],
    notes: "heuristic plan: sections are the children of the largest page frame; no model was consulted",
  };
}

export function defaultResponsivePlan(doc: IRDocument, plans?: Map<string, Plan>): ResponsivePlan | null {
  if (doc.frames.length < 2) return null;
  const sorted = [...doc.frames].sort((a, b) => a.width - b.width);
  const breakpoints = sorted.map((f, i) => {
    const prev = sorted[i - 1];
    const minWidth = i === 0 ? 0 : f.width > 1024 ? (prev.width <= 500 ? 768 : 1024) : Math.round((prev.width + f.width) / 2);
    const name = f.width <= 500 ? "mobile" : f.width <= 1024 ? "tablet" : "desktop";
    return { name, minWidth, frameId: f.id };
  });
  return { schema: "figma-responsive-plan/1", breakpoints, sectionPairs: plans ? pairAllSections(doc, plans) : [] };
}
