#!/usr/bin/env bash
set -e

cd /workspace

# Clean state
pkill -9 bun || true
sleep 2
rm -rf .rivet

# Start serve with killpoint
echo "Starting serve with killpoint..."
RELAY_KILLPOINT="merge.before_cas:1" ~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve_kill.log &
SERVE_PID=$!
echo "Serve PID: $SERVE_PID"
sleep 5

# Start run (which will trigger the kill)
echo "Starting run..."
~/.bun/bin/bun src/cli/index.ts run "Test with restart" 2>&1 > /tmp/run_kill.log &
RUN_PID=$!

# Wait for serve to be killed by the killpoint
sleep 8

# Check if serve is still running
if ! kill -0 $SERVE_PID 2>/dev/null; then
  echo "Serve was killed by killpoint, restarting..."
  sleep 1
  
  # Restart serve WITHOUT killpoint
  ~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve_restart.log &
  SERVE_PID=$!
  echo "Serve restarted with PID $SERVE_PID"
  sleep 5
else
  echo "Serve still running with PID $SERVE_PID"
fi

# Wait for run to complete (max 15s more)
timeout 15 tail --pid=$RUN_PID -f /dev/null || true

# Kill serve
kill $SERVE_PID 2>/dev/null || true
sleep 1

echo ""
echo "=== Run output ==="
cat /tmp/run_kill.log 2>&1 | tail -30

echo ""
echo "=== Serve restart log (last 40 lines) ==="
tail -40 /tmp/serve_restart.log 2>&1 || echo "No restart log"

echo ""
echo "=== Serve restart errors ==="
grep -i "sqlite.*closed\|transaction.*closed" /tmp/serve_restart.log 2>&1 | head -10 || echo "No SQLite errors"
