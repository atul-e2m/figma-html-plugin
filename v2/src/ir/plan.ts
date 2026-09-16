/**
 * figma-plan/1 — the DECISIONS layer.
 *
 * Produced by the planner (heuristics, or the model reading the IR + the
 * screenshot) and consumed by the compiler. Every entry points at IR node ids.
 * There is deliberately no field for a pixel value: the plan says WHAT a node
 * is, the IR says how big it is.
 */

export const PLAN_SCHEMA_ID = "figma-plan/1" as const;

export type PlanLayout = "flow" | "grid" | "overlay" | "absolute";
export type PlanSectionTag = "header" | "section" | "footer" | "nav" | "main" | "aside" | "div";

export interface PlanSection {
  id: string;
  slug: string;
  tag: PlanSectionTag;
  role: string;
  /** Loose layers elsewhere in the tree that visually belong inside this section. */
  attach: string[];
  confidence: number;
  note: string;
}

export interface PlanContainer {
  id: string;
  layout: PlanLayout;
  /** flow without auto-layout only. */
  direction: "row" | "column" | "";
  /** grid only. 0 = infer from the first row. */
  columns: number;
  /** overlay only: the backdrop node. "" = infer. */
  base: string;
  note: string;
}

export interface PlanBreakpoint {
  name: string;
  /** Viewport min-width where this frame takes over (0 for the smallest). */
  minWidth: number;
  frameId: string;
}

export type ResponsiveAction = "stack" | "wrap" | "row" | "hide" | "columns" | "full-width" | "center" | "keep";
export interface ResponsiveEntry { id: string; at: "tablet" | "phone"; action: ResponsiveAction; columns: number; note: string }

export interface Plan {
  schema: typeof PLAN_SCHEMA_ID;
  frameId: string;
  source: "heuristic" | "model";
  model: string;
  pageRoot: string;
  page: { title: string; lang: string };
  sections: PlanSection[];
  containers: PlanContainer[];
  tags: Array<{ id: string; tag: string }>;
  links: Array<{ id: string; href: string }>;
  decorations: Array<{ id: string; treatment: "rasterize" | "ignore"; note: string }>;
  textPolicy: Array<{ id: string; policy: "reflow" | "fixed" }>;
  repeaters: Array<{ id: string; name: string; itemIds: string[] }>;
  ignore: string[];
  /** Per-node overrides of the compiler's responsive heuristics (single-frame designs). */
  responsive: ResponsiveEntry[];
  notes: string;
}

/** Cross-frame decisions when several breakpoint frames were extracted. */
export interface ResponsivePlan {
  schema: "figma-responsive-plan/1";
  breakpoints: PlanBreakpoint[];
  /** Same logical section on two frames. */
  sectionPairs: Array<{ a: string; b: string; note: string }>;
}

export const VALID_TAGS = new Set<string>([
  "section", "div", "header", "footer", "nav", "main", "article", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "ul", "ol", "li", "figure", "blockquote", "label",
]);

export interface PlanIndex {
  plan: Plan;
  containers: Map<string, PlanContainer>;
  tags: Map<string, string>;
  links: Map<string, string>;
  decorations: Map<string, "rasterize" | "ignore">;
  text: Map<string, "reflow" | "fixed">;
  repeaters: Map<string, { name: string; itemIds: string[] }>;
  responsive: Map<string, ResponsiveEntry[]>;
  ignore: Set<string>;
  sectionIds: Set<string>;
  attached: Set<string>;
}

export function indexPlan(plan: Plan): PlanIndex {
  const idx: PlanIndex = {
    plan, containers: new Map(), tags: new Map(), links: new Map(), decorations: new Map(),
    text: new Map(), repeaters: new Map(), responsive: new Map(), ignore: new Set(plan.ignore), sectionIds: new Set(), attached: new Set(),
  };
  for (const r of plan.responsive || []) { if (!idx.responsive.has(r.id)) idx.responsive.set(r.id, []); idx.responsive.get(r.id)!.push(r); }
  for (const c of plan.containers) idx.containers.set(c.id, c);
  for (const t of plan.tags) idx.tags.set(t.id, t.tag);
  for (const l of plan.links) idx.links.set(l.id, l.href);
  for (const d of plan.decorations) idx.decorations.set(d.id, d.treatment);
  for (const t of plan.textPolicy) idx.text.set(t.id, t.policy);
  for (const r of plan.repeaters) idx.repeaters.set(r.id, { name: r.name, itemIds: r.itemIds });
  for (const s of plan.sections) { idx.sectionIds.add(s.id); for (const a of s.attach) idx.attached.add(a); }
  return idx;
}

/**
 * Coerce anything (model output, a hand-edited file) into a well-formed Plan.
 * Unknown ids are dropped, enums are clamped, slugs are made unique.
 */
export function normalizePlan(raw: unknown, knownIds: Set<string>, frameId: string, fallbackRoot: string): Plan {
  const r = (raw || {}) as Partial<Plan> & Record<string, unknown>;
  const has = (id: unknown): id is string => typeof id === "string" && knownIds.has(id);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "section";
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const seen = new Set<string>();
  const sections: PlanSection[] = [];
  for (const s of arr<Partial<PlanSection>>(r.sections)) {
    if (!s || !has(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    sections.push({
      id: s.id,
      slug: slug(String(s.slug || s.role || s.id)),
      tag: (["header", "section", "footer", "nav", "main", "aside", "div"] as PlanSectionTag[]).includes(s.tag as PlanSectionTag)
        ? (s.tag as PlanSectionTag) : "section",
      role: String(s.role || ""),
      attach: arr<string>(s.attach).filter(has).filter((a) => a !== s.id),
      confidence: typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : 0.5,
      note: String(s.note || ""),
    });
  }
  const used = new Set<string>();
  for (const s of sections) { let sl = s.slug, i = 2; while (used.has(sl)) sl = `${s.slug}-${i++}`; used.add(sl); s.slug = sl; }

  const page = (r.page || {}) as Partial<Plan["page"]>;
  return {
    schema: PLAN_SCHEMA_ID,
    frameId,
    source: r.source === "model" ? "model" : "heuristic",
    model: String(r.model || ""),
    pageRoot: has(r.pageRoot) ? r.pageRoot : fallbackRoot,
    page: { title: String(page.title || ""), lang: String(page.lang || "en") },
    sections,
    containers: arr<Partial<PlanContainer>>(r.containers).filter((c) => c && has(c.id)).map((c) => ({
      id: c.id as string,
      layout: (["flow", "grid", "overlay", "absolute"] as PlanLayout[]).includes(c.layout as PlanLayout) ? (c.layout as PlanLayout) : "flow",
      direction: c.direction === "row" || c.direction === "column" ? c.direction : "",
      columns: typeof c.columns === "number" && c.columns > 0 ? Math.round(c.columns) : 0,
      base: has(c.base) ? c.base : "",
      note: String(c.note || ""),
    })),
    tags: arr<{ id: string; tag: string }>(r.tags).filter((t) => t && has(t.id) && VALID_TAGS.has(String(t.tag)))
      .map((t) => ({ id: t.id, tag: String(t.tag) })),
    links: arr<{ id: string; href: string }>(r.links).filter((l) => l && has(l.id) && typeof l.href === "string" && l.href)
      .map((l) => ({ id: l.id, href: l.href })),
    decorations: arr<{ id: string; treatment: string; note?: string }>(r.decorations).filter((d) => d && has(d.id)).map((d) => ({
      id: d.id, treatment: d.treatment === "ignore" ? "ignore" as const : "rasterize" as const, note: String(d.note || ""),
    })),
    textPolicy: arr<{ id: string; policy: string }>(r.textPolicy).filter((t) => t && has(t.id)).map((t) => ({
      id: t.id, policy: t.policy === "fixed" ? "fixed" as const : "reflow" as const,
    })),
    repeaters: arr<{ id: string; name?: string; itemIds?: string[] }>(r.repeaters).filter((x) => x && has(x.id)).map((x) => ({
      id: x.id, name: slug(String(x.name || "items")), itemIds: arr<string>(x.itemIds).filter(has),
    })),
    ignore: arr<string>(r.ignore).filter(has),
    responsive: normalizeResponsive(r.responsive, knownIds),
    notes: String(r.notes || ""),
  };
}

const RESPONSIVE_ACTIONS = new Set<string>(["stack", "wrap", "row", "hide", "columns", "full-width", "center", "keep"]);
export function normalizeResponsive(raw: unknown, knownIds: Set<string>): ResponsiveEntry[] {
  const out: ResponsiveEntry[] = [];
  for (const e of (Array.isArray(raw) ? raw : []) as Array<Partial<ResponsiveEntry>>) {
    if (!e || typeof e.id !== "string" || !knownIds.has(e.id)) continue;
    const at = e.at === "tablet" ? "tablet" : "phone";
    const action = RESPONSIVE_ACTIONS.has(String(e.action)) ? (e.action as ResponsiveAction) : null;
    if (!action) continue;
    out.push({ id: e.id, at, action, columns: action === "columns" && typeof e.columns === "number" && e.columns > 0 ? Math.round(e.columns) : 0, note: String(e.note || "") });
  }
  return out;
}

/** Structured-output schema for the responsive pass. */
export const RESPONSIVE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["responsive", "notes"],
  properties: {
    responsive: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "at", "action", "columns", "note"],
        properties: {
          id: { type: "string", description: "Node id from the outline." },
          at: { type: "string", enum: ["tablet", "phone"], description: "tablet = up to 1024px wide; phone = up to 767px." },
          action: { type: "string", enum: ["stack", "wrap", "row", "hide", "columns", "full-width", "center", "keep"] },
          columns: { type: "integer", description: "Only for action=columns (grid column count at that width). 0 otherwise." },
          note: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
} as const;

/** JSON schema for structured outputs: every object closed, every key required. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pageRoot", "page", "sections", "containers", "tags", "links", "decorations", "textPolicy", "repeaters", "ignore", "notes"],
  properties: {
    pageRoot: { type: "string", description: "Node id of the frame whose children are the page sections stacked top-to-bottom." },
    page: {
      type: "object", additionalProperties: false, required: ["title", "lang"],
      properties: {
        title: { type: "string", description: "A short page title for <title>, from the hero headline or brand." },
        lang: { type: "string", description: "BCP-47 language of the copy, e.g. en." },
      },
    },
    sections: {
      type: "array", description: "Every visible top-level section in visual order.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "slug", "tag", "role", "attach", "confidence", "note"],
        properties: {
          id: { type: "string" },
          slug: { type: "string", description: "kebab-case, e.g. hero, tours, footer." },
          tag: { type: "string", enum: ["header", "section", "footer", "nav", "main", "aside", "div"] },
          role: { type: "string", description: "header|hero|about|cards|features|testimonials|gallery|cta|news|footer|other" },
          attach: { type: "array", items: { type: "string" }, description: "Loose layer ids that visually sit inside this section." },
          confidence: { type: "number" },
          note: { type: "string" },
        },
      },
    },
    containers: {
      type: "array", description: "Layout kind only where Figma's own data is missing or misleading.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "layout", "direction", "columns", "base", "note"],
        properties: {
          id: { type: "string" },
          layout: { type: "string", enum: ["flow", "grid", "overlay", "absolute"] },
          direction: { type: "string", enum: ["row", "column", ""] },
          columns: { type: "integer" },
          base: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    tags: {
      type: "array", description: "Semantic HTML tag per node where the default would be wrong.",
      items: {
        type: "object", additionalProperties: false, required: ["id", "tag"],
        properties: {
          id: { type: "string" },
          tag: { type: "string", enum: ["section", "div", "header", "footer", "nav", "main", "article", "aside",
            "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "ul", "ol", "li", "figure", "blockquote", "label"] },
        },
      },
    },
    links: {
      type: "array", description: "Nodes that are links, with the href when it is visible in the design (else #).",
      items: { type: "object", additionalProperties: false, required: ["id", "href"], properties: { id: { type: "string" }, href: { type: "string" } } },
    },
    decorations: {
      type: "array", description: "Layers CSS cannot rebuild: rasterize (one flattened PNG) or ignore.",
      items: {
        type: "object", additionalProperties: false, required: ["id", "treatment", "note"],
        properties: { id: { type: "string" }, treatment: { type: "string", enum: ["rasterize", "ignore"] }, note: { type: "string" } },
      },
    },
    textPolicy: {
      type: "array", description: "reflow = may grow when the browser wraps differently; fixed = keep exact height.",
      items: { type: "object", additionalProperties: false, required: ["id", "policy"], properties: { id: { type: "string" }, policy: { type: "string", enum: ["reflow", "fixed"] } } },
    },
    repeaters: {
      type: "array", description: "Containers whose children are repeated items of one kind (cards, nav links, logos).",
      items: {
        type: "object", additionalProperties: false, required: ["id", "name", "itemIds"],
        properties: { id: { type: "string" }, name: { type: "string" }, itemIds: { type: "array", items: { type: "string" } } },
      },
    },
    ignore: { type: "array", items: { type: "string" } },
    notes: { type: "string", description: "2-4 sentences: the biggest risks in this conversion." },
  },
} as const;
