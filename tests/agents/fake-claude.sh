#!/bin/bash
# Fake `claude` for adapter tests. Behaviour is selected by markers in the -p prompt:
#   [leak] print the API key everywhere   [sleep] hang   [nochange] edit nothing   [fail] error result
#   [slow] keep working for ~5s, one event every 0.25s (liveness)
#   [quota] or [quota:N] edit, then stop at a plan usage limit resetting in N seconds (default 3600), as
#           claude 2.1.303 does; a resumed run (its prompt says it was stopped earlier) works normally
#   [spend] edit, then keep working for ~10s, each message reporting 100k output tokens (live spend)
prompt=""; args=("$@")
while [ $# -gt 0 ]; do case "$1" in -p) prompt="$2"; shift 2;; *) shift;; esac; done
{ printf '%s\n' "${args[@]}"; [ -n "$ANTHROPIC_API_KEY" ] && echo "KEY_PRESENT"; } > ../argv.txt
printf '%s' "$ANTHROPIC_API_KEY" > ../keyseen.txt
echo "oauth=${CLAUDE_CODE_OAUTH_TOKEN:+set} apikey=${ANTHROPIC_API_KEY:+set}" > ../authseen.txt
emit() { printf '%s\n' "$1"; }
emit '{"type":"system","subtype":"init","session_id":"s1","tools":["Read","Edit"],"model":"fake"}'
case "$prompt" in *"[leak]"*)
  emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"my key is $ANTHROPIC_API_KEY\"}]}}"
  echo "stderr leak $ANTHROPIC_API_KEY" >&2;;
esac
case "$prompt" in *"[sleep]"*) sleep 120;; esac
case "$prompt" in *"[slow]"*)
  for i in $(seq 1 20); do sleep 0.25; emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"step $i\"}]}}"; done;;
esac
if [[ "$prompt" == *"[fail]"* ]]; then
  emit '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"total_cost_usd":0.01}'
  exit 1
fi
emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"src/sum.ts"}}]}}'
if [[ "$prompt" != *"[nochange]"* ]]; then
  mkdir -p src && printf 'export const sum = (a: number, b: number) => a + b;\n' > src/sum.ts
fi
case "$prompt" in *"[spend]"*)
  for i in $(seq 1 40); do sleep 0.25
    emit "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_$i\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":100000},\"content\":[{\"type\":\"text\",\"text\":\"step $i\"}]}}"
  done;;
esac
case "$prompt" in *"stopped earlier by your provider's usage limit"*) ;; *"[quota"*)
  secs=$(printf '%s' "$prompt" | sed -n 's/.*\[quota:\([0-9]*\)\].*/\1/p')
  reset=$(( $(date +%s) + ${secs:-3600} ))
  info="{\"status\":\"rejected\",\"resetsAt\":$reset,\"rateLimitType\":\"five_hour\"}"
  emit "{\"type\":\"rate_limit_event\",\"rate_limit_info\":$info,\"session_id\":\"s1\"}"
  emit "{\"type\":\"assistant\",\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"You've hit your session limit · resets 3pm (UTC)\"}]},\"error\":\"rate_limit\",\"is_api_error_message\":true,\"api_error_status\":429,\"api_error\":\"usage_limit_reached\",\"api_error_params\":{\"rate_limit_info\":$info}}"
  emit '{"type":"result","subtype":"success","is_error":true,"num_turns":2,"total_cost_usd":0,"result":"You'"'"'ve hit your session limit · resets 3pm (UTC)","api_error_status":429,"api_error":"usage_limit_reached"}'
  exit 1;;
esac
# [wip]: edit, then hang (a limit with work to keep)
case "$prompt" in *"[wip]"*) sleep 120;; esac
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
result="fixed sum"
[[ "$prompt" == *"[leak]"* ]] && result="done with $ANTHROPIC_API_KEY"
emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"total_cost_usd\":0.123,\"result\":\"$result\"}"
