#!/usr/bin/env bash
# ADR-018 live e2e: the user's own agent drives a swarm through the capcomd plugin. A headless Claude Code session
# (`claude -p`) loads plugins/capcomd and may use only the plugin's MCP tools and its skills: no shell, no edits.
# It gets a goal in plain words and has to run the swarm itself: a run, three workers in boxd VMs (two Claude, one
# Codex), each verified (its check in a checks VM, then a reviewer agent) and merged into `integration`.
# Same fixture as scripts/mac-subagents-e2e.sh: a private repo with three broken functions, one test each.
# Needs: bun, gh (logged in), claude (logged in), BOXD_API_KEY, working claude + codex agent logins.
# The GitHub repo is kept (the delete command is printed). Ends with `E2E PASS` or `E2E FAIL: <reasons>`.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$(pwd)
OWNER="${CAPCOMD_E2E_OWNER:-MarvinAmador7}"
export BOXD_NO_UPDATE_NOTICE=1
TS="$(date +%s)"
REPO="$OWNER/capcomd-plugin-$TS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-plugin.XXXXXX")"
T0=$(date +%s)
die() { echo "mac-plugin-e2e: $*" >&2; echo "artifacts: $WORK"; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
for c in bun gh claude; do command -v $c >/dev/null || die "$c not on PATH"; done
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
claude plugin validate --strict plugins/capcomd >/dev/null || die "the plugin doesn't validate"
[ -d node_modules ] || bun install
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0='!gh auth git-credential'

# Worker and reviewer profiles (no planner: the orchestrator is the Claude Code session).
AGENTS="$WORK/agents.json"
C='{"provider":"claude","auth":"subscription","maxTurns":25,"timeoutMs":900000}'
X='{"provider":"codex","auth":"subscription","maxTurns":25,"timeoutMs":900000}'
R='{"provider":"claude","auth":"subscription","maxTurns":15,"timeoutMs":600000,"allowedTools":["Read","Glob","Grep","LS","Bash(git diff:*)","Bash(git log:*)","Bash(git show:*)","Bash(bun test:*)","Bash(cat:*)","Bash(ls:*)"]}'
printf '{"schema":"capcomd.agents/v1","agents":{"claude-worker":%s,"codex-worker":%s,"reviewer":%s}}\n' "$C" "$X" "$R" > "$AGENTS"
export CAPCOMD_AGENTS_FILE="$AGENTS"
export CAPCOMD_SANDBOX=boxd
export CAPCOMD_REPO="https://github.com/$REPO.git" CAPCOMD_GITHUB_REPO="$REPO"
export CAPCOMD_MERGE_MODE=pr CAPCOMD_MERGE_STRATEGY=squash CAPCOMD_MERGE_TARGET=integration CAPCOMD_TEST_COMMAND="bun test"
export CAPCOMD_WORKDIR="$WORK/merge" CAPCOMD_TRACE_DIR="$WORK/traces" CAPCOMD_RPC_KEY_FILE="$WORK/rpc.key"
PORT=$(bun -e 'const { testPort } = await import("./tests/helpers/engine.ts"); console.log(await testPort())') || die "no free engine port"
export CAPCOMD_ENDPOINT="http://127.0.0.1:$PORT"

echo "== 0. env snapshot, doctor, preflight"
env -u CAPCOMD_REPO bun src/cli/index.ts env build || die "capcomd env build failed"
bun src/cli/index.ts doctor --strict || die "doctor reported a failure"
for a in claude-worker codex-worker reviewer; do CAPCOMD_AGENT=$a bun scripts/preflight.ts >/dev/null || die "preflight failed for $a"; done

echo "== 1. private repo $REPO (3 broken files, one test each), and its capcomd project config"
SRC="$WORK/project"; mkdir -p "$SRC/src" "$SRC/test" "$SRC/.capcomd"
echo '{ "name": "capcomd-plugin-e2e", "private": true, "type": "module", "scripts": { "test": "bun test" } }' > "$SRC/package.json"
printf 'export function add(a: number, b: number): number {\n  return a - b;\n}\n' > "$SRC/src/add.ts"
printf 'export function mul(a: number, b: number): number {\n  return a + b;\n}\n' > "$SRC/src/mul.ts"
printf 'export function shout(s: string): string {\n  return s.toLowerCase();\n}\n' > "$SRC/src/shout.ts"
printf 'import { test, expect } from "bun:test";\nimport { add } from "../src/add";\ntest("add", () => expect(add(2, 3)).toBe(5));\n' > "$SRC/test/add.test.ts"
printf 'import { test, expect } from "bun:test";\nimport { mul } from "../src/mul";\ntest("mul", () => expect(mul(2, 3)).toBe(6));\n' > "$SRC/test/mul.test.ts"
printf 'import { test, expect } from "bun:test";\nimport { shout } from "../src/shout";\ntest("shout", () => expect(shout("hi")).toBe("HI!"));\n' > "$SRC/test/shout.test.ts"
# The gates, as `capcomd setup project` would write them: one check per file (the others stay broken until their
# branches land), the reviewer, the target. The driver picks check names; it can't change these.
cat > "$SRC/.capcomd/config.json" <<EOF
{ "run": { "checks": { "add": "bun test ./test/add.test.ts", "mul": "bun test ./test/mul.test.ts", "shout": "bun test ./test/shout.test.ts" },
           "reviewer": "reviewer", "target": "integration" },
  "driver": { "maxRunBudget": "usd=8" } }
EOF
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

# The plugin's launcher runs the installed `capcomd`: here, this checkout.
BIN="$WORK/bin"; mkdir -p "$BIN"; ln -s "$ROOT_DIR/src/cli/index.ts" "$BIN/capcomd"
LABEL="plugin e2e $TS"
GOAL="Use capcomd to fix the three failing tests in this repository: src/add.ts (test/add.test.ts), src/mul.ts (test/mul.test.ts) and src/shout.ts (test/shout.test.ts).
Start a run labeled \"$LABEL\" with a budget of usd=6,turns=200,wallSeconds=3600. One worker per file, in parallel: add and mul with the claude-worker profile, shout with codex-worker, each with budget turns=20 and pinned to the check named after its file. Give each a self-contained task that names its file and test and says to change only that file.
Verify each finished worker (the run's reviewer reads it too) and merge it when verification passes. If a worker or its verification fails, spawn one replacement with the failure in its task. Waits are bounded: keep calling until done (use timeoutMs 55000).
End with one line per file: worker id, profile, verified, merged."

echo "== 3. Claude Code with only the capcomd plugin's tools (run label: $LABEL)"
T_RUN0=$(date +%s)
set +e
( cd "$SRC" && PATH="$BIN:$PATH" claude -p "$GOAL" --plugin-dir "$ROOT_DIR/plugins/capcomd" \
    --tools Skill --allowedTools 'mcp__plugin_capcomd_capcomd__*' --permission-mode dontAsk \
    --max-turns 250 --output-format stream-json --verbose ) > "$WORK/session.ndjson" 2> "$WORK/session.err"
CRC=$?
set -e
T_RUN=$(( $(date +%s) - T_RUN0 ))
RUN=$(bun -e 'const fs=require("fs"); const p=".relay/runs.jsonl"; const l=process.argv[1]; const rows=fs.existsSync(p)?fs.readFileSync(p,"utf8").trim().split("\n").map(x=>{try{return JSON.parse(x)}catch{return {}}}):[]; console.log(rows.reverse().find(r=>r.label===l)?.runId ?? "")' "$LABEL")
echo "   session exit $CRC after ${T_RUN}s; run ${RUN:-none}"

echo "== 4. what the session used"
SESSION="$WORK/session.ndjson" bun -e '
  const lines = require("fs").readFileSync(process.env.SESSION, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  const uses = lines.flatMap((m) => (m.message?.content ?? []).filter((c) => c.type === "tool_use").map((c) => c.name));
  const counts = {}; for (const u of uses) counts[u] = (counts[u] ?? 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);
  const other = uses.filter((u) => !u.startsWith("mcp__plugin_capcomd_capcomd__") && u !== "Skill");
  const res = lines.find((m) => m.type === "result");
  console.log(`   other tools: ${other.length ? [...new Set(other)].join(", ") : "none"}`);
  console.log(`   turns ${res?.num_turns ?? "?"}, cost $${(res?.total_cost_usd ?? 0).toFixed(2)} (API-equivalent)`);
  console.log("   final message:"); console.log(String(res?.result ?? "(none)").split("\n").map((l) => "   | " + l).join("\n"));
  require("fs").writeFileSync(process.env.SESSION + ".other", String(other.length));
'
OTHER=$(cat "$WORK/session.ndjson.other" 2>/dev/null || echo "?")

C="bun src/cli/index.ts"
if [ -n "$RUN" ]; then
  echo "== 5. tree"
  $C tree "$RUN" || true
fi
echo "== 6. merged PRs into integration"
gh pr list -R "$REPO" --state all --json number,title,state,url -q '.[] | "   #\(.number) \(.state) \(.title) \(.url)"'
MERGED=$(gh pr list -R "$REPO" --state merged --base integration --json number -q 'length' 2>/dev/null || echo 0)
echo "== 7. integration suite"
FINAL="$WORK/final"
if git clone -q --branch integration "https://github.com/$REPO.git" "$FINAL" 2>/dev/null && (cd "$FINAL" && bun test >"$WORK/final-test.log" 2>&1); then SUITE=pass; else SUITE=fail; fi
sed 's/^/   /' "$WORK/final-test.log" 2>/dev/null | grep -E '(pass|fail)$|^ *\(fail\)' | head -10 || true
echo "== 8. VM cleanup"
if [ -n "$RUN" ]; then bun scripts/vm-cleanup-check.ts "$RUN" && VMS=clean || { [ $? = 1 ] && VMS=leaked || VMS=unchecked; }; else VMS=unchecked; fi
REVIEWERS=0
[ -n "$RUN" ] && REVIEWERS=$($C tree "$RUN" --json 2>/dev/null | bun -e 'const walk=(n)=>[n,...(n.children??[]).flatMap(walk)]; try { const t=JSON.parse(await Bun.stdin.text()); console.log(t.tree.flatMap(walk).filter((n)=>n.profile==="reviewer"&&n.status==="done").length) } catch { console.log(0) }')
echo "   reviewers done: $REVIEWERS"
echo
echo "timings: total $(( $(date +%s) - T0 ))s, session ${T_RUN}s"
echo "artifacts: $WORK   (session.ndjson, engine log, traces, final-test.log)"
echo "repo kept: https://github.com/$REPO   delete when done: gh repo delete $REPO --yes"
FAILS=""
[ "$CRC" = 0 ] || FAILS="$FAILS session-exit=$CRC"
[ -n "$RUN" ] || FAILS="$FAILS no-run"
[ "$OTHER" = 0 ] || FAILS="$FAILS non-plugin-tools=$OTHER"
[ "$MERGED" = 3 ] || FAILS="$FAILS merged=$MERGED/3"
[ "$REVIEWERS" -ge 3 ] || FAILS="$FAILS reviewers=$REVIEWERS/3"
[ "$SUITE" = pass ] || FAILS="$FAILS integration-suite=fail"
[ "$VMS" = clean ] || FAILS="$FAILS vms=$VMS"
if [ -n "$FAILS" ]; then echo "E2E FAIL:$FAILS"; exit 1; fi
echo "E2E PASS: Claude Code drove the swarm with only the plugin's tools; 3/3 reviewed and merged, suite green, no VMs left"
