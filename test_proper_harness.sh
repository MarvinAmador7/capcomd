#!/usr/bin/env bash
set -e

cd /workspace
rm -rf .rivet
pkill -9 bun || true
sleep 2

echo "=== Test 1: Proper waitpid and port check ==="

# Start with killpoint
RELAY_KILLPOINT="merge.before_cas:1" ~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve1.log &
SERVE_PID=$!
echo "Serve PID: $SERVE_PID"

# Wait for port to be ready
sleep 3
if ! lsof -i :6420 > /dev/null 2>&1; then
  echo "ERROR: Port 6420 not listening"
  exit 1
fi
echo "✓ Port 6420 listening"

# Start run
~/.bun/bin/bun src/cli/index.ts run "Test" 2>&1 > /tmp/run1.log &
RUN_PID=$!

# Wait for process to be killed
sleep 5

# Check if serve process is dead
if kill -0 $SERVE_PID 2>/dev/null; then
  echo "ERROR: Serve still running after killpoint"
  kill -9 $SERVE_PID
  exit 1
fi
echo "✓ Serve killed by killpoint"

# Wait for PID to be fully reaped
wait $SERVE_PID 2>/dev/null || true
echo "✓ PID reaped"

# Check no lingering bun processes
LINGERING=$(pgrep -f "bun.*serve" || true)
if [ -n "$LINGERING" ]; then
  echo "ERROR: Lingering bun processes: $LINGERING"
  pkill -9 bun
  sleep 1
fi
echo "✓ No lingering processes"

# Check port is free
if lsof -i :6420 > /dev/null 2>&1; then
  echo "ERROR: Port 6420 still in use"
  lsof -i :6420
  exit 1
fi
echo "✓ Port 6420 free"

# Wait extra time
sleep 2

# Restart serve
echo "Restarting serve..."
~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve2.log &
SERVE_PID=$!
echo "New serve PID: $SERVE_PID"

# Wait for port
sleep 3
if ! lsof -i :6420 > /dev/null 2>&1; then
  echo "ERROR: Port 6420 not listening after restart"
  exit 1
fi
echo "✓ Port 6420 listening after restart"

# Check for errors
sleep 5
if grep -q "transaction.*closed" /tmp/serve2.log; then
  echo "ERROR: Still seeing transaction closed errors"
  grep "transaction.*closed" /tmp/serve2.log | head -5
else
  echo "✓ No transaction closed errors (yet)"
fi

# Let run complete
timeout 10 tail --pid=$RUN_PID -f /dev/null 2>/dev/null || true

# Kill serve
kill $SERVE_PID 2>/dev/null || true

echo ""
echo "=== Run output ==="
tail -20 /tmp/run1.log

echo ""
echo "=== Serve2 errors ==="
grep -i error /tmp/serve2.log | head -10 || echo "No errors"
