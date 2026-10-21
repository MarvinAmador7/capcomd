#!/usr/bin/env bash
# Install a packed capcomd (`bun pm pack`) the way a user would, into a throwaway Bun prefix with a fresh HOME, and
# drive the installed CLI: version, the setup demo, a run on its own engine with fake agents, setup check, the
# service definition, and where state lands (only ~/.capcomd, never inside the installed package).
#   scripts/release-smoke.sh capcomd-0.3.0.tgz [expected-version]
# Ends with `SMOKE PASS` (exit 0) or `SMOKE FAIL: <reasons>` (exit 1). Needs no accounts.
set -u
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); WANT=${2:-}
W=$(mktemp -d); export HOME=$W/home BUN_INSTALL=$W/bun; mkdir -p "$HOME"; cd "$W"
export PATH=$BUN_INSTALL/bin:$PATH
FAILS=(); fail() { FAILS+=("$1"); echo "  ✗ $1"; }; pass() { echo "  ✓ $1"; }
jget() { bun -e "const t=await Bun.stdin.text(); let j; try { j=JSON.parse(t) } catch { process.exit(0) } const v=($1); console.log(typeof v==='object'?JSON.stringify(v):(v ?? ''))"; }
ENGINE=""; cleanup() { [ -n "$ENGINE" ] && { pkill -P "$ENGINE" 2>/dev/null; kill "$ENGINE" 2>/dev/null; }; true; }
# Anything still running from the throwaway install (an engine, a driver) goes too.
reap_all() { cleanup; for _ in 1 2 3 4 5; do pgrep -f "$W/" >/dev/null || return 0; pkill -f "$W/"; sleep 1; done; pkill -9 -f "$W/"; true; }; trap reap_all EXIT

echo "== install $(basename "$TGZ") (HOME and BUN_INSTALL under $W)"
if bun add -g "$TGZ" > "$W/install.log" 2>&1; then pass "bun add -g"; else fail "install failed: $(tail -3 "$W/install.log" | tr '\n' ' ')"; fi
C=$(command -v capcomd || true)
case "$C" in "$BUN_INSTALL"/*) pass "capcomd on PATH from the fresh prefix" ;; *) fail "capcomd not installed in the fresh prefix (found: ${C:-nothing})" ;; esac
[ ${#FAILS[@]} -eq 0 ] || { echo "SMOKE FAIL: ${FAILS[*]}"; exit 1; }

V=$(capcomd --version --json | jget 'j.version')
if [ -z "$WANT" ] || [ "$V" = "$WANT" ]; then pass "version $V"; else fail "version $V, expected $WANT"; fi
capcomd --help 2>&1 | grep -q "capcomd setup" && pass "help lists setup" || fail "help doesn't list setup"

echo "== setup demo (a private engine, three fake agents)"
D=$(capcomd setup demo --json 2>"$W/demo.err")
[ "$(echo "$D" | jget 'j.ok')" = "true" ] && pass "$(echo "$D" | jget 'j.steps[0].detail')" || fail "setup demo: ${D:-$(tail -3 "$W/demo.err")}"

echo "== a run on the installed engine (fake agents)"
P=$(( 20000 + RANDOM % 20000 )); export CAPCOMD_ENDPOINT=http://127.0.0.1:$P CAPCOMD_SANDBOX=fake CAPCOMD_SPAWN_EXEC=fake CAPCOMD_SKIP_PREFLIGHT=1
capcomd serve --port $P > "$W/serve.log" 2>&1 & ENGINE=$!
R=""; for i in $(seq 1 90); do R=$(capcomd run new --budget usd=1 --json 2>/dev/null | jget 'j.runId'); [ -n "$R" ] && break; sleep 1; done
if [ -n "$R" ]; then pass "run new $R (engine up after ${i}s)"; else fail "engine didn't come up: $(tail -5 "$W/serve.log" | tr '\n' ' ')"; fi
if [ -n "$R" ]; then
  A=$(capcomd spawn "$R" --task "hello" --key a --budget usd=0.5 --json | jget 'j.agentId')
  S=$(capcomd await "$R" "$A" --timeout-ms 90000 --json | jget 'j.agents?.[0]?.status')
  [ "$S" = "done" ] && pass "spawn + await: $A $S" || fail "agent $A ended '$S'"
  N=$(capcomd trace "$R" --json | jget 'j.trace?.spanCount')
  [ "${N:-0}" -gt 0 ] 2>/dev/null && pass "trace: $N spans" || fail "trace has no spans"
fi
cleanup; ENGINE=""

echo "== setup check, service definition"
K=$(capcomd setup check --json 2>/dev/null | jget 'j.steps.length')
[ "${K:-0}" -gt 0 ] 2>/dev/null && pass "setup check reports $K items" || fail "setup check gave no report"
SV=$(capcomd service install --dry-run --json | jget 'j.dryRun && j.body.includes("serve") ? j.path : ""')
[ -n "$SV" ] && pass "service install --dry-run: ${SV#$HOME/}" || fail "service install --dry-run gave no definition"
capcomd service status --json | jget 'j.installed' | grep -q false && pass "service status: not installed" || fail "service status"

echo "== where state went"
[ -d "$HOME/.capcomd/state" ] && pass "state in ~/.capcomd ($(cd "$HOME/.capcomd" && ls | tr '\n' ' '))" || fail "no ~/.capcomd/state"
LEAK=$(find "$BUN_INSTALL" \( -name .relay -o -name .traces \) -path '*capcomd*' 2>/dev/null | head -3)
[ -z "$LEAK" ] && pass "nothing written inside the installed package" || fail "state inside the package: $LEAK"

if [ ${#FAILS[@]} -eq 0 ]; then echo "SMOKE PASS"; reap_all; rm -rf "$W"; else echo "SMOKE FAIL: ${FAILS[*]} (logs in $W)"; exit 1; fi
