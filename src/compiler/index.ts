/**
 * compile(doc, plans) -> { files, assetFiles, report }
 * Pure: no filesystem, no network. The CLI does the I/O.
 */
import { walk, type IRDocument, type IRFrame } from "../ir/schema.ts";
import type { Plan, ResponsivePlan } from "../ir/plan.ts";
import { resolveFrame, type ResolvedFrame } from "./resolve.ts";
import { collectRules, emitHtml, emitCss, fontFaces, type Breakpoint } from "./emit.ts";
import { applyResponsive, pruneMedia, stretchFrame } from "./responsive.ts";
import { frameHints } from "./pairs.ts";
import { emitElementor, type ElementorOptions, type ElementorReport } from "./elementor.ts";

export interface CompileOptions {
  responsive?: ResponsivePlan | null;
  inlineSvg?: boolean;
  assetPrefix?: string;
  title?: string;
}

export interface CompileReport {
  generatedAt: string;
  frames: Array<{
    id: string; slug: string; name: string; width: number; height: number; breakpoint: Breakpoint;
    planSource: string; sections: Array<{ slug: string; id: string; name: string; x: number; y: number; w: number; h: number }>;
    /** Text boxes in frame space, so verify can score layout separately from font rendering. */
    textBoxes: number[][];
    screenshotBox: { x: number; y: number; w: number; h: number } | null;
    warnings: string[];
  }>;
  cssRules: number;
  fonts: string[];
  /** From the plugin: families this machine did not have when extracting. */
  fontsUnavailable: string[];
  /** Drop licensed font files here (out/fonts/...) when a family is not on Google Fonts. */
  fontFiles: string[];
}


export interface CompileOutput {
  files: Map<string, string>;
  assetFiles: Set<string>;
  report: CompileReport;
}

/** Default breakpoint ranges from frame widths (a responsive plan overrides). */
export function defaultBreakpoints(frames: IRFrame[], rp?: ResponsivePlan | null): Breakpoint[] {
  const sorted = [...frames].sort((a, b) => a.width - b.width);
  const mins = new Map<string, number>();
  if (rp && rp.breakpoints.length) for (const b of rp.breakpoints) mins.set(b.frameId, b.minWidth);
  else sorted.forEach((f, i) => {
    if (i === 0) { mins.set(f.id, 0); return; }
    const prev = sorted[i - 1];
    // A phone frame hands over at 768; a tablet frame at 1024; otherwise midway.
    const min = f.width > 1024 ? (prev.width <= 500 ? 768 : 1024) : Math.round((prev.width + f.width) / 2);
    mins.set(f.id, min);
  });
  const ordered = [...frames].sort((a, b) => (mins.get(a.id) ?? 0) - (mins.get(b.id) ?? 0));
  const byId = new Map<string, Breakpoint>();
  ordered.forEach((f, i) => {
    const min = mins.get(f.id) ?? 0;
    const next = ordered[i + 1];
    byId.set(f.id, { slug: f.slug, min: i === 0 ? null : min, max: next ? (mins.get(next.id) ?? 0) - 1 : null });
  });
  return frames.map((f) => byId.get(f.id)!);
}

/** F2H_DEBUG_ID=<figma id> prints that node's style (and its parent's) after each compile stage. */
function debugNode(rf: ResolvedFrame, stage: string): void {
  const id = process.env.F2H_DEBUG_ID; if (!id) return;
  const find = (e: import("./resolve.ts").El, parent: import("./resolve.ts").El | null): void => {
    if (e.id === id) { console.error(`[debug ${stage}] ${id} <${e.tag}.${e.cls}> role=${e.role} layout=${e.layoutKind}`, JSON.stringify(e.style), "\n   parent:", parent ? `<${parent.tag}.${parent.cls}> ${JSON.stringify(parent.style)}` : "-"); }
    e.children.forEach((c) => find(c, e));
  };
  for (const s of rf.sections) find(s.el, null);
}

/** IR + plans -> resolved element trees with the responsive baseline applied. Shared by every emitter. */
export function resolveDocument(doc: IRDocument, plans: Map<string, Plan>, opts: CompileOptions = {}): { resolved: ResolvedFrame[]; bps: Breakpoint[] } {
  const assetPrefix = opts.assetPrefix ?? "assets/";
  const resolved: ResolvedFrame[] = [];
  const bps = defaultBreakpoints(doc.frames, opts.responsive);
  doc.frames.forEach((frame, i) => {
    const plan = plans.get(frame.id);
    if (!plan) throw new Error(`no plan for frame ${frame.id} (${frame.name})`);
    const rf = resolveFrame(doc, frame, plan, { assetPrefix, inlineSvg: opts.inlineSvg ?? true });
    debugNode(rf, "after resolve");
    const ridx = new Map<string, Array<{ at: string; action: import("./responsive.ts").ResponsiveAction; columns?: number }>>();
    for (const r of plan.responsive || []) { if (!ridx.has(r.id)) ridx.set(r.id, []); ridx.get(r.id)!.push({ at: r.at, action: r.action, columns: r.columns || undefined }); }
    // The next narrower frame of the same page is the designer's own answer to "how does this
    // stack": its order and alignment drive this frame's restructuring below its width.
    const narrower = [...doc.frames].filter((f) => f.width < frame.width && plans.has(f.id)).sort((a, b) => b.width - a.width)[0];
    const hints = narrower ? frameHints(frame, plan, narrower, plans.get(narrower.id)!, (opts.responsive?.sectionPairs || []).filter((p) => p.a && p.b)) : null;
    applyResponsive(rf.sections, frame.width, ridx, hints);
    stretchFrame(rf.sections, frame.width, { min: bps[i].min ?? 0, max: bps[i].max });
    debugNode(rf, "after responsive");
    pruneMedia(rf.sections, frame.width, { min: bps[i].min ?? 0, max: bps[i].max });
    resolved.push(rf);
  });
  return { resolved, bps };
}

export interface ElementorCompileOutput {
  /** template.json, elementor.css, report.json and synthesised SVGs; paths relative to the output folder. */
  files: Map<string, string>;
  /** Bundle asset files (relative to assets/) the template references. */
  assetFiles: Set<string>;
  report: ElementorReport;
}

/** IR + plans -> Elementor Editor V4 template. Same resolve stage as compileDocument, different emitter. */
export function compileElementor(doc: IRDocument, plans: Map<string, Plan>, opts: CompileOptions & ElementorOptions): ElementorCompileOutput {
  const { resolved } = resolveDocument(doc, plans, { ...opts, inlineSvg: true });
  const out = emitElementor(resolved, {
    publicBase: opts.publicBase, title: opts.title,
    fontsUnavailable: opts.fontsUnavailable ?? (doc.meta.fonts || []).filter((f) => !f.available || f.missing).map((f) => f.family),
  });
  const files = new Map<string, string>([
    ["template.json", JSON.stringify(out.template, null, 2)],
    ["elementor.css", out.css],
    ["report.json", JSON.stringify(out.report, null, 2)],
  ]);
  const assetFiles = new Set<string>();
  for (const a of out.assets) if (a.startsWith("assets/")) assetFiles.add(a.slice("assets/".length));
  for (const [p, text] of out.generated) { files.set(p, text); assetFiles.delete(p.replace(/^assets\//, "")); }
  return { files, assetFiles, report: out.report };
}

export function compileDocument(doc: IRDocument, plans: Map<string, Plan>, opts: CompileOptions = {}): CompileOutput {
  const assetPrefix = opts.assetPrefix ?? "assets/";
  const { resolved, bps } = resolveDocument(doc, plans, opts);
  const R = collectRules(resolved);
  const first = resolved[0];
  const title = opts.title || first.plan.page.title || first.frame.name;
  const html = emitHtml(resolved, R, bps, title, first.plan.page.lang, "styles.css");
  const css = emitCss(resolved, R, bps);

  const assetFiles = new Set<string>();
  const re = new RegExp(`${assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^"')\\s]+)`, "g");
  for (const m of (html + css).matchAll(re)) assetFiles.add(m[1]);

  const fonts = new Set<string>();
  for (const rf of resolved) for (const f of rf.fonts.keys()) fonts.add(f);

  const files = new Map<string, string>([["index.html", html], ["styles.css", css]]);
  for (const rf of resolved) for (const [p, text] of rf.generated) { files.set(p, text); assetFiles.delete(p.replace(/^assets\//, "")); }
  return {
    files,
    assetFiles,
    report: {
      generatedAt: new Date().toISOString(),
      frames: resolved.map((rf, i) => {
        const textBoxes: number[][] = [];
        walk(rf.frame.root, (n) => { if (n.text && n.text.characters.trim()) textBoxes.push([n.box.x, n.box.y, n.box.w, n.box.h].map((v) => Math.round(v))); });
        return {
          id: rf.frame.id, slug: rf.frame.slug, name: rf.frame.name, width: rf.frame.width, height: rf.frame.height, breakpoint: bps[i],
          planSource: rf.plan.source,
          sections: rf.sections.map((s) => ({ slug: s.slug, id: s.id, name: s.name, x: s.box.x, y: s.box.y, w: s.box.w, h: s.box.h })),
          textBoxes,
          screenshotBox: rf.frame.screenshotBox ?? null,
          warnings: rf.warnings,
        };
      }),
      cssRules: R.rules.size,
      fonts: [...fonts],
      fontsUnavailable: (doc.meta.fonts || []).filter((f) => !f.available || f.missing).map((f) => f.family),
      fontFiles: fontFaces(resolved).files,
    },
  };
}
