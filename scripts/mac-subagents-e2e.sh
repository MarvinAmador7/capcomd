#!/usr/bin/env bash
# ADR-017 live e2e: a planner agent (claude, with the profile `capcomd setup` writes: may spawn the two worker
# profiles, no other limits, no run budget) splits a 3-file goal into child agents (mix of claude + codex) from
# inside its VM with in-VM capcomd, verifies and merges each child's branch, and reports. Workers checkpoint every
# 5 s: their checkpoint refs must reach GitHub and be deleted when their work merges. Prints the tree, rollups and
# timings.
# The GitHub repo is NOT deleted (inspect it; the delete command is printed at the end).
# Needs: bun, gh (logged in), a boxd key (BOXD_API_KEY, or the one `capcomd setup` keeps in the keychain),
# working claude + codex logins (capcomd auth status).
# Override profiles with CAPCOMD_PLANNER_SPEC / CAPCOMD_CLAUDE_WORKER_SPEC / CAPCOMD_CODEX_WORKER_SPEC /
# CAPCOMD_REVIEWER_SPEC (JSON). Every verify is also reviewed by the read-only `reviewer` profile.
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
export BOXD_NO_UPDATE_NOTICE=1
TS="$(date +%s)"
REPO="$OWNER/capcomd-subagents-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-subagents.XXXXXX")"
T0=$(date +%s)
die() { echo "mac-subagents-e2e: $*" >&2; echo "artifacts: $WORK"; exit 1; }
command -v bun >/dev/null || die "bun not on PATH"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -d node_modules ] || bun install
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

# Profiles: the planner as `capcomd setup` writes it (may spawn these two worker profiles, nothing else limited).
# Workers keep a 15-minute timeout only as this script's safety net, and checkpoint every 5 s.
AGENTS="$WORK/agents.json"
DEF_P='{"provider":"claude","auth":"subscription","children":{"allowSpawn":true,"allowedChildProfiles":["claude-worker","codex-worker"]}}'
DEF_C='{"provider":"claude","auth":"subscription","timeoutMs":900000,"checkpointEveryMs":5000}'
DEF_X='{"provider":"codex","auth":"subscription","timeoutMs":900000,"checkpointEveryMs":5000}'
# Read-only reviewer: may read and run the tests, never edit (verify never pushes its tree anyway).
DEF_R='{"provider":"claude","auth":"subscription","maxTurns":15,"timeoutMs":600000,"allowedTools":["Read","Glob","Grep","LS","Bash(git diff:*)","Bash(git log:*)","Bash(git show:*)","Bash(bun test:*)","Bash(cat:*)","Bash(ls:*)"]}'
P="${CAPCOMD_PLANNER_SPEC:-$DEF_P}"; C="${CAPCOMD_CLAUDE_WORKER_SPEC:-$DEF_C}"; X="${CAPCOMD_CODEX_WORKER_SPEC:-$DEF_X}"; R="${CAPCOMD_REVIEWER_SPEC:-$DEF_R}"
printf '{"schema":"capcomd.agents/v1","agents":{"planner":%s,"claude-worker":%s,"codex-worker":%s,"reviewer":%s}}\n' "$P" "$C" "$X" "$R" > "$AGENTS"
export CAPCOMD_AGENTS_FILE="$AGENTS"

export CAPCOMD_SANDBOX=boxd
export CAPCOMD_REPO="https://github.com/$REPO.git"
export CAPCOMD_GITHUB_REPO="$REPO"
export CAPCOMD_MERGE_MODE=pr
export CAPCOMD_MERGE_STRATEGY=squash
export CAPCOMD_MERGE_TARGET=integration      # not protected: the planner merges children itself (verify-gated)
export CAPCOMD_TEST_COMMAND="bun test"
export CAPCOMD_WORKDIR="$WORK/merge"
export CAPCOMD_TRACE_DIR="$WORK/traces"
export CAPCOMD_RPC_KEY_FILE="$WORK/rpc.key"   # per-run token signing key (host only)

PORT=$(bun -e 'const { testPort } = await import("./tests/helpers/engine.ts"); console.log(await testPort())') || die "no free engine port"
export CAPCOMD_ENDPOINT="http://127.0.0.1:$PORT"

echo "== 0a. env snapshot (capcomd env build: idempotent, no VM when the snapshot for this env hash exists)"
# The throwaway repo does not exist yet (and is private): bake CLIs only. Repo is not part of the env hash.
env -u CAPCOMD_REPO bun src/cli/index.ts env build || die "capcomd env build failed"
echo "== 0b. doctor --strict (aborts on any ✗: claude and codex must both be usable)"
bun src/cli/index.ts doctor --strict || die "doctor reported a failure (see ✗ above); fix it before spawning agents"
echo "== 0. preflight (credentials checked, never printed)"
for a in planner claude-worker codex-worker reviewer; do CAPCOMD_AGENT=$a bun scripts/preflight.ts >/dev/null || die "preflight failed for $a (capcomd auth status)"; done

echo "== 1. private repo $REPO (3 broken files, one test each)"
SRC="$WORK/src"; mkdir -p "$SRC/src" "$SRC/test"
echo '{ "name": "capcomd-subagents", "private": true, "type": "module", "scripts": { "test": "bun test" } }' > "$SRC/package.json"
printf 'export function add(a: number, b: number): number {\n  return a - b;\n}\n' > "$SRC/src/add.ts"
printf 'export function mul(a: number, b: number): number {\n  return a + b;\n}\n' > "$SRC/src/mul.ts"
printf 'export function shout(s: string): string {\n  return s.toLowerCase();\n}\n' > "$SRC/src/shout.ts"
printf 'import { test, expect } from "bun:test";\nimport { add } from "../src/add";\ntest("add", () => expect(add(2, 3)).toBe(5));\n' > "$SRC/test/add.test.ts"
printf 'import { test, expect } from "bun:test";\nimport { mul } from "../src/mul";\ntest("mul", () => expect(mul(2, 3)).toBe(6));\n' > "$SRC/test/mul.test.ts"
printf 'import { test, expect } from "bun:test";\nimport { shout } from "../src/shout";\ntest("shout", () => expect(shout("hi")).toBe("HI!"));\n' > "$SRC/test/shout.test.ts"
git -C "$SRC" init -q -b main && git -C "$SRC" add -A
git -C "$SRC" -c user.name=capcomd -c user.email=capcomd@users.noreply.github.com commit -q -m "three broken functions"
gh repo create "$REPO" --private >/dev/null
git -C "$SRC" remote add origin "https://github.com/$REPO.git"
git -C "$SRC" push -q -u origin main
git -C "$SRC" push -q origin main:integration
echo "   https://github.com/$REPO  (target branch: integration)"

echo "== 2. engine on :$PORT"
# Engine data in the run's work dir, not ~/.capcomd/engine/<port> (one per test port, never removed).
CAPCOMD_ENGINE_DATA="$WORK/engine" CAPCOMD_HARNESS_SOCKET="$WORK/harness.sock" bun src/cli/index.ts serve --port "$PORT" > "$WORK/engine.log" 2>&1 &
ENGINE_PID=$!
cleanup() { pkill -P "$ENGINE_PID" 2>/dev/null || true; kill "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT
bun tests/chaos/ready-probe.ts "$PORT" >/dev/null 2>"$WORK/ready.err" || die "engine not ready: $(tail -1 "$WORK/ready.err")"
kill -0 "$ENGINE_PID" 2>/dev/null || die "engine exited: $(tail -3 "$WORK/engine.log")"

C="bun src/cli/index.ts"
# CAPCOMD_E2E_VIA=run: the same goal through `capcomd run --planner planner`, which creates the run from the project's
# gates (a .capcomd/config.json in a scratch dir here) and spawns the planner itself; otherwise the script does both.
VIA="${CAPCOMD_E2E_VIA:-spawn}"
CHECKS='{"add":"bun test ./test/add.test.ts","mul":"bun test ./test/mul.test.ts","shout":"bun test ./test/shout.test.ts"}'
PROBLEM="Three functions are broken, each with its own failing test: src/add.ts (test/add.test.ts), src/mul.ts (test/mul.test.ts), src/shout.ts (test/shout.test.ts)."
if [ "$VIA" = run ]; then
  PROJ="$WORK/proj"; mkdir -p "$PROJ/.capcomd"
  printf '{"run":{"checks":%s,"reviewer":"reviewer","target":"integration"}}\n' "$CHECKS" > "$PROJ/.capcomd/config.json"
  GOAL_RUN="$PROBLEM Fix each in its own child, changing only that file: add and mul with --profile claude-worker, shout with --profile codex-worker, each with --children.maxChildren=0 and its file's check pinned (--check add, mul or shout)."
  echo "== 3. capcomd run --planner planner"
  T_RUN0=$(date +%s)
  ROOTDIR=$(pwd)
  set +e
  (cd "$PROJ" && bun "$ROOTDIR/src/cli/index.ts" run "$GOAL_RUN" --planner planner --json) > "$WORK/run.jsonl" 2> "$WORK/run.err"
  RC=$?
  set -e
  grep '"agent.status"' "$WORK/run.jsonl" | bun -e 'for (const l of (await Bun.stdin.text()).trim().split("\n")) { const j = JSON.parse(l); console.log(`   | ${j.agentId} ${j.profile} ${j.status}`); }' || true
  RUN=$(head -1 "$WORK/run.jsonl" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).runId)')
  ROOT=$(grep '"planner.spawned"' "$WORK/run.jsonl" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).agentId)')
  echo "   run $RUN, planner $ROOT, exit $RC"
  $C await "$RUN" "$ROOT" --timeout-ms 60000 --json > "$WORK/await.json" || true
else
# Operator-named checks (a VM can't pass --checks): one per file, since the other files stay broken
# until their branches merge. The planner pins one per child at spawn; merge re-runs the same command.
RUN=$($C run new --label "subagents e2e $TS" \
  --checks-set add='bun test ./test/add.test.ts' --checks-set mul='bun test ./test/mul.test.ts' --checks-set shout='bun test ./test/shout.test.ts' \
  --reviewer reviewer --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).runId)')
GOAL="$PROBLEM
You are the planner. Do NOT edit files yourself. Use the capcomd command (see the orchestration skill in your instructions):
1. Spawn exactly three leaf children in parallel, one per file, each with --children.maxChildren=0:
   add and mul with --profile claude-worker, shout with --profile codex-worker. Give each a self-contained task naming its file and test, and tell it to change only that file.
   Pin each child's check with --check <file> (add, mul or shout: the operator's check that runs only that file's test).
2. capcomd await all three. For each child: capcomd verify --ref <agt> --key v-<file> --acceptance '[\"src/<file>.ts is fixed so test/<file>.test.ts passes\", \"no other file changed\"]' (it runs the pinned check, then the run's reviewer agent reads the change: give the command a 10-minute timeout, and if it is cut off, run the same command again); if it passes, capcomd merge --ref <agt> --require <vfyId>. If the review fails, its reasons are in result.review.reasons.
   If a child failed or its verify failed, spawn one replacement with the failure in the task, then verify and merge it.
3. Finish with: capcomd result --summary \"<per file: child id, profile, verified?, merged?>\""
echo "== 3. planner (run $RUN)"
T_RUN0=$(date +%s)
ROOT=$($C spawn "$RUN" --profile planner --task "$GOAL" --key planner --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).agentId)')
echo "   planner $ROOT"
( while kill -0 "$ENGINE_PID" 2>/dev/null; do sleep 20; $C tree "$RUN" 2>/dev/null | sed 's/^/   | /' | head -12; done ) &
WATCH=$!
set +e
$C await "$RUN" "$ROOT" --timeout-ms 3000000 --json > "$WORK/await.json"
RC=$?
set -e
{ kill "$WATCH" && wait "$WATCH"; } 2>/dev/null || true   # reap it quietly (no "Terminated: 15")
fi
T_RUN=$(( $(date +%s) - T_RUN0 ))

echo "== 4. tree + rollups"
$C tree "$RUN"
$C budget show "$RUN" --json > "$WORK/budget.json"; bun -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("   run totals:", JSON.stringify(b.totals))' "$WORK/budget.json"
echo "== 5. planner result"
bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=j.agents[0]; console.log("   status:", a.status); console.log("   summary:", a.result?.summary ?? a.result?.error)' "$WORK/await.json"
echo "== 6. per-agent timings (agent.run spans) + in-VM calls"
TRACE="$CAPCOMD_TRACE_DIR/$RUN.ndjson" bun -e '
  const fs = require("fs"); const t = process.env.TRACE;
  if (!fs.existsSync(t)) { console.log("   (no trace)"); process.exit(0); }
  const spans = fs.readFileSync(t, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const s of spans.filter((s) => s.name === "agent.run")) console.log(`   ${s.attributes["agent.id"]} [${s.attributes["agent.profile"]}] depth=${s.attributes["agent.depth"]} ${s.attributes["agent.status"] ?? "?"} ${((s.endTime - s.startTime) / 1000).toFixed(0)}s parent=${s.attributes["agent.parent"] ?? "-"}`);
  const ag = spans.filter((s) => /^agent\.(claude_code|codex)$/.test(s.name));
  for (const a of ag) console.log(`   ${a.name} turns=${a.attributes["agent.turns"]} billing=${a.attributes["agent.billing"]} stop=${a.attributes["agent.stop_reason"]} ${((a.endTime - a.startTime) / 1000).toFixed(0)}s`);
'
$C logs "$RUN" "$ROOT" --tail 400 2>/dev/null | grep '\[capcomd\]' | sed 's/^/   /' | head -40 || true
echo "== 7. merged PRs into integration"
gh pr list -R "$REPO" --state all --json number,title,state,url -q '.[] | "   #\(.number) \(.state) \(.title) \(.url)"'
MERGED=$(gh pr list -R "$REPO" --state merged --base integration --json number -q 'length' 2>/dev/null || echo 0)
echo "== 7b. checkpoints (pushed while the workers ran; deleted once their work merged)"
CKPTS=$($C events "$RUN" --json 2>/dev/null | grep -c '"AGENT_CHECKPOINT"' || true)
# The agent id is in the PR's branch name (capcomd/<run>/<agt>); titles are the task text.
MERGED_IDS=$(gh pr list -R "$REPO" --state merged --base integration --json headRefName -q '.[].headRefName' | grep -o 'agt-[a-z0-9]*' | sort -u || true)
LEFT=0
for ref in $(git ls-remote "https://github.com/$REPO.git" 'refs/capcomd/checkpoints/*' | awk '{print $2}'); do
  echo "   left: $ref"; echo "$MERGED_IDS" | grep -qx "${ref##*/}" && LEFT=$((LEFT + 1))
done
echo "   checkpoints recorded: $CKPTS; refs left for merged agents: $LEFT"
echo "== 8. integration suite (the whole goal: every test green once all branches landed)"
FINAL="$WORK/final"
if git clone -q --branch integration "https://github.com/$REPO.git" "$FINAL" 2>/dev/null && (cd "$FINAL" && bun test >"$WORK/final-test.log" 2>&1); then SUITE=pass; else SUITE=fail; fi
sed 's/^/   /' "$WORK/final-test.log" 2>/dev/null | grep -E '(pass|fail)$|^ *\(fail\)' | head -10 || true
echo "== 9. VM cleanup"
bun scripts/vm-cleanup-check.ts "$RUN" && VMS=clean || { [ $? = 1 ] && VMS=leaked || VMS=unchecked; }
REVIEWERS=$($C tree "$RUN" --json 2>/dev/null | bun -e 'const walk=(n)=>[n,...(n.children??[]).flatMap(walk)]; try { const t=JSON.parse(await Bun.stdin.text()); console.log(t.tree.flatMap(walk).filter((n)=>n.profile==="reviewer"&&n.status==="done").length) } catch { console.log(0) }')
echo "   reviewers done: $REVIEWERS"
PSTATUS=$(bun -e 'try { const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(j.agents?.[0]?.status ?? "unknown") } catch { console.log("unknown") }' "$WORK/await.json")
echo
echo "timings: total $(( $(date +%s) - T0 ))s, planner run ${T_RUN}s"
echo "artifacts: $WORK   (engine log, traces, await.json, budget.json, agents.json, final-test.log)"
echo "repo kept: https://github.com/$REPO   delete when done: gh repo delete $REPO --yes"
# Verdict: a planner that finishes "done" with nothing merged is a failure, not a pass.
FAILS=""
[ "$RC" = 0 ] || FAILS="$FAILS await-exit=$RC"
[ "$PSTATUS" = done ] || FAILS="$FAILS planner=$PSTATUS"
[ "$MERGED" = 3 ] || FAILS="$FAILS merged=$MERGED/3"
[ "$REVIEWERS" -ge 3 ] || FAILS="$FAILS reviewers=$REVIEWERS/3"
[ "$SUITE" = pass ] || FAILS="$FAILS integration-suite=fail"
[ "$VMS" = clean ] || FAILS="$FAILS vms=$VMS"
[ "${CKPTS:-0}" -ge 1 ] || FAILS="$FAILS checkpoints=0"
[ "$LEFT" = 0 ] || FAILS="$FAILS checkpoint-refs-left=$LEFT"
if [ -n "$FAILS" ]; then echo "E2E FAIL:$FAILS"; exit 1; fi
echo "E2E PASS: planner done, 3/3 reviewed and merged, integration suite green, checkpoints pushed and cleaned up, no VMs left"
