# Relay v0 - Current Progress

**Updated:** 2026-10-17 19:37 UTC

## Major Progress: 8/10 Killpoints Passing!

### ✅ What's Fixed

**Root Cause:** TaskBoard onWake was calling `c.registry.run.get()` which doesn't exist in Rivet actors.

**Solution:** Simplified onWake to only mark outbox as dispatched, no cross-actor calls.

### Test Results

**Clean Runs:** ✅ **10/10 passing**
```
=== Run 1 === ✓ Run completed successfully
=== Run 2 === ✓ Run completed successfully
...
=== Run 10 === ✓ Run completed successfully
```

**Chaos Tests:** ✅ **8/10 killpoints passing**

**Passing Killpoints (8):**
- ✅ tx.mid (12.4s)
- ✅ model.after_return.before_commit (12.5s)  
- ✅ push.mid (5.4s)
- ✅ push.after.before_event (5.4s)
- ✅ vm.create.after_request.before_record (12.5s)
- ✅ lease.expire.mid (5.4s)
- ✅ budget.charge.mid (12.2s)
- ✅ outbox.dispatch.after_send.before_ack (5.4s)

**Failing Killpoints (2):**
- ❌ merge.before_cas (22s timeout)
- ❌ merge.after_cas.before_event (22s timeout)

### Remaining Issue: Verifier Recovery

**Problem:** When killed during verification, the verifier actor crashes on wake with "actor_stopped_before_ready" after 8 retries.

**Root Cause:** Even minimal onWake (just outbox dispatch) causes wake failures when there's a stuck verification row in the database.

**Attempted Fixes:**
1. ✓ Removed cross-actor calls
2. ✓ Simplified to only outbox dispatch
3. ✓ Added try/catch
4. ✗ Still crashes with stuck verification rows

**Next Steps:**

1. **Debug verifier onWake crash:**
   - Add extensive logging to see what exactly fails
   - Test if it's the outbox query or the mark-as-dispatched that fails
   - Check if there's corrupt data in lifecycle table

2. **Alternative recovery approach:**
   - Don't recover in verifier at all
   - Have taskBoard or run actor check for stuck verifications
   - Or: accept that merge killpoints may leave orphaned state

3. **Manual recovery test:**
   ```bash
   # Kill during merge
   RELAY_KILLPOINT="merge.before_cas:1" bun src/cli/index.ts serve &
   bun src/cli/index.ts run "Test"
   # After kill/restart
   # Check: SELECT * FROM lifecycle WHERE state = 'verifying'
   # Manually mark as passed
   ```

### 50-Seed Test

**Status:** Not run yet (need 10/10 killpoints first)

**Plan:** Once 10/10 pass, run 50 random seeds and classify failures.

### Remaining Work

1. **Fix 2 merge killpoints** (~1-2 hours)
   - Debug verifier wake crash
   - Implement proper recovery or acceptable degradation

2. **50-seed chaos test** (~30 min)
   - Run and classify failures
   - Document patterns

3. **Tracing** (~1 hour)
   - Wire spans into actors
   - Test relay trace output

4. **Canvas** (~2 hours)
   - Fix 3 failing tests
   - Build span waterfall UI

**Total remaining:** ~5-6 hours

## Git Status

```bash
HEAD: fix: taskboard onWake - 8/10 killpoints pass
All changes pushed to origin main
```

## How to Continue

### Immediate: Debug Verifier Wake
```bash
cd /workspace

# Add debug logging
vim src/actors/verifier.ts
# Add console.log at every line in onWake

# Test with merge killpoint
RELAY_KILLPOINT="merge.before_cas:1" bun src/cli/index.ts serve 2>&1 | tee /tmp/debug.log &
sleep 3
bun src/cli/index.ts run "Test"

# Check what fails
grep -A20 "verifier.onWake" /tmp/debug.log
```

### Once Fixed
```bash
# Verify 10/10
bun test tests/chaos/subprocess.test.ts --test-name-pattern "survives all 10"

# Run 50 seeds
bun test tests/chaos/subprocess.test.ts --test-name-pattern "50 random"
```

## Key Insight

The system is fundamentally sound - 8/10 killpoints recover correctly. The merge failure is isolated to verifier recovery, likely due to specific database state after a killed verification transaction.
