#!/usr/bin/env bash
# DRAFT boards: regenerate and render desktop/leftnav/ at 2x (render.sh's headless Chrome flags). Run from
# apps/menubar/design. Each Nav board renders twice: the window (1440 x 900, Reel.png's size) and its states (#states).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/genleftnav.py
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || echo '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')}"
shot() { # <html> <hash> <png> <w> <h>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=3000 \
    --window-size="$4,$5" --screenshot="$PWD/desktop/leftnav/$3" "file://$PWD/desktop/leftnav/$1$2" 2>/dev/null
}
shot NavA.dc.html "" NavA.png 1440 900
shot NavB.dc.html "" NavB.png 1440 900
shot NavC.dc.html "" NavC.png 1440 900
shot NavA.dc.html "#states" NavA-states.png 1440 1290
shot NavB.dc.html "#states" NavB-states.png 1440 1180
shot NavC.dc.html "#states" NavC-states.png 1440 1650
shot NavCompare.dc.html "" NavCompare.png 1440 1290
