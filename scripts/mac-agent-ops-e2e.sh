#!/usr/bin/env bash
# ADR-019 live e2e: what an operator (or a parent) does with running agents, on real Claude Code agents in boxd VMs.
#   1. notice + send: a worker that goes quiet (a long shell command) raises an `idle` notice that `await --notices`
#      returns; a message sent to it then reaches it mid-run, and what it asked for ends up on its branch.
#   2. --continue: a worker stopped at its timeout keeps its work on its branch; `spawn --continue` starts a new
#      agent from that branch, which finishes the job.
#   3. isolation: a process in an agent VM can't mint boxd org credentials from the machine's metadata service.
# Needs: bun, gh (logged in), BOXD_API_KEY, a working claude login (capcomd auth status). No verify or merge: the
# checks read the agents' branches. The GitHub repo is kept (the delete command is printed). From a git worktree,
# point CAPCOMD_AUTH_LEDGER and CAPCOMD_ENV_LEDGER at the main checkout's .relay/ files (that's where logins live).
# Ends with `E2E PASS` or `E2E FAIL: <reasons>`.
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
export BOXD_NO_UPDATE_NOTICE=1
TS="$(date +%s)"
REPO="$OWNER/capcomd-agent-ops-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-agent-ops.XXXXXX")"
T0=$(date +%s)
die() { echo "mac-agent-ops-e2e: $*" >&2; echo "artifacts: $WORK"; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -d node_modules ] || bun install
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

# listener: an idle notice after 20 s without output (no stop: none is set). short: stopped at 60 s.
AGENTS="$WORK/agents.json"
printf '{"schema":"capcomd.agents/v1","agents":{"listener":%s,"short":%s,"worker":%s}}\n' \
  '{"provider":"claude","auth":"subscription","idleAfterMs":20000,"timeoutMs":600000}' \
  '{"provider":"claude","auth":"subscription","timeoutMs":60000}' \
  '{"provider":"claude","auth":"subscription","timeoutMs":600000}' > "$AGENTS"
export CAPCOMD_AGENTS_FILE="$AGENTS"
export CAPCOMD_SANDBOX=boxd
export CAPCOMD_REPO="https://github.com/$REPO.git"
export CAPCOMD_GITHUB_REPO="$REPO"
export CAPCOMD_MERGE_MODE=pr
export CAPCOMD_MERGE_TARGET=main
export CAPCOMD_WORKDIR="$WORK/merge"
export CAPCOMD_TRACE_DIR="$WORK/traces"
export CAPCOMD_RPC_KEY_FILE="$WORK/rpc.key"
PORT=$(bun -e 'const { testPort } = await import("./tests/helpers/engine.ts"); console.log(await testPort())') || die "no free engine port"
export CAPCOMD_ENDPOINT="http://127.0.0.1:$PORT"
C="bun src/cli/index.ts"

echo "== 0. env snapshot, preflight"
env -u CAPCOMD_REPO $C env build || die "capcomd env build failed"
CAPCOMD_AGENT=worker bun scripts/preflight.ts >/dev/null || die "preflight failed (capcomd auth status)"

echo "== 1. private repo $REPO"
SRC="$WORK/src"; mkdir -p "$SRC"
echo "# agent ops e2e" > "$SRC/README.md"
git -C "$SRC" init -q -b main && git -C "$SRC" add -A
git -C "$SRC" -c user.name=capcomd -c user.email=capcomd@users.noreply.github.com commit -q -m "start"
gh repo create "$REPO" --private >/dev/null
git -C "$SRC" remote add origin "https://github.com/$REPO.git"
git -C "$SRC" push -q -u origin main

echo "== 2. engine on :$PORT"
# Engine data in the run's work dir, not ~/.capcomd/engine/<port> (one per test port, never removed).
CAPCOMD_ENGINE_DATA="$WORK/engine" CAPCOMD_HARNESS_SOCKET="$WORK/harness.sock" $C serve --port "$PORT" > "$WORK/engine.log" 2>&1 &
ENGINE_PID=$!
cleanup() { pkill -P "$ENGINE_PID" 2>/dev/null || true; kill "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT
bun tests/chaos/ready-probe.ts "$PORT" >/dev/null 2>"$WORK/ready.err" || die "engine not ready: $(tail -1 "$WORK/ready.err")"

RUN=$($C run new --label "agent ops e2e $TS" --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).runId)')
id() { bun -e 'console.log(JSON.parse(await Bun.stdin.text()).agentId)'; }
LISTEN=$($C spawn "$RUN" --profile listener --key listen --json --task "Do exactly this, in order:
1. Create notes.txt containing the line ALPHA.
2. Run the shell command: sleep 90
3. If you received any further instructions while the command ran, follow them.
Then stop. Don't commit; capcomd commits your work." | id)
SHORT=$($C spawn "$RUN" --profile short --key short --json --task "Do exactly this, in order:
1. Create part1.txt containing the line ONE.
2. Run the shell command: sleep 300
3. Create part2.txt containing the line TWO.
Don't commit; capcomd commits your work." | id)
echo "   listener $LISTEN, short $SHORT (run $RUN)"

echo "== 3. idle notice, then a message"
set +e
$C await "$RUN" "$LISTEN" --notices --timeout-ms 240000 --json > "$WORK/notice.json"
set -e
NOTICE=$(bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(j.notices?.[0]?.kind ?? "none")' "$WORK/notice.json" 2>/dev/null || echo none)
echo "   notice: $NOTICE"
$C send "$RUN" "$LISTEN" "Also add the line BRAVO to notes.txt." >/dev/null
$C await "$RUN" "$LISTEN" --timeout-ms 600000 --json > "$WORK/listen.json" || true
LBRANCH=$(bun -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents[0]; console.log(a.status === "done" ? a.result.branch : "")' "$WORK/listen.json")
NOTES=""; [ -n "$LBRANCH" ] && NOTES=$(gh api "repos/$REPO/contents/notes.txt?ref=$LBRANCH" -q .content 2>/dev/null | base64 -d 2>/dev/null || true)
echo "   notes.txt on ${LBRANCH:-(no branch)}: $(echo "$NOTES" | tr '\n' ' ')"
DELIVERED=$(TRACE="$CAPCOMD_TRACE_DIR/$RUN.ndjson" bun -e 'const fs=require("fs"); const t=process.env.TRACE; let n=0; if (fs.existsSync(t)) for (const l of fs.readFileSync(t,"utf8").trim().split("\n")) { const s=JSON.parse(l); n+=(s.events??[]).filter((e)=>e.name==="agent.message_delivered").length; } console.log(n)')
echo "   delivered (supervisor reports): $DELIVERED"

echo "== 4. stopped at its timeout, then --continue"
$C await "$RUN" "$SHORT" --timeout-ms 600000 --json > "$WORK/short.json" || true
SLIMIT=$(bun -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents[0]; console.log(a.result?.limit ?? a.status)' "$WORK/short.json")
echo "   short stopped: $SLIMIT"
NEXT=$($C spawn "$RUN" --profile worker --key next --continue "$SHORT" --json --task "Finish the job: part2.txt must exist containing the line TWO. Don't run any sleep. Don't commit; capcomd commits your work." | id)
$C await "$RUN" "$NEXT" --timeout-ms 600000 --json > "$WORK/next.json" || true
NBRANCH=$(bun -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents[0]; console.log(a.status === "done" ? a.result.branch : "")' "$WORK/next.json")
P1=""; P2=""
if [ -n "$NBRANCH" ]; then
  P1=$(gh api "repos/$REPO/contents/part1.txt?ref=$NBRANCH" -q .content 2>/dev/null | base64 -d 2>/dev/null || true)
  P2=$(gh api "repos/$REPO/contents/part2.txt?ref=$NBRANCH" -q .content 2>/dev/null | base64 -d 2>/dev/null || true)
fi
echo "   continued on ${NBRANCH:-(no branch)}: part1=$(echo $P1) part2=$(echo $P2)"

echo "== 5. isolation: an agent VM can't mint boxd org credentials (scripts/boxd-isolation-check.ts)"
bun scripts/boxd-isolation-check.ts 2>&1 | sed 's/^/   /' | tee "$WORK/isolation.log"
ISO=$(grep -c "^   ISOLATION OK" "$WORK/isolation.log" || true)

echo "== 6. tree, VM cleanup"
$C tree "$RUN"
bun scripts/vm-cleanup-check.ts "$RUN" && VMS=clean || { [ $? = 1 ] && VMS=leaked || VMS=unchecked; }
echo
echo "timings: total $(( $(date +%s) - T0 ))s"
echo "artifacts: $WORK"
echo "repo kept: https://github.com/$REPO   delete when done: gh repo delete $REPO --yes"
FAILS=""
[ "$NOTICE" = idle ] || FAILS="$FAILS notice=$NOTICE"
echo "$NOTES" | grep -q ALPHA || FAILS="$FAILS notes-missing-ALPHA"
echo "$NOTES" | grep -q BRAVO || FAILS="$FAILS message-not-acted-on"
[ "${DELIVERED:-0}" -ge 1 ] || FAILS="$FAILS delivered=0"
[ "$SLIMIT" = timeout ] || FAILS="$FAILS short-stop=$SLIMIT"
echo "$P1" | grep -q ONE || FAILS="$FAILS continued-without-part1"
echo "$P2" | grep -q TWO || FAILS="$FAILS part2-missing"
[ "$VMS" = clean ] || FAILS="$FAILS vms=$VMS"
[ "${ISO:-0}" -ge 1 ] || FAILS="$FAILS agent-vm-not-isolated"
if [ -n "$FAILS" ]; then echo "E2E FAIL:$FAILS"; exit 1; fi
echo "E2E PASS: idle notice raised, message delivered and acted on, a stopped agent continued to the end, agent VMs isolated, no VMs left"
