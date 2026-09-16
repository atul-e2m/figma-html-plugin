#!/usr/bin/env python3
"""Responsive audit: render the compiled page at several viewport widths and count what a
designer would reject — horizontal overflow, clipped text, overlapping text, unreadable type.

python3 tools/audit.py --html out/index.html --bp <frame-slug> --widths 1024,768,390 --out out/verify/<slug>
Writes <out>-vp<width>.png per width and <out>.audit.json.
"""
import argparse, json
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--html", required=True); ap.add_argument("--bp", required=True)
ap.add_argument("--widths", default="1024,768,390"); ap.add_argument("--out", required=True)
a = ap.parse_args()
widths = [int(w) for w in a.widths.split(",") if w]

JS = """
(args) => {
  const [bp, W] = args;
  const root = document.querySelector(`.page-root[data-bp="${bp}"]`) || document.body;
  const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05; };
  const name = (el) => (el.getAttribute('data-figma-id') || '') + ' ' + (el.getAttribute('class') || el.tagName).toString().slice(0, 30);
  const over = [], clipped = [], tiny = [];
  const textEls = [];
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > W + 1 && r.left < W && el.tagName !== 'svg') over.push(name(el));
    const isText = ['P','H1','H2','H3','H4','H5','H6','SPAN','A','LI','BUTTON','LABEL','BLOCKQUOTE'].includes(el.tagName) && el.textContent.trim() && el.children.length === 0;
    if (isText) {
      textEls.push({ el, r });
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 12) tiny.push(name(el));
      // text wider than its box (nowrap) or cut by an ancestor's overflow:hidden
      if (el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace === 'nowrap') clipped.push(name(el));
      let p = el.parentElement;
      while (p && p !== root) { const pc = getComputedStyle(p); if (pc.overflow === 'hidden' || pc.overflowX === 'hidden' || pc.overflowY === 'hidden') { const pr = p.getBoundingClientRect(); if (r.bottom > pr.bottom + 2 || r.right > pr.right + 2 || r.top < pr.top - 2) { clipped.push(name(el)); break; } } p = p.parentElement; }
    }
  }
  // overlapping text: pairs of text leaves whose boxes intersect substantially
  const overlaps = [];
  for (let i = 0; i < textEls.length; i++) for (let j = i + 1; j < textEls.length; j++) {
    const A = textEls[i].r, B = textEls[j].r;
    const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left), oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    if (ox > 4 && oy > 4 && ox * oy > 0.2 * Math.min(A.width * A.height, B.width * B.height)) { overlaps.push(name(textEls[i].el) + ' × ' + name(textEls[j].el)); if (overlaps.length > 30) break; }
  }
  // Wide screens: every bleed layer (and the assets inside it) must reach both viewport edges.
  const bleedShort = [];
  if (W > 1900) for (const el of root.querySelectorAll('[data-bleed]')) {
    if (!vis(el)) continue;
    let left = Infinity, right = -Infinity;
    const walk = (n) => { const r = n.getBoundingClientRect(); if (r.width > 0) { left = Math.min(left, r.left); right = Math.max(right, r.right); } for (const k of n.children) walk(k); };
    walk(el);
    if (right - left > 8 && (left > 2 || right < W - 2)) bleedShort.push(name(el) + ` spans ${Math.round(left)}..${Math.round(right)} of ${W}`);
  }
  const rr = root.getBoundingClientRect();
  return { height: Math.round(rr.height), overflow: [...new Set(over)], clipped: [...new Set(clipped)], overlapping: overlaps, tinyText: [...new Set(tiny)], bleedShort, scrollWidth: document.documentElement.scrollWidth };
}
"""

results = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    for W in widths:
        pg = b.new_page(viewport={"width": W, "height": 900}, device_scale_factor=1)
        pg.goto("file://" + a.html.replace(" ", "%20")); pg.wait_for_timeout(500)
        pg.evaluate("document.querySelectorAll('img[loading]').forEach(i => i.loading = 'eager')")
        h = pg.evaluate("document.documentElement.scrollHeight")
        for y in range(0, h, 900): pg.evaluate(f"window.scrollTo(0,{y})"); pg.wait_for_timeout(30)
        pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(300)
        pg.add_style_tag(content=f'.page-root:not([data-bp="{a.bp}"]) {{ display: none !important; }} .page-root[data-bp="{a.bp}"] {{ display: block !important; }}')
        m = pg.evaluate(JS, [a.bp, W])
        pg.screenshot(path=f"{a.out}-vp{W}.png", full_page=True)
        m["score"] = len(m["overflow"]) * 3 + len(m["clipped"]) * 2 + len(m["overlapping"]) * 2 + len(m["tinyText"]) + len(m.get("bleedShort", [])) * 3 + (5 if m["scrollWidth"] > W + 1 else 0)
        results[str(W)] = m
        pg.close()
    b.close()
with open(f"{a.out}.audit.json", "w") as f: json.dump(results, f, indent=2)
print(json.dumps({w: {k: (len(v[k]) if isinstance(v[k], list) else v[k]) for k in ("height", "overflow", "clipped", "overlapping", "tinyText", "score")} for w, v in results.items()}))
