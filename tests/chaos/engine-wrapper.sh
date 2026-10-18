#!/bin/sh
# Test-only wrapper for rivet-engine, selected via RIVET_ENGINE_BINARY (resolved first by
# @rivetkit/engine-cli getEnginePath). rivetkit's native runtime spawns the engine with its
# own RIVET__* env, including RIVET__FILE_SYSTEM__PATH=$HOME/.rivetkit/var/engine/db, which
# overrides any value from our env. Re-point it here, right before exec, so each parallel
# chaos worker gets its own data dir. exec keeps the PID, so kill/port/lock accounting is
# unchanged. (Lowering pegboard envoy/runner thresholds here was measured and did NOT help:
# the ~39s restart is gasoline's compile-time WORKER_LOST_THRESHOLD_MS=30s + 10s GC; see
# docs/evidence/CHAOS-NOTES.md.)
if [ -n "$CAPCOMD_CHAOS_ENGINE_DATA" ]; then
  export RIVET__FILE_SYSTEM__PATH="$CAPCOMD_CHAOS_ENGINE_DATA/db"
fi
exec "$CAPCOMD_CHAOS_REAL_ENGINE" "$@"
