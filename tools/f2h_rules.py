#!/usr/bin/env python3
"""Every rule a class gets in the compiled stylesheet, base and per media query, one line each.

python3 tools/f2h_rules.py <bundle>/out/styles.css <class> [<class> ...]
"""
import re, sys
css = open(sys.argv[1]).read()
blocks = re.findall(r'(@media[^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}', css)
for cls in sys.argv[2:]:
    print("==", cls)
    for m in re.finditer(r'\n\.' + re.escape(cls) + r' \{([^}]*)\}', css): print("  base:", " ".join(m.group(1).split()))
    for q, body in blocks:
        for m in re.finditer(r'\.' + re.escape(cls) + r' \{([^}]*)\}', body): print("  " + q.strip() + ":", " ".join(m.group(1).split()))
