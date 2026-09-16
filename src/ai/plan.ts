/**
 * The layout PLAN — the contract between the AI planner and the walker.
 *
 * Principle: the model decides STRUCTURE (which node is the page, what the
 * sections are, whether a container flows / grids / overlays, what a node
 * semantically is). Code reads every measurement (padding, gap, colour,
 * size) exactly from Figma. The schema deliberately has no field for a pixel
 * value, so the model cannot invent one.
 */

export type PlanLayout = "flow" | "grid" | "overlay" | "absolute";
export type PlanSectionTag = "header" | "section" | "footer" | "nav" | "main" | "div";

export interface PlanSection {
  id: string;
  slug: string;
  tag: PlanSectionTag;
  role: string;
  /** Loose layers (siblings elsewhere in the tree) that visually belong inside this section. */
  attach: string[];
  /** 0..1 — low values are surfaced in the UI so a designer can double-check. */
  confidence: number;
  note: string;
}

export interface PlanContainer {
  id: string;
  layout: PlanLayout;
  /** Only used when layout=flow and Figma has no auto-layout to read. */
  direction: "row" | "column" | "";
  /** Only used when layout=grid. 0 = let code infer from the first row. */
  columns: number;
  /** Only used when layout=overlay: the node that is the backdrop. "" = largest child. */
  base: string;
  note: string;
}

export interface PlanTagOverride { id: string; tag: string }
export interface PlanDecoration { id: string; treatment: "rasterize" | "ignore"; note: string }
export interface PlanTextPolicy { id: string; policy: "reflow" | "fixed" }

export interface Plan {
  planVersion: number;
  pageRoot: string;
  sections: PlanSection[];
  containers: PlanContainer[];
  tagOverrides: PlanTagOverride[];
  decorations: PlanDecoration[];
  textPolicy: PlanTextPolicy[];
  ignore: string[];
  notes: string;
}

/** Fast lookups for the walker. */
export interface PlanIndex {
  plan: Plan;
  containers: Map<string, PlanContainer>;
  tags: Map<string, string>;
  decorations: Map<string, PlanDecoration>;
  text: Map<string, PlanTextPolicy>;
  ignore: Set<string>;
  sectionIds: Set<string>;
  attached: Set<string>;
}

export function indexPlan(plan: Plan): PlanIndex {
  const idx: PlanIndex = {
    plan,
    containers: new Map(),
    tags: new Map(),
    decorations: new Map(),
    text: new Map(),
    ignore: new Set(plan.ignore || []),
    sectionIds: new Set(),
    attached: new Set(),
  };
  for (const c of plan.containers || []) idx.containers.set(c.id, c);
  for (const t of plan.tagOverrides || []) idx.tags.set(t.id, t.tag);
  for (const d of plan.decorations || []) idx.decorations.set(d.id, d);
  for (const t of plan.textPolicy || []) idx.text.set(t.id, t);
  for (const s of plan.sections || []) {
    idx.sectionIds.add(s.id);
    for (const a of s.attach || []) idx.attached.add(a);
  }
  return idx;
}

/**
 * Coerce whatever the model returned into a well-formed Plan. Structured
 * outputs guarantee the shape; this guards against empty arrays / nulls and
 * strips ids that do not exist in the document.
 */
export function normalizePlan(raw: unknown, knownIds: Set<string>, fallbackRoot: string): Plan {
  const r = (raw || {}) as Partial<Plan>;
  const has = (id: unknown): id is string => typeof id === "string" && knownIds.has(id);
  const slugify = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "section";

  const seen = new Set<string>();
  const sections: PlanSection[] = [];
  for (const s of r.sections || []) {
    if (!s || !has(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    sections.push({
      id: s.id,
      slug: slugify(String(s.slug || s.role || s.id)),
      tag: (["header", "section", "footer", "nav", "main", "div"] as PlanSectionTag[])
        .includes(s.tag as PlanSectionTag) ? (s.tag as PlanSectionTag) : "section",
      role: String(s.role || ""),
      attach: (s.attach || []).filter(has).filter((a) => a !== s.id),
      confidence: typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : 0.5,
      note: String(s.note || ""),
    });
  }
  // Slugs must be unique — they become file names and CSS hooks.
  const used = new Set<string>();
  for (const s of sections) {
    let sl = s.slug, i = 2;
    while (used.has(sl)) sl = `${s.slug}-${i++}`;
    used.add(sl); s.slug = sl;
  }

  return {
    planVersion: 1,
    pageRoot: has(r.pageRoot) ? r.pageRoot : fallbackRoot,
    sections,
    containers: (r.containers || []).filter((c) => c && has(c.id)).map((c) => ({
      id: c.id,
      layout: (["flow", "grid", "overlay", "absolute"] as PlanLayout[]).includes(c.layout)
        ? c.layout : "flow",
      direction: c.direction === "row" || c.direction === "column" ? c.direction : "",
      columns: typeof c.columns === "number" && c.columns > 0 ? Math.round(c.columns) : 0,
      base: has(c.base) ? c.base : "",
      note: String(c.note || ""),
    })),
    tagOverrides: (r.tagOverrides || []).filter((t) => t && has(t.id) && typeof t.tag === "string"),
    decorations: (r.decorations || []).filter((d) => d && has(d.id)).map((d) => ({
      id: d.id,
      treatment: d.treatment === "ignore" ? "ignore" : "rasterize",
      note: String(d.note || ""),
    })),
    textPolicy: (r.textPolicy || []).filter((t) => t && has(t.id)).map((t) => ({
      id: t.id, policy: t.policy === "fixed" ? "fixed" : "reflow",
    })),
    ignore: (r.ignore || []).filter(has),
    notes: String(r.notes || ""),
  };
}

/**
 * JSON schema for structured outputs. Every object closes with
 * additionalProperties:false and lists all keys as required (the API's
 * constraint); optional-ness is expressed with "" / 0 / [] sentinels.
 */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["planVersion", "pageRoot", "sections", "containers", "tagOverrides",
             "decorations", "textPolicy", "ignore", "notes"],
  properties: {
    planVersion: { type: "integer", description: "Always 1." },
    pageRoot: {
      type: "string",
      description: "Figma node id of the frame that IS the page (its children flow top-to-bottom). Usually the deepest frame that still contains every visible section.",
    },
    sections: {
      type: "array",
      description: "Every visible top-level page section, in visual top-to-bottom order.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "slug", "tag", "role", "attach", "confidence", "note"],
        properties: {
          id: { type: "string", description: "Figma node id of the section's root frame." },
          slug: { type: "string", description: "kebab-case name, e.g. hero, tours, footer." },
          tag: { type: "string", enum: ["header", "section", "footer", "nav", "main", "div"] },
          role: { type: "string", description: "One word: header|hero|about|cards|features|testimonials|gallery|cta|news|footer|other." },
          attach: {
            type: "array", items: { type: "string" },
            description: "Node ids of loose layers that live elsewhere in the tree but visually sit inside this section (decorative photos, badges, dividers). They will be positioned inside it.",
          },
          confidence: { type: "number", description: "0..1 how sure you are this is a real section with the right root." },
          note: { type: "string", description: "One short sentence: why this node, or what is uncertain. Empty string if obvious." },
        },
      },
    },
    containers: {
      type: "array",
      description: "Layout kind for containers where Figma's own data is missing or misleading. Omit containers whose auto-layout is correct as-is.",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "layout", "direction", "columns", "base", "note"],
        properties: {
          id: { type: "string" },
          layout: {
            type: "string", enum: ["flow", "grid", "overlay", "absolute"],
            description: "flow = children follow each other (flex); grid = repeated cards in rows and columns; overlay = children stack on top of each other (hero text over photo); absolute = keep exact coordinates.",
          },
          direction: { type: "string", enum: ["row", "column", ""], description: "For flow without auto-layout. \"\" otherwise." },
          columns: { type: "integer", description: "For grid: number of columns. 0 otherwise." },
          base: { type: "string", description: "For overlay: node id of the backdrop layer (the photo/video). \"\" to use the largest child." },
          note: { type: "string" },
        },
      },
    },
    tagOverrides: {
      type: "array",
      description: "HTML tag corrections. Use for: card titles that are not page headings (h3), containers wrongly named like buttons (section/div), real buttons (button), links (a), lists (ul/li), paragraphs (p).",
      items: {
        type: "object", additionalProperties: false, required: ["id", "tag"],
        properties: {
          id: { type: "string" },
          tag: { type: "string", enum: ["section", "div", "header", "footer", "nav", "main", "article",
                 "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "ul", "li", "img"] },
        },
      },
    },
    decorations: {
      type: "array",
      description: "Purely visual layers CSS cannot rebuild from parts: masked shapes, torn-paper edges, rotated photo collages, complex vector groups, maps with pins. rasterize = export one flattened PNG in place; ignore = drop (guides, hidden helpers).",
      items: {
        type: "object", additionalProperties: false, required: ["id", "treatment", "note"],
        properties: {
          id: { type: "string" },
          treatment: { type: "string", enum: ["rasterize", "ignore"] },
          note: { type: "string" },
        },
      },
    },
    textPolicy: {
      type: "array",
      description: "reflow = this text box (or the frame directly holding it) may grow when the browser wraps differently — use for paragraphs and multi-line copy; fixed = keep exact height (single-line labels, buttons).",
      items: {
        type: "object", additionalProperties: false, required: ["id", "policy"],
        properties: { id: { type: "string" }, policy: { type: "string", enum: ["reflow", "fixed"] } },
      },
    },
    ignore: {
      type: "array", items: { type: "string" },
      description: "Node ids to drop entirely: invisible helpers, duplicated states, off-canvas scraps.",
    },
    notes: { type: "string", description: "2-4 sentences: the biggest risks in this conversion." },
  },
} as const;
