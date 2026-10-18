# Relay v0 - Blocking Issues

**Updated:** 2026-10-17 19:31 UTC

## CRITICAL: Runs Hang After Starting

### Symptoms
- ✅ Actors wake successfully (no more wake retry exhaustion)
- ✅ Run commands start and print goal
- ❌ Runs hang indefinitely - no task creation, no completion
- ❌ Status check fails with "actor does not exist or was destroyed"

### What Works
- CLI commands parse correctly
- Serve starts and actors initialize  
- Run creation begins
- No crash/wake failures

### What's Broken
- Run orchestration flow stalls after initialization
- Tasks never created
- Workers never provisioned
- No error messages or exceptions

### Likely Causes
1. **Event loop stall** - Something blocking in run.ts orchestration
2. **Actor messaging deadlock** - Cross-actor calls not completing
3. **Missing implementation** - Core orchestration logic incomplete
4. **Database lock** - Transaction not committing

### Next Debug Steps

1. **Add debug logging in run.ts:**
```typescript
console.log("[run] Starting orchestration...");
console.log("[run] Creating planner...");
console.log("[run] Planner created, getting plan...");
// etc at each major step
```

2. **Check actor states:**
```bash
# While run is hanging
cd /workspace
.bun/bin/bun src/cli/index.ts status <runId>
```

3. **Bisect against working commit:**
```bash
git bisect start
git bisect bad HEAD
git bisect good 6585e51  # Last known good
# Test each revision
```

4. **Simplify run.ts to minimal:**
- Comment out all orchestration
- Just create run actor and return
- Verify that works
- Add back one piece at a time

### Files to Check

**Primary suspect:** `src/cli/commands/run.ts`
- Line-by-line verification of orchestration flow
- Check for await missing
- Check for promise not resolved
- Check for infinite loop

**Secondary:** Actor implementations
- `src/actors/run.ts` - Run state machine
- `src/actors/planner.ts` - Plan generation
- `src/actors/taskboard.ts` - Task management

### Chaos Test Status

**Cannot proceed** until basic runs complete.

Required:
- 10 consecutive successful runs
- Then: 10/10 killpoints
- Then: 50/50 seeds with classification

### Time Estimate

- 1-2 hours to debug why runs hang
- Once fixed: 2-3 hours for full chaos suite
- Then: 1 hour tracing
- Then: 2 hours canvas

Total remaining: ~6-8 hours

## Completed Work

### Verifier Recovery ✅
- onWake now only schedules work (c.schedule.after)
- recoverInflight is separate action with full logic
- Try/catch with logging
- No blocking work in onWake
- Idempotency keys in recovery

### Git Status
```
HEAD: fix: verifier onWake follows rules
Branch: main
Pushed: Yes
```

## Resume Commands

### Debug Hanging Runs
```bash
cd /workspace

# Add debug logging
vim src/cli/commands/run.ts
# Add console.log at each major step

# Test single run with full output
pkill -9 bun
~/.bun/bin/bun src/cli/index.ts serve &
sleep 3
~/.bun/bin/bun src/cli/index.ts run "Test" 2>&1 | tee /tmp/run_debug.log

# If still hangs, bisect
git bisect start
git bisect bad HEAD
git bisect good 6585e51
```

### Once Runs Work
```bash
# 10 clean runs
for i in {1..10}; do
  ~/.bun/bin/bun src/cli/index.ts run "Test $i"
done

# Chaos tests
~/.bun/bin/bun test tests/chaos/subprocess.test.ts --timeout 400000
```
