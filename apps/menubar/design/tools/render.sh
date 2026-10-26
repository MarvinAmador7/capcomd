#!/usr/bin/env bash
# Render a mockup HTML to PNG at 2x. Usage: tools/render.sh <name> [width] [height]
# Run from apps/menubar/design. Width/height are CSS px (PNG is 2x). Defaults match the panel (760x660).
set -euo pipefail
cd "$(dirname "$0")/.."
name="${1%.html}"; w="${2:-760}"; h="${3:-660}"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || echo '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size="$w,$h" --screenshot="$PWD/$name.png" "file://$PWD/$name.html"
