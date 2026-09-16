/**
 * Prompt text for the two AI calls: PLAN (before the walk) and REFINE (after
 * the rendered page has been measured). The request bodies are assembled here
 * in the main thread; the UI iframe only attaches screenshots + the API key
 * and performs the fetch (the plugin sandbox has no network).
 */
import { PLAN_SCHEMA, Plan } from "./plan";

export const AI_MODEL = "claude-opus-5";

export const PLAN_SYSTEM = `You are the layout planner inside a Figma-to-HTML converter.

You receive (1) screenshots of a Figma frame, sliced into strips top-to-bottom, and (2) a text outline of its layer tree: one line per layer with its node id in [brackets], name, type, box "@x,y wxh" relative to the frame's top-left in design pixels, auto-layout facts, sizing (F=fill, H=hug, X=fixed) and content hints.

Your job is to decide STRUCTURE only. Deterministic code will read every measurement (padding, gap, colours, fonts, sizes) from Figma exactly; you never output pixel values. You decide:

1. pageRoot — the frame whose children are the page sections stacked top-to-bottom. Designers often nest the real page inside a wrapper frame and leave loose layers (photos, badges, a footer) as siblings. Pick the node that best represents "the page".
2. sections — every visible section in visual order, with a good slug, tag and role. If the real sections are children of pageRoot, list those children. If a section lives OUTSIDE pageRoot (e.g. a footer that is a sibling), still list it — sections are looked up by id anywhere in the tree. Use "attach" to pull loose decorative layers into the section they visually sit on, so nothing is orphaned.
3. containers — only where Figma's own layout is missing or misleading:
   - a frame with layout=none whose children clearly form rows/columns → flow (+direction)
   - a repeated-card area (3 cards x 2 rows, a logo strip, a photo strip) → grid (+columns). Do this even if Figma shows a wrapping auto-layout; say how many columns you SEE.
   - hero/banner where text and buttons sit ON TOP of a photo or video → overlay (+base = the photo/video id)
   - a frame with genuine auto-layout that already matches the screenshot → do not list it
   - things that must keep exact coordinates (a scattered polaroid collage) → absolute
4. tagOverrides — semantic corrections: card/feature titles are h3 (not h1); only the page's main headline is h1; a full-width frame named "CTA Section" is a section, not a button; real clickable pills are button or a; nav links are a; testimonial text is p.
5. decorations — visual layers CSS cannot rebuild: torn/ripped edges, masked images, rotated photo stacks, maps with pins, complex vector art, wavy dividers. rasterize them. Layers that are helpers/guides → ignore.
6. textPolicy — mark multi-line paragraphs and descriptions as reflow (browser wrapping differs from Figma; boxes must be allowed to grow). Single-line labels, buttons, headings on one line → fixed. When a frame directly holds a reflow paragraph, mark the paragraph, not the frame.
7. ignore — layers that must not be exported at all (hidden states, duplicate variants, off-canvas scraps).

Lessons from real files: the page is usually ONE child frame of the selection, with a footer or decorative photos left as siblings — the footer is still a section, the photos are "attach". Torn-paper / "Subtract" vectors between sections are decorations attached to the section they belong to, never sections themselves. A hero or footer with text on a photo is an overlay whose base is the photo. Card lists with 2+ rows are grids.

Use the screenshots to check the outline: what looks like one section, which layers overlap, how many columns a grid has, whether something is decorative. When the outline and the picture disagree, trust the picture for STRUCTURE and the outline for IDS.

Be exhaustive about sections and grids — those two decisions cause the largest visual errors. Be conservative with overlay: use it only where content genuinely sits on top of media. Return only the JSON plan.`;

export const REFINE_SYSTEM = `You are refining a layout plan for a Figma-to-HTML converter. You previously produced a plan; code executed it and rendered the HTML in a browser; the render was then MEASURED against the Figma frame. You receive the plan, the measurements, and the original Figma screenshots.

Diagnose the biggest discrepancies and return a corrected FULL plan (same schema). Typical fixes:
- a section renders far taller than Figma → its cards are in one row instead of a grid (add/fix a grid container with the right column count), or a fixed-height frame holds reflowing text (mark the text reflow, not the frame), or an overlay was emitted as flow.
- a section renders far shorter or collapses → its children were treated as absolute/overlay; switch the container to flow; or its content was attached to the wrong section.
- horizontal overflow → a row that should wrap (grid) or a decoration that should be rasterized.
- broken or missing imagery → decoration should be rasterize.
Change only what the measurements justify; keep every decision that measured fine. Never output pixel values. Return only the JSON plan.`;

export interface StripMeta { index: number; count: number; fromY: number; toY: number }

export function planUserText(
  frameName: string, width: number, height: number, outline: string, outlineTruncated: boolean
): string {
  return `Frame "${frameName}" — ${width}x${height} design pixels. Screenshots above are strips in reading order; each label gives the design-pixel y-range it covers so you can align it with the outline's @x,y boxes.

LAYER OUTLINE${outlineTruncated ? " (deep levels truncated)" : ""}:
${outline}

Produce the layout plan JSON.`;
}

export interface MeasuredForAI {
  docHeight: number;
  expectedHeight: number;
  overflowCount: number;
  brokenImages: number;
  sectionDeltas: Array<{ slug: string; expected: number; actual: number; delta: number }>;
  structure: string[];   // one line per rendered section: children + their boxes
  overflowing: string[]; // class names of the widest offenders
}

export function refineUserText(plan: Plan, m: MeasuredForAI): string {
  const worst = [...m.sectionDeltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return `PREVIOUS PLAN:
${JSON.stringify(plan)}

MEASUREMENTS (rendered HTML vs Figma):
- page height: ${m.docHeight}px rendered vs ${m.expectedHeight}px in Figma (${m.docHeight - m.expectedHeight >= 0 ? "+" : ""}${m.docHeight - m.expectedHeight})
- elements overflowing the canvas horizontally: ${m.overflowCount}${m.overflowing.length ? ` (${m.overflowing.slice(0, 8).join(", ")})` : ""}
- broken images: ${m.brokenImages}
- section heights (slug: rendered vs figma):
${worst.map((d) => `  ${d.slug}: ${d.actual} vs ${d.expected} (${d.delta >= 0 ? "+" : ""}${d.delta})`).join("\n")}

RENDERED STRUCTURE (per section, first-level children with display/direction and box):
${m.structure.join("\n")}

Return the corrected full plan JSON.`;
}

/** Request body minus images (the UI splices the strips in) and minus the key. */
export function buildRequestBody(system: string, userText: string) {
  return {
    model: AI_MODEL,
    max_tokens: 16000,
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: PLAN_SCHEMA },
    },
    system,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
  };
}
