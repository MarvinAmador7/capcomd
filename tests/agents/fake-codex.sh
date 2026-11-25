#!/bin/bash
# Fake `codex` for adapter tests: emits `codex exec --json` JSONL. Markers in the prompt (last arg):
#   [loop] keep running tools (guard test)  [fail] turn.failed  [nochange] edit nothing  [leak] echo key
# Sessions (ADR-026 §2), as codex 0.169 keeps them: without --ephemeral, a run writes
# $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (CODEX_HOME defaults to $HOME/.codex); `exec … resume <id>
# "<prompt>"` appends to that file, after writing its line count and first line to ../resumed.txt, or fails (exit 1,
# "no rollout found for thread id <id>") without it.
args=("$@"); prompt="${args[$((${#args[@]}-1))]}"; out=""; resume=""; eph=0
for ((i=0;i<${#args[@]};i++)); do
  [ "${args[$i]}" = "-o" ] && out="${args[$((i+1))]}"
  [ "${args[$i]}" = "--ephemeral" ] && eph=1
  [ "${args[$i]}" = "resume" ] && resume="${args[$((i+1))]}"
done
ch="${CODEX_HOME:-$HOME/.codex}"; tid="th-$$-$RANDOM"; rollout=""
if [ -n "$resume" ]; then
  rollout=$(find "$ch/sessions" -type f -name "rollout-*-$resume.jsonl" 2>/dev/null | head -n 1)
  if [ -z "$rollout" ]; then echo "Error: thread/resume: thread/resume failed: no rollout found for thread id $resume (code -32600)" >&2; exit 1; fi
  { echo "lines=$(wc -l < "$rollout" | tr -d ' ')"; head -1 "$rollout"; } > ../resumed.txt
  tid="$resume"
elif [ "$eph" = 0 ]; then
  d="$ch/sessions/$(date -u +%Y/%m/%d)"; mkdir -p "$d"; rollout="$d/rollout-$(date -u +%Y-%m-%dT%H-%M-%S)-$tid.jsonl"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\n' "$tid" "$PWD" > "$rollout"
fi
[ -n "$rollout" ] && printf '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":%s}]}}\n' "$(printf '%s' "$prompt" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.stringify(s)))')" >> "$rollout"
{ printf '%s\n' "${args[@]}"; [ -n "$CODEX_API_KEY" ] && echo "KEY_PRESENT"; } > ../argv.txt
printf '%s' "$CODEX_API_KEY" > ../keyseen.txt
echo "codex_home=${CODEX_HOME:+set} apikey=${CODEX_API_KEY:+set}${OPENAI_API_KEY:+set}" > ../authseen.txt
e() { printf '%s\n' "$1"; }
e "{\"type\":\"thread.started\",\"thread_id\":\"$tid\"}"
e '{"type":"turn.started"}'
if [[ "$prompt" == *"[fail]"* ]]; then e '{"type":"turn.failed","error":{"message":"model refused"}}'; exit 1; fi
if [[ "$prompt" == *"[loop]"* ]]; then
  for i in $(seq 1 200); do e "{\"type\":\"item.completed\",\"item\":{\"id\":\"i$i\",\"type\":\"command_execution\",\"command\":\"ls\",\"exit_code\":0,\"status\":\"completed\"}}"; sleep 0.05; done; exit 0
fi
[[ "$prompt" == *"[leak]"* ]] && e "{\"type\":\"item.completed\",\"item\":{\"id\":\"m0\",\"type\":\"agent_message\",\"text\":\"key $CODEX_API_KEY\"}}"
# [refuse]: a command its rules forbid, which codex 0.163 reports only on stderr. [scribble]: write a file anyway.
[[ "$prompt" == *"[refuse]"* ]] && printf '%s\n' "2026-11-05T19:13:04.307231Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"\`/bin/bash -lc 'git push origin HEAD:main'\` rejected: capcomd orchestrate mode: no pushes\\\")\" }" >&2
[[ "$prompt" == *"[scribble]"* ]] && printf 'notes\n' > notes.txt
e '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}'
e '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","exit_code":0,"status":"completed"}}'
if [[ "$prompt" != *"[nochange]"* ]]; then
  mkdir -p src && printf 'export const sum = (a: number, b: number) => a + b;\n' > src/sum.ts
  e '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/sum.ts","kind":"update"}],"status":"completed"}}'
fi
e '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"fixed sum with codex"}}'
[ -n "$out" ] && printf 'fixed sum with codex' > "$out"
[ -n "$rollout" ] && printf '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fixed sum with codex"}]}}\n' >> "$rollout"
e '{"type":"turn.completed","usage":{"input_tokens":10000,"cached_input_tokens":2000,"output_tokens":1000,"reasoning_output_tokens":500}}'
