/** Element tree -> HTML + CSS text. */
import type { El, ResolvedFrame, Section } from "./resolve.ts";
import type { Style } from "./style.ts";
import { px } from "./style.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Rules {
  rules: Map<string, string>;      // class -> body
  classOf: Map<string, string>;    // key -> class
  hover: Map<string, string>;      // class -> body
  media: Map<string, Map<string, string>>; // query -> class -> body
  /** `.cls:hover [data-figma-id="x"] { … }` and `.cls:active { … }` */
  stateRules: string[];
}

function styleText(s: Style): string {
  return Object.keys(s).filter((k) => s[k] !== undefined && s[k] !== "").map((k) => `  ${k}: ${s[k]};`).join("\n");
}

/** One class per distinct rule body; names from layer names, unique by suffix. */
export function collectRules(frames: ResolvedFrame[]): Rules {
  const rules = new Map<string, string>(), classOf = new Map<string, string>(), hover = new Map<string, string>();
  const media = new Map<string, Map<string, string>>();
  const stateRules: string[] = [];
  const byBody = new Map<string, string>(); const used = new Set<string>(["page-root"]);
  const alloc = (base: string, body: string): string => {
    const ex = byBody.get(body); if (ex) return ex;
    let cls = base || "el", i = 2; while (used.has(cls)) cls = `${base}-${i++}`;
    used.add(cls); rules.set(cls, body); byBody.set(body, cls); return cls;
  };
  const visit = (e: El) => {
    const mediaKey = Object.entries(e.media).map(([q, st]) => `@${q}{${styleText(st)}}`).join("");
    // Hover/state deltas are part of the identity: two elements with the same
    // resting style but different hover styles must not share a class.
    const stateKey = (e.hover ? `:hover{${styleText(e.hover)}}` : "") + e.stateRules.map((r) => `${r.state}/${r.childId}{${styleText(r.style)}}`).join("");
    const body = styleText(e.style) + (mediaKey ? `\n  /*${mediaKey}*/` : "") + (stateKey ? `\n  /*${stateKey}*/` : "");
    if (body.trim()) {
      const cls = alloc(e.cls, body);
      classOf.set(e.id, cls);
      if (e.hover) hover.set(cls, styleText(e.hover));
      for (const r of e.stateRules) {
        const sel = r.childId ? `.${cls}:${r.state} [data-figma-id="${r.childId}"]` : `.${cls}:${r.state}`;
        stateRules.push(`${sel} {\n${styleText(r.style)}\n}`);
      }
      for (const [q, st] of Object.entries(e.media)) { if (!media.has(q)) media.set(q, new Map()); media.get(q)!.set(cls, styleText(st)); }
    }
    if (e.runs) e.runs.forEach((r, i) => { const b = styleText(r.style); if (b.trim()) classOf.set(`${e.id}#${i}`, alloc(`${e.cls}-run`, b)); });
    e.children.forEach(visit);
  };
  for (const f of frames) for (const s of f.sections) visit(s.el);
  return { rules, classOf, hover, media, stateRules };
}

/* --------------------------------------------------------------- HTML */

/** Figma exports "noise" effects as feTurbulence filters that browsers render
 *  as a flat block or nothing at all. Remove those filters; keep the shape. */
export function stripNoiseFilters(svg: string): string {
  if (!/feTurbulence/.test(svg)) return svg;
  const ids = new Set<string>();
  for (const m of svg.matchAll(/<filter[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/filter>/g)) if (/feTurbulence/.test(m[2])) ids.add(m[1]);
  for (const id of ids) {
    svg = svg.replace(new RegExp(`\\sfilter="url\\(#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)"`, "g"), "");
  }
  return svg;
}

function renderEl(e: El, R: Rules, indent: string, lazy: boolean): string {
  const cls = R.classOf.get(e.id);
  const attrs: string[] = [];
  if (cls) attrs.push(`class="${cls}"`);
  for (const [k, v] of Object.entries(e.attrs)) if (k !== "alt") attrs.push(`${k}="${esc(v)}"`);

  if (e.tag === "svg" && e.svg) {
    const vb = e.svg.match(/viewBox="([\d.\-\s]+)"/);
    let stretch = false;
    if (vb) { const p = vb[1].trim().split(/\s+/).map(Number); const va = p[2] / Math.max(1e-6, p[3]); const ba = e.box.w / Math.max(1e-6, e.box.h); stretch = Math.abs(va - ba) / Math.max(va, ba) > 0.03; }
    if (e.attrs["data-stretch"]) stretch = true;
    let svg = stripNoiseFilters(e.svg.replace(/^\s*<\?xml[^>]*>\s*/i, ""));
    // Size comes from CSS; only the ROOT tag loses its width/height.
    svg = svg.replace(/^(\s*<svg\b[^>]*)>/, (m, open: string) => `${open.replace(/\s(width|height)="[^"]*"/g, "")}${cls ? ` class="${cls}"` : ""} data-figma-id="${esc(e.id)}"${stretch ? ' preserveAspectRatio="none"' : ""} role="img" aria-label="${esc(e.name)}">`);
    return `${indent}${svg}`;
  }
  if (e.tag === "img") {
    attrs.push(`src="${esc(e.src || "")}"`, `alt="${esc(e.attrs["alt"] ?? e.name)}"`);
    if (lazy) attrs.push(`loading="lazy"`);
    return `${indent}<img ${attrs.join(" ")}>`;
  }
  if (e.tag === "video") {
    if (e.poster) attrs.push(`poster="${esc(e.poster)}"`, `data-video-source="${esc(e.name)}"`);
    attrs.push("autoplay", "muted", "loop", "playsinline");
    return `${indent}<video ${attrs.join(" ")}></video>`;
  }
  const open = `${indent}<${e.tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  if (e.runs) {
    const inner = e.runs.map((r, i) => {
      const rc = R.classOf.get(`${e.id}#${i}`);
      const t = esc(r.text).replace(/\n/g, "<br>");
      if (r.href) return `<a href="${esc(r.href)}"${rc ? ` class="${rc}"` : ""}>${t}</a>`;
      return rc ? `<span class="${rc}">${t}</span>` : t;
    }).join("");
    return `${open}${inner}</${e.tag}>`;
  }
  if (e.text !== null && !e.children.length) return `${open}${esc(e.text).replace(/\n/g, "<br>")}</${e.tag}>`;
  if (!e.children.length) return `${open}</${e.tag}>`;
  return `${open}\n${e.children.map((c) => renderEl(c, R, indent + "  ", lazy)).join("\n")}\n${indent}</${e.tag}>`;
}

export interface Breakpoint { slug: string; min: number | null; max: number | null }

export function fontLinks(frames: ResolvedFrame[]): string {
  const fams = new Map<string, Set<string>>();
  for (const f of frames) for (const [fam, ws] of f.fonts) { if (!fams.has(fam)) fams.set(fam, new Set()); ws.forEach((w) => fams.get(fam)!.add(w)); }
  if (!fams.size) return "";
  // One request per family: Google Fonts answers 400 for the WHOLE request when
  // any family is unknown (licensed fonts), which would drop the known ones too.
  const links = [...fams].map(([fam, ws]) => {
    const list = [...ws].sort((a, b) => { const [ai, aw] = a.split(",").map(Number), [bi, bw] = b.split(",").map(Number); return ai - bi || aw - bw; });
    return `<link href="https://fonts.googleapis.com/css2?family=${fam.trim().replace(/\s+/g, "+")}:ital,wght@${list.join(";")}&display=swap" rel="stylesheet">`;
  });
  return `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n${links.join("\n")}\n`;
}

/** Local faces for every family: an installed font or a file in fonts/ wins when Google has no such family. */
export function fontFaces(frames: ResolvedFrame[]): { css: string; files: string[] } {
  const fams = new Map<string, Set<string>>();
  for (const f of frames) for (const [fam, ws] of f.fonts) { if (!fams.has(fam)) fams.set(fam, new Set()); ws.forEach((w) => fams.get(fam)!.add(w)); }
  const rules: string[] = []; const files: string[] = [];
  for (const [fam, ws] of fams) for (const w of ws) {
    const [ital, weight] = w.split(",").map(Number);
    const file = `fonts/${fam.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${weight}${ital ? "-italic" : ""}.woff2`;
    files.push(file);
    rules.push(`@font-face { font-family: "${fam}"; font-weight: ${weight}; font-style: ${ital ? "italic" : "normal"}; font-display: swap; src: local("${fam}"), url("${file}") format("woff2"); }`);
  }
  return { css: rules.join("\n"), files };
}

export function emitHtml(frames: ResolvedFrame[], R: Rules, bps: Breakpoint[], title: string, lang: string, cssHref: string): string {
  const bodies = frames.map((f, fi) => {
    const secs = f.sections.map((s, i) => renderEl(s.el, R, "      ", i >= 2)).join("\n");
    const bp = bps[fi];
    return `    <div class="page-root" data-bp="${esc(bp.slug)}" data-frame="${esc(f.frame.id)}">\n${secs}\n    </div>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="${esc(lang || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${fontFaces(frames).css}
</style>
${fontLinks(frames)}<link rel="stylesheet" href="${esc(cssHref)}">
</head>
<body>
${bodies}
</body>
</html>
`;
}

/* ---------------------------------------------------------------- CSS */

function dominantFont(frames: ResolvedFrame[]): string {
  let best = "", n = 0;
  for (const f of frames) for (const [fam, ws] of f.fonts) if (ws.size >= n) { best = fam; n = ws.size; }
  return best ? `"${best}", system-ui, sans-serif` : "system-ui, sans-serif";
}

/** Section N starts exactly where Figma put it, even when sections overlap or gap. */
function sectionOffsets(f: ResolvedFrame, R: Rules): string[] {
  const out: string[] = [];
  const secs = f.sections;
  for (let i = 1; i < secs.length; i++) {
    const prev = secs[i - 1], cur = secs[i];
    const delta = Math.round((cur.box.y - (prev.box.y + prev.box.h)) * 100) / 100;
    // Keyed on the section attribute: classes are shared between identical rule bodies.
    if (Math.abs(delta) > 0.5) out.push(`.page-root[data-bp="${f.frame.slug}"] > [data-section="${cur.slug}"] { margin-top: ${px(delta)}; }`);
  }
  return out;
}

export function emitCss(frames: ResolvedFrame[], R: Rules, bps: Breakpoint[]): string {
  const out: string[] = [];
  out.push(`/* generated by figma-ir-pipeline */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: ${dominantFont(frames)}; -webkit-font-smoothing: antialiased; background: #fff; color: #000; }
img, svg, video { display: block; flex-shrink: 0; }
img { max-width: 100%; }
h1, h2, h3, h4, h5, h6, p, figure, blockquote, ul, ol { margin: 0; }
ul, ol { padding: 0; list-style: none; }
a { color: inherit; text-decoration: none; }
button { font: inherit; }
.page-root { position: relative; width: 100%; margin: 0 auto; overflow-x: clip; }`);
  // No cap on the root: sections bleed to the viewport edges and centre their content themselves.
  frames.forEach((f, i) => {
    const extra = Object.entries(f.rootStyle).map(([k, v]) => ` ${k}: ${v};`).join("");
    out.push(`.page-root[data-bp="${bps[i].slug}"] { --design-width: ${px(f.frame.width)};${extra} }`);
  });
  out.push("");
  for (const [cls, body] of R.rules) out.push(`.${cls} {\n${body.replace(/\n  \/\*(@|:hover|hover\/|active\/).*\*\/$/s, "").replace(/\n  \/\*(@|:hover|hover\/|active\/).*\*\/$/s, "")}\n}`);
  out.push("");
  for (const [cls, body] of R.hover) out.push(`.${cls}:hover {\n${body}\n}`);
  out.push(...R.stateRules);
  for (const f of frames) out.push(...sectionOffsets(f, R));
  const queries = [...R.media.keys()].sort((a, b) => (parseInt(b.match(/\d+/)?.[0] || "0", 10)) - (parseInt(a.match(/\d+/)?.[0] || "0", 10)));
  for (const q of queries) {
    out.push("", `@media ${q} {`);
    for (const [cls, body] of R.media.get(q)!) out.push(`  .${cls} {\n${body.replace(/^/gm, "  ")}\n  }`);
    out.push("}");
  }
  if (bps.length > 1) {
    out.push("", "/* breakpoint frames */");
    bps.forEach((bp) => {
      const cond = [bp.min !== null ? `(min-width: ${bp.min}px)` : "", bp.max !== null ? `(max-width: ${bp.max}px)` : ""].filter(Boolean).join(" and ");
      out.push(`.page-root[data-bp="${bp.slug}"] { display: none; }`);
      out.push(`@media ${cond || "all"} { .page-root[data-bp="${bp.slug}"] { display: block; } }`);
    });
  }
  return out.join("\n") + "\n";
}
