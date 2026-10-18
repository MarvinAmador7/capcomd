#!/usr/bin/env bash
set -e

cd /workspace
rm -rf .rivet

# Kill ALL rivet processes
pkill -9 rivet-eng || true
pkill -9 rivet-ser || true
pkill -9 bun || true
sleep 2

echo "=== Test 2: Kill rivet children properly ==="

# Start with killpoint
RELAY_KILLPOINT="merge.before_cas:1" ~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve_fix1.log &
SERVE_PID=$!
echo "Serve PID: $SERVE_PID"

# Wait for engine to start
sleep 3
RIVET_PIDS=$(pgrep rivet-eng || true)
echo "Rivet engine PIDs: $RIVET_PIDS"

# Start run
~/.bun/bin/bun src/cli/index.ts run "Test" 2>&1 > /tmp/run_fix1.log &
RUN_PID=$!

# Wait for killpoint
sleep 5

# Kill EVERYTHING (bun + rivet children)
echo "Killing bun + rivet children..."
pkill -9 -P $SERVE_PID || true  # Kill children of serve
kill -9 $SERVE_PID 2>/dev/null || true
pkill -9 rivet-eng || true
pkill -9 rivet-ser || true
sleep 1

# Verify port is free
if lsof -i :6420 > /dev/null 2>&1; then
  echo "ERROR: Port still in use after kill"
  lsof -i :6420
  exit 1
fi
echo "✓ Port 6420 free"

# Verify no rivet processes
if pgrep rivet > /dev/null 2>&1; then
  echo "ERROR: Rivet processes still running"
  pgrep rivet
  exit 1
fi
echo "✓ No rivet processes"

# Wait
sleep 2

# Restart
echo "Restarting serve..."
~/.bun/bin/bun src/cli/index.ts serve 2>&1 > /tmp/serve_fix2.log &
SERVE_PID=$!

# Wait for startup
sleep 5

# Check for errors
if grep -q "transaction.*closed" /tmp/serve_fix2.log; then
  echo "ERROR: Still seeing coordinator errors"
  grep "transaction.*closed" /tmp/serve_fix2.log | head -3
  exit 1
else
  echo "✓ No coordinator errors"
fi

# Wait for run
timeout 10 tail --pid=$RUN_PID -f /dev/null 2>/dev/null || true

# Cleanup
pkill -9 rivet-eng || true
pkill -9 rivet-ser || true
pkill -9 bun || true

echo ""
echo "=== Run output ==="
tail -15 /tmp/run_fix1.log

echo ""
echo "SUCCESS: Clean restart without coordinator errors"
