#!/usr/bin/env node
/**
 * f2h — drive the pipeline on an IR bundle (the unzipped plugin export).
 *
 *   f2h unzip   <zip> [dir]                 unpack a plugin export
 *   f2h plan    <bundle> [--no-model|--model] [--dry-run] [--effort high]
 *   f2h compile <bundle> [--out dir]
 *   f2h elementor <bundle> [--out dir] [--public-base url]   Elementor Editor V4 template -> out/elementor/
 *   f2h verify  <bundle> [--out dir]        render + diff against the Figma screenshot
 *   f2h refine  <bundle> [--out dir]        feed verify measurements back to the planner
 *   f2h build   <bundle> [--no-model] [--refine N] [--out dir]   plan → compile → verify (→ refine → …)
 *   f2h measure <bundle>                    stack the rows the audit proved too tight (deterministic)
 *   f2h regress [corpus] [--update] [--only a,b]   rebuild + verify every bundle, compare to baseline.json
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type { IRDocument } from "./ir/schema.ts";
import type { Plan, ResponsivePlan } from "./ir/plan.ts";
import { planFrame, refinePlan, responsivePlan } from "./planner/index.ts";
import { defaultResponsivePlan } from "./planner/default.ts";
import { compileDocument, compileElementor } from "./compiler/index.ts";
import { BUCKETS, BUCKET_BY_NAME } from "./compiler/responsive.ts";
import type { ResponsiveAt } from "./ir/plan.ts";
import type { VerifyMeasurements } from "./planner/prompt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m: string) => console.error(`[f2h] ${m}`);

// Keys from .env at the repo root (OPENROUTER_API_KEY=... / ANTHROPIC_API_KEY=...). Shell env wins.
for (const f of [path.join(here, "..", ".env"), path.join(process.cwd(), ".env")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function parseArgs(argv: string[]) {
  const pos: string[] = []; const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const nx = argv[i + 1]; if (nx && !nx.startsWith("--")) { flags[k] = nx; i++; } else flags[k] = true; }
    else pos.push(a);
  }
  return { pos, flags };
}

/* --------------------------------------------------------------- unzip */

function unzip(zipPath: string, outDir: string): void {
  const buf = fs.readFileSync(zipPath);
  let p = 0, n = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const flags = buf.readUInt16LE(p + 6), method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18), nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    if (flags & 0x08) throw new Error("zip uses data descriptors; unzip it with the OS instead");
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + csize);
    const out = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out) throw new Error(`unsupported zip method ${method} for ${name}`);
    if (name.includes("..")) throw new Error(`refusing path ${name}`);
    if (!name.endsWith("/")) { const f = path.join(outDir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, out); n++; }
    p = start + csize;
  }
  log(`unpacked ${n} files to ${outDir}`);
}

/* -------------------------------------------------------------- bundle */

function loadBundle(dir: string): IRDocument {
  const f = path.join(dir, "ir.json");
  if (!fs.existsSync(f)) throw new Error(`${f} not found — pass the unzipped plugin export folder`);
  const doc = JSON.parse(fs.readFileSync(f, "utf8")) as IRDocument;
  if (doc.schema !== "figma-ir/1") throw new Error(`unsupported IR schema ${doc.schema}`);
  return doc;
}
const planPath = (dir: string, slug: string) => path.join(dir, "plans", `${slug}.plan.json`);
const responsivePath = (dir: string) => path.join(dir, "plans", "responsive.plan.json");

function loadPlans(dir: string, doc: IRDocument): { plans: Map<string, Plan>; responsive: ResponsivePlan | null; missing: string[] } {
  const plans = new Map<string, Plan>(); const missing: string[] = [];
  for (const f of doc.frames) { const p = planPath(dir, f.slug); if (fs.existsSync(p)) plans.set(f.id, JSON.parse(fs.readFileSync(p, "utf8"))); else missing.push(f.slug); }
  const rp = responsivePath(dir);
  return { plans, responsive: fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, "utf8")) : null, missing };
}

/* ------------------------------------------------------------ commands */

async function cmdPlan(dir: string, flags: Record<string, string | boolean>): Promise<void> {
  const doc = loadBundle(dir);
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY);
  const useModel = flags["no-model"] ? false : !!(flags["model"] || flags["provider"] || hasKey);
  if (!useModel) log("no API key (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) and no --model: writing heuristic plans");
  fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
  for (const frame of doc.frames) {
    if (flags["frame"] && flags["frame"] !== frame.id && flags["frame"] !== frame.slug) continue;
    const plan = await planFrame(doc, frame, {
      bundleDir: dir, useModel, dryRun: !!flags["dry-run"], replan: !!flags["replan"], log,
      provider: flags["provider"] === "openrouter" || flags["provider"] === "anthropic" ? flags["provider"] : undefined,
      model: typeof flags["model"] === "string" ? flags["model"] : undefined,
      effort: (typeof flags["effort"] === "string" ? flags["effort"] : "high") as "high",
    });
    fs.writeFileSync(planPath(dir, frame.slug), JSON.stringify(plan, null, 2));
    log(`${frame.slug}: ${plan.source} plan, ${plan.sections.length} sections, ${plan.containers.length} containers -> plans/${frame.slug}.plan.json`);
  }
  if (doc.frames.length > 1) {
    const { plans } = loadPlans(dir, doc);
    const existing: ResponsivePlan | null = fs.existsSync(responsivePath(dir)) ? JSON.parse(fs.readFileSync(responsivePath(dir), "utf8")) : null;
    const rp = defaultResponsivePlan(doc, plans);
    if (rp && !existing) { fs.writeFileSync(responsivePath(dir), JSON.stringify(rp, null, 2)); log(`responsive: ${rp.breakpoints.map((b) => `${b.name}@${b.minWidth}`).join(", ")}; ${rp.sectionPairs.length} section pair(s)`); }
    else if (rp && existing && !(existing.sectionPairs || []).length && rp.sectionPairs.length) {
      // Breakpoints are the user's (hand-edited); the pairs are derived and were missing.
      fs.writeFileSync(responsivePath(dir), JSON.stringify({ ...existing, sectionPairs: rp.sectionPairs }, null, 2)); log(`responsive: ${rp.sectionPairs.length} section pair(s) added`);
    }
  }
}

/** Node ids the plan wants flattened but the bundle has no bytes for — paste into the plugin. */
function cmdRasterList(dir: string): void {
  const doc = loadBundle(dir);
  const { plans } = loadPlans(dir, doc);
  const ids: string[] = [];
  for (const frame of doc.frames) {
    const plan = plans.get(frame.id); if (!plan) continue;
    const byId = new Map<string, import("./ir/schema.ts").IRNode>();
    const visit = (n: import("./ir/schema.ts").IRNode) => { byId.set(n.id, n); n.children.forEach(visit); }; visit(frame.root);
    for (const d of plan.decorations) {
      if (d.treatment !== "rasterize") continue;
      const n = byId.get(d.id); if (!n) continue;
      let has = false; const scan = (k: import("./ir/schema.ts").IRNode) => { if (k.asset) has = true; k.children.forEach(scan); }; scan(n);
      if (!has) ids.push(d.id);
    }
  }
  if (!ids.length) { log("nothing to rasterize: every planned decoration already has bytes"); return; }
  log(`${ids.length} node(s) need a re-extract with rasterize; paste this into the plugin:`);
  console.log(JSON.stringify({ rasterize: ids }));
}

function cmdCompile(dir: string, flags: Record<string, string | boolean>): string {
  const doc = loadBundle(dir);
  const { plans, responsive, missing } = loadPlans(dir, doc);
  if (missing.length) throw new Error(`no plan for ${missing.join(", ")}; run: f2h plan ${dir}`);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  const t0 = Date.now();
  const res = compileDocument(doc, plans, { responsive, inlineSvg: !flags["no-inline-svg"] });
  fs.mkdirSync(path.join(out, "assets"), { recursive: true });
  // Atomic writes: a browser reloading mid-build must never see a truncated file.
  const writeAtomic = (target: string, text: string) => { const tmp = `${target}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, target); };
  const copyAtomic = (src: string, target: string) => { const tmp = `${target}.${process.pid}.tmp`; fs.copyFileSync(src, tmp); fs.renameSync(tmp, target); };
  for (const [f, text] of res.files) { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); writeAtomic(path.join(out, f), text); }
  let copied = 0, missingAssets = 0;
  for (const a of res.assetFiles) {
    const src = path.join(dir, "assets", a);
    if (fs.existsSync(src)) { copyAtomic(src, path.join(out, "assets", a)); copied++; } else missingAssets++;
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(res.report, null, 2));
  const warn = res.report.frames.reduce((n, f) => n + f.warnings.length, 0);
  log(`compiled ${doc.frames.length} frame(s) in ${Date.now() - t0}ms: ${res.report.cssRules} css rules, ${copied} assets${missingAssets ? `, ${missingAssets} MISSING` : ""}, ${warn} warning(s) -> ${out}/index.html`);
  for (const f of res.report.frames) for (const w of f.warnings.slice(0, 10)) log(`  ! ${f.slug}: ${w}`);
  return out;
}

/** Elementor Editor V4 template + companion css -> <out>/elementor/. */
function cmdElementor(dir: string, flags: Record<string, string | boolean>): string {
  const doc = loadBundle(dir);
  const { plans, responsive, missing } = loadPlans(dir, doc);
  if (missing.length) throw new Error(`no plan for ${missing.join(", ")}; run: f2h plan ${dir}`);
  const out = path.join(typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out"), "elementor");
  const publicBase = typeof flags["public-base"] === "string" ? flags["public-base"] : `http://localhost/f2h/${path.basename(dir)}`;
  const t0 = Date.now();
  const res = compileElementor(doc, plans, { responsive, publicBase });
  fs.mkdirSync(path.join(out, "assets"), { recursive: true });
  for (const [f, text] of res.files) { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); fs.writeFileSync(path.join(out, f), text); }
  let copied = 0, missingAssets = 0;
  for (const a of res.assetFiles) {
    const src = path.join(dir, "assets", a);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, "assets", a)); copied++; } else missingAssets++;
  }
  const r = res.report;
  const n = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const kinds = Object.entries(r.elements).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ");
  log(`elementor: ${n(r.elements)} elements (${kinds}) in ${Date.now() - t0}ms; ${n(r.nativeProps)} native props, ${n(r.companionProps)} companion declarations in ${r.companionRules} rules; ${copied} assets${missingAssets ? `, ${missingAssets} MISSING` : ""} -> ${out}/template.json`);
  const top = Object.entries(r.companionProps).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(", ");
  if (top) log(`  companion css carries: ${top}`);
  for (const w of r.warnings.slice(0, 10)) log(`  ! ${w}`);
  if (typeof flags["public-base"] !== "string") log(`  assets are addressed at ${publicBase}; pass --public-base <url> (tools/elementor_deploy.sh does) before importing`);
  return out;
}

interface AuditRow { height: number; overflow: string[]; clipped: string[]; overlapping: string[]; tinyText: string[]; narrowText?: string[]; tapTargets?: string[]; underfilled?: string[]; bleedShort?: string[]; culprits?: Record<string, { kind: "row" | "grid"; problems: string[] }>; score: number }

/**
 * Widths a frame is audited at: one just above and one well inside every breakpoint bucket
 * (1366, 1200, 1024, 880, 767, 480) plus the common devices, restricted to the frame's own
 * breakpoint range and never its design width (verify compares that one to the screenshot).
 */
export const AUDIT_LADDER = [2560, 1600, 1440, 1367, 1280, 1201, 1100, 1025, 900, 881, 768, 600, 481, 430, 390, 360, 320];
const AUDIT_LADDER_QUICK = [2560, 1440, 1367, 1201, 1025, 881, 768, 600, 481, 390, 360];
export function auditWidths(designW: number, bp: { min: number | null; max: number | null }, allWidths: number[], full = false): number[] {
  const ladder = full ? AUDIT_LADDER : AUDIT_LADDER_QUICK;
  const lo = bp.min ?? 0, hi = bp.max ?? Infinity;
  const widest = Math.max(...allWidths);
  // The edges of the range are where two frames hand over: always rendered.
  const edges = [bp.min, bp.max].filter((v): v is number => v !== null && v > 0 && Math.abs(v - designW) >= 24);
  return [...new Set([...ladder, ...edges])].sort((a, b) => b - a).filter((w) => {
    if (Math.abs(w - designW) < 24) return false;            // the design width itself
    if (w < lo || w > hi) return false;                        // another frame serves it
    if (w > designW && designW >= 1024 && w !== 2560) return false; // a desktop frame above its width only needs the bleed check
    if (w === 2560 && designW !== widest) return false;
    return true;
  });
}

function cmdVerify(dir: string, flags: Record<string, string | boolean>): Map<string, VerifyMeasurements> {
  const doc = loadBundle(dir);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  const reportFile = path.join(out, "report.json");
  if (!fs.existsSync(reportFile)) throw new Error(`no ${reportFile}; run compile first`);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as ReturnType<typeof compileDocument>["report"];
  // --url <page>: verify a deployed Elementor page instead of out/index.html (results under out/elementor/verify/).
  const url = typeof flags["url"] === "string" ? flags["url"] : "";
  const verifyDir = url ? path.join(out, "elementor", "verify") : path.join(out, "verify");
  fs.mkdirSync(verifyDir, { recursive: true });
  const results = new Map<string, VerifyMeasurements>();
  for (const f of report.frames) {
    if (url && f.width !== Math.max(...report.frames.map((x) => x.width))) continue; // the Elementor build is the widest frame only
    const frame = doc.frames.find((x) => x.id === f.id)!;
    const shot = frame.screenshot ? path.join(dir, frame.screenshot) : "";
    const args = [
      path.join(here, "..", "tools", "verify.py"),
      "--html", url || path.join(out, "index.html"), "--width", String(f.width), "--height", String(f.height),
      "--bp", f.slug, "--sections", JSON.stringify(f.sections), "--out", path.join(verifyDir, f.slug),
    ];
    if (shot && fs.existsSync(shot)) {
      // Newer bundles record the box the screenshot covers; older ones exported the render bounds.
      const sb = frame.screenshotBox, rb = frame.root.renderBox, bb = frame.root.box;
      let origin = sb ? `${sb.x},${sb.y}` : `${rb.x - bb.x},${rb.y - bb.y}`;
      // The PNG is the truth: a frame's own effect pads the export on every side, and older plugins
      // recorded the frame box instead. Centre the box in the pixels when the sizes disagree.
      const dims = pngSize(shot);
      if (dims && sb) {
        const sc = frame.screenshotScale || 1;
        const padX = (dims.w / sc - sb.w) / 2, padY = (dims.h / sc - sb.h) / 2;
        if (Math.abs(padX) >= 1 || Math.abs(padY) >= 1) { origin = `${sb.x - padX},${sb.y - padY}`; log(`  screenshot is ${dims.w}x${dims.h} for a ${sb.w}x${sb.h} box; origin ${origin}`); }
      }
      args.push("--shot", shot, "--scale", String(frame.screenshotScale), "--shot-origin", origin, "--text-boxes", JSON.stringify(f.textBoxes || []));
    }
    log(`verify ${f.slug} @ ${f.width}px…`);
    const r = spawnSync("python3", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) { log(`verify failed:\n${r.stderr}`); continue; }
    const m = JSON.parse(fs.readFileSync(path.join(verifyDir, `${f.slug}.report.json`), "utf8")) as VerifyMeasurements;
    results.set(f.id, m);
    // Responsive audit: every width in this frame's breakpoint range that is not its own design
    // width. Above the design width a phone/tablet frame must stretch; below it everything must
    // restructure. The ladder straddles every bucket boundary so a transform that fires late shows.
    const bp = f.breakpoint || { min: null, max: null };
    const widths = auditWidths(f.width, bp, doc.frames.map((x) => x.width), flags["ladder"] === "full");
    if (widths.length && !flags["no-audit"] && !url) {
      const ra = spawnSync("python3", [path.join(here, "..", "tools", "audit.py"), "--html", path.join(out, "index.html"), "--bp", f.slug, "--widths", widths.join(","), "--design-width", String(f.width), "--out", path.join(verifyDir, f.slug)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (ra.status !== 0) log(`audit failed:\n${ra.stderr}`);
      else {
        const audit = JSON.parse(fs.readFileSync(path.join(verifyDir, `${f.slug}.audit.json`), "utf8")) as Record<string, AuditRow>;
        (m as unknown as { audit?: unknown }).audit = audit;
        for (const [w, r] of Object.entries(audit).sort((a, b) => parseInt(b[0], 10) - parseInt(a[0], 10))) {
          const bs = r.bleedShort || [], nt = r.narrowText || [], tt = r.tapTargets || [], uf = r.underfilled || [];
          const parts = [`overflow ${r.overflow.length}`, `clipped ${r.clipped.length}`, `overlapping ${r.overlapping.length}`, `tiny ${r.tinyText.length}`];
          if (nt.length) parts.push(`squeezed ${nt.length}`); if (tt.length) parts.push(`small taps ${tt.length}`); if (uf.length) parts.push(`underfilled`); if (bs.length) parts.push(`bleed short ${bs.length}`);
          log(`  @${w}px: height ${r.height}, ${parts.join(", ")}  (score ${r.score})`);
          for (const b of [...bs, ...uf].slice(0, 4)) log(`    ! ${b}`);
        }
      }
    }
    const worst = [...m.sections].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
    const lm = (m as unknown as { layoutMismatchPct?: number }).layoutMismatchPct;
    log(`  height ${m.docHeight} vs ${m.expectedHeight}${m.mismatchPct !== undefined ? `, pixel mismatch ${m.mismatchPct}%` : ""}${lm !== undefined ? ` (layout only ${lm}%)` : ""}, overflow ${m.overflowCount}, broken images ${m.brokenImages}`);
    if (report.fontsUnavailable?.length) log(`  fonts not on the extracting machine: ${report.fontsUnavailable.join(", ")}`);
    const dist = (m as unknown as { distorted?: string[] }).distorted || [];
    for (const d of dist.slice(0, 6)) log(`  ! distorted asset: ${d}`);
    for (const s of worst) if (Math.abs(s.delta) > 2) log(`  ${s.slug}: ${s.actual} vs ${s.expected} (${s.delta >= 0 ? "+" : ""}${s.delta})`);
    console.error(`  side-by-side: ${path.join(verifyDir, `${f.slug}-side.png`)}`);
  }
  return results;
}

async function cmdRefine(dir: string, flags: Record<string, string | boolean>, measured?: Map<string, VerifyMeasurements>): Promise<boolean> {
  const doc = loadBundle(dir);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  let changed = false;
  for (const frame of doc.frames) {
    const pf = planPath(dir, frame.slug);
    if (!fs.existsSync(pf)) continue;
    const prev = JSON.parse(fs.readFileSync(pf, "utf8")) as Plan;
    let m = measured?.get(frame.id);
    if (!m) { const rf = path.join(out, "verify", `${frame.slug}.report.json`); if (!fs.existsSync(rf)) { log(`no verify report for ${frame.slug}`); continue; } m = JSON.parse(fs.readFileSync(rf, "utf8")); }
    const next = await refinePlan(doc, frame, prev, m!, { bundleDir: dir, useModel: true, dryRun: !!flags["dry-run"], log, provider: flags["provider"] === "openrouter" || flags["provider"] === "anthropic" ? flags["provider"] : undefined, model: typeof flags["model"] === "string" ? flags["model"] : undefined });
    if (JSON.stringify(next) !== JSON.stringify(prev)) { fs.copyFileSync(pf, pf.replace(/\.json$/, `.prev.json`)); fs.writeFileSync(pf, JSON.stringify(next, null, 2)); changed = true; log(`${frame.slug}: plan refined`); }
    else log(`${frame.slug}: plan unchanged`);
  }
  return changed;
}

/**
 * Deterministic corrections from the audit: a row whose content the browser squeezed, clipped or
 * pushed out of the viewport at width `w` is stacked from the bucket above `w`. Written into
 * `plan.responsive` (note `measured@w`), so the next compile is content-driven by measurement.
 */
function cmdMeasure(dir: string, flags: Record<string, string | boolean>): boolean {
  const doc = loadBundle(dir);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  let changed = false;
  const bucketAbove = (w: number, W: number): ResponsiveAt | null => {
    const usable = BUCKETS.filter((b) => b < W);
    for (let i = usable.length - 1; i >= 0; i--) if (usable[i] >= w) return Object.keys(BUCKET_BY_NAME).find((k) => BUCKET_BY_NAME[k] === usable[i]) as ResponsiveAt;
    return null;
  };
  for (const frame of doc.frames) {
    const pf = planPath(dir, frame.slug), af = path.join(out, "verify", `${frame.slug}.audit.json`);
    if (!fs.existsSync(pf) || !fs.existsSync(af)) continue;
    const plan = JSON.parse(fs.readFileSync(pf, "utf8")) as Plan;
    const audit = JSON.parse(fs.readFileSync(af, "utf8")) as Record<string, AuditRow>;
    const entries = [...(plan.responsive || [])];
    const added: string[] = [];
    for (const [ws, row] of Object.entries(audit)) {
      const w = parseInt(ws, 10);
      if (w >= frame.width) continue;
      const at = bucketAbove(w, frame.width);
      if (!at) continue; // above the widest bucket: the design-width shares cover it, nothing to stack
      for (const [id, c] of Object.entries(row.culprits || {})) {
        if (c.kind !== "row") continue;
        const serious = c.problems.filter((p) => p === "squeezed" || p === "clipped").length + (c.problems.filter((p) => p === "overflow").length >= 2 ? 1 : 0);
        if (!serious) continue;
        const has = entries.some((e) => e.id === id && (e.action === "keep" || ((e.action === "stack" || e.action === "wrap" || e.action === "columns") && (BUCKET_BY_NAME[e.at] ?? 767) >= (BUCKET_BY_NAME[at] ?? 767))));
        if (has) continue;
        // One measured entry per row: the widest bucket wins (it covers the narrower ones).
        for (let i = entries.length - 1; i >= 0; i--) if (entries[i].id === id && entries[i].action === "stack" && entries[i].note.startsWith("measured@") && (BUCKET_BY_NAME[entries[i].at] ?? 767) < (BUCKET_BY_NAME[at] ?? 767)) entries.splice(i, 1);
        entries.push({ id, at, action: "stack", columns: 0, note: `measured@${w}: ${[...new Set(c.problems)].join(",")}` });
        added.push(`${id} stack@${at} (${[...new Set(c.problems)].join(",")} at ${w}px)`);
      }
    }
    if (added.length) {
      fs.writeFileSync(pf, JSON.stringify({ ...plan, responsive: entries }, null, 2));
      changed = true;
      log(`${frame.slug}: ${added.length} measured correction(s)`);
      for (const a of added.slice(0, 12)) log(`  + ${a}`);
    } else log(`${frame.slug}: no measured corrections`);
  }
  return changed;
}

/** Model pass over the baseline's tablet/phone renders; writes plan.responsive. */
async function cmdResponsive(dir: string, flags: Record<string, string | boolean>): Promise<boolean> {
  const doc = loadBundle(dir);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  let changed = false;
  for (const frame of doc.frames) {
    const pf = planPath(dir, frame.slug);
    const af = path.join(out, "verify", `${frame.slug}.audit.json`);
    if (!fs.existsSync(pf) || !fs.existsSync(af)) { log(`${frame.slug}: need plan + verify (audit) first`); continue; }
    const plan = JSON.parse(fs.readFileSync(pf, "utf8")) as Plan;
    const widths = JSON.parse(fs.readFileSync(af, "utf8")) as Record<string, { height: number; overflow: string[]; clipped: string[]; overlapping: string[] }>;
    const screenshots: Record<string, string> = {};
    for (const w of Object.keys(widths)) screenshots[w] = path.join(out, "verify", `${frame.slug}-vp${w}.png`);
    const next = await responsivePlan(doc, frame, plan, { widths, screenshots }, { bundleDir: dir, useModel: true, dryRun: !!flags["dry-run"], replan: !!flags["replan"], log,
      provider: flags["provider"] === "openrouter" || flags["provider"] === "anthropic" ? flags["provider"] : undefined, model: typeof flags["model"] === "string" ? flags["model"] : undefined });
    if (JSON.stringify(next.responsive) !== JSON.stringify(plan.responsive || [])) { fs.writeFileSync(pf, JSON.stringify(next, null, 2)); changed = true; }
  }
  return changed;
}

async function cmdBuild(dir: string, flags: Record<string, string | boolean>): Promise<void> {
  await cmdPlan(dir, flags);
  cmdCompile(dir, flags);
  let measured = cmdVerify(dir, flags);
  // What the browser proved too tight is stacked before the model looks at anything.
  if (!flags["no-measure"] && cmdMeasure(dir, flags)) { cmdCompile(dir, flags); measured = cmdVerify(dir, flags); }
  // Single-frame designs: let the model correct the responsive baseline once it has seen it.
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY);
  const audited = [...measured.values()].some((m) => (m as unknown as { audit?: unknown }).audit);
  if (audited && hasKey && !flags["no-model"] && !flags["no-responsive"]) {
    if (await cmdResponsive(dir, flags)) { cmdCompile(dir, flags); measured = cmdVerify(dir, flags); }
  }
  const rounds = typeof flags["refine"] === "string" ? parseInt(flags["refine"], 10) : 0;
  for (let i = 0; i < rounds; i++) {
    const bad = [...measured.values()].some((m) => Math.abs(m.docHeight - m.expectedHeight) > Math.max(24, m.expectedHeight * 0.02) || m.overflowCount > 0);
    if (!bad) { log("measurements within tolerance; no refinement needed"); break; }
    log(`refine round ${i + 1}/${rounds}`);
    if (!(await cmdRefine(dir, flags, measured))) break;
    cmdCompile(dir, flags);
    measured = cmdVerify(dir, flags);
  }
}

/* -------------------------------------------------------------- regress */

interface RegressRow { mismatch: number | null; layout: number | null; heightDelta: number; overflow: number; audit: Record<string, number> }
type Baseline = Record<string, Record<string, RegressRow>>; // bundle -> frame slug -> row

/**
 * `f2h regress [corpus-dir] [--update] [--only a,b]`: rebuild and verify every bundle under the
 * corpus (default `v2 tests/`) with the plans on disk, compare against `<corpus>/baseline.json`,
 * fail on a pixel, layout-only or audit regression. `--update` stores the new numbers.
 */
function cmdRegress(corpus: string, flags: Record<string, string | boolean>): void {
  const only = typeof flags["only"] === "string" ? new Set(flags["only"].split(",")) : null;
  const bundles = fs.readdirSync(corpus).filter((d) => fs.existsSync(path.join(corpus, d, "ir.json")) && fs.existsSync(path.join(corpus, d, "plans"))).filter((d) => !only || only.has(d)).sort();
  const baseFile = path.join(corpus, "baseline.json");
  const base: Baseline = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : {};
  const next: Baseline = { ...base };
  const failures: string[] = [];
  const pad = (v: string | number, n: number) => String(v).padStart(n);
  for (const b of bundles) {
    const dir = path.join(corpus, b);
    log(`regress ${b}`);
    let measured: Map<string, VerifyMeasurements>;
    try { cmdCompile(dir, { ...flags, out: path.join(dir, "out") }); measured = cmdVerify(dir, { ...flags, out: path.join(dir, "out") }); }
    catch (e) { failures.push(`${b}: ${(e as Error).message}`); continue; }
    const doc = loadBundle(dir);
    next[b] = {};
    for (const [fid, m] of measured) {
      const slug = doc.frames.find((f) => f.id === fid)!.slug;
      const audit = ((m as unknown as { audit?: Record<string, AuditRow> }).audit) || {};
      const row: RegressRow = {
        mismatch: (m as unknown as { mismatchPct?: number }).mismatchPct ?? null,
        layout: (m as unknown as { layoutMismatchPct?: number }).layoutMismatchPct ?? null,
        heightDelta: m.docHeight - m.expectedHeight, overflow: m.overflowCount,
        audit: Object.fromEntries(Object.entries(audit).map(([w, r]) => [w, r.score])),
      };
      next[b][slug] = row;
      const prev = base[b]?.[slug];
      const auditSum = Object.values(row.audit).reduce((a, v) => a + v, 0);
      const prevAudit = prev ? Object.values(prev.audit).reduce((a, v) => a + v, 0) : null;
      const line = `  ${slug.padEnd(32)} pixel ${pad(row.mismatch ?? "-", 6)}%  layout ${pad(row.layout ?? "-", 6)}%  height ${pad(row.heightDelta, 5)}  overflow ${pad(row.overflow, 2)}  audit ${pad(auditSum, 3)}` +
        (prev ? `   (was ${prev.mismatch ?? "-"}% / ${prev.layout ?? "-"}% / audit ${prevAudit})` : "   (new)");
      log(line);
      if (prev) {
        if (row.mismatch !== null && prev.mismatch !== null && row.mismatch > prev.mismatch + 0.3) failures.push(`${b}/${slug}: pixel mismatch ${prev.mismatch}% -> ${row.mismatch}%`);
        if (row.layout !== null && prev.layout !== null && row.layout > prev.layout + 0.3) failures.push(`${b}/${slug}: layout mismatch ${prev.layout}% -> ${row.layout}%`);
        if (row.overflow > prev.overflow) failures.push(`${b}/${slug}: overflow ${prev.overflow} -> ${row.overflow}`);
        for (const [w, sc] of Object.entries(row.audit)) if (prev.audit[w] !== undefined && sc > prev.audit[w]) failures.push(`${b}/${slug}: audit @${w}px ${prev.audit[w]} -> ${sc}`);
      }
    }
  }
  if (flags["update"] || !fs.existsSync(baseFile)) { fs.writeFileSync(baseFile, JSON.stringify(next, null, 2)); log(`baseline written: ${baseFile}`); }
  if (failures.length) { log(`${failures.length} regression(s):`); for (const f of failures) log(`  ! ${f}`); if (!flags["update"]) process.exit(1); }
  else log("no regressions");
}

/* ----------------------------------------------------------------- main */

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, target] = pos;
  try {
    switch (cmd) {
      case "unzip": { if (!target) throw new Error("usage: f2h unzip <zip> [dir]"); unzip(target, pos[2] || target.replace(/\.zip$/i, "")); break; }
      case "plan": await cmdPlan(need(target), flags); break;
      case "compile": cmdCompile(need(target), flags); break;
      case "elementor": cmdElementor(need(target), flags); break;
      case "raster-list": cmdRasterList(need(target)); break;
      case "verify": cmdVerify(need(target), flags); break;
      case "refine": await cmdRefine(need(target), flags); break;
      case "responsive": await cmdResponsive(need(target), flags); break;
      case "measure": cmdMeasure(need(target), flags); break;
      case "build": await cmdBuild(need(target), flags); break;
      case "regress": cmdRegress(path.resolve(target || path.join(here, "..", "v2 tests")), flags); break;
      default:
        console.error("usage: f2h <unzip|plan|compile|elementor|verify|measure|refine|responsive|build|raster-list|regress> <bundle-dir> [--no-model] [--provider anthropic|openrouter] [--model id] [--dry-run] [--replan] [--out dir] [--refine N] [--public-base url] [--ladder full] [--update] [--only a,b]");
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) { log(`error: ${(e as Error).message}`); process.exit(1); }
}
/** Width/height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } | null {
  try {
    const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(24); fs.readSync(fd, buf, 0, 24, 0); fs.closeSync(fd);
    if (buf.toString("ascii", 1, 4) !== "PNG") return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}
function need(t?: string): string { if (!t) throw new Error("bundle directory required"); return path.resolve(t); }
main();
