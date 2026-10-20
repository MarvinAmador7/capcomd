#!/usr/bin/env bash
# Live env e2e on the Mac: env build → secrets sync → doctor → mac-e2e (claude-code, codex) from the
# snapshot, plus fresh-image baseline run(s), then a timing table.
# Needs what scripts/mac-e2e.sh needs, plus ANTHROPIC_API_KEY and OPENAI_API_KEY in env for
# `secrets sync` (read from env, never printed). Agent runs then use CAPCOMD_CREDENTIALS=secret, so
# the VMs only ever hold bxds_ placeholders.
#   CAPCOMD_ENV_E2E_AGENTS   agents to run from the snapshot   (default "claude-code codex")
#   CAPCOMD_ENV_E2E_BASELINE agents to also run on the image   (default "claude-code"; "none" to skip)
# Each agent run creates one private repo (like mac-e2e.sh); delete them afterwards (printed).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
die() { echo "mac-env-e2e: $*" >&2; exit 1; }
[ -n "${BOXD_API_KEY:-}" ] || die "BOXD_API_KEY is not set"
export CAPCOMD_SANDBOX=boxd
AGENTS="${CAPCOMD_ENV_E2E_AGENTS:-claude-code codex}"
BASELINE="${CAPCOMD_ENV_E2E_BASELINE:-claude-code}"; [ "$BASELINE" = none ] && BASELINE=""
OUT="$(mktemp -d "${TMPDIR:-/tmp}/capcomd-env-e2e.XXXXXX")"
TIMINGS="$OUT/timings.ndjson"; : > "$TIMINGS"
now() { bun -e 'console.log(Date.now())'; }
[ -d node_modules ] || bun install

echo "######## 1. capcomd env build"
t0=$(now)
bun src/cli/index.ts env build
BUILD_MS=$(( $(now) - t0 ))
bun src/cli/index.ts env status

echo "######## 2. capcomd secrets sync"
bun src/cli/index.ts secrets sync || die "secrets sync failed"

echo "######## 3. capcomd doctor (VM from the snapshot)"
t0=$(now)
bun src/cli/index.ts doctor || echo "   (doctor reported failures; continuing so the runs show where)"
DOCTOR_MS=$(( $(now) - t0 ))

run() { # $1 agent  $2 env-label (snapshot|image)
  local agent="$1" envl="$2" log="$OUT/e2e-$1-$2.log"
  echo "######## 4. mac-e2e agent=$agent env=$envl"
  set +e
  if [ "$envl" = image ]; then CAPCOMD_ENV=image CAPCOMD_AGENT="$agent" CAPCOMD_CREDENTIALS=secret bash scripts/mac-e2e.sh 2>&1 | tee "$log"
  else CAPCOMD_AGENT="$agent" CAPCOMD_CREDENTIALS=secret bash scripts/mac-e2e.sh 2>&1 | tee "$log"; fi
  set -e
  grep '^CAPCOMD_TIMING ' "$log" | sed "s/^CAPCOMD_TIMING {/{\"env\":\"$envl\",/" >> "$TIMINGS" || echo "{\"env\":\"$envl\",\"agent\":\"$agent\",\"rc\":-1}" >> "$TIMINGS"
}
for a in $AGENTS; do run "$a" snapshot; done
for a in $BASELINE; do run "$a" image; done

echo
echo "######## timings"
BUILD_MS=$BUILD_MS DOCTOR_MS=$DOCTOR_MS TIMINGS="$TIMINGS" bun -e '
  const rows = require("fs").readFileSync(process.env.TIMINGS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  console.log(`env build: ${(process.env.BUILD_MS/1000).toFixed(1)}s   doctor: ${(process.env.DOCTOR_MS/1000).toFixed(1)}s`);
  const f = (ms) => ms ? (ms/1000).toFixed(1) + "s" : "-";
  console.log("agent        env       rc  run     vm-boot  install  agent    turns  cost     credential");
  for (const r of rows) console.log(`${String(r.agent).padEnd(12)} ${r.env.padEnd(9)} ${String(r.rc).padEnd(3)} ${(r.run_s ? r.run_s + "s" : "-").padEnd(7)} ${f(r.vm_boot_ms).padEnd(8)} ${(r.installed ? f(r.install_ms) : "skipped").padEnd(8)} ${f(r.agent_ms).padEnd(8)} ${String(r.turns ?? "-").padEnd(6)} ${String(r.cost_usd != null ? "$" + Number(r.cost_usd).toFixed(3) : "-").padEnd(8)} ${r.credential ?? "-"}`);
  for (const a of new Set(rows.map((r) => r.agent))) {
    const s = rows.find((r) => r.agent === a && r.env === "snapshot"), i = rows.find((r) => r.agent === a && r.env === "image");
    if (s && i && s.run_s && i.run_s) console.log(`${a}: snapshot ${s.run_s}s vs image ${i.run_s}s → ${i.run_s - s.run_s >= 0 ? "saved" : "lost"} ${Math.abs(i.run_s - s.run_s)}s (install ${f(i.install_ms)} → ${s.installed ? f(s.install_ms) : "skipped"})`);
  }
  const bad = rows.filter((r) => r.rc !== 0); if (bad.length) { console.log(`FAILED: ${bad.map((r) => r.agent + "/" + r.env).join(", ")}`); process.exit(1); }
'
echo "logs: $OUT"
echo "repos created: gh repo list MarvinAmador7 --limit 20 | grep capcomd-e2e   (delete with gh repo delete <repo> --yes)"
