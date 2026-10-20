#!/bin/bash
# Fake `codex` for adapter tests: emits `codex exec --json` JSONL. Markers in the prompt (last arg):
#   [loop] keep running tools (guard test)  [fail] turn.failed  [nochange] edit nothing  [leak] echo key
args=("$@"); prompt="${args[$((${#args[@]}-1))]}"; out=""
for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = "-o" ] && out="${args[$((i+1))]}"; done
{ printf '%s\n' "${args[@]}"; [ -n "$CODEX_API_KEY" ] && echo "KEY_PRESENT"; } > ../argv.txt
printf '%s' "$CODEX_API_KEY" > ../keyseen.txt
e() { printf '%s\n' "$1"; }
e '{"type":"thread.started","thread_id":"th_1"}'
e '{"type":"turn.started"}'
if [[ "$prompt" == *"[fail]"* ]]; then e '{"type":"turn.failed","error":{"message":"model refused"}}'; exit 1; fi
if [[ "$prompt" == *"[loop]"* ]]; then
  for i in $(seq 1 200); do e "{\"type\":\"item.completed\",\"item\":{\"id\":\"i$i\",\"type\":\"command_execution\",\"command\":\"ls\",\"exit_code\":0,\"status\":\"completed\"}}"; sleep 0.05; done; exit 0
fi
[[ "$prompt" == *"[leak]"* ]] && e "{\"type\":\"item.completed\",\"item\":{\"id\":\"m0\",\"type\":\"agent_message\",\"text\":\"key $CODEX_API_KEY\"}}"
e '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}'
e '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","exit_code":0,"status":"completed"}}'
if [[ "$prompt" != *"[nochange]"* ]]; then
  mkdir -p src && printf 'export const sum = (a: number, b: number) => a + b;\n' > src/sum.ts
  e '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/sum.ts","kind":"update"}],"status":"completed"}}'
fi
e '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"fixed sum with codex"}}'
[ -n "$out" ] && printf 'fixed sum with codex' > "$out"
e '{"type":"turn.completed","usage":{"input_tokens":10000,"cached_input_tokens":2000,"output_tokens":1000,"reasoning_output_tokens":500}}'
