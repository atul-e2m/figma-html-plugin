import { IRNode, IRPage, AssetMap } from "../core/types";

/**
 * section-specs.json — schema_version 2.0.
 * v1.x keys are preserved byte-identically so the existing
 * extract_plugin_export.py keeps working; `media` and `interactions`
 * are additive and safely ignored by v1 consumers.
 */
export function emitSectionSpecs(page: IRPage): unknown {
  const sections: Record<string, unknown> = {};

  for (const sec of page.sections) {
    const elements: Record<string, unknown> = {};
    const media: Record<string, unknown> = {};
    const interactions: Record<string, unknown> = {};

    const visit = (n: IRNode, path: string) => {
      const key = n.role ? `${n.role}` : n.className;
      const k = elements[key] ? `${key}-${n.id.slice(-4)}` : key;
      elements[k] = {
        tag: n.tag,
        figmaNodeId: n.id,
        figmaType: n.figmaType,
        text: n.text,
        ...n.style,
      };
      if (n.assetRef) {
        media[k] = { kind: n.assetKind, assetRef: n.assetRef,
                     width: n.bbox.width, height: n.bbox.height };
      }
      if (n.interactions) interactions[k] = n.interactions;
      n.children.forEach((c, i) => visit(c, `${path}/${i}`));
    };
    visit(sec.root, "root");

    sections[sec.slug] = {
      spacingSource: sec.root.spacingSource,
      figmaNodeId: sec.id,
      screenshotFile: `screenshots/${sec.slug}-desktop.png`,
      section: sec.root.style,
      elements,
      ...(Object.keys(media).length ? { media } : {}),
      ...(Object.keys(interactions).length ? { interactions } : {}),
    };
  }

  return {
    schema_version: "2.0",
    figma_canvas_width: page.canvasWidth,
    figma_canvas_height: page.canvasHeight,
    page_slug: page.slug,
    extracted_at: new Date().toISOString(),
    sections,
  };
}

/** Design tokens — real Figma Variables when bound, observed values otherwise. */
export async function emitTokens(page: IRPage): Promise<unknown> {
  const colors: Record<string, string> = {};
  const typography: Record<string, unknown> = {};
  const spacing: Record<string, string> = {};

  try {
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) {
      const modes = Object.keys(v.valuesByMode);
      if (!modes.length) continue;
      const val = v.valuesByMode[modes[0]];
      if (v.resolvedType === "COLOR" && val && typeof val === "object" && "r" in val) {
        const c = val as RGBA;
        const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
        colors[v.name] = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
      } else if (v.resolvedType === "FLOAT" && typeof val === "number") {
        spacing[v.name] = `${val}px`;
      }
    }
  } catch { /* Variables API unavailable — fall back to observed values. */ }

  // Observed values as a fallback / supplement.
  const seenColors = new Set<string>();
  const seenFonts = new Map<string, { size: string; weight: string; lineHeight?: string }>();
  const visit = (n: IRNode) => {
    if (n.style.backgroundColor) seenColors.add(n.style.backgroundColor);
    if (n.style.color) seenColors.add(n.style.color);
    if (n.style.fontFamily && n.style.fontSize) {
      const key = `${n.tag}`;
      if (!seenFonts.has(key)) {
        seenFonts.set(key, {
          size: n.style.fontSize, weight: n.style.fontWeight || "400",
          lineHeight: n.style.lineHeight,
        });
      }
    }
    n.children.forEach(visit);
  };
  page.sections.forEach((s) => visit(s.root));

  let i = 1;
  for (const c of seenColors) if (!Object.values(colors).includes(c)) colors[`color-${i++}`] = c;
  for (const [tag, f] of seenFonts) typography[tag] = f;

  return {
    schema_version: "2.0",
    colors,
    typography,
    spacing,
    canvas: { width: page.canvasWidth, height: page.canvasHeight },
  };
}

/** content.json — editable text, repeaters preserved as arrays. */
export function emitContent(page: IRPage): unknown {
  const out: Record<string, unknown> = {};
  for (const sec of page.sections) {
    const bucket: Record<string, unknown> = {};
    const counts = new Map<string, string[]>();
    const visit = (n: IRNode) => {
      if (n.text !== undefined) {
        const key = n.role || n.tag;
        const arr = counts.get(key) || [];
        arr.push(n.text);
        counts.set(key, arr);
      }
      n.children.forEach(visit);
    };
    visit(sec.root);
    for (const [k, arr] of counts) bucket[k] = arr.length === 1 ? arr[0] : arr;
    out[sec.slug] = bucket;
  }
  return { schema_version: "2.0", page_slug: page.slug, sections: out };
}

export function emitImageMap(assets: AssetMap): unknown {
  const images: Record<string, unknown> = {};
  for (const rec of assets.values()) {
    images[rec.filename] = {
      kind: rec.kind, hash: rec.hash, nodeName: rec.nodeName,
      width: rec.width, height: rec.height,
    };
  }
  return { schema_version: "2.0", images };
}
