# capcomd

Agent orchestration CLI built on Rivet Actors and XState state machines.

## Overview

`capcomd` is a v0 implementation of an agent orchestration system that coordinates planners, workers, and verifiers through explicit lifecycle state machines. It demonstrates crash-safe execution using Rivet Actors' SQLite persistence and XState v5 for pure transitions.

**Key features:**
- Crash-safe lifecycle management with atomic state transitions
- Epoch-based lease management to prevent stale worker reports
- Outbox pattern for reliable side effects
- Fake model client and sandbox provider for offline development
- Comprehensive chaos testing suite

## Architecture

See `docs/` for detailed design documents:
- `actors-v1.md` - Actor topology and responsibilities
- `adr-008-lifecycle-state-machines.md` - State machine design
- `durability.md` - Failure scenarios and recovery
- `rivet-sqlite.md` - Persistence layer details
- `boxd.md` - Sandbox provider integration

### Actors

- **RunActor**: Manages run lifecycle, budget, and event log
- **PlannerActor**: Creates task plans (fake model calls)
- **TaskBoardActor**: Task and lease lifecycle management
- **WorkerActor**: VM provisioning and task execution
- **VerifierActor**: Verifies handoffs and merges
- **JudgeActor**: Evaluates run completion

### State Machines

- **Task**: pending → leased → running → handed_off → verifying → merged
- **Lease**: free → held (with epoch-guarded heartbeats) → released/expired
- **Worker**: provisioning → idle → busy → draining → destroyed
- **Run**: planning → executing → judging → completed

## Installation

A fresh clone has three package roots: the CLI/engine, the canvas UI and the terminal debugger (apps/tui).
Install all three, or `bun run typecheck` fails (it checks apps/canvas and apps/tui too):

```bash
bun install
(cd apps/canvas && bun install)
(cd apps/tui && bun install)
# or, equivalently:
bun run setup
```

## Usage

### Start the Rivet engine

```bash
bun run src/cli/index.ts serve
```

Or use the CLI directly:

```bash
bun capcomd serve
```

### Run a task

In a separate terminal:

```bash
bun capcomd run "Build a todo app"
```

### Check status

```bash
bun capcomd status <runId>
```

### Cancel a run

```bash
bun capcomd cancel <runId>
```

### Replay events

```bash
bun capcomd replay <runId>
```

## Testing

### Unit tests (state machines)

```bash
bun test tests/machines/
```

### Chaos tests

```bash
# Run all chaos tests
bun test tests/chaos/

# Run with specific killpoint
CAPCOMD_KILLPOINT=tx.mid:1 bun test tests/chaos/
```

### Named killpoints

- `tx.mid` - Kill during transaction
- `model.after_return.before_commit` - Kill after model call
- `merge.before_cas` - Kill before merge CAS
- `merge.after_cas.before_event` - Kill after CAS, before event
- `vm.create.after_request.before_record` - Kill during VM creation
- `lease.expire.mid` - Kill during lease expiry
- `budget.charge.mid` - Kill during budget charge
- `outbox.dispatch.after_send.before_ack` - Kill during outbox dispatch

## Known Limitations (v0)

- **No real VM execution**: Uses FakeProvider for testing
- **BoxdProvider stubbed**: Requires BOXD_API_KEY (not implemented)
- **No bun build --compile**: rivetkit's native module doesn't survive compilation
- **Fake model client**: No actual LLM calls
- **No real git operations**: Simulated in FakeProvider
- **Local engine only**: Rivet Cloud deferred

## Development

Type check:
```bash
bun check
```

Run all tests:
```bash
bun test
```

## Project Structure

```
src/
  actors/       - Rivet actor implementations
  cli/          - CLI commands
  machines/     - XState state machines
  models/       - Model client (fake)
  providers/    - Sandbox providers (fake, boxd stub)
  utils/        - Lifecycle, killpoint utilities
tests/
  machines/     - Transition table tests
  chaos/        - Crash recovery tests
docs/           - Design documents and ADRs
```

## Contributing

This is a v0 implementation for demonstration and testing purposes. Production use requires:
- Real BoxdProvider implementation
- Actual model client integration
- Git operations through sandboxes
- Backup and restore procedures
- Monitoring and observability
- Production-grade error handling

See `docs/durability.md` for the full failure matrix and recovery procedures.

## Naming (renamed from relay)

The CLI was renamed from `relay` to `capcomd` on 2026-10-18.
- Binary / package: `capcomd`. MCP tools: `capcomd_run`, `capcomd_status`, `capcomd_cancel`, `capcomd_events`, `capcomd_trace`, `capcomd_approve`.
- Env: `CAPCOMD_*` (`CAPCOMD_ENDPOINT`, `CAPCOMD_SANDBOX`, `CAPCOMD_PROTECTED_BRANCHES`, `CAPCOMD_TRACE`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_KILLPOINT`, `CAPCOMD_BOXD_DB`). The old `RELAY_*` names still work as deprecated aliases and print one warning on stderr (silence with `CAPCOMD_NO_DEPRECATION_WARNINGS=1`).
- Deliberately unchanged, for compatibility: actor names, the `relay.v1` JSON schema id, `relay.*` span attribute keys in traces, the `.relay/` state directory, and the `relay-` boxd VM name prefix (existing idempotency keys stay stable).
