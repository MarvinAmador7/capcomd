#!/bin/sh
# The capcomd plugin's MCP server (ADR-018 §2). Agent apps often start servers with a short PATH, so look in the
# usual install places too. launch.mjs finds the installed capcomd and runs `capcomd mcp`, or serves a one-tool
# server (capcomd_setup) that says how to install it. Without bun or node to run it, the capcomd binary serves itself.
here=$(cd "$(dirname "$0")" && pwd)
PATH="$PATH:$HOME/.capcomd/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH
if command -v bun >/dev/null 2>&1; then exec bun "$here/launch.mjs"; fi
if command -v node >/dev/null 2>&1; then exec node "$here/launch.mjs"; fi
if command -v capcomd >/dev/null 2>&1; then exec capcomd mcp; fi
echo "capcomd plugin: capcomd isn't installed; install it with: curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh" >&2
exit 1
