#!/bin/sh
# Chaos/test engines (CAPCOMD_CHAOS_ENGINE_DATA, CAPCOMD_CHAOS_REAL_ENGINE): same launcher as serve.
exec "$(dirname "$0")/../../src/engine/engine-wrapper.sh" "$@"
