#!/bin/bash
# Fake `claude` for adapter tests. Behaviour is selected by markers in the -p prompt:
#   [leak] print the API key everywhere   [sleep] hang   [nochange] edit nothing   [fail] error result
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
if [[ "$prompt" == *"[fail]"* ]]; then
  emit '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"total_cost_usd":0.01}'
  exit 1
fi
emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"src/sum.ts"}}]}}'
if [[ "$prompt" != *"[nochange]"* ]]; then
  mkdir -p src && printf 'export const sum = (a: number, b: number) => a + b;\n' > src/sum.ts
fi
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
result="fixed sum"
[[ "$prompt" == *"[leak]"* ]] && result="done with $ANTHROPIC_API_KEY"
emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"total_cost_usd\":0.123,\"result\":\"$result\"}"
