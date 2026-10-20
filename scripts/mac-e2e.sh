#!/usr/bin/env bash
# Real end-to-end: GitHub repo → capcomd run (boxd VM + Claude Code, PR mode) → merged PR.
# Needs: bun, gh (logged in as MarvinAmador7), BOXD_API_KEY and ANTHROPIC_API_KEY in env.
# Secrets are read from env only and never echoed (no `set -x`).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
PORT="${CAPCOMD_E2E_PORT:-6420}"
TS="$(date +%s)"
REPO="$OWNER/capcomd-e2e-$TS"
RUN_ID="run-e2e-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-e2e.XXXXXX")"
LOG="$WORK/capcomd-run.ndjson"

die() { echo "mac-e2e: $*" >&2; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
[ -n "${ANTHROPIC_API_KEY:-}" ] || die "ANTHROPIC_API_KEY is not set"
command -v bun >/dev/null || die "bun not on PATH (try: export PATH=\$HOME/.bun/bin:\$PATH)"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -d node_modules ] || bun install

# git over https uses gh's credentials for this script only (no global git config change).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

export CAPCOMD_SANDBOX=boxd
export CAPCOMD_AGENT=claude-code
export CAPCOMD_REPO="https://github.com/$REPO.git"
export CAPCOMD_GITHUB_REPO="$REPO"
export CAPCOMD_MERGE_MODE=pr
export CAPCOMD_MERGE_STRATEGY=squash
export CAPCOMD_MERGE_TARGET=main
export CAPCOMD_TEST_COMMAND="bun test"
export CAPCOMD_WORKDIR="$WORK/merge"
export CAPCOMD_ENDPOINT="http://127.0.0.1:$PORT"
export CAPCOMD_TRACE_DIR="$WORK/traces"
export CAPCOMD_AGENT_MAX_TURNS="${CAPCOMD_AGENT_MAX_TURNS:-20}"
export CAPCOMD_AGENT_MAX_BUDGET_USD="${CAPCOMD_AGENT_MAX_BUDGET_USD:-1}"

echo "== 0. preflight (credentials are checked, never printed)"
bun scripts/preflight.ts || die "preflight failed; nothing was created"

echo "== 1. throwaway private repo $REPO"
SRC="$WORK/src"; mkdir -p "$SRC/src" "$SRC/test"
cat > "$SRC/package.json" <<'JSON'
{ "name": "capcomd-e2e", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
JSON
cat > "$SRC/src/sum.ts" <<'TS'
export function sum(a: number, b: number): number {
  return a - b;
}
TS
cat > "$SRC/test/sum.test.ts" <<'TS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.ts";

test("sum adds two numbers", () => {
  assert.equal(sum(2, 3), 5);
});
TS
printf '# capcomd e2e\n\n`npm test` (node >= 22.18) or `bun test`.\n' > "$SRC/README.md"
git -C "$SRC" init -q -b main
git -C "$SRC" add -A
git -C "$SRC" -c user.name=capcomd -c user.email=capcomd@users.noreply.github.com commit -q -m "tiny TS project with one failing test"
# Create empty, then push over https with gh's credential helper (never ssh: no host-key prompt).
gh repo create "$REPO" --private >/dev/null
git -C "$SRC" remote add origin "https://github.com/$REPO.git"
git -C "$SRC" push -q -u origin main
echo "   https://github.com/$REPO"
(cd "$SRC" && bun test >/dev/null 2>&1) && die "fixture test unexpectedly passes" || echo "   fixture test fails as intended"

echo "== 2. engine on :$PORT"
curl -s -m 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && die "port $PORT is busy; stop the old engine or set CAPCOMD_E2E_PORT"
bun src/cli/index.ts serve --port "$PORT" > "$WORK/engine.log" 2>&1 &
ENGINE_PID=$!
cleanup() { [ -n "${RUN_PID:-}" ] && kill "$RUN_PID" 2>/dev/null; pkill -P "$ENGINE_PID" 2>/dev/null || true; kill "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT
bun tests/chaos/ready-probe.ts "$PORT" >/dev/null || die "engine not ready (see $WORK/engine.log)"

echo "== 3. capcomd run 'make the failing test pass' (run $RUN_ID)"
# main counts as protected: the task parks in awaiting_approval after verification.
# Approve exactly once, only when status says task-1 is awaiting approval; stop when the run exits.
bun src/cli/index.ts run --json --run-id "$RUN_ID" 'make the failing test pass' > "$LOG" 2> "$WORK/run.err" &
RUN_PID=$!
APPROVED=0
while kill -0 "$RUN_PID" 2>/dev/null; do
  sleep 5
  [ "$APPROVED" = 1 ] && continue
  if bun src/cli/index.ts status "$RUN_ID" --json 2>/dev/null | grep -q '"awaitingApproval":\[[^]]*"task-1"'; then
    bun src/cli/index.ts approve "$RUN_ID" task-1 --json >/dev/null 2>&1 && { APPROVED=1; echo "   approved task-1"; }
  fi
done
set +e
wait "$RUN_PID"
RC=$?
set -e
grep -o '"type":"[a-z_.]*"' "$LOG" | cut -d'"' -f4 | uniq | tr '\n' ' '; echo
[ "$RC" = 0 ] || { tail -5 "$WORK/run.err" >&2; echo "run failed (exit $RC); log $LOG" >&2; }

echo "== 4. result"
gh pr list -R "$REPO" --state all --json number,url,state,mergeCommit \
  -q '.[] | "   PR #\(.number) \(.state) \(.url)\n   merged sha: \(.mergeCommit.oid // "-")"'
echo "   main: $(gh api "repos/$REPO/commits/main" -q .sha)"

echo "== 5. trace summary"
bun src/cli/index.ts trace "$RUN_ID" 2>/dev/null | head -60 || true
TRACE_FILE="$CAPCOMD_TRACE_DIR/$RUN_ID.ndjson" bun -e '
  const fs = require("fs"); const p = process.env.TRACE_FILE;
  const spans = fs.readFileSync(p, "utf8").trim().split("\n").map(JSON.parse);
  const a = spans.find((s) => s.name === "agent.claude_code");
  if (a) console.log(`   agent: ${a.attributes["agent.stop_reason"]} turns=${a.attributes["agent.turns"]} cost=$${a.attributes["agent.cost_usd"]} events=${a.events.length} sha=${a.attributes["git.sha"]}`);
  const tools = {}; for (const e of a?.events ?? []) if (e.attributes?.["agent.tool"]) tools[e.attributes["agent.tool"]] = (tools[e.attributes["agent.tool"]] ?? 0) + 1;
  console.log(`   tools: ${JSON.stringify(tools)}`);
  const leak = fs.readFileSync(p, "utf8").includes(process.env.ANTHROPIC_API_KEY);
  console.log(`   api key in trace: ${leak ? "YES (BUG)" : "no"}`);
'  || true

echo "== 6. VM cleanup check"
bun scripts/vm-cleanup-check.ts "$RUN_ID" || true

echo
echo "artifacts: $WORK   (run log, engine log, traces)"
echo "delete the repo when done: gh repo delete $REPO --yes   (needs: gh auth refresh -h github.com -s delete_repo)"
exit "$RC"
