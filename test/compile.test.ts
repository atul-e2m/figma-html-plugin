import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSample, node, col, row, text } from "./fixture.ts";
import { defaultPlan } from "../src/planner/default.ts";
import { buildOutline } from "../src/planner/outline.ts";
import { compileDocument } from "../src/compiler/index.ts";
import { normalizePlan } from "../src/ir/plan.ts";

function writeBundle(): string {
  const { doc, files } = makeSample();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f2h-fixture-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ir.json"), JSON.stringify(doc));
  for (const [f, b] of files) fs.writeFileSync(path.join(dir, f), b);
  return dir;
}

test("heuristic plan finds the page and its sections", () => {
  const { doc } = makeSample();
  const plan = defaultPlan(doc.frames[0]);
  assert.equal(plan.sections.length, 4);
  assert.deepEqual(plan.sections.map((s) => s.slug), ["header", "hero", "tours-section", "footer"]);
  assert.equal(plan.sections[0].tag, "header");
  assert.equal(plan.sections[3].tag, "footer");
  assert.equal(plan.page.title, "Discover the wild coast");
  assert.ok(plan.textPolicy.length >= 2, "multi-line copy is marked reflow");
});

test("outline lists every node id and layout facts", () => {
  const { doc } = makeSample();
  const o = buildOutline(doc.frames[0]);
  assert.ok(o.ids.size > 30);
  assert.match(o.text, /layout=row\+wrap gap=40/);
  assert.match(o.text, /img-fill/);
  assert.match(o.text, /text\(56px,2ln\)="Discover the wild coast"/);
});

test("compile: semantic tags, grid, overlay, assets, fonts", () => {
  const { doc } = makeSample();
  const plan = defaultPlan(doc.frames[0]);
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const html = out.files.get("index.html")!, css = out.files.get("styles.css")!;
  assert.match(html, /<header [^>]*data-section="header"/);
  assert.match(html, /<footer [^>]*data-section="footer"/);
  assert.match(html, /<h1 [^>]*>Discover the wild coast<\/h1>/);
  assert.match(html, /<h[34] [^>]*>Tour 1<\/h[34]>/, "card titles are sub-headings, not h1");
  assert.match(html, /<a [^>]*href="#book"/, "click-to-url reaction becomes a link");
  assert.match(html, /<svg [^>]*class="logo"/, "vector inlined");
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=DM\+Sans/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, "wrapping auto-layout becomes a 3-column grid");
  assert.match(css, /\.hero \{[^}]*position: relative;/s, "hero is an overlay");
  assert.match(css, /\.hero-inner \{[^}]*height: 600px;/s, "overlay hero keeps its height on its centred inner box");
  assert.match(css, /\.hero-inner \{[^}]*max-width: 1440px;[^}]*margin: 0 auto;/s, "content is centred at the design width");
  assert.doesNotMatch(css, /\.page-root\[data-bp="desktop"\] \{[^}]*max-width/, "root is not capped");
  assert.equal((html.match(/<h1 /g) || []).length, 1, "exactly one h1");
  assert.match(html, /<nav [^>]*>\s*<a class="home" href="#"/, "nav items are links");
  assert.match(html, /src="assets\/hero-bg\.png"/);
  assert.match(css, /\.header-inner \{[^}]*padding: 28px min\(120px, 8\.33vw\) 28px min\(120px, 8\.33vw\)/s, "section side padding is fluid, on the inner box");
  assert.match(css, /justify-content: space-between/);
  assert.match(css, /@media \(max-width: 767px\) \{[^@]*grid-template-columns: repeat\(1, minmax\(0, 1fr\)\)/s, "grid collapses on phones");
  assert.match(css, /font-size: clamp\(34px, 3\.89vw, 56px\)/, "large type is fluid");
  assert.match(html, /<svg [^>]*class="logo"[^>]*><rect width="140" height="40"/, "inner svg attributes survive");
  assert.deepEqual([...out.assetFiles].sort(), ["card-photo.png", "hero-bg.png"]);
  assert.equal(out.report.frames[0].sections.length, 4);
  assert.equal(out.report.frames[0].warnings.length, 0, out.report.frames[0].warnings.join("; "));
});

test("plan overrides are honoured and unknown ids dropped", () => {
  const { doc } = makeSample();
  const base = defaultPlan(doc.frames[0]);
  const ids = new Set<string>(); let heroCopy = "";
  const walk = (n: typeof doc.frames[0]["root"]) => { ids.add(n.id); if (n.name === "Hero Copy") heroCopy = n.id; n.children.forEach(walk); }; walk(doc.frames[0].root);
  const plan = normalizePlan({ ...base, tags: [{ id: heroCopy, tag: "article" }, { id: "nope", tag: "div" }], links: [{ id: "nope", href: "x" }] }, ids, doc.frames[0].id, base.pageRoot);
  assert.equal(plan.tags.length, 1);
  assert.equal(plan.links.length, 0);
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  assert.match(out.files.get("index.html")!, /<article class="hero-copy"/);
});

test("equal stripes become one repeating gradient", () => {
  const { doc } = makeSample();
  const rects = Array.from({ length: 20 }, (_, i) => node({ name: `Rectangle ${i}`, type: "rect", x: i * 10, y: 0, w: 5, h: 100, fills: [{ type: "solid", color: i % 2 ? "#56b099" : "#a4d866", opacity: 1 }] }));
  const stripes = node({ name: "stripes", x: 0, y: 0, w: 200, h: 100, children: rects, clips: true });
  doc.frames[0].root.children[0].children.unshift(stripes);
  const plan = defaultPlan(doc.frames[0]);
  plan.sections.unshift({ id: stripes.id, slug: "stripes", tag: "section", role: "", attach: [], confidence: 1, note: "" });
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const css = out.files.get("styles.css")!;
  assert.match(css, /repeating-linear-gradient\(90deg, #a4d866 0px 5px, transparent 5px 10px, #56b099 10px 15px, transparent 15px 20px\)/);
  assert.doesNotMatch(out.files.get("index.html")!, /Rectangle 3/);
});

test("many small vectors compose into one single-root svg asset", () => {
  const { doc } = makeSample();
  const dots: ReturnType<typeof node>[] = [];
  for (let i = 0; i < 30; i++) {
    const aid = `dot${i}:svg`;
    doc.assets[aid] = { id: aid, file: `dot-${i}.svg`, kind: "svg", hash: `d${i}`, width: 6, height: 4, scale: 1, nodeName: "Vector", svg: `<svg width="7" height="5" viewBox="0 0 7 5" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h7v5H0z" fill="#E5E5E5"/></svg>` };
    dots.push(node({ name: "Vector", type: "vector", x: (i % 6) * 10, y: Math.floor(i / 6) * 10, w: 6, h: 4, asset: aid }));
  }
  const map = node({ name: "OBJECTS", x: 0, y: 0, w: 60, h: 50, children: dots });
  doc.frames[0].root.children[0].children.unshift(map);
  const plan = defaultPlan(doc.frames[0]);
  plan.sections.unshift({ id: map.id, slug: "map", tag: "section", role: "", attach: [], confidence: 1, note: "" });
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const gen = [...out.files.keys()].find((k) => k.startsWith("assets/objects-"));
  assert.ok(gen, "composite asset generated");
  const svg = out.files.get(gen!)!;
  assert.equal((svg.match(/<svg\b/g) || []).length, 1, "exactly one <svg> root");
  assert.equal((svg.match(/<\/svg>/g) || []).length, 1, "exactly one closing tag");
  assert.equal((svg.match(/<g transform=/g) || []).length, 30);
  assert.match(out.files.get("index.html")!, new RegExp(`src="${gen}"`));
});

test("prototype hover state becomes :hover rules on the root and its children", () => {
  const { doc } = makeSample();
  const find = (n: typeof doc.frames[0]["root"], name: string): typeof n | null => n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean) || null;
  const btn = find(doc.frames[0].root, "Button")!;
  const hoverBtn = structuredClone(btn);
  hoverBtn.id = "h:1"; hoverBtn.fills = [{ type: "solid", color: "#0B3E47", opacity: 1 }];
  hoverBtn.children[0].id = "h:2"; hoverBtn.children[0].text!.segments[0].color = "#FFFFFF";
  hoverBtn.children[0].box = { ...hoverBtn.children[0].box, x: hoverBtn.children[0].box.x + 6 };
  btn.states = { hover: hoverBtn };
  btn.interactions = [{ trigger: "hover", action: "style", url: null, durationMs: 300, easing: "ease-in-out", hover: null, destinationId: "h:1", transitionType: "SMART_ANIMATE" }];
  const plan = defaultPlan(doc.frames[0]);
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const css = out.files.get("styles.css")!;
  assert.match(css, /\.button:hover \{[^}]*background-color: #0B3E47/s, "root hover delta");
  assert.match(css, new RegExp(`\\.button:hover \\[data-figma-id="${btn.children[0].id}"\\] \\{[^}]*color: #FFFFFF`, "s"), "child text colour on hover");
  assert.match(css, /translate\(6px, 0px\)/, "child slides on hover");
  assert.match(css, /\.button \{[^}]*transition: all 300ms ease-in-out/s);
});

test("hover variant that reorders and drops layers pairs children by name", () => {
  const { doc } = makeSample();
  const find = (n: typeof doc.frames[0]["root"], name: string): typeof n | null => n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean) || null;
  const btn = find(doc.frames[0].root, "Button")!;
  const label = btn.children[0];
  const bar = node({ id: "bar:1", name: "Bar", type: "rect", x: btn.box.x, y: btn.box.y - 3, w: btn.box.w, h: 3, fills: [{ type: "solid", color: "#D9D9D9", opacity: 1 }] });
  const extra = node({ id: "gone:1", name: "Gone", type: "rect", x: btn.box.x, y: btn.box.y, w: 10, h: 10, fills: [{ type: "solid", color: "#FF0000", opacity: 1 }] });
  btn.children = [label, bar, extra];
  const hoverBtn = structuredClone(btn);
  hoverBtn.id = "h:1";
  const hLabel = structuredClone(label); hLabel.id = "h:2"; hLabel.box = { ...label.box, y: label.box.y - 20 };
  const hBar = structuredClone(bar); hBar.id = "h:3"; hBar.box = { ...bar.box, y: bar.box.y + 3 };
  hoverBtn.children = [hBar, hLabel]; // reordered, "Gone" removed
  btn.states = { hover: hoverBtn };
  btn.interactions = [{ trigger: "hover", action: "style", url: null, durationMs: 300, easing: "ease", hover: null, destinationId: "h:1", transitionType: "SMART_ANIMATE" }];
  const plan = defaultPlan(doc.frames[0]);
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const css = out.files.get("styles.css")!;
  assert.match(css, new RegExp(`\\.button:hover \\[data-figma-id="${label.id}"\\] \\{[^}]*translate\\(0px, -20px\\)`, "s"), "label paired by name and slid up");
  assert.match(css, /\.button:hover \[data-figma-id="bar:1"\] \{[^}]*translate\(0px, 3px\)/s, "bar paired by name");
  assert.match(css, /\.button:hover \[data-figma-id="gone:1"\] \{[^}]*opacity: 0/s, "layer missing from the variant is hidden");
  assert.doesNotMatch(css, /\.button:hover \{[^}]*height/s, "same-size variant adds no root size delta");
});

test("four small counters wrap 2-up where they stop fitting, with the full gap expression", () => {
  const { doc } = makeSample();
  const frame = doc.frames[0];
  const counters = Array.from({ length: 4 }, (_, i) => col(`Counter 0${i + 1}`, 160 + i * 300, 3000, 220, 100, 10, [0, 0, 0, 0], [
    text(`n${i}`, "500+", 160 + i * 300, 3000, 220, 60, { fontSize: 48 }), text(`l${i}`, "Outlet Services", 160 + i * 300, 3070, 220, 20, { fontSize: 16 }),
  ], { sizing: { w: "hug", h: "hug", minW: null, maxW: null, minH: null, maxH: null } }));
  const rowEl = row("Counters", 0, 2980, frame.width, 140, 80, [20, 0, 20, 0], counters, { sizing: { w: "fill", h: "hug", minW: null, maxW: null, minH: null, maxH: null } });
  frame.root.children.push(rowEl);
  frame.height = 3200; frame.root.box.h = 3200; frame.root.size.h = 3200;
  const plan = defaultPlan(frame);
  const out = compileDocument(doc, new Map([[frame.id, plan]]));
  const css = out.files.get("styles.css")!;
  // Four 220px counters with an 80px gap need ~1120 of the 1440 row: they wrap 2-up from the 1200 bucket.
  const m = css.slice(css.indexOf("@media (max-width: 1200px)"), css.indexOf("@media (max-width: 1024px)"));
  assert.match(m, /\.counter-01 \{[^}]*flex: 0 0 calc\(50% - min\([^)]*\) \* 0\.5\)/s, "basis subtracts the fluid gap expression, not its last token");
  assert.doesNotMatch(css, /@media \(max-width: 1366px\) \{[^@]*\.counters \{/s, "not before they need to");
});

test("two frames compile to breakpoint wrappers", () => {
  const { doc } = makeSample();
  const mobile = structuredClone(doc.frames[0]);
  mobile.id = "m:1"; mobile.slug = "mobile"; mobile.name = "Mobile"; mobile.width = 390; mobile.root.id = "m:1";
  doc.frames.push(mobile);
  const plans = new Map(doc.frames.map((f) => [f.id, defaultPlan(f)] as const));
  const out = compileDocument(doc, plans);
  const css = out.files.get("styles.css")!;
  assert.match(css, /@media \(max-width: 767px\) \{ \.page-root\[data-bp="mobile"\]/);
  assert.match(css, /@media \(min-width: 768px\) \{ \.page-root\[data-bp="desktop"\]/);
  assert.match(out.files.get("index.html")!, /data-bp="mobile"/);
});

test("fixture bundle is written for manual inspection", () => {
  const dir = writeBundle();
  fs.writeFileSync(path.join(dir, "PATH"), dir);
  console.log(`fixture bundle: ${dir}`);
  assert.ok(fs.existsSync(path.join(dir, "ir.json")));
});
