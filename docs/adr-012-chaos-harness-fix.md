# ADR-012: Chaos Test Harness Process Cleanup

## Status

Accepted

## Context

Chaos tests were failing on `merge.before_cas` and `merge.after_cas.before_event` killpoints with:
```
level=error message="sqlite operation failed" ... sql="SELECT MIN(trigger_at) FROM _rivet_schedule_events" 
code=transaction_closed error_message="SQLite transaction coordinator is closed."
```

Initially suspected a Rivet engine bug affecting all actors with `db()`, but 8/10 other killpoints passed cleanly.

## Investigation

### Root Cause

`bun src/cli/index.ts serve` spawns **rivet-engine** and **rivet-server** child processes. When the test harness kills bun with SIGKILL (exit code 137), **child processes remain alive**:

```bash
$ lsof -i :6420
COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
rivet-eng 18049 ubuntu  488u  IPv4  69949      0t0  TCP localhost:6420 (LISTEN)
rivet-ser 18491 ubuntu   10u  IPv4  70098      0t0  TCP localhost:42764->localhost:6420 (ESTABLISHED)
```

When the harness restarts serve (500ms later), the new engine tries to bind port 6420 (fails) and access `.rivet/` while the old engine still holds locks. **Two engines accessing the same SQLite databases = coordinator corruption.**

### Why Only Merge Killpoints Failed

The merge killpoints (`merge.before_cas`, `merge.after_cas.before_event`) are in the **verifier actor's critical path** after it has written `state='verifying'` to its database. When the engine crashes mid-verification and restarts, the verifier actor must wake from persisted state. The **wake logic queries `_rivet_schedule_events`** to sync alarms, hitting the corrupted coordinator.

Other killpoints either:
- Fire before actors with db() are created
- Fire in actors without persistent SQLite state  
- Don't leave actors in partially-complete states requiring wake

## Decision

Fix the chaos test harness to kill child processes before restart:

```typescript
serve.on("exit", (code) => {
  if (code === 137 && !killed) {
    killed = true;
    console.log(`Server killed at ${killpoint}, cleaning up...`);
    
    exec("pkill -9 rivet-eng; pkill -9 rivet-ser", () => {
      setTimeout(() => {
        serve = spawn("bun", ["src/cli/index.ts", "serve"], {
          cwd: "/workspace",
          stdio: "pipe",
        });
      }, 2000);  // Increased from 500ms to 2000ms
    });
  }
});
```

## Verification

Manual test of 3 critical killpoints after fix:

```
=== Testing tx.mid ===
  ✓ tx.mid: 0 coordinator errors

=== Testing merge.before_cas ===
  ✓ merge.before_cas: 0 coordinator errors

=== Testing merge.after_cas.before_event ===
  ✓ merge.after_cas.before_event: 0 coordinator errors
```

Before fix:
- Port 6420 held by old rivet-eng after bun killed
- Multiple "transaction coordinator closed" errors on restart
- merge killpoints: 0% pass rate

After fix:
- Port 6420 free after cleanup
- 0 coordinator errors on restart
- merge killpoints: 100% pass rate (manual test)

## Consequences

### Positive
- Chaos tests can now properly validate durability across all killpoints
- Root cause was application harness bug, not Rivet engine limitation
- Fix is simple and doesn't require architecture changes

### Negative
- Slower test execution (500ms → 2000ms restart delay)
- Relies on `pkill` which may not be portable (fine for Linux CI)

## Not a Rivet Bug

The original hypothesis that "Rivet can't wake actors with db() after crash" was **wrong**. The issue was:
- Test harness leaving zombie processes
- Two engines accessing one data directory
- Race condition corrupting SQLite coordinators

Rivet's actor wake mechanism works correctly when processes are cleanly killed and restarted.
