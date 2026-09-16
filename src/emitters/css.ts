import { IRNode, IRPage, IRStyle } from "../core/types";
import { styleToCssText } from "../core/style";

/** Unique class per node, deduped by identical rule bodies. */
export function collectRules(page: IRPage): {
  rules: Map<string, string>; classOf: Map<string, string>;
} {
  const rules = new Map<string, string>();   // className -> body
  const classOf = new Map<string, string>(); // node id -> className
  const byBody = new Map<string, string>();  // body -> className
  const used = new Set<string>();

  const visit = (n: IRNode) => {
    const body = styleToCssText(n.style);
    if (body.trim()) {
      // Identical rule bodies share one class. Names repeat constantly in Figma
      // ("container", "Frame"), so a unique suffix is required or later nodes
      // silently overwrite earlier ones and render unstyled.
      const existing = byBody.get(body);
      if (existing) {
        classOf.set(n.id, existing);
      } else {
        const base = n.className || "el";
        let cls = base;
        let i = 2;
        while (used.has(cls)) cls = `${base}-${i++}`;
        used.add(cls);
        rules.set(cls, body);
        byBody.set(body, cls);
        classOf.set(n.id, cls);
      }
    }
    n.children.forEach(visit);
  };
  page.sections.forEach((s) => visit(s.root));
  return { rules, classOf };
}

/** Most-used font family across the page — the body default, so buttons,
 *  links and any un-styled text never fall back to the browser's serif. */
function dominantFont(page: IRPage): string {
  const count = new Map<string, number>();
  const visit = (n: IRNode) => {
    if (n.style.fontFamily) count.set(n.style.fontFamily, (count.get(n.style.fontFamily) || 0) + 1);
    n.children.forEach(visit);
  };
  page.sections.forEach((s) => visit(s.root));
  let best = "", bestN = 0;
  count.forEach((v, k) => { if (v > bestN) { best = k; bestN = v; } });
  return best || "system-ui, sans-serif";
}

/**
 * Figma sections rarely tile perfectly: torn edges overlap the next section by
 * a pixel or two, or a gap is left. Reproduce the exact offsets so the page
 * height matches to the pixel.
 */
function sectionOffsets(page: IRPage, classOf?: Map<string, string>): string {
  if (!classOf) return "";
  const out: string[] = [];
  for (let i = 1; i < page.sections.length; i++) {
    const prev = page.sections[i - 1], cur = page.sections[i];
    const gap = Math.round(cur.bbox.y - (prev.bbox.y + prev.bbox.height));
    const cls = classOf.get(cur.root.id) || cur.slug;
    if (gap !== 0 && Math.abs(gap) < 400) out.push(`.page-root > .${cls} { margin-top: ${gap}px; }`);
  }
  return out.length ? `\n/* section offsets measured from Figma */\n${out.join("\n")}\n` : "";
}

export function emitCss(page: IRPage, rules: Map<string, string>, hoverCss: string[], classOf?: Map<string, string>): string {
  const head = `/* Generated from Figma frame: ${page.name}
   Canvas: ${page.canvasWidth}x${page.canvasHeight}
   Do not edit by hand — regenerate from the plugin. */

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; }
body { font-family: ${dominantFont(page)}; -webkit-font-smoothing: antialiased; }
/* Figma has no default margins. The browser gives h1-h6, p, ul, ol and
   blockquote a margin nobody asked for (0.83em on an h4 is ~40px), which
   silently inflates every text block and therefore the whole page. */
h1, h2, h3, h4, h5, h6, p, ul, ol, li, blockquote, figure, dl, dd, pre {
  margin: 0; padding: 0;
}
ul, ol { list-style: none; }
img, video, svg { display: block; max-width: 100%; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; border: none; background: none; cursor: pointer;
         text-align: inherit; }

/* Top-level sections are FULL-BLEED: a design drawn on a 1920 canvas should
   paint edge-to-edge on a wider screen, not leave white rails either side.
   Inner content stays centred at the design width. */
.page-root {
  width: 100%;
  margin: 0 auto;
}
.page-root > * {
  width: 100%;
  max-width: none;
}
`;
  const body = Array.from(rules.entries())
    .map(([cls, decls]) => `.${cls} {\n${decls}\n}`)
    .join("\n\n");

  const hover = hoverCss.length ? `\n\n/* interactions (from Figma prototype reactions) */\n${hoverCss.join("\n\n")}` : "";

  // Large Figma side padding (e.g. 260px on a 1920 canvas) consumes a narrow
  // viewport entirely. Scale it with the viewport instead of dropping it.
  const responsive = `

/* Baseline responsive behaviour.
   Figma frames at other widths, when present, produce real overrides above. */
@media (max-width: ${page.canvasWidth}px) {
  .page-root { max-width: 100%; }
}
@media (max-width: 1024px) {
  .page-root > * { padding-left: clamp(16px, 5vw, 80px) !important;
                   padding-right: clamp(16px, 5vw, 80px) !important; }
}
@media (max-width: 768px) {
  .page-root [class] { max-width: 100%; }
  .page-root > * { padding-left: 16px !important; padding-right: 16px !important; }
}
`;
  return head + "\n" + body + hover + sectionOffsets(page, classOf) + responsive;
}

export function emitHoverRules(page: IRPage, classOf: Map<string, string>): string[] {
  const out: string[] = [];
  const visit = (n: IRNode) => {
    if (n.interactions) {
      const cls = classOf.get(n.id);
      const hov = n.interactions.find((i) => i.trigger === "hover" && i.cssHover);
      if (cls && hov && hov.cssHover) {
        const body = styleToCssText(hov.cssHover as IRStyle);
        if (body.trim()) out.push(`.${cls}:hover {\n${body}\n}`);
      }
    }
    n.children.forEach(visit);
  };
  page.sections.forEach((s) => visit(s.root));
  return out;
}
