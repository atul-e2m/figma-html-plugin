#!/usr/bin/env node
/**
 * f2h — drive the pipeline on an IR bundle (the unzipped plugin export).
 *
 *   f2h unzip   <zip> [dir]                 unpack a plugin export
 *   f2h plan    <bundle> [--no-model|--model] [--dry-run] [--effort high]
 *   f2h compile <bundle> [--out dir]
 *   f2h verify  <bundle> [--out dir]        render + diff against the Figma screenshot
 *   f2h refine  <bundle> [--out dir]        feed verify measurements back to the planner
 *   f2h build   <bundle> [--no-model] [--refine N] [--out dir]   plan → compile → verify (→ refine → …)
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
import { compileDocument } from "./compiler/index.ts";
import type { VerifyMeasurements } from "./planner/prompt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m: string) => console.error(`[f2h] ${m}`);

// Keys from v2/.env (OPENROUTER_API_KEY=... / ANTHROPIC_API_KEY=...). Shell env wins.
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
  if (!fs.existsSync(responsivePath(dir))) {
    const rp = defaultResponsivePlan(doc);
    if (rp) { fs.writeFileSync(responsivePath(dir), JSON.stringify(rp, null, 2)); log(`responsive: ${rp.breakpoints.map((b) => `${b.name}@${b.minWidth}`).join(", ")}`); }
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

function cmdVerify(dir: string, flags: Record<string, string | boolean>): Map<string, VerifyMeasurements> {
  const doc = loadBundle(dir);
  const out = typeof flags["out"] === "string" ? flags["out"] : path.join(dir, "out");
  const reportFile = path.join(out, "report.json");
  if (!fs.existsSync(reportFile)) throw new Error(`no ${reportFile}; run compile first`);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as ReturnType<typeof compileDocument>["report"];
  const verifyDir = path.join(out, "verify");
  fs.mkdirSync(verifyDir, { recursive: true });
  const results = new Map<string, VerifyMeasurements>();
  for (const f of report.frames) {
    const frame = doc.frames.find((x) => x.id === f.id)!;
    const shot = frame.screenshot ? path.join(dir, frame.screenshot) : "";
    const args = [
      path.join(here, "..", "tools", "verify.py"),
      "--html", path.join(out, "index.html"), "--width", String(f.width), "--height", String(f.height),
      "--bp", f.slug, "--sections", JSON.stringify(f.sections), "--out", path.join(verifyDir, f.slug),
    ];
    if (shot && fs.existsSync(shot)) {
      // Newer bundles record the box the screenshot covers; older ones exported the render bounds.
      const sb = frame.screenshotBox, rb = frame.root.renderBox, bb = frame.root.box;
      const origin = sb ? `${sb.x},${sb.y}` : `${rb.x - bb.x},${rb.y - bb.y}`;
      args.push("--shot", shot, "--scale", String(frame.screenshotScale), "--shot-origin", origin, "--text-boxes", JSON.stringify(f.textBoxes || []));
    }
    log(`verify ${f.slug} @ ${f.width}px…`);
    const r = spawnSync("python3", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) { log(`verify failed:\n${r.stderr}`); continue; }
    const m = JSON.parse(fs.readFileSync(path.join(verifyDir, `${f.slug}.report.json`), "utf8")) as VerifyMeasurements;
    results.set(f.id, m);
    // Responsive audit: only meaningful for a frame that must serve widths it was not designed at.
    const others = doc.frames.filter((x) => x.id !== f.id).map((x) => x.width);
    // Narrower widths no other frame serves, plus one wide screen for the widest frame (bleed check).
    const widest = Math.max(...doc.frames.map((x) => x.width));
    const widths = [1024, 768, 390].filter((w) => w < f.width && !others.some((o) => Math.abs(o - w) < 200));
    if (f.width === widest) widths.unshift(2560);
    if (widths.length && !flags["no-audit"]) {
      const ra = spawnSync("python3", [path.join(here, "..", "tools", "audit.py"), "--html", path.join(out, "index.html"), "--bp", f.slug, "--widths", widths.join(","), "--out", path.join(verifyDir, f.slug)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (ra.status !== 0) log(`audit failed:\n${ra.stderr}`);
      else {
        const audit = JSON.parse(fs.readFileSync(path.join(verifyDir, `${f.slug}.audit.json`), "utf8")) as Record<string, { height: number; overflow: string[]; clipped: string[]; overlapping: string[]; tinyText: string[]; score: number }>;
        (m as unknown as { audit?: unknown }).audit = audit;
        for (const [w, r] of Object.entries(audit)) {
          const bs = (r as unknown as { bleedShort?: string[] }).bleedShort || [];
          log(`  @${w}px: height ${r.height}, overflow ${r.overflow.length}, clipped text ${r.clipped.length}, overlapping text ${r.overlapping.length}, tiny text ${r.tinyText.length}${bs.length ? `, bleed stops short ${bs.length}` : ""}  (score ${r.score})`);
          for (const b of bs.slice(0, 4)) log(`    ! ${b}`);
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

/* ----------------------------------------------------------------- main */

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, target] = pos;
  try {
    switch (cmd) {
      case "unzip": { if (!target) throw new Error("usage: f2h unzip <zip> [dir]"); unzip(target, pos[2] || target.replace(/\.zip$/i, "")); break; }
      case "plan": await cmdPlan(need(target), flags); break;
      case "compile": cmdCompile(need(target), flags); break;
      case "raster-list": cmdRasterList(need(target)); break;
      case "verify": cmdVerify(need(target), flags); break;
      case "refine": await cmdRefine(need(target), flags); break;
      case "responsive": await cmdResponsive(need(target), flags); break;
      case "build": await cmdBuild(need(target), flags); break;
      default:
        console.error("usage: f2h <unzip|plan|compile|verify|refine|responsive|build|raster-list> <bundle-dir> [--no-model] [--provider anthropic|openrouter] [--model id] [--dry-run] [--replan] [--out dir] [--refine N]");
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) { log(`error: ${(e as Error).message}`); process.exit(1); }
}
function need(t?: string): string { if (!t) throw new Error("bundle directory required"); return path.resolve(t); }
main();
