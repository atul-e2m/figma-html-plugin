import { IRNode, IRPage } from "../core/types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const VOID = new Set(["img", "br", "hr", "input"]);

function renderNode(n: IRNode, classOf: Map<string, string>, indent: string): string {
  const cls = classOf.get(n.id);
  const attrs: string[] = [];
  if (cls) attrs.push(`class="${cls}"`);
  attrs.push(`data-figma-id="${n.id}"`);
  if (n.role) attrs.push(`data-role="${n.role}"`);

  if (n.tag === "svg" && n.svgMarkup) {
    // Inline the vector so it inherits color and scales cleanly. Figma
    // stretches vectors to their node box (torn edges, dividers), so let CSS
    // size win over the SVG's own aspect ratio.
    const vb = n.svgMarkup.match(/viewBox="([\d.\-\s]+)"/);
    let stretch = false;
    if (vb) {
      const parts = vb[1].trim().split(/\s+/).map(Number);
      const va = parts[2] / Math.max(1e-6, parts[3]);
      const ba = n.bbox.width / Math.max(1e-6, n.bbox.height);
      stretch = Math.abs(va - ba) / Math.max(va, ba) > 0.03;
    }
    const svg = n.svgMarkup.replace("<svg", `<svg class="${cls || ""}"${stretch ? ' preserveAspectRatio="none"' : ""}`);
    return `${indent}${svg}`;
  }
  if (n.tag === "img") {
    // Paths are relative to html/index.html, so assets/ needs one level up.
    attrs.push(`src="../assets/images/${n.assetRef ? n.assetRef : ""}"`);
    attrs.push(`alt="${esc(n.name)}"`);
    attrs.push(`loading="lazy"`);
    return `${indent}<img ${attrs.join(" ")}>`;
  }
  if (n.tag === "video") {
    // Figma cannot export video bytes; the poster keeps the frame visible and
    // the data-video-source names the file a developer must drop in.
    if (n.assetRef) {
      attrs.push(`poster="../assets/video/${n.assetRef}"`);
      attrs.push(`data-video-source="${esc(n.name)}"`);
    }
    attrs.push(`autoplay`, `muted`, `loop`, `playsinline`);
    return `${indent}<video ${attrs.join(" ")}></video>`;
  }

  const open = `${indent}<${n.tag} ${attrs.join(" ")}>`;
  if (VOID.has(n.tag)) return open;

  if (n.text !== undefined && !n.children.length) {
    const t = esc(n.text).replace(/\n/g, "<br>");
    return `${open}${t}</${n.tag}>`;
  }
  const inner = n.children
    .map((c) => renderNode(c, classOf, indent + "  "))
    .join("\n");
  return `${open}\n${inner}\n${indent}</${n.tag}>`;
}

/** Google Fonts link for every family the design uses, so the export renders
 *  with the real typeface instead of a fallback (what made text re-wrap). */
function fontLinks(page: IRPage): string {
  const fams = new Set<string>();
  const visit = (n: IRNode) => {
    const f = n.style.fontFamily;
    if (f) { const m = f.match(/"([^"]+)"/); if (m) fams.add(m[1]); }
    n.children.forEach(visit);
  };
  page.sections.forEach((s) => visit(s.root));
  if (!fams.size) return "";
  const q = Array.from(fams).map((f) => `family=${f.trim().replace(/\s+/g, "+")}:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600`).join("&");
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet">
`;
}

export function emitHtml(page: IRPage, classOf: Map<string, string>, hasJs: boolean): string {
  const body = page.sections
    .map((s) => renderNode(s.root, classOf, "    "))
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.name)}</title>
${fontLinks(page)}<link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="page-root">
${body}
  </div>
${hasJs ? '  <script src="script.js"></script>\n' : ""}</body>
</html>
`;
}
