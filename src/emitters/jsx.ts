import { IRNode, IRPage } from "../core/types";

const pascal = (s: string) =>
  s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
   .replace(/^[a-z]/, (c) => c.toUpperCase()) || "Section";

const escJsx = (s: string) =>
  s.replace(/([{}])/g, "{'$1'}").replace(/\n/g, " ");

function renderNode(n: IRNode, classOf: Map<string, string>, indent: string): string {
  const cls = classOf.get(n.id);
  const clsAttr = cls ? ` className="${cls}"` : "";

  if (n.tag === "svg" && n.svgMarkup) {
    // SVG attributes must be camelCased for JSX.
    const jsxSvg = n.svgMarkup
      .replace(/([a-z])-([a-z])/g, (_, a, b) => a + b.toUpperCase())
      .replace("<svg", `<svg${clsAttr}`);
    return `${indent}${jsxSvg}`;
  }
  if (n.tag === "img") {
    return `${indent}<img${clsAttr} src="../assets/images/${n.assetRef || ""}" alt="${n.name}" loading="lazy" />`;
  }
  if (n.tag === "video") {
    return `${indent}<video${clsAttr}${n.assetRef ? ` poster="../assets/video/${n.assetRef}"` : ""} autoPlay muted loop playsInline />`;
  }

  if (n.text !== undefined && !n.children.length) {
    return `${indent}<${n.tag}${clsAttr}>${escJsx(n.text)}</${n.tag}>`;
  }
  const inner = n.children.map((c) => renderNode(c, classOf, indent + "  ")).join("\n");
  if (!inner) return `${indent}<${n.tag}${clsAttr} />`;
  return `${indent}<${n.tag}${clsAttr}>\n${inner}\n${indent}</${n.tag}>`;
}

function jsImport(n: IRNode): string {
  return `"${"./assets/images/"}${n.assetRef || ""}"`;
}

export function emitJsx(
  page: IRPage, classOf: Map<string, string>, typescript: boolean
): { filename: string; code: string } {
  const name = pascal(page.name);
  const ext = typescript ? "tsx" : "jsx";
  const body = page.sections
    .map((s) => renderNode(s.root, classOf, "      "))
    .join("\n");

  const code = `import React from "react";
import "./styles.css";

/**
 * Generated from Figma frame: ${page.name}
 * Canvas: ${page.canvasWidth}x${page.canvasHeight}
 * Regenerate from the plugin rather than editing by hand.
 */
export default function ${name}()${typescript ? ": React.JSX.Element" : ""} {
  return (
    <div className="page-root">
${body}
    </div>
  );
}
`;
  return { filename: `${name}.${ext}`, code };
}
