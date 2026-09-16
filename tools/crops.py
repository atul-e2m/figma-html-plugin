#!/usr/bin/env python3
"""python3 tools/crops.py <bundle> [frame-slug]  ->  out/verify/sec-<slug>.png side-by-side crops (Figma left, HTML right)."""
import json, sys
from PIL import Image
b = sys.argv[1]; want = sys.argv[2] if len(sys.argv) > 2 else None
ir = json.load(open(f"{b}/ir.json")); rep = json.load(open(f"{b}/out/report.json"))
for f in rep["frames"]:
    if want and f["slug"] != want: continue
    fr = next(x for x in ir["frames"] if x["id"] == f["id"])
    fig = Image.open(f"{b}/{fr['screenshot']}").convert("RGB")
    sc = fr["screenshotScale"]
    if abs(sc - 1) > 1e-6: fig = fig.resize((round(fig.width / sc), round(fig.height / sc)), Image.LANCZOS)
    sb = fr.get("screenshotBox")
    ox = sb["x"] if sb else fr["root"]["renderBox"]["x"] - fr["root"]["box"]["x"]
    oy = sb["y"] if sb else fr["root"]["renderBox"]["y"] - fr["root"]["box"]["y"]
    W = f["width"]; fig = fig.crop((round(-ox), round(-oy), round(-ox) + W, round(-oy) + f["height"]))
    html = Image.open(f"{b}/out/verify/{f['slug']}-html.png").convert("RGB")
    for s in f["sections"]:
        y0 = int(s["y"]); y1 = min(y0 + int(s["h"]), fig.height, html.height)
        if y1 <= y0: continue
        out = Image.new("RGB", (W * 2 + 40, y1 - y0), (255, 0, 255)); out.paste(fig.crop((0, y0, W, y1)), (0, 0)); out.paste(html.crop((0, y0, W, y1)), (W + 40, 0))
        prefix = f"{f['slug']}-" if len(rep["frames"]) > 1 else ""
        out = out.resize((1400, max(1, int(out.height * 1400 / out.width)))); out.save(f"{b}/out/verify/sec-{prefix}{s['slug']}.png")
    print(f"{f['slug']}: {len(f['sections'])} crops, origin offset ({ox},{oy})")
