#!/bin/bash
# Fake `fx` for auth tests: `login vercel` (a device code, as fx's OAuth device flow prints it), `login grok` (a browser
# URL, then the code pasted back), `status --json` (with fields a check must never pass on) and `ask` (the verify call).
# FAKE_FX_STATUS=missing makes status say there is no login although the file is there.
h="${FX_HOME:-$HOME/.fx}"
if [ "$1" = login ]; then
  [ "$FX_NO_OPEN_BROWSER" = 1 ] || { echo "fx would open a browser"; exit 6; }
  mkdir -p "$h" && chmod 700 "$h"
  case "$2" in
    vercel)
      echo "Open https://vercel.com/oauth/device?user_code=WXYZ-9876 in your browser"
      echo "and confirm the code WXYZ-9876."
      sleep 0.2
      printf '{"access_token":"eyJhbGciOiJSUzI1NiJ9.eyJ2ZXJjZWwiOiJ4eHh4eCJ9.c2lnbmF0dXJlc2ln","refresh_token":"vcr_FAKEREFRESH"}' > "$h/auth.json"
      chmod 600 "$h/auth.json"
      echo "Signed in to Vercel"
      exit 0;;
    grok)
      echo "Open https://auth.x.ai/oauth2/auth?client_id=fx-cli to sign in to Grok."
      printf "Paste the code shown by xAI: "
      read -r code
      [ "$code" = "XAI-CODE-123" ] || { echo "That code didn't work."; exit 1; }
      printf '{"access_token":"eyJhbGciOiJSUzI1NiJ9.eyJncm9rIjoieXl5eXkifQ.c2lnbmF0dXJlc2ln","refresh_token":"xrt_FAKEREFRESH"}' > "$h/grok-auth.json"
      chmod 600 "$h/grok-auth.json"
      echo "Signed in to Grok"
      exit 0;;
    *) echo "fx login: no device flow for $2"; exit 2;;
  esac
fi
# The credential fx would use for its provider: an env key outranks a login, as in fx.
cred() {
  case "${FX_PROVIDER:-gateway}" in
    gateway) [ -n "$AI_GATEWAY_API_KEY" ] && { echo AI_GATEWAY_API_KEY; return; }; [ -s "$h/auth.json" ] && { echo "fx login"; return; };;
    grok) [ -s "$h/grok-auth.json" ] && { echo "fx login"; return; };;
  esac
  echo missing
}
if [ "$1" = status ]; then
  a="$(cred)"; [ -n "$FAKE_FX_STATUS" ] && a="$FAKE_FX_STATUS"
  printf '{"kind":"status","model":"m","provider":"%s","auth":"%s","auth_refreshable":true,"session":"vcr_FAKEREFRESH","home":"%s"}\n' "${FX_PROVIDER:-gateway}" "$a" "$h"
  exit 0
fi
if [ "$1" = ask ]; then
  [ -n "$AI_GATEWAY_API_KEY$VERCEL_OIDC_TOKEN" ] && { echo '{"kind":"ask","exit_code":4,"error":"an API key was used"}'; exit 4; }
  [ "$(cred)" = "fx login" ] || { echo '{"kind":"ask","exit_code":1,"error":"fx needs access to Vercel AI Gateway"}'; exit 1; }
  echo "{\"kind\":\"ask\",\"provider\":\"${FX_PROVIDER:-gateway}\",\"final_output\":\"ok\",\"exit_code\":0}"
  exit 0
fi
[ "$1" = --version ] && { echo "0.0.16"; exit 0; }
exit 2
