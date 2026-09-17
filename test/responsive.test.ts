import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSample, node, col, row, text } from "./fixture.ts";
import { defaultPlan, defaultResponsivePlan } from "../src/planner/default.ts";
import { compileDocument } from "../src/compiler/index.ts";
import { bucketAtOrAbove, bucketFloor, breakWidth, BUCKETS } from "../src/compiler/responsive.ts";
import { pairSections, frameHints } from "../src/compiler/pairs.ts";

test("buckets: a transform fires at the smallest bucket above the width where content breaks", () => {
  assert.equal(bucketAtOrAbove(700, 1920), "(max-width: 767px)");
  assert.equal(bucketAtOrAbove(800, 1920), "(max-width: 880px)");
  assert.equal(bucketAtOrAbove(1100, 1920), "(max-width: 1200px)");
  assert.equal(bucketAtOrAbove(1500, 1920), "(max-width: 1366px)", "above the widest bucket: from that bucket down (shares cover the gap)");
  assert.equal(bucketAtOrAbove(1300, 1200), "(max-width: 1024px)", "never at or above the design width: from the widest usable bucket");
  assert.equal(bucketFloor(767), 320);
  assert.equal(bucketFloor(1024), 881);
  assert.deepEqual([...BUCKETS], [1366, 1200, 1024, 880, 767]);
  // A 1100px row that needs 550px of content breaks at ~1000px on a 1920 design (a little early on purpose).
  assert.ok(Math.abs(breakWidth(1100, 550, 1920) - 1037) < 2);
});

test("header with a link list gets a css-only menu; touch and motion guards are emitted", () => {
  const { doc } = makeSample();
  const plan = defaultPlan(doc.frames[0]);
  const out = compileDocument(doc, new Map([[doc.frames[0].id, plan]]));
  const html = out.files.get("index.html")!, css = out.files.get("styles.css")!;
  assert.match(html, /<input type="checkbox" id="f2h-menu-[^"]+" class="f2h-menu-toggle"/);
  assert.match(html, /<label for="f2h-menu-[^"]+" class="f2h-menu-btn"/);
  assert.match(html, /<nav [^>]*data-menu="1"/);
  // Logo 140 + four links 420 + 240 of padding need ~800 of the 1440 row: the menu starts at the 880 bucket.
  assert.match(css, /\[data-menu-row="880"\]:has\(\.f2h-menu-toggle:checked\) \[data-menu\] \{ display: flex; \}/);
  assert.match(css, /@media \(hover: none\)|\.f2h-menu-btn \{ display: none/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /@media \(max-width: 900px\)/, "the old 900px query is gone; buckets only");
});

test("content-driven grid: three 325px cards keep three columns until the cells stop fitting", () => {
  const { doc } = makeSample();
  const plan = defaultPlan(doc.frames[0]);
  const css = compileDocument(doc, new Map([[doc.frames[0].id, plan]])).files.get("styles.css")!;
  const block = (q: string) => { const i = css.indexOf(`@media ${q} {`); return i < 0 ? "" : css.slice(i, css.indexOf("\n}", i)); };
  assert.doesNotMatch(block("(max-width: 1366px)"), /\.cards \{/, "at 1201px three 325px cards fit a 1000px grid");
  assert.match(block("(max-width: 1200px)"), /\.cards \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s, "at 1025px they no longer do: two columns");
  assert.match(block("(max-width: 767px)"), /\.cards \{[^}]*repeat\(1, minmax\(0, 1fr\)\)/s);
});

test("a narrow frame stretches above its own width; its transforms are pruned to its range", () => {
  const { doc } = makeSample();
  const mobile = structuredClone(doc.frames[0]);
  mobile.id = "m:1"; mobile.slug = "mobile"; mobile.name = "Mobile"; mobile.width = 390; mobile.root.id = "m:1";
  // Make the mobile frame's boxes narrow so its inner/max-width logic sees a 390 design.
  const shrink = (n: typeof mobile.root) => { n.box.w = Math.min(n.box.w, 390); n.size.w = Math.min(n.size.w, 390); n.children.forEach(shrink); };
  shrink(mobile.root);
  doc.frames.push(mobile);
  const plans = new Map(doc.frames.map((f) => [f.id, defaultPlan(f)] as const));
  const rp = defaultResponsivePlan(doc, plans)!;
  assert.equal(rp.breakpoints.find((b) => b.frameId === "m:1")!.minWidth, 0);
  assert.equal(rp.breakpoints.find((b) => b.frameId !== "m:1")!.minWidth, 768);
  assert.ok(rp.sectionPairs.length >= 4, "the same sections on both frames are paired by slug");
  const out = compileDocument(doc, plans, { responsive: rp });
  const css = out.files.get("styles.css")!;
  assert.match(css, /@media \(min-width: 391px\) \{[^@]*max-width: none/s, "the phone frame's inner boxes follow the viewport above 390px");
  assert.match(css, /@media \(max-width: 767px\) \{ \.page-root\[data-bp="mobile"\]/);
  assert.match(css, /@media \(min-width: 768px\) \{ \.page-root\[data-bp="desktop"\]/);
});

test("section pairing and hints: order and alignment come from the narrow frame", () => {
  const { doc } = makeSample();
  const wide = doc.frames[0];
  const narrow = structuredClone(wide);
  narrow.id = "n:1"; narrow.slug = "mobile"; narrow.width = 390; narrow.root.id = "n:1";
  // On the phone the hero copy is centred.
  const centre = (n: typeof narrow.root) => { if (n.text) n.text.align = "center"; n.children.forEach(centre); };
  centre(narrow.root);
  const pw = defaultPlan(wide), pn = defaultPlan(narrow);
  const pairs = pairSections(wide, pw, narrow, pn);
  assert.equal(pairs.length, pw.sections.length);
  assert.ok(pairs.every((p) => p.note === "slug"));
  const h = frameHints(wide, pw, narrow, pn, pairs);
  assert.ok(h.order.size > 10, "matched text and pictures get a reading-order rank");
  assert.ok([...h.align.values()].every((a) => a === "center"));
  assert.equal(h.dropped.size, 0);
});
