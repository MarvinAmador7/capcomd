#!/bin/sh
# The capcomd plugin's MCP server (ADR-018 §2). Agent apps often start servers with a short PATH, so look in the
# usual install places too. launch.mjs finds the installed capcomd and runs `capcomd mcp`, or serves a one-tool
# server (capcomd_setup) that says how to install it.
here=$(cd "$(dirname "$0")" && pwd)
PATH="$PATH:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH
if command -v bun >/dev/null 2>&1; then exec bun "$here/launch.mjs"; fi
if command -v node >/dev/null 2>&1; then exec node "$here/launch.mjs"; fi
echo "capcomd plugin: neither bun nor node found; install Bun (https://bun.sh), then: bun add -g capcomd" >&2
exit 1
