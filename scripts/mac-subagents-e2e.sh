#!/usr/bin/env bash
# ADR-017 live e2e: a planner agent (claude, children.allowSpawn, depth 1, 3 children) splits a
# 3-file goal into child agents (mix of claude + codex) from inside its VM with in-VM capcomd,
# verifies and merges each child's branch, and reports. Prints the tree, rollups and timings.
# The GitHub repo is NOT deleted (inspect it; the delete command is printed at the end).
# Needs: bun, gh (logged in), BOXD_API_KEY, working claude + codex logins (capcomd auth status).
# Override profiles with CAPCOMD_PLANNER_SPEC / CAPCOMD_CLAUDE_WORKER_SPEC / CAPCOMD_CODEX_WORKER_SPEC (JSON).
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
export BOXD_NO_UPDATE_NOTICE=1
TS="$(date +%s)"
REPO="$OWNER/capcomd-subagents-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-subagents.XXXXXX")"
T0=$(date +%s)
die() { echo "mac-subagents-e2e: $*" >&2; echo "artifacts: $WORK"; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
command -v bun >/dev/null || die "bun not on PATH"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -d node_modules ] || bun install
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

# Profiles: the planner may spawn exactly these two worker profiles, 3 at a time, one level deep.
AGENTS="$WORK/agents.json"
DEF_P='{"provider":"claude","auth":"subscription","maxTurns":60,"timeoutMs":2400000,"children":{"allowSpawn":true,"maxDepth":1,"maxChildren":3,"maxTotalDescendants":6,"allowedChildProfiles":["claude-worker","codex-worker"],"budgetShare":0.34}}'
DEF_C='{"provider":"claude","auth":"subscription","maxTurns":25,"timeoutMs":900000}'
DEF_X='{"provider":"codex","auth":"subscription","maxTurns":25,"timeoutMs":900000}'
P="${CAPCOMD_PLANNER_SPEC:-$DEF_P}"; C="${CAPCOMD_CLAUDE_WORKER_SPEC:-$DEF_C}"; X="${CAPCOMD_CODEX_WORKER_SPEC:-$DEF_X}"
printf '{"schema":"capcomd.agents/v1","agents":{"planner":%s,"claude-worker":%s,"codex-worker":%s}}\n' "$P" "$C" "$X" > "$AGENTS"
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

echo "== 0. preflight (credentials checked, never printed)"
for a in planner claude-worker codex-worker; do CAPCOMD_AGENT=$a bun scripts/preflight.ts >/dev/null || die "preflight failed for $a (capcomd auth status)"; done

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
bun src/cli/index.ts serve --port "$PORT" > "$WORK/engine.log" 2>&1 &
ENGINE_PID=$!
cleanup() { pkill -P "$ENGINE_PID" 2>/dev/null || true; kill "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT
bun tests/chaos/ready-probe.ts "$PORT" >/dev/null 2>"$WORK/ready.err" || die "engine not ready: $(tail -1 "$WORK/ready.err")"
kill -0 "$ENGINE_PID" 2>/dev/null || die "engine exited: $(tail -3 "$WORK/engine.log")"

C="bun src/cli/index.ts"
RUN=$($C run new --budget usd=6,turns=200,wallSeconds=3600 --label "subagents e2e $TS" --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).runId)')
GOAL="Three functions are broken, each with its own failing test: src/add.ts (test/add.test.ts), src/mul.ts (test/mul.test.ts), src/shout.ts (test/shout.test.ts).
You are the planner. Do NOT edit files yourself. Use the capcomd command (see the orchestration skill in your instructions):
1. Spawn exactly three leaf children in parallel, one per file, each with --children.maxChildren=0 and a budget of turns=20:
   add and mul with --profile claude-worker, shout with --profile codex-worker. Give each a self-contained task naming its file and test, and tell it to change only that file.
2. capcomd await all three. For each child: capcomd verify --ref <agt>; if it passes, capcomd merge --ref <agt> --require <vfyId>.
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
kill "$WATCH" 2>/dev/null || true
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
echo "== 8. VM cleanup"
bun scripts/vm-cleanup-check.ts "$RUN" || true
echo
echo "timings: total $(( $(date +%s) - T0 ))s, planner run ${T_RUN}s"
echo "artifacts: $WORK   (engine log, traces, await.json, budget.json, agents.json)"
echo "repo kept: https://github.com/$REPO   delete when done: gh repo delete $REPO --yes"
exit "$RC"
