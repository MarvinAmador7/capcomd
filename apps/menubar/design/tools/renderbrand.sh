#!/usr/bin/env bash
# Regenerate and render every brand/ mockup at 2x, then quantize. Run from apps/menubar/design.
set -euo pipefail
cd "$(dirname "$0")/.."
bun tools/genbrand.ts
while read -r name w h; do tools/render.sh "brand/$name" "$w" "$h" 2>/dev/null; done <<'EOF'
panel-tree 760 820
thread 760 680
mention 1240 270
moments 1240 600
menubar 1240 540
directions 1240 700
catalog 1240 1960
catalog-body 1240 1720
contact-sheet 1240 2080
EOF
python3 tools/quantize.py brand/*.png
