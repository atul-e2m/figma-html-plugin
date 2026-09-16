"""Render an HTML file at 1920 wide, compare against the Figma PNG, report per-band mismatch and write side-by-side crops."""
import asyncio, sys, json
from playwright.async_api import async_playwright
from PIL import Image, ImageChops
HTML = sys.argv[1]; OUT = sys.argv[2] if len(sys.argv)>2 else "out"
FIG = sys.argv[3] if len(sys.argv)>3 else "/Users/atulrathour/Downloads/Frame 4804.png"
FIG_SCALE = float(sys.argv[4]) if len(sys.argv)>4 else 0.5   # reference px -> css px
async def render():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width":1920,"height":1080}, device_scale_factor=1)
        await pg.goto("file://" + HTML.replace(" ", "%20"))
        await pg.wait_for_timeout(800)
        # force lazy images to load
        await pg.evaluate("document.querySelectorAll('img[loading]').forEach(i=>i.loading='eager')")
        h = await pg.evaluate("document.documentElement.scrollHeight")
        for y in range(0, h, 900):
            await pg.evaluate(f"window.scrollTo(0,{y})"); await pg.wait_for_timeout(60)
        await pg.evaluate("window.scrollTo(0,0)"); await pg.wait_for_timeout(400)
        await pg.evaluate("document.fonts.ready")
        await pg.screenshot(path=f"{OUT}-html.png", full_page=True)
        info = await pg.evaluate("""() => [...document.querySelectorAll('.page-root > *, body > section, body > header, body > footer')].map(e=>{const r=e.getBoundingClientRect();return {c:(e.getAttribute('class')||e.tagName).slice(0,30),y:Math.round(r.top+scrollY),h:Math.round(r.height)}})""")
        await b.close(); return info
info = asyncio.run(render())
_f = Image.open(FIG).convert("RGBA"); _bg = Image.new("RGBA", _f.size, (255,255,255,255)); _bg.alpha_composite(_f); fig = _bg.convert("RGB")
if FIG_SCALE != 1.0: fig = fig.resize((round(fig.width*FIG_SCALE), round(fig.height*FIG_SCALE)), Image.LANCZOS)
fig = fig.crop((0,0,1920,fig.height))
html = Image.open(f"{OUT}-html.png").convert("RGB")
H = max(fig.height, html.height)
def pad(im): 
    c = Image.new("RGB",(1920,H),(255,0,255)); c.paste(im,(0,0)); return c
f, h = pad(fig), pad(html)
diff = ImageChops.difference(f, h).convert("L")
BAND=200; rows=[]
for y in range(0,H,BAND):
    box=(0,y,1920,min(H,y+BAND)); d=diff.crop(box)
    hist=d.histogram(); tot=sum(hist); bad=sum(hist[40:])   # pixels differing by >40/255
    rows.append((y, round(100*bad/tot,1)))
print("html height", html.height, "figma height", fig.height)
print("sections:", json.dumps(info))
worst=sorted(rows,key=lambda r:-r[1])[:12]
print("mismatch% per 200px band (worst 12):", worst)
print("overall mismatch%:", round(sum(r[1] for r in rows)/len(rows),1))
side = Image.new("RGB",(1920*2+20,H),(255,0,255)); side.paste(f,(0,0)); side.paste(h,(1940,0))
side.resize((side.width//2, H//2), Image.LANCZOS).save(f"{OUT}-side.png")
json.dump({"bands":rows,"sections":info,"htmlH":html.height,"figH":fig.height}, open(f"{OUT}-report.json","w"))
