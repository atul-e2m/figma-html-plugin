/**
 * Planner: IR frame (+ screenshot) -> Plan.
 *
 *   planFrame(doc, frame, { bundleDir, useModel })
 *     - useModel=false  -> heuristic plan (instant, offline)
 *     - useModel=true   -> Claude reads the outline + screenshot strips and
 *                          returns a schema-validated plan; heuristics fill gaps.
 *   refinePlan(...)     -> same, seeded with a previous plan + verify measurements.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import Anthropic from "@anthropic-ai/sdk";
import type { IRDocument, IRFrame } from "../ir/schema.ts";
import { type Plan, PLAN_JSON_SCHEMA, normalizePlan } from "../ir/plan.ts";
import { buildOutline, outlineHash } from "./outline.ts";
import { defaultPlan } from "./default.ts";
import { PLAN_SYSTEM, REFINE_SYSTEM, RESPONSIVE_SYSTEM, planUserText, refineUserText, responsiveUserText, type VerifyMeasurements } from "./prompt.ts";
import { RESPONSIVE_JSON_SCHEMA, normalizeResponsive } from "../ir/plan.ts";

export const PLANNER_MODEL = "claude-opus-5";

export type Provider = "anthropic" | "openrouter";
export const OPENROUTER_MODEL = "anthropic/claude-opus-5";

export interface PlanOptions {
  bundleDir: string;
  useModel: boolean;
  /** anthropic (SDK, ANTHROPIC_API_KEY) or openrouter (OPENROUTER_API_KEY). */
  provider?: Provider;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Print the request (minus image bytes) instead of calling the API. */
  dryRun?: boolean;
  /** Ignore the plan cache. */
  replan?: boolean;
  log?: (msg: string) => void;
  client?: Anthropic;
}

/* ------------------------------------------------------- screenshots */

interface Strip { png: Buffer; fromY: number; toY: number }

/** Slice the full-frame screenshot into strips the model can read (≤ ~1000px wide, ≤ 1400px tall). */
export function screenshotStrips(pngBytes: Buffer, shotScale: number, maxStrips = 16, maxWidth = 1000): Strip[] {
  const src = PNG.sync.read(pngBytes);
  const k = Math.max(1, Math.ceil(src.width / maxWidth));       // integer downscale factor
  const w = Math.floor(src.width / k), h = Math.floor(src.height / k);
  const small = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = ((y * k + dy) * src.width + (x * k + dx)) * 4;
      r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
    }
    const n = k * k, o = (y * w + x) * 4;
    // composite on white so transparent frames do not read as black
    const al = a / n / 255;
    small.data[o] = Math.round((r / n) * al + 255 * (1 - al));
    small.data[o + 1] = Math.round((g / n) * al + 255 * (1 - al));
    small.data[o + 2] = Math.round((b / n) * al + 255 * (1 - al));
    small.data[o + 3] = 255;
  }
  let stripH = 1400;
  if (Math.ceil(h / stripH) > maxStrips) stripH = Math.ceil(h / maxStrips);
  // Providers reject images taller than 8000px; more strips beat a rejected request.
  stripH = Math.min(stripH, 7000);
  const strips: Strip[] = [];
  const designPerPx = k / shotScale;
  for (let y0 = 0; y0 < h; y0 += stripH) {
    const sh = Math.min(stripH, h - y0);
    const s = new PNG({ width: w, height: sh });
    small.data.copy(s.data, 0, y0 * w * 4, (y0 + sh) * w * 4);
    strips.push({ png: PNG.sync.write(s), fromY: Math.round(y0 * designPerPx), toY: Math.round((y0 + sh) * designPerPx) });
  }
  return strips;
}

/* --------------------------------------------------------------- API */

type Content = Anthropic.MessageParam["content"];

function buildContent(strips: Strip[], userText: string): Content {
  const blocks: Anthropic.ContentBlockParam[] = [];
  strips.forEach((s, i) => {
    blocks.push({ type: "text", text: `Strip ${i + 1}/${strips.length}: design y ${s.fromY}–${s.toY}` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: s.png.toString("base64") } });
  });
  blocks.push({ type: "text", text: userText });
  return blocks;
}

async function callModel(client: Anthropic, model: string, effort: PlanOptions["effort"], system: string, content: Content, log: (m: string) => void, schema: object = PLAN_JSON_SCHEMA): Promise<unknown> {
  const base = {
    model,
    max_tokens: 32000,
    system,
    messages: [{ role: "user" as const, content: content as Anthropic.Beta.BetaContentBlockParam[] }],
    output_config: { effort: effort || "high", format: { type: "json_schema", schema } },
  };
  // A safety decline is re-run on a fallback model inside the same call. If
  // the account or SDK predates the parameter, retry once without it.
  const withFallback = { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await client.beta.messages.stream(withFallback as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
      log("server-side fallbacks not accepted; retrying without");
      msg = await client.beta.messages.stream(base as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming).finalMessage();
    } else throw e;
  }
  if (msg.stop_reason === "refusal") throw new Error(`model declined the request (${JSON.stringify((msg as unknown as { stop_details?: unknown }).stop_details ?? null)})`);
  if (msg.stop_reason === "max_tokens") throw new Error("plan truncated at max_tokens; raise the limit");
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  log(`model: ${msg.model}, in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`model returned non-JSON: ${text.slice(0, 200)}`); }
}

/**
 * OpenRouter speaks the OpenAI chat format. Same system prompt, same JSON
 * schema (strict), images as data URLs. Routed only to providers that honour
 * response_format so the plan is always schema-valid.
 */
async function callOpenRouter(model: string, effort: PlanOptions["effort"], system: string, content: Content, log: (m: string) => void, schema: object = PLAN_JSON_SCHEMA): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const parts = (content as Anthropic.ContentBlockParam[]).map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image" && b.source.type === "base64") return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    throw new Error(`unsupported block ${b.type}`);
  });
  const reasoning = effort === "low" || effort === "medium" ? effort : "high";
  const body = {
    model,
    max_tokens: 32000,
    messages: [{ role: "system", content: system }, { role: "user", content: parts }],
    response_format: { type: "json_schema", json_schema: { name: "layout_plan", strict: true, schema } },
    provider: { require_parameters: true },
    reasoning: { effort: reasoning },
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/figma-ir-pipeline", "X-Title": "figma-ir-pipeline planner" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message}`);
  const ch = data.choices?.[0];
  if (!ch?.message) throw new Error(`OpenRouter returned no choices: ${text.slice(0, 300)}`);
  if (ch.message.refusal) throw new Error(`model declined: ${ch.message.refusal}`);
  if (ch.finish_reason === "length") throw new Error("plan truncated at max_tokens; raise the limit");
  log(`openrouter ${model}: in=${data.usage?.prompt_tokens ?? "?"} out=${data.usage?.completion_tokens ?? "?"}`);
  const raw = ch.message.content || "";
  try { return JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error(`model returned non-JSON: ${raw.slice(0, 200)}`); }
}

function pickProvider(opts: PlanOptions): Provider {
  if (opts.provider) return opts.provider;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "anthropic";
}
function modelFor(opts: PlanOptions, provider: Provider): string {
  if (opts.model) return opts.model;
  return provider === "openrouter" ? OPENROUTER_MODEL : PLANNER_MODEL;
}
async function ask(opts: PlanOptions, system: string, content: Content, log: (m: string) => void, schema: object = PLAN_JSON_SCHEMA): Promise<{ raw: unknown; model: string }> {
  const provider = pickProvider(opts);
  const model = modelFor(opts, provider);
  log(`planner: ${provider} / ${model} / effort ${opts.effort || "high"}`);
  const raw = provider === "openrouter"
    ? await callOpenRouter(model, opts.effort, system, content, log, schema)
    : await callModel(opts.client || new Anthropic(), model, opts.effort, system, content, log, schema);
  return { raw, model };
}

/* ------------------------------------------------------------- plans */

/** Fill anything the model left empty from the heuristic plan. */
function mergeWithDefault(p: Plan, d: Plan): Plan {
  if (!p.sections.length) p.sections = d.sections;
  if (!p.page.title) p.page.title = d.page.title;
  const have = new Set(p.textPolicy.map((t) => t.id));
  for (const t of d.textPolicy) if (!have.has(t.id)) p.textPolicy.push(t);
  return p;
}

export async function planFrame(doc: IRDocument, frame: IRFrame, opts: PlanOptions): Promise<Plan> {
  const log = opts.log || (() => {});
  const heuristic = defaultPlan(frame);
  if (!opts.useModel) return heuristic;

  const outline = buildOutline(frame);
  const hash = outlineHash(outline.text);
  const cacheDir = path.join(opts.bundleDir, ".plan-cache");
  const cacheFile = path.join(cacheDir, `${frame.slug}-${hash}.json`);
  if (!opts.replan && fs.existsSync(cacheFile)) { log(`plan cache hit ${path.relative(opts.bundleDir, cacheFile)}`); return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Plan; }

  let strips: Strip[] = [];
  if (frame.screenshot) {
    const p = path.join(opts.bundleDir, frame.screenshot);
    if (fs.existsSync(p)) strips = screenshotStrips(fs.readFileSync(p), frame.screenshotScale);
    else log(`screenshot ${frame.screenshot} missing; planning from the outline only`);
  }
  const userText = planUserText(frame.name, frame.width, frame.height, outline.text, outline.truncated);
  const content = buildContent(strips, userText);
  log(`outline: ${outline.nodeCount} nodes, ${outline.text.length} chars; ${strips.length} screenshot strips`);

  if (opts.dryRun) {
    const dump = { provider: pickProvider(opts), model: modelFor(opts, pickProvider(opts)), system: PLAN_SYSTEM, strips: strips.map((s) => ({ fromY: s.fromY, toY: s.toY, bytes: s.png.length })), userText };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${frame.slug}-${hash}.request.json`), JSON.stringify(dump, null, 2));
    log(`dry run: request written to .plan-cache/${frame.slug}-${hash}.request.json`);
    return heuristic;
  }

  const { raw, model } = await ask(opts, PLAN_SYSTEM, content, log);
  const plan = mergeWithDefault(normalizePlan({ ...(raw as object), source: "model", model }, outline.ids, frame.id, heuristic.pageRoot), heuristic);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(plan, null, 2));
  return plan;
}

export async function refinePlan(doc: IRDocument, frame: IRFrame, previous: Plan, measured: VerifyMeasurements, opts: PlanOptions): Promise<Plan> {
  const log = opts.log || (() => {});
  const outline = buildOutline(frame);
  let strips: Strip[] = [];
  if (frame.screenshot) { const p = path.join(opts.bundleDir, frame.screenshot); if (fs.existsSync(p)) strips = screenshotStrips(fs.readFileSync(p), frame.screenshotScale); }
  const text = `${refineUserText(previous, measured)}\n\nLAYER OUTLINE (for ids):\n${outline.text}`;
  const content = buildContent(strips, text);
  if (opts.dryRun) { log("dry run: refine request not sent"); return previous; }
  const { raw, model } = await ask(opts, REFINE_SYSTEM, content, log);
  return mergeWithDefault(normalizePlan({ ...(raw as object), source: "model", model }, outline.ids, frame.id, previous.pageRoot), defaultPlan(frame));
}


export interface AuditInput { widths: Record<string, { height: number; overflow: string[]; clipped: string[]; overlapping: string[]; narrowText?: string[] }>; screenshots: Record<string, string> }

/**
 * Responsive pass: the model sees the design, the baseline renders at tablet and
 * phone width, and the audit of those renders, and returns per-node corrections.
 * Merged into plan.responsive (replacing earlier model decisions).
 */
export async function responsivePlan(doc: IRDocument, frame: IRFrame, plan: Plan, audit: AuditInput, opts: PlanOptions): Promise<Plan> {
  const log = opts.log || (() => {});
  const outline = buildOutline(frame);
  const hash = outlineHash(outline.text + JSON.stringify(Object.values(audit.widths).map((w) => [w.overflow.length, w.clipped.length, w.overlapping.length])));
  const cacheDir = path.join(opts.bundleDir, ".plan-cache");
  const cacheFile = path.join(cacheDir, `${frame.slug}-${hash}.responsive.json`);
  if (!opts.replan && fs.existsSync(cacheFile)) { log(`responsive cache hit`); return { ...plan, responsive: JSON.parse(fs.readFileSync(cacheFile, "utf8")) }; }

  // Image budget: providers cap the total image payload (OpenRouter: 30MB). A tall
  // page rendered at three widths blows through it, so shrink until it fits.
  const BUDGET = 18 * 1024 * 1024;
  let blocks: Anthropic.ContentBlockParam[] = [];
  const shotFile = frame.screenshot ? path.join(opts.bundleDir, frame.screenshot) : null;
  for (const [designW, renderW, designN, renderN] of [[800, 600, 6, 4], [640, 480, 4, 3], [480, 360, 3, 2], [360, 240, 2, 1]] as const) {
    blocks = [];
    let bytes = 0;
    if (shotFile && fs.existsSync(shotFile)) {
      const strips = screenshotStrips(fs.readFileSync(shotFile), frame.screenshotScale, designN, designW);
      strips.forEach((s, i) => { bytes += s.png.length; blocks.push({ type: "text", text: `Design strip ${i + 1}/${strips.length}: y ${s.fromY}–${s.toY}` }); blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: s.png.toString("base64") } }); });
    }
    for (const [w, file] of Object.entries(audit.screenshots).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      if (!fs.existsSync(file)) continue;
      const parts = screenshotStrips(fs.readFileSync(file), 1, renderN, renderW);
      parts.forEach((s, i) => { bytes += s.png.length; blocks.push({ type: "text", text: `Baseline render at ${w}px, part ${i + 1}/${parts.length}` }); blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: s.png.toString("base64") } }); });
    }
    if (bytes <= BUDGET) break;
    log(`image payload ${(bytes / 1048576).toFixed(1)}MB over budget; shrinking`);
  }
  blocks.push({ type: "text", text: responsiveUserText(frame.name, frame.width, outline.text, audit.widths) });
  log(`responsive pass: ${blocks.filter((b) => b.type === "image").length} images (design + renders at ${Object.keys(audit.screenshots).join(", ")}px)`);
  if (opts.dryRun) { log("dry run: responsive request not sent"); return plan; }
  const { raw } = await ask(opts, RESPONSIVE_SYSTEM, blocks, log, RESPONSIVE_JSON_SCHEMA);
  const entries = normalizeResponsive((raw as { responsive?: unknown }).responsive, outline.ids);
  log(`responsive: ${entries.length} decision(s)${(raw as { notes?: string }).notes ? ` — ${String((raw as { notes?: string }).notes).slice(0, 200)}` : ""}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(entries, null, 2));
  return { ...plan, responsive: entries };
}
