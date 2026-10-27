#!/usr/bin/env python3
# Quantize mockup PNGs to a 256-colour palette in place (keeps PRs small). Usage: python3 tools/quantize.py brand/*.png
import sys
from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert("RGB")
    q = im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    q.save(path, optimize=True)
    print(path, im.size)
