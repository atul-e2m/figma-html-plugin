#!/usr/bin/env python3
"""Render compiled HTML at the frame width, measure it, and diff it against the Figma screenshot.

Writes <out>.report.json (VerifyMeasurements), <out>-html.png and, when a screenshot
is given, <out>-side.png (Figma left, HTML right).
"""
import argparse, json, sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops

ap = argparse.ArgumentParser()
ap.add_argument("--html", required=True); ap.add_argument("--width", type=int, required=True); ap.add_argument("--height", type=int, required=True)
ap.add_argument("--bp", required=True); ap.add_argument("--sections", default="[]"); ap.add_argument("--out", required=True)
ap.add_argument("--shot"); ap.add_argument("--scale", type=float, default=1.0)
ap.add_argument("--shot-origin", default="0,0", help="frame-space x,y of the screenshot's top-left (root renderBox), design px")
ap.add_argument("--text-boxes", default="[]", help="JSON [[x,y,w,h],...] of text nodes in frame space; masked out for the layout score")
a = ap.parse_args()
sections = json.loads(a.sections)

MEASURE_JS = """
(args) => {
  const [bp, sections, W] = args;
  const root = document.querySelector(`.page-root[data-bp="${bp}"]`) || document.body;
  const rr = root.getBoundingClientRect();
  const top = rr.top + scrollY;
  const secs = sections.map(s => {
    const el = root.querySelector(`[data-section="${s.slug}"]`);
    if (!el) return { slug: s.slug, expected: Math.round(s.h), actual: 0, delta: -Math.round(s.h), missing: true };
    const r = el.getBoundingClientRect();
    return { slug: s.slug, expected: Math.round(s.h), actual: Math.round(r.height), delta: Math.round(r.height - s.h), y: Math.round(r.top + scrollY - top) };
  });
  const over = [];
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > W + 1 && r.left < W) over.push((el.getAttribute('class') || el.tagName).slice(0, 40));
  }
  const broken = [...root.querySelectorAll('img')].filter(i => !i.complete || i.naturalWidth === 0).length;
  // Distorted assets: an inline svg whose viewBox aspect differs from its box, or an
  // <img> whose natural aspect differs from its box without object-fit: cover.
  const distorted = [];
  for (const el of root.querySelectorAll('svg[viewBox], img')) {
    const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
    let aw, ah;
    if (el.tagName.toLowerCase() === 'svg') { const p = el.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number); aw = p[2]; ah = p[3]; }
    else { if (getComputedStyle(el).objectFit === 'cover') continue; aw = el.naturalWidth; ah = el.naturalHeight; }
    if (!aw || !ah) continue;
    const ra = aw / ah, rb = r.width / r.height;
    if (Math.abs(ra - rb) / Math.max(ra, rb) > 0.06) distorted.push(`${el.getAttribute('data-figma-id') || ''} ${(el.getAttribute('class') || el.tagName).toString().slice(0, 30)} asset ${Math.round(aw)}x${Math.round(ah)} in ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const structure = sections.map(s => {
    const el = root.querySelector(`[data-section="${s.slug}"]`); if (!el) return `${s.slug}: MISSING`;
    const kids = [...el.children].slice(0, 12).map(k => { const cs = getComputedStyle(k); const r = k.getBoundingClientRect(); return `${(k.getAttribute('class')||k.tagName).slice(0,24)} ${cs.display}${cs.display==='flex'?'/'+cs.flexDirection:''} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    return `${s.slug}: ${kids.join(' | ')}`;
  });
  return { docHeight: Math.round(rr.height), sections: secs, overflowCount: over.length, overflowing: [...new Set(over)].slice(0, 12), brokenImages: broken, distorted: distorted.slice(0, 20), structure };
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": a.width, "height": 1000}, device_scale_factor=1)
    pg.goto("file://" + a.html.replace(" ", "%20"))
    pg.wait_for_timeout(600)
    pg.evaluate("document.querySelectorAll('img[loading]').forEach(i => i.loading = 'eager')")
    h = pg.evaluate("document.documentElement.scrollHeight")
    for y in range(0, h, 900):
        pg.evaluate(f"window.scrollTo(0,{y})"); pg.wait_for_timeout(40)
    pg.evaluate("window.scrollTo(0,0)")
    try: pg.evaluate("document.fonts.ready")
    except Exception: pass
    pg.wait_for_timeout(500)
    # Only the frame under test should be visible for the screenshot.
    pg.add_style_tag(content=f'.page-root:not([data-bp="{a.bp}"]) {{ display: none !important; }} .page-root[data-bp="{a.bp}"] {{ display: block !important; }}')
    pg.wait_for_timeout(100)
    m = pg.evaluate(MEASURE_JS, [a.bp, sections, a.width])
    pg.screenshot(path=f"{a.out}-html.png", full_page=True)
    b.close()

m["expectedHeight"] = a.height
m["width"] = a.width

if a.shot:
    fig = Image.open(a.shot).convert("RGBA")
    bg = Image.new("RGBA", fig.size, (255, 255, 255, 255)); bg.alpha_composite(fig); fig = bg.convert("RGB")
    if abs(a.scale - 1.0) > 1e-6:
        fig = fig.resize((round(fig.width / a.scale), round(fig.height / a.scale)), Image.LANCZOS)
    ox, oy = [float(v) for v in a.shot_origin.split(",")]
    html = Image.open(f"{a.out}-html.png").convert("RGB")
    W = a.width
    # The export starts at the render bounds' origin; the frame's (0,0) is at (-ox, -oy) inside it.
    fig = fig.crop((round(-ox), round(-oy), round(-ox) + W, round(-oy) + a.height)); html = html.crop((0, 0, W, html.height))
    H = max(fig.height, html.height)
    def pad(im):
        if im.height == H: return im
        c = Image.new("RGB", (W, H), (255, 255, 255)); c.paste(im, (0, 0)); return c
    fig, html = pad(fig), pad(html)
    diff = ImageChops.difference(fig, html).convert("L").point(lambda v: 255 if v > 40 else 0)
    hist = diff.histogram(); total = W * H
    m["mismatchPct"] = round(100.0 * hist[255] / max(1, total), 2)
    # Layout score: the same diff with every text box (padded 4px) masked out, so a
    # fallback font does not read as a layout error.
    from PIL import ImageDraw
    boxes = json.loads(a.text_boxes)
    if boxes:
        mask = Image.new("L", (W, H), 255); dr = ImageDraw.Draw(mask)
        for (x, y, w, h) in boxes: dr.rectangle((x - 4, y - 4, x + w + 4, y + h + 4), fill=0)
        masked = ImageChops.multiply(diff, mask)
        kept = mask.histogram()[255]
        m["layoutMismatchPct"] = round(100.0 * masked.histogram()[255] / max(1, kept), 2)
        m["textAreaPct"] = round(100.0 * (total - kept) / max(1, total), 1)
    bands = []
    for y0 in range(0, H, 200):
        band = diff.crop((0, y0, W, min(H, y0 + 200))); bh = band.histogram()
        bands.append({"y": y0, "mismatchPct": round(100.0 * bh[255] / max(1, W * band.height), 1)})
    m["bands"] = bands
    side = Image.new("RGB", (W * 2 + 20, H), (240, 240, 240)); side.paste(fig, (0, 0)); side.paste(html, (W + 20, 0))
    side.thumbnail((2400, 20000)); side.save(f"{a.out}-side.png")

with open(f"{a.out}.report.json", "w") as f: json.dump(m, f, indent=2)
print(json.dumps({k: m[k] for k in ("docHeight", "expectedHeight", "overflowCount", "brokenImages") if k in m} | ({"mismatchPct": m["mismatchPct"]} if "mismatchPct" in m else {})))
