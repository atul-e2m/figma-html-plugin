#!/usr/bin/env python3
"""Debug helper: f2h inspect.  python3 tools/inspect.py <bundle> <node-id | name/text substring> [--kids N] [--up N]

Prints the ancestor chain (IR facts) and the emitted CSS rule for each node, then the children.
"""
import json, re, sys
bundle = sys.argv[1]; key = sys.argv[2]
kids = int(sys.argv[sys.argv.index("--kids") + 1]) if "--kids" in sys.argv else 8
up = int(sys.argv[sys.argv.index("--up") + 1]) if "--up" in sys.argv else 4
ir = json.load(open(f"{bundle}/ir.json")); css = open(f"{bundle}/out/styles.css").read(); html = open(f"{bundle}/out/index.html").read()
idx = {}
def walk(n, p=None):
    idx[n["id"]] = (n, p); [walk(c, n) for c in n["children"]]
for f in ir["frames"]: walk(f["root"])
def cls_of(i):
    m = re.search(r'<[a-z0-9]+ ([^>]*)data-figma-id="%s"' % re.escape(i), html)
    if not m: return None
    c = re.search(r'class="([^"]+)"', m.group(1)); return c.group(1) if c else None
def rule(c):
    m = re.search(r'\.%s \{([^}]*)\}' % re.escape(c), css)
    return " ".join(m.group(1).split()) if m else "(no rule)"
def brief(n):
    t = n["text"]; b = n["box"]
    lay = n["layout"] and f'{n["layout"]["direction"]} gap={n["layout"]["gap"]} just={n["layout"]["justify"]} align={n["layout"]["align"]} pad={n["layout"]["padding"]}'
    extra = f' text[{t["autoResize"]},{t["lines"]}ln,{t["segments"][0]["fontSize"] if t["segments"] else "?"}px]="{t["characters"][:40]!r}"' if t else ""
    return (f'[{n["id"]}] {n["name"][:32]!r} {n["type"]} box=({b["x"]},{b["y"]},{b["w"]},{b["h"]}) size=({n["size"]["w"]},{n["size"]["h"]}) '
            f'sz={n["sizing"]["w"]}/{n["sizing"]["h"]} c={n["constraints"]["h"]}/{n["constraints"]["v"]} pos={n["positioning"]} lay={lay} clips={n["clips"]} '
            f'fills={[x["type"] for x in n["fills"]]} asset={bool(n["asset"])} kids={len(n["children"])} op={n["opacity"]} rot={n["rotation"]}{extra}')
def show(n, indent):
    c = cls_of(n["id"]); print(indent + brief(n)); print(indent + "    css ." + (c or "-") + " { " + (rule(c) if c else "not emitted") + " }")
targets = [idx[key][0]] if key in idx else [n for n, _ in idx.values() if key.lower() in n["name"].lower() or (n["text"] and key.lower() in n["text"]["characters"].lower())]
if not targets: sys.exit(f"no node matches {key!r}")
for t in targets[:3]:
    chain = []; q = t
    while q and len(chain) <= up: chain.append(q); q = idx[q["id"]][1]
    print("=" * 100)
    for d, n in enumerate(reversed(chain)): show(n, "  " * d)
    d = len(chain)
    for k in t["children"][:kids]: show(k, "  " * d + "> ")
