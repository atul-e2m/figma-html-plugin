#!/usr/bin/env python3
"""Measure the same Figma nodes in the HTML build and on a live (Elementor) page.

    python3 tools/f2h_compare.py <bundle> <url> <figma-id> [figma-id ...]
    python3 tools/f2h_compare.py <bundle> <url> --section <slug>     # every node under that section, depth ≤ 3

Prints, per node, box and the computed properties that most often explain a layout delta.
Both renders are loaded at the frame width; nodes are found by data-figma-id.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

b, url, *ids = sys.argv[1:]
b = os.path.abspath(b)
rep = json.load(open(f"{b}/out/report.json")); f = max(rep["frames"], key=lambda x: x["width"])
section = None
if ids and ids[0] == "--section": section = ids[1]; ids = []

JS = """
([ids, section]) => {
  const P = ['display','flexDirection','position','width','height','minHeight','maxWidth','padding','margin','gap','gridTemplateColumns','gridTemplateRows','fontSize','lineHeight','letterSpacing','textTransform','whiteSpace','alignSelf','flex','transform'];
  let els = ids.map(id => document.querySelector(`[data-figma-id="${id}"]`)).filter(Boolean);
  if (section) { const s = document.querySelector(`[data-section="${section}"]`); els = []; const walk = (e, d) => { if (d > 3) return; if (e.getAttribute('data-figma-id')) els.push(e); for (const c of e.children) walk(c, d + 1); }; if (s) walk(s, 0); }
  return els.map(el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); const o = { id: el.getAttribute('data-figma-id'), tag: el.tagName.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    for (const p of P) o[p] = cs[p]; return o; });
}
"""

def measure(pg, target):
    pg.goto(target if target.startswith("http") else "file://" + target.replace(" ", "%20"), wait_until="networkidle")
    pg.wait_for_timeout(500)
    return {m["id"]: m for m in pg.evaluate(JS, [ids, section])}

with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": f["width"], "height": 1000})
    html = measure(pg, f"{b}/out/index.html"); live = measure(pg, url); br.close()

for nid in (list(html) if section else ids):
    a, c = html.get(nid), live.get(nid)
    if not a or not c: print(f"{nid}: {'missing in html' if not a else 'missing on page'}"); continue
    dif = [k for k in a if k not in ("id", "tag", "x", "y") and a[k] != c[k]]
    flag = "" if abs(a["h"] - c["h"]) <= 1 and abs(a["w"] - c["w"]) <= 1 else "  <-- size differs"
    print(f"{nid} <{a['tag']}|{c['tag']}> html {a['w']}x{a['h']} @{a['y']}  page {c['w']}x{c['h']} @{c['y']}{flag}")
    for k in dif:
        if k in ("w", "h"): continue
        print(f"    {k:20} html: {a[k][:60]:60} page: {c[k][:60]}")
