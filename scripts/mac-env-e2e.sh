#!/usr/bin/env bash
# Live e2e on the Mac with NO inference API keys: workers use Claude Code / Codex logged in with
# Marvin's subscriptions. Steps: validate → env build (no VM if up to date) → auth login if missing
# (interactive: open the printed URL / enter the code) → auth status → doctor → mac-e2e with a
# claude and a codex subscription profile → timing table.
# Needs only BOXD_API_KEY (+ bun, gh logged in). ANTHROPIC_API_KEY / OPENAI_API_KEY are unset here.
#   CAPCOMD_ENV_E2E_AGENTS  providers to run (default "claude codex")
#   CAPCOMD_E2E_CODEX_SANDBOX codex --sandbox for the e2e profile (default workspace-write)
# Each run creates one private GitHub repo (like mac-e2e.sh); delete them afterwards (printed).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
die() { echo "mac-env-e2e: $*" >&2; exit 1; }
ms() { bun -e 'console.log(Date.now())'; }

echo "######## 0. validate (before any VM boots)"
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
command -v bun >/dev/null || die "bun not on PATH"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY CAPCOMD_CREDENTIALS CAPCOMD_AUTH CAPCOMD_AGENT; do
  [ -n "${!k:-}" ] && echo "   unsetting $k for this run (subscription-only)"; unset "$k"
done
[ -d node_modules ] || bun install
export CAPCOMD_SANDBOX=boxd
CAPCOMD_AGENT=fake bun scripts/preflight.ts >/dev/null || die "BOXD_API_KEY rejected by boxd"
echo "   ok: BOXD_API_KEY accepted, gh logged in, no inference API keys in env"
PROVIDERS="${CAPCOMD_ENV_E2E_AGENTS:-claude codex}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-env-e2e.XXXXXX")"
TIMINGS="$OUT/timings.ndjson"; : > "$TIMINGS"
STEPS="$OUT/steps.ndjson"; : > "$STEPS"
step() { echo "{\"step\":\"$1\",\"ms\":$2}" >> "$STEPS"; }

echo "######## 1. capcomd env build (skips the VM when the snapshot is up to date)"
t=$(ms); bun src/cli/index.ts env build; step env_build $(( $(ms) - t ))

echo "######## 2. agent profiles (subscription auth only)"
export CAPCOMD_AGENTS_FILE="$OUT/agents.json"
bun src/cli/index.ts agents add e2e-claude --provider claude --auth subscription --max-turns 20 --description "mac-env-e2e claude (plan login)" >/dev/null
bun src/cli/index.ts agents add e2e-codex --provider codex --auth subscription --max-turns 20 --sandbox "${CAPCOMD_E2E_CODEX_SANDBOX:-workspace-write}" --description "mac-env-e2e codex (plan login)" >/dev/null
bun src/cli/index.ts agents list

echo "######## 3. auth login where missing, then verify"
for p in $PROVIDERS; do
  if bun src/cli/index.ts auth status "$p" --quick --json 2>/dev/null | grep -q '"present":true'; then
    echo "   $p: profile present"
  else
    echo "   $p: no login yet → interactive login (open the URL; tokens are never printed)"
    t=$(ms); bun src/cli/index.ts auth login "$p" || die "auth login $p failed"; step "login_$p" $(( $(ms) - t ))
  fi
done
t=$(ms); bun src/cli/index.ts auth status || die "a saved login is invalid: rerun capcomd auth login <agent>"; step auth_status $(( $(ms) - t ))

echo "######## 4. capcomd doctor"
t=$(ms); bun src/cli/index.ts doctor || echo "   (doctor reported failures; continuing so the runs show where)"; step doctor $(( $(ms) - t ))

echo "######## 5. mac-e2e from the auth snapshots"
for p in $PROVIDERS; do
  log="$OUT/e2e-$p.log"
  set +e; CAPCOMD_AGENT="e2e-$p" bash scripts/mac-e2e.sh 2>&1 | tee "$log"; set -e
  grep '^CAPCOMD_TIMING ' "$log" | sed 's/^CAPCOMD_TIMING //' >> "$TIMINGS" || echo "{\"agent\":\"e2e-$p\",\"rc\":-1}" >> "$TIMINGS"
done

echo
echo "######## timings"
TIMINGS="$TIMINGS" STEPS="$STEPS" bun -e '
  const fs = require("fs"); const rd = (p) => fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const s = (ms) => (ms ? (ms / 1000).toFixed(1) + "s" : "-");
  for (const x of rd(process.env.STEPS)) console.log(`${x.step.padEnd(14)} ${s(x.ms)}`);
  console.log("\nagent        rc  run     vm-boot  install  agent    turns  billing");
  const rows = rd(process.env.TIMINGS);
  for (const r of rows) console.log(`${String(r.agent).padEnd(12)} ${String(r.rc).padEnd(3)} ${(r.run_s ? r.run_s + "s" : "-").padEnd(7)} ${s(r.vm_boot_ms).padEnd(8)} ${(r.installed ? s(r.install_ms) : "skipped").padEnd(8)} ${s(r.agent_ms).padEnd(8)} ${String(r.turns ?? "-").padEnd(6)} ${r.billing ?? "-"}`);
  console.log("\nreference: first e2e (API key, fresh image, claude) = 51s total, 9 turns");
  const bad = rows.filter((r) => r.rc !== 0); if (bad.length) { console.log("FAILED: " + bad.map((r) => r.agent).join(", ")); process.exit(1); }
'
echo "logs: $OUT"
echo "repos created: gh repo list MarvinAmador7 --limit 20 | grep capcomd-e2e   (delete with gh repo delete <repo> --yes)"
