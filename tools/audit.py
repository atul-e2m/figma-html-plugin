#!/usr/bin/env python3
"""Responsive audit: render the compiled page at several viewport widths and count what a
designer would reject — horizontal overflow, clipped text, overlapping text, unreadable type,
paragraphs squeezed into slivers, tiny tap targets on phones, and (for a frame shown above its own
width) content that fails to stretch across the viewport.

python3 tools/audit.py --html out/index.html --bp <frame-slug> --widths 1024,768,390 --out out/verify/<slug>
Writes <out>-vp<width>.png per width and <out>.audit.json.
"""
import argparse, json
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--html", required=True); ap.add_argument("--bp", required=True)
ap.add_argument("--widths", default="1024,768,390"); ap.add_argument("--out", required=True)
ap.add_argument("--design-width", type=int, default=0, help="the frame's own width; widths above it check that the frame stretches")
a = ap.parse_args()
widths = [int(w) for w in a.widths.split(",") if w]

JS = """
(args) => {
  const [bp, W, designW] = args;
  const root = document.querySelector(`.page-root[data-bp="${bp}"]`) || document.body;
  const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05; };
  const name = (el) => { const r = el.getBoundingClientRect(); return (el.getAttribute('data-figma-id') || '') + ' ' + (el.getAttribute('class') || el.tagName).toString().slice(0, 30) + ` @${Math.round(r.top + scrollY)}`; };
  const over = [], clipped = [], tiny = [], narrow = [], taps = [];
  // The row (or grid) an offending element sits in: the compiler stacks it one bucket above this width.
  const culprits = {};
  // Hidden past an ancestor's overflow (a map wider than its frame, a photo cropped by its card): not visible, not overflow.
  const clippedInside = (el) => { let p = el.parentElement; while (p && p !== root) { const pc = getComputedStyle(p); if (pc.overflow === 'hidden' || pc.overflowX === 'hidden' || pc.overflowX === 'clip') { const pr = p.getBoundingClientRect(); if (pr.right <= W + 1) return true; } p = p.parentElement; } return false; };
  const blame = (el, kind) => {
    let p = el.parentElement;
    while (p && p !== root) {
      const cs = getComputedStyle(p);
      const kids = [...p.children].filter(k => getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).display !== 'none');
      if (p.hasAttribute('data-menu-row') || p.hasAttribute('data-menu')) return; // the header menu handles itself
      if ((cs.display === 'flex' && cs.flexDirection === 'row' && kids.length >= 2) || (cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length >= 2)) {
        const id = p.getAttribute('data-figma-id'); if (id) { culprits[id] = culprits[id] || { kind: cs.display === 'grid' ? 'grid' : 'row', problems: [] }; culprits[id].problems.push(kind); }
        return;
      }
      p = p.parentElement;
    }
  };
  const textEls = [];
  let cLeft = Infinity, cRight = -Infinity;
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > W + 1 && r.left < W && el.tagName !== 'svg' && !clippedInside(el)) { over.push(name(el)); blame(el, 'overflow'); }
    const isText = ['P','H1','H2','H3','H4','H5','H6','SPAN','A','LI','BUTTON','LABEL','BLOCKQUOTE'].includes(el.tagName) && el.textContent.trim() && el.children.length === 0;
    const isMedia = ['IMG','VIDEO','svg'].includes(el.tagName) || el.tagName === 'svg';
    // Content extent: text and media, not bleed backgrounds. Tells whether a stretched frame fills the viewport.
    if ((isText || isMedia) && r.width < W * 0.98) { cLeft = Math.min(cLeft, r.left); cRight = Math.max(cRight, r.right); }
    if (isText) {
      textEls.push({ el, r });
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 12) tiny.push(name(el));
      // text wider than its box (nowrap) or cut by an ancestor's overflow:hidden
      if (el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace === 'nowrap') { clipped.push(name(el)); blame(el, 'clipped'); }
      // A paragraph squeezed into a sliver: a column that should have stacked or wrapped.
      const chars = el.textContent.trim().length;
      if (chars >= 30 && r.width < Math.min(150, W * 0.3) && cs.whiteSpace !== 'nowrap' && r.height > parseFloat(cs.fontSize) * 3.5) { narrow.push(name(el)); blame(el, 'squeezed'); }
      let p = el.parentElement;
      while (p && p !== root) { const pc = getComputedStyle(p); if (pc.overflow === 'hidden' || pc.overflowX === 'hidden' || pc.overflowY === 'hidden') { const pr = p.getBoundingClientRect(); if (r.bottom > pr.bottom + 2 || r.right > pr.right + 2 || r.top < pr.top - 2) { clipped.push(name(el)); break; } } p = p.parentElement; }
    }
    // Phones: a button-like control under 32px tall is hard to tap.
    if (W <= 480 && (el.tagName === 'BUTTON' || (el.tagName === 'A' && (getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)' || getComputedStyle(el).borderTopWidth !== '0px'))) && el.textContent.trim() && r.height < 32) taps.push(name(el));
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
  // A frame shown WIDER than it was designed (a 390 phone frame at 700) must stretch: its content
  // should span most of the viewport, not sit as a centred column of the design width.
  const underfilled = [];
  if (designW && W > designW + 40 && W < 1024 && cRight > cLeft) {
    const span = cRight - cLeft;
    if (span < W * 0.72) underfilled.push(`content spans ${Math.round(cLeft)}..${Math.round(cRight)} of ${W} (design ${designW})`);
  }
  const rr = root.getBoundingClientRect();
  return { height: Math.round(rr.height), overflow: [...new Set(over)], clipped: [...new Set(clipped)], overlapping: overlaps, tinyText: [...new Set(tiny)], narrowText: [...new Set(narrow)], tapTargets: [...new Set(taps)], underfilled, bleedShort, culprits, scrollWidth: document.documentElement.scrollWidth };
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
        m = pg.evaluate(JS, [a.bp, W, a.design_width])
        pg.screenshot(path=f"{a.out}-vp{W}.png", full_page=True)
        m["score"] = (len(m["overflow"]) * 3 + len(m["clipped"]) * 2 + len(m["overlapping"]) * 2 + len(m["tinyText"]) + len(m["narrowText"]) * 2
                      + len(m["tapTargets"]) + len(m["underfilled"]) * 3 + len(m.get("bleedShort", [])) * 3 + (5 if m["scrollWidth"] > W + 1 else 0))
        results[str(W)] = m
        pg.close()
    b.close()
with open(f"{a.out}.audit.json", "w") as f: json.dump(results, f, indent=2)
print(json.dumps({w: {k: (len(v[k]) if isinstance(v[k], list) else v[k]) for k in ("height", "overflow", "clipped", "overlapping", "tinyText", "narrowText", "tapTargets", "underfilled", "score")} for w, v in results.items()}))
