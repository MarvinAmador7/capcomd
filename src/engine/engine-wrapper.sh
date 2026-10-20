#!/bin/sh
# rivet-engine launcher, selected via RIVET_ENGINE_BINARY (resolved first by @rivetkit/engine-cli).
# rivetkit's native runtime spawns the engine with its own RIVET__* env, including
# RIVET__FILE_SYSTEM__PATH=$HOME/.rivetkit/var/engine/db, which overrides ours. Re-point it here,
# right before exec, so each engine (per serve port, per chaos worker) has its own data dir:
# two engines on one dir fight over the RocksDB LOCK and the second never becomes healthy.
# Also records the engine pid (exec keeps it), because rivet-engine runs in its own process
# group and outlives the serve process that started it unless serve kills it explicitly.
DATA="${CAPCOMD_ENGINE_DATA:-$CAPCOMD_CHAOS_ENGINE_DATA}"
if [ -n "$DATA" ]; then
  mkdir -p "$DATA"
  export RIVET__FILE_SYSTEM__PATH="$DATA/db"
fi
[ -n "$CAPCOMD_ENGINE_PIDFILE" ] && echo $$ > "$CAPCOMD_ENGINE_PIDFILE"
exec "${CAPCOMD_REAL_ENGINE:-$CAPCOMD_CHAOS_REAL_ENGINE}" "$@"
