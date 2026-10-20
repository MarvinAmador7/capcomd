#!/bin/bash
# Fake `codex` for auth tests: `login --device-auth` and `exec` verify.
if [ "$1" = login ] && [ "$2" = --device-auth ]; then
  grep -q 'cli_auth_credentials_store = "file"' "$CODEX_HOME/config.toml" || { echo "not file store"; exit 5; }
  echo "Follow these steps to sign in with ChatGPT using device code authorization:"
  echo "1. Open this link in your browser https://auth.openai.com/codex/device"
  echo "2. Enter this one-time code ABCD-1234"
  sleep 0.2
  mkdir -p "$CODEX_HOME"
  printf '{"auth_mode":"chatgpt","tokens":{"id_token":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2ln","access_token":"eyJhbGciOiJSUzI1NiJ9.eyJhY2Nlc3MiOiJ5eXl5In0.c2lnbmF0dXJlc2ln","refresh_token":"rt_FAKEREFRESH"},"last_refresh":"2026-10-19T00:00:00Z"}' > "$CODEX_HOME/auth.json"
  echo "Successfully logged in"
  exit 0
fi
if [ "$1" = exec ]; then
  [ -n "$CODEX_API_KEY$OPENAI_API_KEY" ] && { echo '{"type":"error","message":"api key used"}'; exit 4; }
  [ -s "$CODEX_HOME/auth.json" ] || { echo '{"type":"turn.failed","error":{"message":"401 not logged in"}}'; exit 1; }
  echo '{"type":"thread.started","thread_id":"t"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'
  exit 0
fi
[ "$1" = --version ] && { echo "codex-cli 0.159.3"; exit 0; }
exit 2
