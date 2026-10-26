#!/bin/bash
# Fake `claude` for adapter tests. Behaviour is selected by markers in the -p prompt:
#   [leak] print the API key everywhere   [sleep] hang   [nochange] edit nothing   [fail] error result
#   [slow] keep working for ~5s, one event every 0.25s (liveness)
#   [quota] or [quota:N] edit, then stop at a plan usage limit resetting in N seconds (default 3600), as
#           claude 2.1.303 does; a resumed run (its prompt says it was stopped earlier) works normally
#   [steady] edit, then keep working for ~3s (checkpoints, supervisor heartbeats)
#   [spend] edit, then keep working for ~10s, each message reporting 100k output tokens (live spend)
#   [spin] or [spin:N] edit, then make the same Read call N times (default 30, 0.15s apart), then finish normally (stuck: spinning)
#   [failing] or [failing:N] edit, then N times (default 30) run the same failing command and try another edit, the
#           error differing only in numbers, then finish normally (stuck: failing)
#   [listen] edit, then work for ~8s, writing each message it reads on stdin to messages.txt (send mid-run)
# With --input-format stream-json (the supervisor feeds it), the prompt is the first stdin message, and after its
# result it answers further messages until stdin closes, as claude does.
prompt=""; stream=0; args=("$@")
while [ $# -gt 0 ]; do case "$1" in
  -p) case "${2:-}" in -*|"") shift;; *) prompt="$2"; shift 2;; esac;;
  --input-format) [ "${2:-}" = stream-json ] && stream=1; shift 2;;
  *) shift;; esac; done
text_of() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).message.content))}catch{}})'; }
if [ "$stream" = 1 ]; then IFS= read -r first; prompt=$(printf '%s' "$first" | text_of); fi
printf '%s' "$prompt" > ../prompt-seen.txt
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
case "$prompt" in *"[spin"*)
  n=$(printf '%s' "$prompt" | sed -n 's/.*\[spin:\([0-9]*\)\].*/\1/p')
  for i in $(seq 1 "${n:-30}"); do sleep 0.15
    emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"s$i\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/sum.ts\"}}]}}"
    emit "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"s$i\",\"content\":\"export const sum = 1\"}]}}"
  done;;
esac
case "$prompt" in *"[failing"*)
  n=$(printf '%s' "$prompt" | sed -n 's/.*\[failing:\([0-9]*\)\].*/\1/p')
  for i in $(seq 1 "${n:-30}"); do sleep 0.15
    emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"f$i\",\"name\":\"Bash\",\"input\":{\"command\":\"bun test\"}}]}}"
    emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"e$i\",\"name\":\"Edit\",\"input\":{\"file_path\":\"src/sum.ts\",\"attempt\":$i}}]}}"
    emit "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"f$i\",\"is_error\":true,\"content\":\"sum.test.ts:$i expected 3, received $((i * 7)) (${i}ms)\"}]}}"
  done;;
esac
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
case "$prompt" in *"[steady]"*)
  for i in $(seq 1 12); do sleep 0.25; emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"step $i\"}]}}"; done;;
esac
case "$prompt" in *"[listen]"*)
  for i in $(seq 1 8); do
    if [ "$stream" = 1 ] && IFS= read -r -t 1 line; then
      printf '%s\n' "$line" | text_of >> messages.txt; printf '\n' >> messages.txt
      emit '{"type":"assistant","message":{"content":[{"type":"text","text":"heard a message"}]}}'
    else [ "$stream" = 1 ] || sleep 1; emit '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'; fi
  done;;
esac
# [thread]: a markdown message and a timed tool call, for the thread items (harness.v1 GET …/thread)
case "$prompt" in *"[thread]"*)
  emit '{"type":"assistant","message":{"id":"msg_plan","content":[{"type":"thinking","thinking":"Plan the backfill first."}]}}'
  emit '{"type":"assistant","message":{"id":"msg_plan","content":[{"type":"text","text":"## Plan\n\n- Normalize emails\n- Fan out on `ids/v1`\n\n```sql\nSELECT 1;\n```\n\n| shard | rows |\n|--|--:|\n| 1 | 10 |\n\nSee [the schema](ids/v1/schema.json)."}]}}'
  emit '{"type":"assistant","message":{"id":"msg_glob","content":[{"type":"tool_use","id":"g1","name":"Glob","input":{"pattern":"**/*.ts"}}]}}'
  sleep 0.5
  emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"g1","content":"src/sum.ts"}]},"tool_use_result":{"filenames":["src/sum.ts"],"durationMs":412,"numFiles":1}}';;
esac
# [wip]: edit, then hang (a limit with work to keep)
case "$prompt" in *"[wip]"*) sleep 120;; esac
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
result="fixed sum"
[[ "$prompt" == *"[leak]"* ]] && result="done with $ANTHROPIC_API_KEY"
emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"total_cost_usd\":0.123,\"result\":\"$result\"}"
# Fed on stdin: answer what comes after the result, until the input ends.
if [ "$stream" = 1 ]; then
  while IFS= read -r line; do
    printf '%s\n' "$line" | text_of >> messages.txt; printf '\n' >> messages.txt
    emit '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0,"result":"answered"}'
  done
fi
