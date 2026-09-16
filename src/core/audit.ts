import { IRNode, IRPage } from "./types";

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
  weight: number;          // contribution to the score
}

export interface AuditReport {
  score: number;           // 0-100
  checks: Check[];
  measured?: MeasuredReport;
}

/** Figma-side expectations the UI measures the rendered page against. */
export interface Expectation {
  canvasWidth: number;
  canvasHeight: number;
  sections: Array<{ slug: string; height: number; y: number }>;
}

export interface MeasuredReport {
  docHeight: number;
  expectedHeight: number;
  heightDelta: number;
  overflowCount: number;
  brokenImages: number;
  sectionDeltas: Array<{ slug: string; expected: number; actual: number; delta: number }>;
}

export function buildExpectation(page: IRPage): Expectation {
  let y = 0;
  const sections = page.sections.map((s) => {
    const rec = { slug: s.slug, height: Math.round(s.bbox.height), y };
    y += s.bbox.height;
    return rec;
  });
  return {
    canvasWidth: page.canvasWidth,
    canvasHeight: page.canvasHeight,
    sections,
  };
}

/**
 * Static checks over the generated tree — things that are knowably wrong
 * without rendering. These run BEFORE the measured pass and catch the classes
 * of bug that produced silent breakage in earlier exports.
 */
export function staticChecks(page: IRPage, cssRuleCount: number): Check[] {
  const checks: Check[] = [];
  let nodes = 0, unstyled = 0, zeroSize = 0, fixedWide = 0;
  let textNodes = 0, emptyText = 0, absChildren = 0, imgs = 0, missingAsset = 0;

  const visit = (n: IRNode, depth: number) => {
    nodes++;
    const st = n.style;
    if (!Object.keys(st).length) unstyled++;
    if (st.position === "absolute") absChildren++;
    if (n.tag === "img" || n.tag === "video") {
      imgs++;
      if (!n.assetRef) missingAsset++;
    }
    if (n.text !== undefined) {
      textNodes++;
      if (!n.text.trim()) emptyText++;
    }
    // A fixed px width wider than 60% of canvas is an overflow risk.
    if (st.width && st.width.endsWith("px") && !st.maxWidth) {
      const w = parseFloat(st.width);
      if (w > page.canvasWidth * 0.6) fixedWide++;
    }
    if (n.bbox.width === 0 || n.bbox.height === 0) zeroSize++;
    n.children.forEach((c) => visit(c, depth + 1));
  };
  page.sections.forEach((s) => visit(s.root, 0));

  checks.push({
    id: "styled", label: "Every element styled", weight: 20,
    pass: unstyled === 0,
    detail: unstyled === 0 ? `${nodes} nodes` : `${unstyled}/${nodes} nodes have no CSS`,
  });
  checks.push({
    id: "overflow-risk", label: "No unbounded fixed widths", weight: 20,
    pass: fixedWide === 0,
    detail: fixedWide === 0 ? "all widths bounded" : `${fixedWide} wide px widths without max-width`,
  });
  checks.push({
    id: "assets", label: "Media resolved", weight: 15,
    pass: missingAsset === 0,
    detail: missingAsset === 0 ? `${imgs} media nodes` : `${missingAsset}/${imgs} missing a file`,
  });
  checks.push({
    id: "text", label: "Text captured", weight: 10,
    pass: emptyText === 0 && textNodes > 0,
    detail: textNodes === 0 ? "no text found" : `${textNodes} text nodes, ${emptyText} empty`,
  });
  checks.push({
    id: "rules", label: "CSS emitted", weight: 10,
    pass: cssRuleCount > 0,
    detail: `${cssRuleCount} rules`,
  });
  return checks;
}

export function scoreOf(checks: Check[], measured?: MeasuredReport): number {
  let got = 0, total = 0;
  for (const c of checks) { total += c.weight; if (c.pass) got += c.weight; }

  // The measured pass is worth 25 — the single most informative signal.
  if (measured) {
    total += 25;
    const pctOff = measured.expectedHeight
      ? Math.abs(measured.heightDelta) / measured.expectedHeight : 1;
    let m = 0;
    if (pctOff <= 0.02) m = 25;
    else if (pctOff <= 0.05) m = 20;
    else if (pctOff <= 0.10) m = 14;
    else if (pctOff <= 0.20) m = 7;
    if (measured.overflowCount > 0) m = Math.max(0, m - 8);
    if (measured.brokenImages > 0) m = Math.max(0, m - 5);
    got += m;
  }
  return Math.round((got / total) * 100);
}
