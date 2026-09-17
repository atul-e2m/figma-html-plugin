import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSample } from "./fixture.ts";
import { defaultPlan } from "../src/planner/default.ts";
import { compileElementor } from "../src/compiler/index.ts";
import { convertStyle, type ElementorElement } from "../src/compiler/elementor.ts";

const id = (r: string) => r;

test("convertStyle: layout, spacing, typography become typed V4 props", () => {
  const { props, rest } = convertStyle({
    display: "flex", "flex-direction": "column", gap: "24px 16px", padding: "10px 20px", margin: "0 auto",
    width: "min(100%, 350px)", height: "600px", "font-size": "56px", "line-height": "1.2", "font-family": "\"DM Sans\", sans-serif",
    "font-weight": "700", color: "#111111", "text-align": "left", "border-radius": "8px", "z-index": "2", opacity: "0.5",
    "white-space": "nowrap", "text-box-trim": "trim-both",
  }, id);
  assert.deepEqual(props.display, { $$type: "string", value: "flex" });
  assert.deepEqual(props.gap, { $$type: "layout-direction", value: { row: { $$type: "size", value: { size: 24, unit: "px" } }, column: { $$type: "size", value: { size: 16, unit: "px" } } } });
  assert.deepEqual((props.padding.value as Record<string, unknown>)["inline-end"], { $$type: "size", value: { size: 20, unit: "px" } });
  assert.deepEqual((props.margin.value as Record<string, unknown>)["inline-start"], { $$type: "size", value: { size: "", unit: "auto" } });
  assert.deepEqual(props.width, { $$type: "size", value: { size: "min(100%, 350px)", unit: "custom" } }, "calc-like values ride in a custom unit");
  assert.deepEqual(props["line-height"], { $$type: "size", value: { size: "1.2", unit: "custom" } });
  assert.deepEqual(props["font-family"], { $$type: "font-family", value: "DM Sans" });
  assert.deepEqual(props["font-weight"], { $$type: "string", value: "700" });
  assert.deepEqual(props["text-align"], { $$type: "string", value: "start" });
  assert.deepEqual(props["border-radius"], { $$type: "size", value: { size: 8, unit: "px" } });
  assert.deepEqual(props["z-index"], { $$type: "number", value: 2 });
  assert.deepEqual(props.opacity, { $$type: "size", value: { size: 50, unit: "%" } });
  assert.deepEqual(rest, { "white-space": "nowrap", "text-box-trim": "trim-both" }, "unsupported declarations go to the companion css");
});

test("convertStyle: background layers, shadows, transforms, position", () => {
  const { props, rest } = convertStyle({
    "background-color": "#ffffff",
    "background-image": "url(\"assets/hero.png\"), linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.6) 100%)",
    "background-size": "cover, auto", "background-position": "center, center", "background-repeat": "no-repeat",
    "box-shadow": "inset 0 0 0 1px #000000, 0 4px 12px 0 rgba(0, 0, 0, 0.2)",
    transform: "translate(-50%, 10px) rotate(45deg)", position: "absolute", top: "0", left: "50%", inset: "auto",
    border: "1px solid rgba(0, 0, 0, 0.1)", flex: "0 0 calc(50% - 12px)", transition: "all 300ms ease-in-out",
  }, (r) => `https://cdn.test/${r}`);
  const bg = props.background.value as { color: unknown; "background-overlay": { value: Array<{ $$type: string; value: Record<string, unknown> }> } };
  assert.deepEqual(bg.color, { $$type: "color", value: "#ffffff" });
  assert.equal(bg["background-overlay"].value.length, 2);
  const img = bg["background-overlay"].value[0];
  assert.equal(img.$$type, "background-image-overlay");
  assert.equal(JSON.stringify(img.value.image).includes("https://cdn.test/assets/hero.png"), true);
  assert.deepEqual(img.value.size, { $$type: "string", value: "cover" });
  assert.deepEqual(img.value.position, { $$type: "string", value: "center center" });
  const grad = bg["background-overlay"].value[1];
  assert.equal(grad.$$type, "background-gradient-overlay");
  assert.deepEqual(grad.value.angle, { $$type: "number", value: 180 });
  assert.equal((grad.value.stops as { value: unknown[] }).value.length, 2);
  const shadows = props["box-shadow"].value as Array<{ value: Record<string, unknown> }>;
  assert.equal(shadows.length, 2);
  assert.deepEqual(shadows[0].value.position, { $$type: "string", value: "inset" });
  assert.deepEqual(shadows[1].value.blur, { $$type: "size", value: { size: 12, unit: "px" } });
  const fns = (props.transform.value as { "transform-functions": { value: Array<{ $$type: string }> } })["transform-functions"].value;
  assert.deepEqual(fns.map((f) => f.$$type), ["transform-move", "transform-rotate"]);
  assert.deepEqual(props["inset-block-start"], { $$type: "size", value: { size: 0, unit: "px" } }, "longhand top wins over the inset shorthand");
  assert.deepEqual(props["inset-inline-start"], { $$type: "size", value: { size: 50, unit: "%" } });
  assert.deepEqual(props["inset-block-end"], { $$type: "size", value: { size: "", unit: "auto" } });
  assert.deepEqual(props["border-width"], { $$type: "size", value: { size: 1, unit: "px" } });
  assert.deepEqual(props["border-style"], { $$type: "string", value: "solid" });
  assert.deepEqual((props.flex.value as Record<string, unknown>).flexBasis, { $$type: "size", value: { size: "calc(50% - 12px)", unit: "custom" } });
  assert.equal(props.transition.$$type, "transition");
  assert.deepEqual(rest, {});
});

test("convertStyle: nested functions parse with balanced parentheses and colours become hex", () => {
  const { props } = convertStyle({ filter: "drop-shadow(0px 8px 20px rgba(11, 62, 71, 0.2))", "backdrop-filter": "blur(4px)" }, id);
  const fn = (props.filter.value as Array<{ value: { args: { value: { color: { value: string } } } } }>)[0];
  assert.equal(fn.value.args.value.color.value, "#0b3e4733");
  assert.equal(props["backdrop-filter"].$$type, "backdrop-filter");
});

test("convertStyle: a partial flex longhand is completed with the CSS initial values", () => {
  const { props } = convertStyle({ "flex-shrink": "0" }, id);
  assert.deepEqual(props.flex, { $$type: "flex", value: { flexGrow: { $$type: "number", value: 0 }, flexShrink: { $$type: "number", value: 0 }, flexBasis: { $$type: "size", value: { size: "", unit: "auto" } } } });
});

test("convertStyle: what V4 cannot hold falls back as a unit", () => {
  const { props, rest } = convertStyle({ transform: "none", "background-image": "radial-gradient(circle, #fff, #000)", "background-size": "cover", "align-items": "baseline", filter: "brightness(0.5)" }, id);
  assert.deepEqual(props, {});
  assert.deepEqual(Object.keys(rest).sort(), ["align-items", "background-image", "background-size", "filter", "transform"]);
});

test("compileElementor: template shape, element kinds, companion css", () => {
  const { doc } = makeSample();
  const plan = defaultPlan(doc.frames[0]);
  const out = compileElementor(doc, new Map([[doc.frames[0].id, plan]]), { publicBase: "https://cdn.test/site" });
  const tpl = JSON.parse(out.files.get("template.json")!) as { content: ElementorElement[]; version: string; type: string; title: string };
  assert.equal(tpl.version, "0.4"); assert.equal(tpl.type, "page"); assert.equal(tpl.title, "Discover the wild coast");
  assert.equal(tpl.content.length, 1, "one root element");
  const root = tpl.content[0];
  assert.equal(root.elType, "e-flexbox");
  assert.equal(root.elements.length, 4, "one child per section");
  assert.deepEqual(root.elements.map((s) => s.settings.tag), [{ $$type: "string", value: "header" }, { $$type: "string", value: "section" }, { $$type: "string", value: "section" }, { $$type: "string", value: "footer" }]);

  const all: ElementorElement[] = []; const walk = (e: ElementorElement) => { all.push(e); e.elements.forEach(walk); }; walk(root);
  const kinds = new Map<string, number>(); for (const e of all) kinds.set(e.widgetType || e.elType, (kinds.get(e.widgetType || e.elType) || 0) + 1);
  assert.ok((kinds.get("e-heading") || 0) >= 4, "headings");
  assert.ok((kinds.get("e-paragraph") || 0) >= 2, "paragraphs");
  assert.ok((kinds.get("e-image") || 0) >= 1, "images");
  assert.ok((kinds.get("e-svg") || 0) >= 1, "svg logo");
  const h1 = all.find((e) => e.widgetType === "e-heading" && (e.settings.tag as { value: string }).value === "h1")!;
  assert.deepEqual(h1.settings.title, { $$type: "html-v3", value: { content: { $$type: "string", value: "Discover the wild coast" }, children: [] } });
  assert.equal(all.filter((e) => e.widgetType === "e-heading" && (e.settings.tag as { value: string }).value === "h1").length, 1, "exactly one h1");
  const hrefs = all.filter((e) => e.settings.link).map((e) => (e.settings.link.value as { destination: { value: string } }).destination.value);
  assert.ok(hrefs.includes("#book"), `click-to-url reaction becomes a link (got ${hrefs.join(", ")})`);

  for (const e of all) {
    assert.match(e.id, /^[0-9a-f]{7}$/);
    const styleIds = Object.keys(e.styles);
    assert.equal(styleIds.length, 1);
    assert.match(styleIds[0], new RegExp(`^e-${e.id}-[0-9a-f]{7}$`));
    assert.deepEqual(e.settings.classes, { $$type: "classes", value: styleIds });
    assert.equal(e.styles[styleIds[0]].type, "class");
    for (const v of e.styles[styleIds[0]].variants) { assert.ok(["desktop", "laptop", "tablet_extra", "tablet", "mobile_extra", "mobile"].includes(v.meta.breakpoint)); assert.ok(v.meta.state === null || v.meta.state === "hover"); }
    if (e.elType !== "widget") assert.ok(e.styles[styleIds[0]].variants[0].props.padding, `${e.editor_settings.title}: containers always override the 10px base padding`);
    if (e.elType !== "widget") assert.ok(e.styles[styleIds[0]].variants[0].props.display, `${e.editor_settings.title}: containers always set display`);
  }
  const img = all.find((e) => e.widgetType === "e-image")!;
  assert.match(JSON.stringify(img.settings.image), /https:\/\/cdn\.test\/site\/assets\/[^"]+\.png/);
  const svg = all.find((e) => e.widgetType === "e-svg")!;
  assert.match(JSON.stringify(svg.settings.svg), /https:\/\/cdn\.test\/site\/assets\/f2h-[0-9a-f]{7}\.svg/);
  assert.ok([...out.files.keys()].some((f) => /^assets\/f2h-[0-9a-f]{7}\.svg$/.test(f)), "inline vector written as a file");

  const css = out.files.get("elementor.css")!;
  assert.match(css, /#f2h-[0-9a-f]{7}, #f2h-[0-9a-f]{7} \* \{ box-sizing: border-box; \}/);
  assert.match(css, /@font-face \{ font-family: "DM Sans"/);
  assert.match(css, /url\("https:\/\/cdn\.test\/site\/fonts\//);
  assert.ok(out.report.companionRules >= 1);
  assert.ok(out.assetFiles.has("hero-bg.png"));
});
