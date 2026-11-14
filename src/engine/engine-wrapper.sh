#!/bin/sh
# rivet-engine launcher, selected via RIVET_ENGINE_BINARY (resolved first by @rivetkit/engine-cli).
# rivetkit's native runtime spawns the engine with its own RIVET__* env, including (rivetkit 3.x, the depot storage)
# RIVET__STORAGE__LOG_DIRECTORY and RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH under
# <storage root>/.rivetkit/var/engine/depot, which override ours. Re-point them here,
# right before exec, to capcomd's own data dir (`capcomd serve` always sets CAPCOMD_ENGINE_DATA:
# <capcomd home>/engine/<port>, src/engine/data.ts), so each engine (per serve port, per test engine) has its
# own: two engines on one dir fight over the storage and the second never becomes healthy.
# Also records the engine pid (exec keeps it), because rivet-engine runs in its own process
# group and outlives the serve process that started it unless serve kills it explicitly.
DATA="${CAPCOMD_ENGINE_DATA:-$CAPCOMD_TEST_ENGINE_DATA}"
if [ -n "$DATA" ]; then
  mkdir -p "$DATA/db/log" "$DATA/db/objects"
  export RIVET__STORAGE__LOG_DIRECTORY="$DATA/db/log"
  export RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH="$DATA/db/objects"
fi
[ -n "$CAPCOMD_ENGINE_PIDFILE" ] && echo $$ > "$CAPCOMD_ENGINE_PIDFILE"
# And how rivetkit launched it, so `capcomd serve` can start it again in place when it exits under rivetkit (rivet-engine
# 3.x fences itself and exits when the machine slept past its topology lease; rivetkit doesn't restart it): this
# script's argv, and only the RIVET__* settings rivetkit gave it (the rest of the environment, API keys included, is
# serve's own and never written). NUL-separated, owner-only.
if [ -n "$DATA" ]; then
  (
    umask 077
    printf '%s\0' "$0" "$@" > "$DATA/engine-launch.argv"
    for v in $(env | sed -n 's/^\(RIVET__[A-Za-z0-9_]*\)=.*/\1/p' | sort -u); do
      eval "printf '%s=%s\\0' \"\$v\" \"\${$v}\""
    done > "$DATA/engine-launch.env"
  ) 2>/dev/null
fi
exec "${CAPCOMD_REAL_ENGINE:-$CAPCOMD_TEST_REAL_ENGINE}" "$@"
