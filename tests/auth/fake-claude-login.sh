#!/bin/bash
# Fake `claude` for auth tests: `setup-token` (interactive) and `-p` verify.
TOKEN="sk-ant-oat01-FAKEOAUTHTOKEN_abcdefghijklmnopqrstuvwxyz0123456789-XYZ"
if [ "$1" = setup-token ]; then
  printf '\033[1mOpen this URL to authorize:\033[0m https://claude.ai/oauth/authorize?code=true&client_id=fake\n'
  printf 'Paste code here if prompted > '
  read -r code
  [ "$code" = "BROWSERCODE" ] || { echo "bad code"; exit 3; }
  # Token printed in two writes with colour, like a TUI might.
  printf '\n\033[32m✓ Long-lived token:\033[0m sk-ant-oat01-FAKEOAUTH'; sleep 0.05
  printf 'TOKEN_abcdefghijklmnopqrstuvwxyz0123456789-XYZ\n'
  printf 'Store this token securely.\n'
  exit 0
fi
if [ "$1" = -p ]; then
  [ -n "$ANTHROPIC_API_KEY" ] && { echo "api key used (wrong)"; exit 4; }
  case "$CLAUDE_CODE_OAUTH_TOKEN" in "$TOKEN"|bxds_*) echo ok; exit 0;; esac
  echo "Invalid API key · Please run /login" >&2; exit 1
fi
[ "$1" = --version ] && { echo "2.1.286 (Claude Code)"; exit 0; }
exit 2
