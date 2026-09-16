import { AssetMap, IRPage, IRNode } from "./core/types";
import { walkPage } from "./core/walker";
import { collectRules, emitCss, emitHoverRules } from "./emitters/css";
import { emitHtml } from "./emitters/html";
import { emitJsx } from "./emitters/jsx";
import { emitSectionSpecs, emitTokens, emitContent, emitImageMap } from "./emitters/specs";
import { Zip, base64 } from "./core/zip";
import { staticChecks, buildExpectation, scoreOf, MeasuredReport } from "./core/audit";
import { buildOutline, outlineHash } from "./ai/outline";
import { Plan, normalizePlan } from "./ai/plan";
import {
  AI_MODEL, PLAN_SYSTEM, REFINE_SYSTEM, buildRequestBody, planUserText, refineUserText, MeasuredForAI,
} from "./ai/prompt";

const VALID = new Set(["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET", "GROUP"]);

// Two ways to reach Claude: Anthropic directly, or via OpenRouter. The UI
// converts the request to whichever wire format the chosen provider speaks.
type Provider = "anthropic" | "openrouter";
const PROVIDER_STORE = "ai_provider";
const KEY_STORES: Record<Provider, string> = {
  anthropic: "anthropic_api_key",
  openrouter: "openrouter_api_key",
};
const MODEL_BY_PROVIDER: Record<Provider, string> = {
  anthropic: AI_MODEL,
  openrouter: `anthropic/${AI_MODEL}`,
};

async function activeProvider(): Promise<Provider> {
  const p = (await figma.clientStorage.getAsync(PROVIDER_STORE)) as string | undefined;
  return p === "openrouter" ? "openrouter" : "anthropic";
}
async function activeKey(): Promise<{ provider: Provider; key: string; model: string }> {
  const provider = await activeProvider();
  const key = ((await figma.clientStorage.getAsync(KEY_STORES[provider])) as string | undefined) || "";
  return { provider, key, model: MODEL_BY_PROVIDER[provider] };
}

figma.showUI(__html__, { width: 520, height: 760, themeColors: true });

/* ------------------------------------------------------------ selection */

function currentSelection(): FrameNode | null {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const n = sel[0];
  if (!VALID.has(n.type)) return null;
  return n as FrameNode;
}

function postSelection() {
  const n = currentSelection();
  const sel = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "selection", ok: !!n,
    name: n ? n.name : null,
    width: n ? Math.round(n.width) : null,
    height: n ? Math.round(n.height) : null,
    count: sel.length,
    nodeType: sel.length === 1 ? sel[0].type : null,
  });
}

async function postConfig() {
  const { provider, key, model } = await activeKey();
  const keys: Record<string, string> = {};
  for (const p of Object.keys(KEY_STORES) as Provider[]) {
    keys[p] = ((await figma.clientStorage.getAsync(KEY_STORES[p])) as string | undefined) || "";
  }
  figma.ui.postMessage({
    type: "config", provider, hasKey: !!key, key, keys, model,
    models: MODEL_BY_PROVIDER,
  });
}

postSelection();
postConfig();
figma.on("selectionchange", postSelection);

/* -------------------------------------------- UI round-trips (network, DOM) */

// The plugin sandbox has no fetch and no DOM. The UI iframe does both: it
// calls the Claude API and renders the page off-screen to measure it. Each
// request carries an id; the reply resolves the matching promise here.
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqSeq = 0;

function askUI<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const reqId = `r${++reqSeq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`${String(msg.type)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    figma.ui.postMessage({ ...msg, reqId });
  });
}

const progress = (message: string, pct: number) =>
  figma.ui.postMessage({ type: "progress", message, pct });

/* ------------------------------------------------------------------ build */

interface BuildResult {
  page: IRPage;
  bytes: Uint8Array;
  files: Record<string, string>;
  preview: { html: string; css: string; width: number };
  audit: { checks: ReturnType<typeof staticChecks>; expect: ReturnType<typeof buildExpectation>; baseScore: number };
  stats: { sections: number; rules: number; images: number; videos: number; elapsed: string };
  filename: string;
}

async function buildExport(
  frame: FrameNode, plan: Plan | null, format: "html" | "jsx", pctBase: number, pctSpan: number
): Promise<BuildResult> {
  const t0 = Date.now();
  const p = (msg: string, f: number) => progress(msg, Math.round(pctBase + pctSpan * f));

  p("Reading layers…", 0.05);
  const assets: AssetMap = new Map();
  const page: IRPage = await walkPage(frame, assets, plan);

  p("Resolving styles…", 0.4);
  const { rules, classOf } = collectRules(page);
  const hoverCss = emitHoverRules(page, classOf);

  const fixRefs = (n: IRNode) => {
    if (n.assetRef) { const rec = assets.get(n.assetRef); if (rec) n.assetRef = rec.filename; }
    n.children.forEach(fixRefs);
  };
  page.sections.forEach((s) => fixRefs(s.root));

  p("Generating code…", 0.55);
  const zip = new Zip();
  const wantHtml = format === "html";
  const wantJsx = format === "jsx";
  const css = emitCss(page, rules, hoverCss, classOf);
  const html = emitHtml(page, classOf, false);
  if (wantHtml) { zip.add("html/index.html", html); zip.add("html/styles.css", css); }
  const jsxOut = wantJsx ? emitJsx(page, classOf, false) : null;
  if (jsxOut) { zip.add(`jsx/${jsxOut.filename}`, jsxOut.code); zip.add("jsx/styles.css", css); }

  p("Writing specs…", 0.65);
  const base = `pages/${page.slug}/figma`;
  const specs = JSON.stringify(emitSectionSpecs(page), null, 2);
  zip.add(`${base}/section-specs.json`, specs);
  zip.add(`${base}/tokens.json`, JSON.stringify(await emitTokens(page), null, 2));
  zip.add(`${base}/content.json`, JSON.stringify(emitContent(page), null, 2));
  zip.add(`${base}/image-map.json`, JSON.stringify(emitImageMap(assets), null, 2));
  if (plan) zip.add(`${base}/layout-plan.json`, JSON.stringify(plan, null, 2));

  p("Exporting assets…", 0.72);
  let videoCount = 0;
  for (const rec of assets.values()) {
    zip.add(`${rec.kind === "video" ? "assets/video" : "assets/images"}/${rec.filename}`, rec.bytes);
    if (rec.kind === "video") videoCount++;
  }

  p("Capturing screenshots…", 0.85);
  try {
    const full = await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    zip.add(`${base}/screenshots/00-full-page-desktop.png`, full);
    for (const sec of page.sections) {
      const node = await figma.getNodeByIdAsync(sec.id);
      if (node && "exportAsync" in node) {
        const shot = await (node as ExportMixin).exportAsync({
          format: "PNG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: false,
        });
        zip.add(`${base}/screenshots/${sec.slug}-desktop.png`, shot);
      }
    }
  } catch (e) { console.warn("screenshot capture failed", e); }

  zip.add("manifest.json", JSON.stringify({
    schema_version: "2.0",
    generator: "figma-to-html-jsx",
    generated_at: new Date().toISOString(),
    figma: {
      fileName: figma.root.name, frameName: frame.name, frameId: frame.id,
      canvasWidth: page.canvasWidth, canvasHeight: page.canvasHeight,
    },
    pages: [{ slug: page.slug, name: page.name, sections: page.sections.length }],
    outputs: { html: wantHtml, jsx: wantJsx },
    planner: plan ? { model: AI_MODEL, sections: plan.sections.length, containers: plan.containers.length } : null,
    counts: { sections: page.sections.length, cssRules: rules.size, images: assets.size - videoCount, videos: videoCount },
  }, null, 2));

  const bytes = zip.finish();

  // Inline assets as data URIs so the UI preview (and the measurement pass)
  // renders real imagery — the iframe cannot read the ZIP.
  let previewHtml = html, previewCss = css;
  for (const rec of assets.values()) {
    if (rec.kind === "svg") continue;
    const uri = `data:image/png;base64,${base64(rec.bytes)}`;
    previewHtml = previewHtml.split(`../assets/images/${rec.filename}`).join(uri);
    previewHtml = previewHtml.split(`../assets/video/${rec.filename}`).join(uri);
    previewCss = previewCss.split(`../assets/images/${rec.filename}`).join(uri);
  }

  const checks = staticChecks(page, rules.size);
  return {
    page, bytes,
    filename: `${page.slug}-export.zip`,
    files: {
      ...(wantHtml ? { "index.html": html } : {}),
      "styles.css": css,
      ...(jsxOut ? { [jsxOut.filename]: jsxOut.code } : {}),
      "section-specs.json": specs,
      ...(plan ? { "layout-plan.json": JSON.stringify(plan, null, 2) } : {}),
    },
    preview: { html: previewHtml, css: previewCss, width: page.canvasWidth },
    audit: { checks, expect: buildExpectation(page), baseScore: scoreOf(checks) },
    stats: {
      sections: page.sections.length, rules: rules.size,
      images: assets.size - videoCount, videos: videoCount,
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
    },
  };
}

/* ------------------------------------------------------------- AI planner */

interface UIMeasured extends MeasuredReport { structure: string[]; overflowing: string[] }

async function screenshotForAI(frame: FrameNode): Promise<{ bytes: Uint8Array; scale: number }> {
  // ≤1280px wide keeps each 2400px-tall strip inside the model's native
  // resolution, so text stays legible without paying for downscaled pixels.
  const scale = Math.min(1, 1280 / frame.width);
  const bytes = await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  return { bytes, scale };
}

async function callPlanner(
  kind: "plan" | "refine", system: string, userText: string,
  shot: { bytes: Uint8Array; scale: number }, frame: FrameNode
): Promise<unknown> {
  const body = buildRequestBody(system, userText);
  const res = await askUI<{ ok: boolean; json?: unknown; error?: string; usage?: unknown; ms?: number }>({
    type: "ai-request", kind, body,
    screenshot: shot.bytes, scale: shot.scale,
    canvasWidth: Math.round(frame.width), canvasHeight: Math.round(frame.height),
  }, 10 * 60 * 1000);
  if (!res.ok) throw new Error(res.error || "AI request failed");
  return res.json;
}

function needsRefine(m: UIMeasured): boolean {
  if (!m.expectedHeight) return false;
  if (Math.abs(m.heightDelta) / m.expectedHeight > 0.03) return true;
  if (m.overflowCount > 0) return true;
  return m.sectionDeltas.some((d) => Math.abs(d.delta) > Math.max(40, d.expected * 0.05));
}

/** Lower is better: total absolute drift plus a penalty per overflow. */
function drift(m: UIMeasured): number {
  return Math.abs(m.heightDelta) + m.sectionDeltas.reduce((a, d) => a + Math.abs(d.delta), 0) + m.overflowCount * 50;
}

/* --------------------------------------------------------------- messages */

figma.ui.onmessage = async (msg: {
  type: string; format?: "html" | "jsx"; forceReplan?: boolean; noVerify?: boolean;
  key?: string; provider?: string; reqId?: string; ok?: boolean; error?: string; json?: unknown; measured?: UIMeasured;
}) => {
  if (msg.type === "cancel") { figma.closePlugin(); return; }

  if (msg.type === "set-key") {
    const prov: Provider = msg.provider === "openrouter" ? "openrouter" : "anthropic";
    await figma.clientStorage.setAsync(KEY_STORES[prov], (msg.key || "").trim());
    await figma.clientStorage.setAsync(PROVIDER_STORE, prov);
    await postConfig();
    return;
  }
  if (msg.type === "set-provider") {
    await figma.clientStorage.setAsync(PROVIDER_STORE, msg.provider === "openrouter" ? "openrouter" : "anthropic");
    await postConfig();
    return;
  }

  // Replies from the UI to askUI() round-trips.
  if ((msg.type === "ai-response" || msg.type === "measured") && msg.reqId) {
    const p = pending.get(msg.reqId);
    if (p) { pending.delete(msg.reqId); p.resolve(msg); }
    return;
  }

  if (msg.type !== "export") return;

  const frame = currentSelection();
  if (!frame) {
    figma.ui.postMessage({ type: "error", message: "Select a single Frame, Component, or Group." });
    return;
  }
  const format = msg.format || "html";
  const t0 = Date.now();

  try {
    const { provider, key, model } = await activeKey();
    const ai = { used: false, cached: false, refined: false, notes: "", model, provider, planMs: 0, refineMs: 0, error: "" };

    let plan: Plan | null = null;
    let shot: { bytes: Uint8Array; scale: number } | null = null;

    if (!key) progress("No API key saved — heuristics only", 3);
    if (key) {
      progress("Reading the layer tree…", 3);
      const outline = buildOutline(frame);
      const cacheKey = `plan:${frame.id}:${outlineHash(outline.text)}`;
      const cached = msg.forceReplan ? null : (await figma.clientStorage.getAsync(cacheKey)) as Plan | undefined;
      if (cached && cached.sections && cached.sections.length) {
        plan = cached; ai.used = true; ai.cached = true; ai.notes = cached.notes || "";
        progress("Using cached layout plan", 8);
      } else {
        progress("Capturing the frame for the planner…", 6);
        shot = await screenshotForAI(frame);
        progress(`Planning layout with ${model}${provider === "openrouter" ? " via OpenRouter" : ""}… (${outline.nodeCount} layers)`, 10);
        const tp = Date.now();
        try {
          const raw = await callPlanner("plan", PLAN_SYSTEM,
            planUserText(frame.name, Math.round(frame.width), Math.round(frame.height), outline.text, outline.truncated),
            shot, frame);
          plan = normalizePlan(raw, outline.ids, frame.id);
          ai.used = true; ai.notes = plan.notes; ai.planMs = Date.now() - tp;
          if (plan.sections.length) await figma.clientStorage.setAsync(cacheKey, plan);
          else { plan = null; ai.used = false; ai.error = "planner returned no sections; used heuristics"; }
        } catch (e) {
          // Accuracy first, but never a dead end: fall back to heuristics and SAY so.
          ai.error = e instanceof Error ? e.message : String(e);
          console.error("[ai-planner] plan failed:", ai.error);
          progress(`AI planning failed (${ai.error.slice(0, 80)}) — continuing with heuristics`, 28);
          plan = null;
        }
      }
    }

    let result = await buildExport(frame, plan, format, 30, 30);

    // Verification round: render → measure → let the model correct its plan.
    let measured: UIMeasured | null = null;
    if (plan && key && !msg.noVerify) {
      progress("Measuring the rendered page…", 62);
      const m1 = await askUI<{ measured: UIMeasured | null }>({ type: "measure", preview: result.preview, expect: result.audit.expect }, 30000);
      measured = m1.measured;
      if (measured && needsRefine(measured)) {
        progress(`Refining layout plan with ${model}…`, 66);
        const tr = Date.now();
        try {
          if (!shot) shot = await screenshotForAI(frame);
          const forAI: MeasuredForAI = {
            docHeight: measured.docHeight, expectedHeight: measured.expectedHeight,
            overflowCount: measured.overflowCount, brokenImages: measured.brokenImages,
            sectionDeltas: measured.sectionDeltas, structure: measured.structure || [],
            overflowing: measured.overflowing || [],
          };
          const outline = buildOutline(frame);
          const raw = await callPlanner("refine", REFINE_SYSTEM, refineUserText(plan, forAI), shot, frame);
          const plan2 = normalizePlan(raw, outline.ids, frame.id);
          ai.refineMs = Date.now() - tr;
          if (plan2.sections.length) {
            const result2 = await buildExport(frame, plan2, format, 72, 22);
            progress("Measuring the refined page…", 95);
            const m2 = await askUI<{ measured: UIMeasured | null }>({ type: "measure", preview: result2.preview, expect: result2.audit.expect }, 30000);
            if (m2.measured && drift(m2.measured) <= drift(measured)) {
              result = result2; plan = plan2; measured = m2.measured; ai.refined = true; ai.notes = plan2.notes;
              await figma.clientStorage.setAsync(`plan:${frame.id}:${outlineHash(outline.text)}`, plan2);
            } else {
              ai.error = "refined plan measured worse; kept the first plan";
            }
          }
        } catch (e) {
          ai.error = `refine skipped: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    figma.ui.postMessage({
      type: "done",
      filename: result.filename,
      bytes: result.bytes,
      files: result.files,
      preview: result.preview,
      audit: result.audit,
      measured,
      plan: plan ? {
        sections: plan.sections.map((s) => ({ slug: s.slug, confidence: s.confidence, note: s.note })),
        containers: plan.containers.length, decorations: plan.decorations.length, notes: plan.notes,
      } : null,
      ai,
      stats: { ...result.stats, elapsed },
    });
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
