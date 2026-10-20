#!/usr/bin/env bash
# Real end-to-end: GitHub repo → capcomd run (boxd VM + agent, PR mode) → merged PR.
# CAPCOMD_AGENT = an agent profile name (capcomd agents list) or claude-code (default) | codex.
# CAPCOMD_ENV=image forces the default boxd image; otherwise workers boot from the env snapshot,
# or from the auth profile snapshot for subscription logins.
# Needs: bun, gh (logged in as MarvinAmador7), BOXD_API_KEY. API keys only for auth=apikey agents.
# Secrets are read from env only and never echoed (no `set -x`).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
PORT="${CAPCOMD_E2E_PORT:-6420}"
TS="$(date +%s)"
AGENT="${CAPCOMD_AGENT:-claude-code}"
AUTH="${CAPCOMD_AUTH:-}"
case "$AGENT" in
  claude-code|codex) PROVIDER="$AGENT";;
  *) SPEC=$(bun src/cli/index.ts agents show "$AGENT" --json 2>/dev/null) || { echo "mac-e2e: unknown agent profile $AGENT (capcomd agents list)" >&2; exit 2; }
     PROVIDER=$(printf '%s' "$SPEC" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(j.spec.provider==="codex"?"codex":"claude-code")')
     AUTH=$(printf '%s' "$SPEC" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(j.spec.auth)');;
esac
case "$PROVIDER" in claude-code) KEYVAR=ANTHROPIC_API_KEY; SPAN=agent.claude_code;; *) KEYVAR=OPENAI_API_KEY; SPAN=agent.codex;; esac
SUFFIX=""; [ "$PROVIDER" = codex ] && SUFFIX="-codex"
REPO="$OWNER/capcomd-e2e$SUFFIX-$TS"
RUN_ID="run-e2e-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-e2e.XXXXXX")"
LOG="$WORK/capcomd-run.ndjson"

die() { echo "mac-e2e: $*" >&2; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
if [ "$AUTH" = apikey ] && [ "${CAPCOMD_CREDENTIALS:-auto}" != secret ]; then [ -n "${!KEYVAR:-}" ] || die "$KEYVAR is not set (agent $AGENT uses auth=apikey)"; fi
# (subscription / inferred auth is checked by preflight below: exactly one credential per agent.)
command -v bun >/dev/null || die "bun not on PATH (try: export PATH=\$HOME/.bun/bin:\$PATH)"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -d node_modules ] || bun install

# git over https uses gh's credentials for this script only (no global git config change).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

export CAPCOMD_SANDBOX=boxd
export CAPCOMD_AGENT="$AGENT"
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

echo "   agent: $AGENT   env: $(bun src/cli/index.ts env status 2>/dev/null | tail -1 | sed 's/^workers use: //' || echo '?')${CAPCOMD_ENV:+ (CAPCOMD_ENV=$CAPCOMD_ENV)}"

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
T_RUN0=$(date +%s)
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
T_RUN=$(( $(date +%s) - T_RUN0 ))
grep -o '"type":"[a-z_.]*"' "$LOG" | cut -d'"' -f4 | uniq | tr '\n' ' '; echo
[ "$RC" = 0 ] || { tail -5 "$WORK/run.err" >&2; echo "run failed (exit $RC); log $LOG" >&2; }

echo "== 4. result"
gh pr list -R "$REPO" --state all --json number,url,state,mergeCommit \
  -q '.[] | "   PR #\(.number) \(.state) \(.url)\n   merged sha: \(.mergeCommit.oid // "-")"'
echo "   main: $(gh api "repos/$REPO/commits/main" -q .sha)"

echo "== 5. trace summary"
bun src/cli/index.ts trace "$RUN_ID" 2>/dev/null | head -60 || true
TRACE_FILE="$CAPCOMD_TRACE_DIR/$RUN_ID.ndjson" SPAN="$SPAN" KEYVAR="$KEYVAR" T_RUN="$T_RUN" AGENT="$AGENT" RC="$RC" bun -e '
  const fs = require("fs"); const p = process.env.TRACE_FILE;
  const text = fs.readFileSync(p, "utf8");
  const spans = text.trim().split("\n").map(JSON.parse);
  const a = spans.find((s) => s.name === process.env.SPAN);
  const d = (s) => (s && s.endTime ? s.endTime - s.startTime : 0);
  const sum = (re) => spans.filter((s) => re.test(s.name)).reduce((n, s) => n + d(s), 0);
  if (a) console.log(`   agent: profile=${a.attributes["agent.profile"] || "-"} billing=${a.attributes["agent.billing"]} ${a.attributes["agent.stop_reason"]} turns=${a.attributes["agent.turns"]} cost=$${a.attributes["agent.cost_usd"]} version=${a.attributes["agent.version"]} credential=${a.attributes["agent.credential_mode"]} deps_reused=${a.attributes["agent.deps_reused"]} events=${a.events.length} sha=${a.attributes["git.sha"]}`);
  const tools = {}; for (const e of a?.events ?? []) if (e.attributes?.["agent.tool"]) tools[e.attributes["agent.tool"]] = (tools[e.attributes["agent.tool"]] ?? 0) + 1;
  console.log(`   tools: ${JSON.stringify(tools)}`);
  const key = process.env[process.env.KEYVAR];
  console.log(`   api key in trace: ${key && text.includes(key) ? "YES (BUG)" : "no"}`);
  const install = spans.find((s) => s.name === "agent.install");
  const t = { agent: process.env.AGENT, billing: a?.attributes["agent.billing"] ?? null, rc: Number(process.env.RC), run_s: Number(process.env.T_RUN),
    vm_boot_ms: sum(/^sandbox\.(ensure|waitReady)$/), install_ms: d(install), installed: !!install,
    agent_ms: d(a), cost_usd: a?.attributes["agent.cost_usd"] ?? null, turns: a?.attributes["agent.turns"] ?? null,
    credential: a?.attributes["agent.credential_mode"] ?? null };
  console.log("CAPCOMD_TIMING " + JSON.stringify(t));
'  || true

echo "== 6. VM cleanup check"
bun scripts/vm-cleanup-check.ts "$RUN_ID" || true

echo
echo "artifacts: $WORK   (run log, engine log, traces)"
echo "delete the repo when done: gh repo delete $REPO --yes   (needs: gh auth refresh -h github.com -s delete_repo)"
exit "$RC"
