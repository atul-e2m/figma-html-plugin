#!/usr/bin/env python3
"""Live boxes of compiled elements at a viewport width: where each node sits, its flex/min-width, its
three nearest ancestors, and the overflow-hidden ancestor that clips it (if any).

python3 tools/f2h_boxes.py <bundle>/out/index.html <frame-slug> <width> <figma-id> [<figma-id> ...]
"""
import sys
from playwright.sync_api import sync_playwright
html, bp, W = sys.argv[1], sys.argv[2], int(sys.argv[3]); ids = sys.argv[4:]
JS = """([bp, ids]) => ids.map(id => { const el = document.querySelector(`.page-root[data-bp="${bp}"] [data-figma-id="${id}"]`); if (!el) return id + ': missing';
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const chain = []; let p = el.parentElement; for (let i = 0; i < 3 && p; i++) { const pr = p.getBoundingClientRect(), pc = getComputedStyle(p); chain.push(`${(p.getAttribute('data-figma-id')||p.className).toString().slice(0,22)}[${Math.round(pr.left)}..${Math.round(pr.right)} ${pc.display}/${pc.flexDirection} pos=${pc.position} w=${pc.width} minw=${pc.minWidth} flex=${pc.flex}]`); p = p.parentElement; }
  const clips = []; p = el.parentElement;
  while (p && !p.classList.contains('page-root')) { const pc = getComputedStyle(p); if (pc.overflow === 'hidden' || pc.overflowX === 'hidden' || pc.overflowY === 'hidden') { const pr = p.getBoundingClientRect(); if (r.bottom > pr.bottom + 2 || r.right > pr.right + 2 || r.top < pr.top - 2 || r.left < pr.left - 2) clips.push(`${p.getAttribute('data-figma-id')||p.className} [${Math.round(pr.left)}..${Math.round(pr.right)} y${Math.round(pr.top+scrollY)} h${Math.round(pr.height)}]`); } p = p.parentElement; }
  return `${id} ${el.className}: x ${Math.round(r.left)}..${Math.round(r.right)} y ${Math.round(r.top+scrollY)} h ${Math.round(r.height)} w=${cs.width} minw=${cs.minWidth} flex=${cs.flex} ws=${cs.whiteSpace} pos=${cs.position}\\n     in ${chain.join(' < ')}` + (clips.length ? `\\n     clipped by ${clips.join(' ; ')}` : ''); })"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": W, "height": 900})
    pg.goto("file://" + html.replace(" ", "%20")); pg.wait_for_timeout(400)
    pg.add_style_tag(content=f'.page-root:not([data-bp="{bp}"]) {{ display: none !important; }}')
    for line in pg.evaluate(JS, [bp, ids]): print(line)
    b.close()
